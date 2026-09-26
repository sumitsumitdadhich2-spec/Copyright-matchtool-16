# HANDOFF PROMPT — "Gemini Minute Finder" (TwelveLabs/Pegasus ka alternative)

> Status: DRAFT — user approval ke baad hi implement karna hai.

---

Mere project "Copyright Match Tool" (Next.js 16, Gemini video analysis, `@google/genai`) me ye kaam karo.

## 0. SABSE PEHLE — STRICT RULES (inko kabhi mat todo)

1. **Chunk-time scan me ZERO badlaav.** `lib/scheduler.ts` ka chunk-map / verify / rescan / candidate / render flow, prompts (`lib/gemini.ts` ke `CHUNK_MAP_PROMPT`, `VERIFY_PROMPT`, rescan prompt), `lib/models.ts` ke pools, 24fps, 60s chunks, pacing, quality-retry — **sab bilkul waisa hi rahega**. Naya kaam sirf "minute dhundne" wale step ko replace karta hai.
2. **TwelveLabs / Pegasus code DELETE nahi karna.** `lib/twelvelabs.ts`, `lib/pegasus.ts`, `lib/merge-pipeline.ts`, `components/cmt/twelvelabs-panel.tsx`, `minute-approval.tsx`, `app/api/scans/[id]/twelvelabs/*`, `merge-pipeline/*` — sab file waise hi rahengi. Sirf ek **toggle** ke peeche chali jayengi (default: OFF).
3. Minute finder me **sirf do model**: `gemini-3.6-flash` aur `gemini-3.7-flash`. Koi aur model BANNED.
4. Short video **hamesha 5 fps** par jayega. Movie window par **fps set NAHI** hoga (default 1 fps).
5. Movie window **fixed 20 minute** (0–20m, 20–40m, 40–60m, ...). Aakhri window chhota ho sakta hai.
6. Har request ka pattern chunk-time request jaisa hi: `[short video, movie window, prompt]` — prompt bhi chunk-map prompt jaisa hi (neeche diya hai), sirf "1-minute chunk" ki jagah "20-minute window" aur 24fps ki jagah 5fps/1fps wording.

---

## 1. TOGGLE (UI + settings)

- `data/settings.json` / user settings me naya field: `minuteFinder: 'gemini' | 'twelvelabs' | 'off'`. **Default = `'gemini'`.**
- UI: **Auto Pipeline panel** (abhi `twelvelabs-panel.tsx` jahan dikhta hai) ke header me ek segmented control:
  `Minute finder:  [ Gemini ]  [ TwelveLabs ]  [ Off ]`
  - `Gemini` → naya Gemini Minute Finder chalega (is doc ka kaam).
  - `TwelveLabs` → purana merge → Marengo → Pegasus → approval flow chalega (jaisa abhi hai, zero change).
  - `Off` → koi minute finder nahi; user manual **Start** dabayega → normal FULL scan (jaisa `prefilter` mode `'full'` me hota hai).
- Toggle save hone par `PUT /api/settings` se persist ho. Running pipeline ke beech toggle badalne par current run par asar na ho; agla upload/trim se naya mode lage.
- Jahan-jahan abhi `startMergePipeline(id, tlKey)` call hota hai (`app/api/scans/[id]/upload/route.ts`, `trim/route.ts`, `merge-pipeline/route.ts`) — wahan mode check:
  - `'gemini'` → `startGeminiMinuteFinder(id, userApiKeys)`
  - `'twelvelabs'` → purana `startMergePipeline(id, tlKey)` (TL key na ho to purana behaviour)
  - `'off'` → kuch nahi.

---

## 2. NAYA MODULE — `lib/gemini-minute-finder.ts`

### 2.1 Trigger / gate
Wahi condition jo `pipelineReady()` me hai: short + movie dono ready, `awaitingTrim === false` (trim confirm ho chuka). Trim range = `movieTrimStart`–`movieTrimEnd` (absent to poori movie). Minute finder **sirf trim range** par chalega.

