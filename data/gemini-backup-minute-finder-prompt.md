# Gemini BACKUP Minute Finder — Prompt + Design (manual test ke liye)

Ye normal minute finder (`data/gemini-minute-finder-prompt.md`) ka **doosra pass** hai.
Normal pass poora short (@5fps) har 20-min movie window ke saath check karta hai. Jo short ke hisse
KISI BHI window me nahi mile (na MATCH, na POSSIBLE) — sirf UNHI hisson ko cut karke, HIGH FPS par,
dobara har window me dhundha jaata hai. Movie side same rehti hai (20-min window @1fps, Files API cache se — dobara upload nahi).

Goal same: movie ke kaun se MINUTE me footage hai. Output phir 24fps chunk scan ko jaata hai. RECALL sabse zyada important.

Code: `lib/gemini-minute-finder.ts` (`runBackupPass`), prompt `lib/gemini.ts` (`BACKUP_MINUTE_FINDER_PROMPT`), clip `lib/ffmpeg.ts` (`buildBackupClip`).

---

## Normal finder vs Backup finder — kya alag hai

| | Normal pass | Backup pass |
|---|---|---|
| Video 1 | poora short (uncut), 5 fps | sirf MISSING tukde (concat clip), 5-24 fps |
| Video 1 ki clock | = short ki asli clock | clip ki apni clock (00:00 se), asli short time ALAG hai — PART MAP se map hota hai |
| Scenes | 20-30 scenes ek saath dhundhne | 1-5 chhote hisse, poora focus |
| Kab chale | hamesha | sirf jab short ka koi >=4 sec hissa kisi window me na mile |
| Kitni baar | 1 baar (saare windows) | 1 baar (saare windows), loop nahi |
| Prompt | poora scene-map + hunt | halka scene-map + deep hunt + "ye clip pehle miss hua tha" context |

---

## Nuksaan (problems) aur unke solutions — jo prompt/design me daale gaye hain

### Problem 1 — Movie side abhi bhi 1 fps hai
Short ko 20fps karne se sirf QUERY sharp hoti hai. Movie window me 1 sec se chhota shot 0-1 frame hi hai.
**Solution (design):** <4 sec ke missing tukde DROP — unke liye backup chalega hi nahi (waste bachao).
**Solution (prompt):** HUNT me AUDIO ko primary locator banaya — 1fps par bhi audio poora hota hai, dialogue/music/SFX
se position milti hai chahe frames kam ho. Aur "1 fps par movie side me 1-2 frame hi dikhe to bhi agar audio +
location + costume match hai to POSSIBLE do, NOT FOUND nahi" — rule daala.

### Problem 2 — Scene movie me hai hi nahi (intro card, logo, outro, text screen, doosri movie ka footage)
Backup poori movie scan karega aur kuch nahi milega.
**Solution (design):** Backup sirf 1 baar chalta hai. Har window ka NOT FOUND aane par gap ko "NOT IN MOVIE" mark karke chhod dete hain.
**Solution (prompt):** HISSA 1 me har part ka `TYPE` tag mangte hain: `MOVIE FOOTAGE` / `TEXT-CARD` / `LOGO-INTRO-OUTRO` / `NON-MOVIE`.
Agar model khud bole ki ye tukda text-card ya logo hai, to app us hisse ko "not in movie" maan kar aage ke windows me
bhi usse skip nahi karti (rule: saare windows chalenge), lekin final report me "movie footage nahi" likh deti hai.

### Problem 3 — Requests double / RPD consumption
2h movie = 6 windows extra per backup pass.
**Solution (design):** Multiple gaps → EK clip me concat → ek hi pass. Gap <4s drop. Backup 1 baar hi.
Window ORDER smart: found minutes ke beech wali window pehle (shorts chronological hote hain), baaki baad me. Saare chalte hain.

