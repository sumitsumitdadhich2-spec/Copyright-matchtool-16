# HANDOFF PROMPT — Next AI ke liye (copy-paste karke do)

---

Mere project "Copyright Match Tool" (Next.js app, Gemini video analysis) me ye kaam karo:

## KAAM 1 — Purana segmentation system PURA hatao

Abhi app ka pipeline aisa hai: pehle short video ko Gemini se alag step me segments me todа jata hai (segmentation prompt/step), fir har segment ko movie chunks ke against match kiya jata hai. Ye PURA segmentation system hata do:

- `lib/gemini.ts` me jo bhi separate segmentation prompt/function hai (short video ko segments me todne wala step) — remove karo.
- `lib/scheduler.ts` me jo segmentation phase/step chalta hai — remove karo.
- Store/scan JSON me segmentation-related state jo ab use nahi hogi — clean karo (lekin scan results ka final output format UI me dikhna chahiye).
- Koi bhi UI jo "segmentation step" dikhata hai use naye flow ke hisaab se update karo.

## KAAM 2 — Naya single-prompt flow (har chunk pe same prompt)

Naya pipeline simple hai:

1. Short video ko 24fps me re-encode karo (ffmpeg, jaisa abhi hota hai).
2. Movie ko ~1 minute ke chunks me todo, har chunk 24fps (ye chunking already `lib/ffmpeg.ts` me hai — rakho).
3. HAR EK movie chunk ke liye Gemini ko EK hi call bhejo jisme:
   - Video 1 = poora SHORT VIDEO
   - Video 2 = wo MOVIE CHUNK
   - Prompt = neeche diya gaya EXACT prompt (bina badlav ke, word-to-word)
4. Model ka output (HISSA 1 + HISSA 2) har chunk ke liye save karo aur UI me dikhao. HISSA 2 ki "Short X --> Movie Y" lines hi matches hain; "NOT FOUND" lines skip karo. Movie chunk ke local timestamps ko chunk ke start-offset se global movie time me convert karo.
5. Ye SAME prompt har chunk pe repeat hota hai — koi alag segmentation call nahi.

Ye prompt already project me `data/experiment-prompt.md` me saved hai. Test run isi repo me `.v0/experiment/run.mjs` se hua tha aur result `.v0/experiment/result.txt` me saved hai — reference ke liye dekh sakte ho.

## EXACT PROMPT (har chunk ke liye, bina badlav ke use karo)

```
You are a forensic video analyst. You are given TWO videos:
- Video 1: a SHORT VIDEO that was edited together from clips of a movie.
- Video 2: a ONE-MINUTE CHUNK cut from the original movie.

Both videos are exactly 24 fps. Analyze them frame by frame at 24 fps precision.

Respond in Hinglish (Hindi written in Latin script). Spoken dialogue must always be QUOTED VERBATIM in its original language.

Your answer has exactly TWO parts:

=====================
HISSA 1 — SHORT VIDEO TIME MAP
=====================
Watch Video 1 from start to finish and break it into small, fine-grained segments:
- Har segment chhota hona chahiye — zyada tar segments 1 second ya usse kam ke hone chahiye. Ek lambi continuous shot ko bhi chhote sub-segments me todo taaki mapping precise rahe.
- Segments contiguous hone chahiye: har segment ka start = pichle segment ka end. Pehla segment 00:00.000 se shuru ho, aakhri segment video ki total duration par khatam ho. Koi gap nahi, koi overlap nahi.
- Har line ka format:
  mm:ss.mmm - mm:ss.mmm (startFrame-endFrame frames): <ek line ka Hinglish description — kaun kya kar raha hai, aur agar koi kuch bol raha hai to exact words quote karo>
- Frame numbers = timestamp x 24 (24 fps). Timestamps millisecond precision me, frame boundaries 1/24s (0.0417s) steps par aligned.
- Dialogue sabse strong fingerprint hai — kabhi summarize mat karo, hamesha exact words quote karo.

=====================
HISSA 2 — MOVIE MAP TIME
=====================
Ab HISSA 1 ke HAR EK segment ke liye Video 2 (movie chunk) me EXACT wahi footage dhundho (same recording, frame for frame — sirf similar scene nahi).

STRICT RULES:
1. 1:1 SAME-DURATION MAPPING (sabse important rule): Har short segment ka movie me matched window EXACTLY utni hi duration ka hona chahiye. Agar short segment 0.417s ka hai, to movie window bhi 0.417s ka hoga — na kam, na zyada. (movie_end - movie_start) MUST equal (short_end - short_start). Kabhi bhi ek chhote short segment ko movie ke bade 5-10 second block par map mat karo.
2. HAR SEGMENT KI APNI LINE: Har short segment ke liye alag mapping line likho. Kai segments ko ek saath ek badi range me merge mat karo (consecutive NOT FOUND segments ko ek line me group karna allowed hai).
3. Movie timestamps Video 2 ki APNI clock se aane chahiye (00:00.000 se ~01:00.000) — frames ko actually dekh kar. Short video ke timestamps copy karke movie column me daalna FORBIDDEN hai jab tak tumne wahi frames Video 2 me us position par khud verify na kiye hon.
4. NOT FOUND: Agar koi short segment is movie chunk ke andar NAHI milta, to clearly likho "NOT FOUND — ye scene is movie chunk ke andar nahi hai". Ye ek movie ka sirf 1-minute chunk hai — bahut se segments milenge hi nahi. Zabardasti match banana false positive hai, jo miss karne se bahut zyada bura hai. SIMILAR IS NOT SAME — same actors/location par different moment = NOT FOUND.
5. Movie ke andar segments ka order short video ke order se alag ho sakta hai (short video edited hai) — har segment independently dhundho.

Har matched line ka format:
  Short mm:ss.mmm - mm:ss.mmm --> Movie mm:ss.mmm - mm:ss.mmm (startFrame-endFrame frames)

Na milne par:
  Short mm:ss.mmm - mm:ss.mmm --> NOT FOUND — <chhota reason>

Poore answer me sirf HISSA 1 aur HISSA 2 do, aur kuch nahi.
```

## TECHNICAL NOTES

- Gemini call: `@google/genai` package, Files API se dono videos upload karo (short video ek baar upload karke reuse kar sakte ho, har chunk alag upload hoga), model pool `lib/models.ts` me hai, API keys `data/settings.json` me.
- Test run stats (reference): model `gemini-3.5-flash`, ~93s response time, ~33k total tokens per chunk call.
- Output parsing: HISSA 2 ki lines regex se parse karo: `Short (\d+:\d+\.\d+) - (\d+:\d+\.\d+) --> Movie (\d+:\d+\.\d+) - (\d+:\d+\.\d+)` — NOT FOUND lines ignore.
- Global movie time = chunk_start_offset + movie_local_time.
- Raw Gemini output bhi har chunk ke liye save karo (debugging ke liye), sirf parsed matches nahi.