### 2.2 Pre-checks (fail = status `error`, message log, aur normal manual Start/Full scan available rahe)
- **Short > 180 s (3 min)** → `error`: "Short video 3 minute se lamba hai — Gemini Minute Finder sirf ≤3 min short par chalta hai. Manual Full scan use karo." (koi split / koi auto fallback nahi — user ka decision).
- Gemini API key ek bhi nahi → `error`.

### 2.3 Movie file tayaar karna (upload copy)
Gemini Files API limit: ek file **max 2 GB**, project total 20 GB, file 48 ghante rehti hai.
- `data/scans/<id>/media/movie.mp4` (ya jo bhi source hai) se ek **upload-copy** banao `media/prescan-movie.mp4`:
  - Trim range par cut (`-ss trimStart -to trimEnd`).
  - Agar cut ke baad size ≤ 1.9 GB hoga → **stream copy** (`-c copy`), fast.
  - Warna **ffmpeg re-encode** compressed copy: `-vf scale=-2:480 -r 24 -c:v libx264 -preset veryfast -crf 30 -c:a aac -b:a 64k` (target < 1.9 GB; agar phir bhi bada ho to crf badhao / 360p). Audio rakhna hai (dialogue fingerprint).
  - Ye copy **sirf Gemini upload** ke liye hai — original movie, chunks, render par koi asar nahi.
- Short: `media/short.mp4` waise hi upload hoga (fps sirf request me `videoMetadata.fps = 5` se set hoga, re-encode ki zarurat nahi).

### 2.4 Upload (per API key)
Gemini Files API me file **har API key ke liye alag** upload hoti hai (files project-scoped hain) — jaise abhi `uploadFile()` `lib/gemini.ts` me per-key karta hai. To:
- Har active key ke liye short + prescan-movie dono upload karo (parallel, `ai.files.upload` + `ACTIVE` state tak poll).
- URIs scan JSON me cache karo: `prescan.uploads[keyId] = { shortUri, movieUri, uploadedAt }`. 48 h ke andar Retry/Resume par re-upload skip.

### 2.5 Windows banana
```
windowLen = 1200 s (20 min)
for (t = 0; t < movieCopyDuration; t += 1200):
  window = { index, startOffset: t, endOffset: min(t+1200, movieCopyDuration), status: 'pending' }
```
(`movieCopyDuration` = trim range ki duration; absolute movie time = `trimStart + t`.)

### 2.6 Request (ek window = ek request)
```ts
contents: [{
  role: 'user',
  parts: [
    { fileData: { fileUri: shortUri, mimeType: 'video/mp4' }, videoMetadata: { fps: 5 } },
    { fileData: { fileUri: movieUri, mimeType: 'video/mp4' },
      videoMetadata: { startOffset: `${w.startOffset}s`, endOffset: `${w.endOffset}s` } },   // NO fps
    { text: MINUTE_FINDER_PROMPT(w) },
  ],
}]
config: GEN_CONFIG (thinking HIGH, maxOutputTokens 65536 — same as chunk scan)
```
Token estimate: short 3 min @5fps ≈ 60–70K + movie 20 min @1fps + audio ≈ 110–130K + prompt/output ≈ 30–50K → **≤ 250K TPM**. `usageMetadata.totalTokenCount` har response se log karo (real numbers dekhne ke liye).

### 2.7 Parallel lanes + quota
- Lanes = **har API key × {gemini-3.6-flash, gemini-3.7-flash}** (chunk scan jaisa hi). Shared window queue; har lane ek window uthata hai, complete hone par agla.
- Har lane par **1 request / minute** spacing (TPM 250K). 429 par `RATE_COOLDOWN_MS` cooldown, window wapas queue me.
- **RPD note:** ye dono model chunk scan wale hi hain (20 RPD / model / key). Minute finder ke requests wahi daily counter use karenge (`data/usage` jo bhi existing hai) — taaki chunk phase ko exact bacha hua quota dikhe. 2 h movie = 6 windows; 5 keys × 2 models = 10 lanes → sab windows ek round me (~1–2 min), phir chunk scan.
- Window fail (non-429 error / parse fail) → 1 retry alag lane par; phir bhi fail → window `failed`, aage badho (minute list baaki windows se banegi; fail windows log me dikhao).