### Problem 4 — Multiple gaps, ek clip
Model ko confusion ho sakta hai ki clip ke 00:10 ka matlab short ka 00:10 hai.
**Solution (prompt):** `{{PART_MAP}}` diya jaata hai — clip ke har PART ki clip-clock range aur uski asli short-time range.
HISSA 1 me model ko PART boundaries respect karni hain (do PARTS ko ek scene me merge karna FORBIDDEN),
aur HISSA 2/3 me output me PART number aur SHORT time (asli) likhna hai — clip time nahi. Isse app timestamps seedha map kar leti hai.
Concat ke beech me 1 sec black frame + silence daala jaata hai taaki PART boundary visually saaf ho.

### Problem 5 — Gap detection imperfect (short-side timestamps approx hain)
Normal pass ke short timestamps model ke approx boundaries hain, +-2 sec error normal hai.
**Solution (design):** Gap nikaalne ke baad har gap ko dono taraf 2 sec PAD karo (short ke 0 aur end par clamp),
phir <4 sec wale drop. Isse boundary error se scene ka aadha hissa cut nahi hota.
**Solution (bug fix, code):** normal pass me jab short range parse nahi hoti to `fullShort` assume hota hai — isse coverage
100% dikhti hai aur backup kabhi trigger nahi hota. Fix: HISSA-3-only / range-less minutes ko coverage me COUNT NAHI karna
(`normalCoverage()` sirf parsable short range wale hits ginta hai).

### Problem 6 — Chunk scan late start
**Solution (design):** Sequential — normal → backup → chunk scan. Backup sirf tab jab gap hai,
warna koi delay nahi. Status me "Backup finder: window x/N" dikhega.

### Problem 7 — Normal prompt se confusion
Normal prompt "poore short ko 1-10 sec scenes me todo" bolta hai — 30 sec clip 10 tukdon me toot jaayega, har tukda alag hunt.
**Solution (prompt):** Alag prompt (neeche). HISSA 1 halka: har PART ko max 2-3 scenes me todo (ya poora PART ek scene).
Context clearly bataya: "ye pehle miss hua tha, isliye ab zyada dhyan se — audio pehle, phir visual, phir POSSIBLE dene me generous raho".

### Problem 8 — Backup me over-eager MATCH (false positive) ka risk
Kyunki hum bolte hain "miss hua tha, dhundho", model zabardasti match bana sakta hai.
**Solution (prompt):** MATCH ke liye wahi strict evidence (dialogue words ya action sequence). Shak ho to POSSIBLE — MATCH nahi.
Window verdict me "NOT IN THIS WINDOW" dena bilkul normal, isko repeat kiya. Chunk scan 24fps par waise bhi verify karega,
isliye POSSIBLE cheap hai, galat MATCH bhi utna mehnga nahi — lekin phir bhi honest rakha.

---

## FPS table (900-frame budget, ~66 tok/frame + 32 tok/sec audio, movie window ~130K fixed)

| Clip duration (saare gaps concat) | FPS | Short tokens ≈ | Total/request ≈ |
|---|---|---|---|
| 4 – 37 sec | 24 | ≤ 60K | ≤ 196K |
| 37 – 45 sec | 20 | ≤ 61K | ≤ 197K |
| 45 – 60 sec | 15 | ≤ 61K | ≤ 197K |
| 60 – 90 sec | 10 | ≤ 62K | ≤ 198K |
| 90 – 120 sec | 8 | ≤ 67K | ≤ 203K |
| 120 – 180 sec | 5 | ≤ 65K | ≤ 201K |

Formula: `fps = clamp(floor(900 / clipSeconds), 5, 24)` (`backupClipFps()` in `lib/gemini.ts`). Sab 250K TPM ke andar.

---

