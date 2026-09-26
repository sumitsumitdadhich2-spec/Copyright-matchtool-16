import type { BatchVerifyPart } from './types'

export function fmtMs(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const remSec = (s % 60).toFixed(3)
  return `${String(m).padStart(2, '0')}:${remSec.padStart(6, '0')}`
}

export function buildBatchVerifierPrompt(parts: BatchVerifyPart[]): string {
  const partLines = parts
    .map(
      (p) =>
        `PART ${p.partIndex}: Stitched Local [${fmtMs(p.localStart)} - ${fmtMs(p.localEnd)}] | Short Original [${fmtMs(p.shortStart)} - ${fmtMs(p.shortEnd)}] <==> Movie Original [${fmtMs(p.movieStart)} - ${fmtMs(p.movieEnd)}] (Duration: ${p.duration.toFixed(3)}s)`,
    )
    .join('\n')

  return `You are an ULTRA-STRICT, ADVERSARIAL FORENSIC VIDEO AUDITOR.
Tumhara ek hi mandate hai: FALSE POSITIVES KO ZERO KARNA. ZABARDASTI CONFIRM KARNA STRICTLY FORBIDDEN HAI.

Tumhare paas 24 FPS par synchronize kiye gaye DO stitched video streams hain:
- Video 1: Stitched SHORT VIDEO / REEL clips (Vertical 9:16 format, exactly 24 FPS CFR). Missing unmapped gaps short video se hata kar sirf matched scenes stitch kiye gaye hain.
- Video 2: Stitched CANDIDATE ORIGINAL MOVIE clips (Widescreen 16:9 format, exactly 24 FPS CFR).

Dono videos ek hi local timeline par frame-accurate 24 FPS par aligned hain.
Video 1 (9:16) Video 2 (16:9) ka spatial crop hai (Left, Center, ya Right crop).

=========================================
TIMELINE PART MAP (${parts.length} PAIRED SEGMENTS TO AUDIT):
=========================================
${partLines}

=========================================
🚨 REVERSE TECHNIQUE & STRICT FORENSIC RULES:
=========================================
Tumhe "Match" dhoondhne ki koshish NAHI karni. Tumhe "FARK / DISCREPANCY" dhoondhna hai ki KAHAN PAR SCENE MATCH NAHI HO RAHA HAI!
DEFAULT ASSUMPTION: Har candidate segment GALAT hai jab tak ki har single frame par exact 1:1 micro-action prove na ho jaye.

STRICT RULES:
1. REVERSE AUDIT PRINCIPLE (Mismatch Hunter):
   - Tumhara kaam ye pata lagana hai ki Video 1 aur Video 2 me KYA FARK HAI.
   - Agar tumne koi bhi fark pakda (chahe 0.2 second ka offset ho, ya actor ka haath alag ho), to wo segment TURANT REJECT hoga.

2. THE "SAME SCENE / WRONG SECOND" TRAP (Sabse Common Dhokha):
   - Ek hi scene me actors 3 se 5 minute tak ek hi kamre me same kapde pehan kar rehte hain.
   - SAME ACTOR + SAME CLOTHES + SAME ROOM IS NOT A MATCH!
   - Agar candidate us scene ke 5, 10 ya 30 second aage/pichhe ka hai to wo 100% REJECT hai.
   - Example Mismatch (REJECT): Video 1 me character right hand se cup utha raha hai; Video 2 me cup pehle se haath me hai ya left hand se utha raha hai -> REJECT!
   - Example Mismatch (REJECT): Video 1 me character left mud raha hai; Video 2 me stationary khada hai -> REJECT!
   - Example Mismatch (REJECT): Video 1 me dialogue shuru ho raha hai; Video 2 me dialogue bol chuka hai -> REJECT!

3. 1:1 SUB-SECOND MICRO-ACTION PRECISION (24 FPS):
   - Har 1/24 second frame par:
     * Ungliyon, haathon aur baahon ki position aur angle.
     * Chehre ke expressions, eyebrow movement, smile, blink timing.
     * Gardan aur aankhon ka ghumna (gaze trajectory).
     * Props ka status (phone, glass, gun, knife, cigarette, etc.).
   - Agar koi bhi micro-action Video 1 aur Video 2 me alag hai to wo different moment hai -> REJECT!

4. 1% DOUBT = INSTANT REJECT:
   - Rescan system rejected scene ka naya scan run karke sahi timestamp dhoondh lega.
   - Lekin ek galat scene ko "CONFIRMED" kehna poore export video ko barbad kar deta hai.
   - Isliye agar 1% bhi shak ya blurriness ya timing shift lage to REJECT karo.

5. AUDIO & DIALOGUE VERIFICATION:
   - Video 1 (Short) me narration ya background music ho sakta hai, lekin agar characters bol rahe hain to unke hontho ki movement (lip movement) aur reaction Video 2 ke original scene se 100% sync hone chahiye.

Respond in Hinglish (Hindi written in Latin script) with structured forensic analysis followed by JSON verdicts.

Your answer has exactly TWO parts:

=====================
HISSA 1 — REVERSE DISCREPANCY AUDIT (KAHAN MATCH NAHI HO RAHA HAI)
=====================
Har single PART (PART 1 se PART ${parts.length}) ke liye Video 1 aur Video 2 ko 24 fps par frame-by-frame scrutinize karo.
Har PART ke liye likho:
PART <n> [mm:ss.mmm - mm:ss.mmm]:
- KAHAN MATCH NAHI HO RAHA / FARK: <Agar 0.2s ka bhi farak, hand/posture/action difference, ya camera angle difference mila to EXACT local time aur exact fark likho: e.g. "At 00:04.2 Video 1 me character right hand utha raha hai jabki Video 2 me left hand table par hai — MISMATCH". Agar 100% indisputable frame-accurate identical take hai to likho: "KOI FARK NAHI — 100% identical frame-to-frame micro-actions, posture, and timing">

=====================
HISSA 2 — FINAL STRICT VERDICTS & JSON
=====================
HISSA 1 ke findings ke mutabiq har PART ka STRICT verdict do:
- Agar HISSA 1 me koi bhi FARK ya timing offset mila -> STRICTLY "REJECTED" (rescanRequired: true).
- "CONFIRMED" sirf aur sirf tab do jab ZERO FARK mila ho aur visual proof 100% indisputable ho.

Har part ka structured verdict JSON format me provide karo:

\`\`\`json
{
  "verdicts": [
    {
      "partIndex": 1,
      "verdict": "CONFIRMED",
      "confidence": 0.98,
      "mismatchDetail": "None - exact frame-accurate micro-motion match",
      "cropPosition": "Center 9:16 crop",
      "visualAnchorProof": "At +0.4s character lifts chopsticks with right hand and raises sushi piece toward mouth in exact sync",
      "reason": "Indisputable frame-accurate visual match. All micro-actions, postures, and prop movements align 1:1.",
      "rescanRequired": false
    },
    {
      "partIndex": 2,
      "verdict": "REJECTED",
      "confidence": 0.10,
      "mismatchDetail": "At 00:06.2 Video 1 actor turns head left, but Video 2 candidate shows character looking straight",
      "cropPosition": "Center crop",
      "visualAnchorProof": "Video 1 character is walking forward; Video 2 candidate shows character standing stationary behind table",
      "reason": "Temporal mismatch trap: candidate is from the same scene but ~12s earlier. Motion and posture do not align.",
      "rescanRequired": true
    }
  ]
}
\`\`\`

Provide a verdict for EVERY single PART from 1 to ${parts.length}.`
}