### 2.8 Result parse → minute list
- Response ka HISSA 2 regex se parse (wahi regex jo chunk-map me hai): `Short (\d+:\d+\.\d+) - (\d+:\d+\.\d+) --> Movie (\d+:\d+\.\d+) - (\d+:\d+\.\d+)`; `NOT FOUND` lines skip.
- **Movie timestamp reference:** Pehle **ek test request** chala kar confirm karo ki `startOffset` wale window par Gemini timestamps **window-relative** (00:00 se) deta hai ya **file-absolute**. Code me ek flag `WINDOW_TIMESTAMPS_RELATIVE` rakho aur usi hisaab se convert:
  `absMovieSec = trimStart + (relative ? w.startOffset + t : t)`
- Har matched line se movie minute nikalo: `minute = floor(absMovieSec / 60)` (start aur end dono cover karo — agar match minute boundary cross kare to dono minutes add).
- `MinuteSuggestion[]` banao (existing type reuse): `{ minute, sceneCount, confidences: [], shortWindows: [{start, end}] }` — `shortWindows` = us line ka short range (absolute short seconds).
- Raw output har window ka save karo: `prescan.windows[i].raw` (debug / UI).
- Poori window NOT FOUND → bilkul theek, `matches: 0`.

### 2.9 AUTO-START chunk scan (koi approval UI nahi)
- Sab windows done → agar `minuteSuggestions.length === 0` → status `error`: "Gemini Minute Finder ko koi match nahi mila — manual Full scan use karo." (auto full scan **nahi**).
- Warna: `app/api/scans/[id]/merge-pipeline/approve/route.ts` ka **per-short-minute → movieRange** logic ek shared function me nikalo (`applyApprovedMinutes(scan, minutes, suggestions)`) — purana approve route bhi usi ko call kare (behaviour same). Minute finder **sab suggested minutes** ke saath usko call karega, phir `scheduler.start(id, false, userApiKeys, tlApiKey)` — exactly jaise approve route karta hai (token deduct/refund bhi same).
- Iske baad chunk-time scan **100% jaisa abhi** chalta hai (per-minute `movieRangeStart/End` se chunks select, 24fps, verify, rescan...).

### 2.10 State (scan JSON)
```ts
interface GeminiPrescanState {
  status: 'idle' | 'preparing' | 'uploading' | 'scanning' | 'starting_scan' | 'done' | 'error'
  progress?: string
  windowLen: 1200
  movieCopy?: { path: string; durationSec: number; sizeBytes: number; reencoded: boolean }
  uploads: Record<string /*keyId*/, { shortUri: string; movieUri: string; uploadedAt: number }>
  windows: { index: number; startOffset: number; endOffset: number; status: 'pending'|'running'|'done'|'failed'; lane?: string; tokens?: number; matches?: number; raw?: string; error?: string }[]
  minuteSuggestions?: MinuteSuggestion[]
  error?: string | null
  startedAt?: number | null
  finishedAt?: number | null
}
// Scan me: geminiPrescan?: GeminiPrescanState
```
Resume-safe: server restart par `done` windows dobara nahi chalte, uploads 48 h tak reuse.

---

## 3. PROMPT — `MINUTE_FINDER_PROMPT` (chunk-map prompt ka window version)

Chunk-map prompt ki structure/rules **same** rakho; sirf ye badlo:
- "Video 2: a ONE-MINUTE CHUNK" → "Video 2: a TWENTY-MINUTE WINDOW of the original movie (from {startOffset} to {endOffset} of the movie)".
- "Both videos are exactly 24 fps..." → "Video 1 is sampled at 5 fps, Video 2 at 1 fps. Timestamps are in seconds/milliseconds — do NOT report frame numbers."
- HISSA 1 segments 1 s ke bajay **2–5 second** ke ho sakte hain (5 fps hai, coarse mapping chahiye — exact frame nahi, sirf **kaunsa minute**).
- HISSA 2 me 1:1 same-duration rule rahe, lekin tolerance ±1 s. "NOT FOUND" rule utna hi strict (SIMILAR IS NOT SAME). Poora window NOT FOUND aana normal hai.
- Movie timestamps ke liye line: "Report Video 2 timestamps as shown on Video 2's own clock (mm:ss.mmm)." (test se pata chalega relative/absolute — Sec 2.8).
- Output format lines **same**:
  `Short mm:ss.mmm - mm:ss.mmm --> Movie mm:ss.mmm - mm:ss.mmm`
  `Short mm:ss.mmm - mm:ss.mmm --> NOT FOUND — <reason>`