## Test setup (AI Studio / Gemini app)
- Video 1 = short ka CUT clip (sirf missing hissa/hisse). Video settings me fps = upar table se.
- Video 2 = poori movie, clip range `{{WINDOW_START}} → {{WINDOW_END}}`, 1 fps.
- `{{PART_MAP}}` example (ek gap):
  ```
  PART 1: clip 00:00 - 00:30  =  short 01:00 - 01:30
  ```
  Example (do gaps, beech me 1 sec black):
  ```
  PART 1: clip 00:00 - 00:12  =  short 00:18 - 00:30
  PART 2: clip 00:13 - 00:45  =  short 01:08 - 01:40
  ```
- `{{FOUND_SUMMARY}}` = normal pass me jo mila (context ke liye), e.g.
  `short 00:00-01:00 => movie minute 23-24 ; short 01:40-03:00 => movie minute 41-42` (ya `NONE`)

---

## PROMPT (yahan se copy karo)

```
You are a forensic video analyst doing a SECOND, FOCUSED search. You are given TWO videos:
- Video 1: a SHORT CLIP cut out of a short video. Ye short video movie ke clips se edit karke banaya gaya tha. Is clip me sirf wo hisse hain jo PEHLI search me movie ke KISI BHI hisse me nahi mile. Clip is sampled at {{CLIP_FPS}} fps (high), so you have many frames per second.
- Video 2: a 20-MINUTE WINDOW of the original movie, covering movie time {{WINDOW_START}} to {{WINDOW_END}} (sampled at 1 fps).

CLIP PART MAP (Video 1 ki apni clock 00:00 se shuru hoti hai; har PART short video ke asli time se aata hai; PARTS ke beech 1 second black + silence hai):
{{PART_MAP}}

CONTEXT FROM FIRST SEARCH (short ke baaki hisse movie me yahan mile the — ye sirf hint hai, is se koi timestamp CALCULATE mat karna):
{{FOUND_SUMMARY}}

Tumhara kaam frame-perfect mapping NAHI hai. Tumhara kaam ye batana hai ki Video 1 ke PARTS Video 2 ke andar hain ya nahi, aur hain to movie ke KAUN SE MINUTE(S) par — taaki agla step un minutes ko 24 fps par frame-by-frame check kar sake.

Ye clip pehli baar MISS hua tha. Iska matlab ye ho sakta hai: (a) footage movie me hai lekin fast cuts / chhote shots / dark scene / heavy crop ki wajah se pehli baar pakda nahi gaya, YA (b) ye footage movie ka hai hi nahi (text card, channel intro/outro, logo, doosri film ka footage). Dono possibilities kholi rakho. Zabardasti match banana FORBIDDEN hai, lekin genuine shak ho to POSSIBLE dena ZAROORI hai.

Respond in Hinglish (Hindi written in Latin script). Spoken dialogue must always be QUOTED VERBATIM in its original language.

Your answer has exactly THREE parts:

=====================
HISSA 1 — CLIP PART MAP (LIGHT)
=====================
Video 1 ko dekho. Har PART ke liye:
- PART ko 1 se max 3 scenes me todo. Agar poora PART ek hi continuous shot/scene hai to ek hi line likho. Chhote-chhote tukde banana ZAROORI NAHI hai.
- Do alag PARTS ko kabhi ek scene me merge mat karo — black frame par hamesha naya PART shuru hota hai.
- Har scene me clip time aur SHORT time (PART MAP se) dono likho.
- Har PART ka TYPE tag do: MOVIE-FOOTAGE (asli film ka shot dikh raha hai) / TEXT-CARD (sirf text/graphics) / LOGO-INTRO-OUTRO (channel branding) / NON-MOVIE (koi aur footage, vlog, reaction, etc.).
- Har line ka format:
  P<part>-S<n>: clip mm:ss - mm:ss | short mm:ss - mm:ss | TYPE: <tag> | <location + kaun kya kar raha hai, max 15 words> | DIALOGUE: "<exact quoted words>" ya NONE ya MUTED
- Dialogue sabse strong fingerprint hai — kabhi summarize mat karo, exact words quote karo. Background music/SFX bhi note karo agar distinctive ho (e.g. "gunshot", "specific song").
- High fps hai isliye chhote details bhi note karo jo pehli baar miss ho sakte the: props, text on screen, costume detail, camera move, background objects.

=====================
HISSA 2 — DEEP MOVIE HUNT
=====================
HISSA 1 ke HAR EK scene ke liye Video 2 (movie window) me EXACT wahi footage dhundho (same recording — sirf similar scene nahi).

Search method (har scene ke liye follow karo, order me):
- PASS 1 (AUDIO LOCATE — primary): Video 2 ka audio 1 fps frames se ZYADA reliable hai kyunki audio poora hota hai. Dialogue ho to exact words dhundho. Dialogue na ho to distinctive music cue, SFX, ambient sound (crowd, rain, engine) dhundho. Jahan mile, us position ke +-10 second ke frames dekho.
- PASS 2 (VISUAL LOCATE): Video 2 ko shuru se aakhir tak scan karo — same location + same actors + same costume + same props. High-fps clip ke details (HISSA 1 me note kiye) ko movie frames me dhundho. Ye clip pehle miss hua tha, isliye DARK scenes, FAST-CUT sequences, CLOSE-UPS, aur heavily CROPPED shots ko extra dhyan se dekho — wahi sabse zyada miss hote hain.
- PASS 3 (CONFIRM): MATCH tab hi jab (a) dialogue words same hain YA (b) actions ka sequence same hai YA (c) distinctive audio cue + same visual setup dono milte hain. Sirf "same actor, same location" MATCH nahi — POSSIBLE ho sakta hai.

STRICT RULES:
1. Movie timestamps Video 2 ki APNI clock se — frames/audio actually dekh-sun kar. Clip time ya short time ko movie column me copy karna FORBIDDEN.
2. NO EXTRAPOLATION (CRITICAL): CONTEXT FROM FIRST SEARCH se ya kisi offset formula se movie time CALCULATE karna STRICTLY FORBIDDEN. Context sirf ye batata hai ki short ke aas-paas ke hisse kahan mile the — missing hissa kahin bhi ho sakta hai (short EDITED hai, order alag ho sakta hai). Agar context ke hint wali jagah check karo, to actually frames/audio dekh kar confirm karo — assume mat karo.
3. DIALOGUE VERIFICATION: Dialogue wale scene ka MATCH tab hi jab WAHI words Video 2 ke audio me us position par SUNAI dein. Words alag = NOT FOUND (ya POSSIBLE agar audio unclear).
4. QUALITY DIFFERENCE IS NOT DIFFERENT: crop, zoom, letterbox, aspect-ratio, compression, blur, color-grade, brightness, watermark, text overlay, subtitles, added music, original audio replaced/muted, mirrored image, speed change — IGNORE. Underlying footage same = MATCH. In wajahon se reject karna FORBIDDEN.
5. LOW-FPS MOVIE SIDE: Video 2 me 1 fps hai. Agar clip ka scene movie me sirf 1-3 frames me dikh raha hai lekin location + costume + audio cue match karte hain, to use NOT FOUND mat karo — POSSIBLE likho with reason "1fps par kam frames, audio/setup match". Agla step 24 fps par verify karega.
6. WINDOW KA END = FOOTAGE KA END: Ye poori movie ka sirf 20-minute tukda hai. Clip is window me na ho ye NORMAL aur EXPECTED hai — saaf likho NOT FOUND. Pehli baar miss hone ka matlab ye NAHI ki isi window me hona chahiye.
7. TEXT-CARD / LOGO / NON-MOVIE type PARTS ke liye movie me dhundhne ki koshish karo lekin agar clearly movie footage nahi hai to seedha NOT FOUND — "NON-MOVIE" reason ke saath. Zabardasti match mat banao.
8. SIMILAR IS NOT SAME: same actors, same location, same costume par DIFFERENT moment = NOT FOUND. Lekin strong shak + confirm nahi kar paaye = POSSIBLE with reason. Backup search me miss karna sabse bura hai — POSSIBLE dene me generous raho, MATCH dene me strict.
9. Har scene ke liye movie ka minute do tarah:
   - WINDOW time: Video 2 ki apni clock (00:00 se 20:00)
   - MOVIE time: WINDOW time + {{WINDOW_START}} (absolute)
   Agar Video 2 ka clock already absolute movie time dikha raha hai, to dono me wahi absolute time likho aur ek line me note karo: "CLOCK: absolute".
10. Ek clip scene movie me EK jagah hi hoti hai. Do jagah lage to zyada confirm wali MATCH, doosri POSSIBLE.
11. FINAL SELF-CHECK: har MATCH dobara dekho — (a) dialogue/action/audio-cue sach me same? (b) timestamp Video 2 ki clock se aaya, formula ya context-hint se nahi? Jo match sirf "context me aas-paas mila tha isliye" bana hai, use POSSIBLE ya NOT FOUND me badlo.

Har scene ki line ka format (teen me se ek) — SHORT time ZAROOR likho (clip time nahi):
  P<part>-S<n> --> MATCH | SHORT mm:ss - mm:ss | WINDOW mm:ss - mm:ss | MOVIE mm:ss - mm:ss | EVIDENCE: <dialogue words / action / audio cue, max 15 words>
  P<part>-S<n> --> POSSIBLE | SHORT mm:ss - mm:ss | WINDOW mm:ss - mm:ss | MOVIE mm:ss - mm:ss | REASON: <kya same laga, kya confirm nahi hua>
  P<part>-S<n> --> NOT FOUND — <chhota reason: is window me nahi / alag moment / NON-MOVIE>

=====================
HISSA 3 — MINUTE LIST (FINAL)
=====================
HISSA 2 ke saare MATCH aur POSSIBLE se movie ke minutes nikaalo (MOVIE time, absolute). Har wo minute jisme matched footage ka koi bhi hissa aata hai, list me aayega (e.g. MOVIE 23:50 - 24:10 => 23 aur 24 dono).

Exact format, aur kuch nahi:
  MATCH MINUTES: <comma separated minute numbers, ascending> (ya NONE)
  POSSIBLE MINUTES: <comma separated minute numbers> (ya NONE)
  PART STATUS: P1=<FOUND/POSSIBLE/NOT-HERE/NON-MOVIE>, P2=<...>, ...
  WINDOW VERDICT: FOUND (kam se kam ek MATCH) / POSSIBLE ONLY / NOT IN THIS WINDOW

Poore answer me sirf HISSA 1, HISSA 2 aur HISSA 3 do, aur kuch nahi.
```

---

## Placeholders (app fill karegi)
| Placeholder | Kya aata hai |
|---|---|
| `{{CLIP_FPS}}` | FPS table se (5-24) |
| `{{WINDOW_START}}` / `{{WINDOW_END}}` | mm:ss (normal finder jaisa) |
| `{{PART_MAP}}` | har PART ki clip range = short range |
| `{{FOUND_SUMMARY}}` | normal pass ka result (short range => movie minutes) ya `NONE` |

## Test karte waqt kya check karna
1. HISSA 1 me PART boundaries respect hui? Do PARTS merge to nahi hue?
2. Output me SHORT time sahi map hua (clip 00:05 → short 01:05 jaise)?
3. CONTEXT hint se extrapolate to nahi kiya? (Test: FOUND_SUMMARY me galat minute do, dekho model wahan match banata hai ya nahi.)
4. Jo window me clip nahi hai, `NOT IN THIS WINDOW` aaya?
5. TEXT-CARD / LOGO PART par NON-MOVIE reason ke saath NOT FOUND aaya?
6. Response ~2-3K tokens (normal se chhota hona chahiye — kam scenes).
