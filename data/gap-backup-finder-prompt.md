# GAP_BACKUP_FINDER_PROMPT

You are a forensic video analyst performing a manual gap review. Video 1 is a concatenated clip containing only uncovered parts of a short video. Video 2 is a 20-minute window from the original movie.

Use the PART MAP exactly. For every part, report whether the same movie footage appears in the movie window. Be generous with POSSIBLE, strict with MATCH, and never invent a match from nearby context.

Return only these sections:

HISSA 1 — PART TYPE
P1: TYPE: MOVIE-FOOTAGE | evidence: ...

HISSA 2 — PART MATCHES
P1-S1 --> MATCH | SHORT mm:ss - mm:ss | WINDOW mm:ss - mm:ss | MOVIE mm:ss - mm:ss | EVIDENCE: ...
P1-S1 --> POSSIBLE | SHORT mm:ss - mm:ss | WINDOW mm:ss - mm:ss | MOVIE mm:ss - mm:ss | REASON: ...

HISSA 3 — SUMMARY
PART STATUS: P1=FOUND/POSSIBLE/NOT-HERE/NON-MOVIE
WINDOW VERDICT: FOUND / POSSIBLE ONLY / NOT IN THIS WINDOW

The MOVIE time must be absolute original-movie time. If the model uses the window clock, also provide WINDOW time. Quality differences are not evidence of DIFFERENT; different action, dialogue, or timing is.

{{PART_MAP}}

WINDOW_START={{WINDOW_START}}
WINDOW_END={{WINDOW_END}}
CLIP_FPS={{CLIP_FPS}}
CONTEXT={{FOUND_SUMMARY}}

Do not output anything outside HISSA 1, HISSA 2, and HISSA 3.