(Final prompt text implement karte waqt `lib/gemini.ts` me `CHUNK_MAP_PROMPT` ke bagal me `MINUTE_FINDER_PROMPT` const ke roop me rakho — chunk-map prompt ko touch mat karo.)

---

## 4. UI — Auto Pipeline panel (Gemini mode)

Existing panel ka look/feel reuse karo (steps strip, live progress, logs). Gemini mode me steps:
`Prepare movie copy → Upload (keys x/y) → Scan windows (done/total, live lanes) → Minutes found → Chunk scan started`
- Window grid: har window `00:00–20:00`, status chip, matches count, tokens, model+key lane; click → raw output collapsible.
- **Minutes found** (read-only list, chips): "Movie minute 31, 32, 47 (3 windows me se 2 me match)". Approval button **nahi** — auto-start.
- Buttons: `Retry failed windows`, `Re-run minute finder` (uploads reuse), `Stop`. Error state me manual **Start (Full scan)** waise hi available.
- Purana TwelveLabs panel `minuteFinder === 'twelvelabs'` par hi render ho.
- Reports (`report-panel.tsx`, `ScanReport.prefilterMode`) me naya value `'gemini'` add: "Chunk set: Gemini Minute Finder (N minutes)".

---

## 5. FILES (expected touch list)

- **NEW** `lib/gemini-minute-finder.ts` (module), `app/api/scans/[id]/minute-finder/route.ts` (POST start/retry, DELETE stop), `components/cmt/minute-finder-panel.tsx`, `components/cmt/minute-finder-toggle.tsx`
- **EDIT** `lib/types.ts` (state + `minuteFinder` setting + `prefilterMode: 'gemini'`), `lib/gemini.ts` (`MINUTE_FINDER_PROMPT` + `runMinuteFinderWindow()` — existing functions untouched), `lib/ffmpeg.ts` (prescan copy helper), `app/api/settings/route.ts`, upload/trim/merge-pipeline routes (mode switch), `approve/route.ts` (shared `applyApprovedMinutes` extract, behaviour same), dashboard/panel wiring, report panel.
- **NO CHANGE** `lib/scheduler.ts` chunk/verify/rescan logic, `lib/models.ts` pools, chunk-map/verify/rescan prompts, `lib/twelvelabs.ts`, `lib/pegasus.ts`, `lib/merge-pipeline.ts` (sirf call site gated).

---

## 6. DOUBTS — approve karne se pehle confirm karo

1. **RPD share:** 3.6/3.7 flash ke 20 RPD/key/model chunk scan ke saath share honge. 2 h movie = 6 requests minute-finder me jayenge. Theek hai? (alternative: minute finder ke liye alag daily budget cap, e.g. max 8 windows/key/din).
2. **TPM safety:** agar kisi window par real tokens > 250K aaye (429 TPM), to kya us window ko **automatically 10-min do halves** me tod kar dobara bhejein, ya sirf fail mark karke aage badhein? (Recommend: auto-split ek baar.)
3. **Minute boundary ±1:** Pegasus flow me chunk selection ke liye ±1 buffer minute nahi tha (approve route min..max range). Gemini 1 fps par timestamp ±2–3 s off ho sakta hai — kya **±1 minute buffer** add karein (e.g. match 30:58 → minutes 30 aur 31 dono)? (Recommend: haan.)
4. **Default mode `gemini`** rakhna theek hai, ya `off` default aur user manually Gemini choose kare?
5. Test request (Sec 2.8 relative/absolute timestamp check) me 1 window ka quota lagega — chalega?
