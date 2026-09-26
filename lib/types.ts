export type ChunkStatus = 'pending' | 'scanning' | 'no_match' | 'match' | 'failed' | 'cancelled' | 'policy_blocked'

/** PROVENANCE — where a match / candidate group came from:
 *  'chunk'      = normal chunk-mapping pass (short minute vs movie chunk)
 *  'rescan'     = window found by the full-chunk rescan after verify said DIFFERENT
 *  'gap-backup' = post-verification GAP BACKUP pass (never-found short parts re-searched
 *                 in every 20-min movie window at high fps, then chunk-scanned + verified)
 *  'user'       = hand-picked by the user ("Make main") */
export type MatchOrigin = 'chunk' | 'rescan' | 'gap-backup' | 'user'

/** One parsed "Short X --> Movie Y" mapping line from the model's HISSA 2 output. */
export interface ChunkMatch {
  /** unique stable ID for this match */
  id?: string
  /** seconds within the short video */
  shortStart: number
  shortEnd: number
  /** ABSOLUTE seconds within the full movie (chunk offset + local chunk time) */
  movieStart: number
  movieEnd: number
  /** which movie chunk this match was found in */
  chunkIndex: number
  model: string
  /** verifier outcome: true = confirmed SAME at 24fps, false = kept but unverified (API errors) */
  verified?: boolean
  /** the confirmed window came from a rescan, not the original chunk mapping */
  viaRescan?: boolean
  /** USER CHOICE: the user hand-picked this candidate as the main clip for its
   *  short window (overrides the AI confirmed/unverified/rejected verdict) */
  userPick?: boolean
  /** REJECTED — KEPT: the verifier said DIFFERENT for every candidate of this
   *  short window, but the best candidate is kept in the merge anyway ("almost
   *  right" beats a hole in the output). verified is always false here. */
  rejected?: boolean
  /** where this match came from (see MatchOrigin) */
  origin?: MatchOrigin
  /** gap-backup only: 20-min movie window (#index) that found this part */
  originWindow?: number
  /** BATCH MINUTE VERIFIER: result of multi-scene stitched verification at 24 fps */
  batchVerified?: 'confirmed' | 'rejected' | 'pending'
  batchVerdict?: 'CONFIRMED' | 'REJECTED'
  batchReason?: string
  batchModel?: string
  batchTimestamp?: number
  rescanRequired?: boolean
}

/** Full raw model output captured for a chunk request (for the UI expander). */
export interface ChunkRawOutput {
  model: string
  t: number
  text: string
}

export interface ChunkState {
  index: number
  status: ChunkStatus
  model?: string
  attempts: number
  /** legacy UI field — not set by the current pipeline */
  confidence?: number
  /** parsed HISSA 2 matches found inside THIS chunk (absolute movie seconds) */
  matches?: ChunkMatch[]
  /** automatic quality retries used (false-result detector) — max 1 */
  qualityRetries?: number
  /** whether this chunk had an automatic audio-stripped sanitized retry after a policy block */
  policyRetried?: boolean
  /** which API key index processed this chunk */
  keyIdx?: number
  /** total actual API requests made to Gemini for this chunk (including sanitized retries) */
  requestCount?: number
  /** full raw Gemini outputs produced for this chunk, oldest first */
  rawOutputs?: ChunkRawOutput[]
  /** cancelled by the EARLY-STOP system (all matches found + fast-confirmed) —
   *  not revived on Resume unless its minute's matches get rejected */
  skippedEarlyStop?: boolean
}

export type ShortSegmentStatus = 'pending' | 'scanning' | 'verifying' | 'done'

/** One 1-minute segment of the SHORT video. Long shorts are scanned
 *  minute-by-minute: segment N+1 only starts after segment N has been
 *  mapped against EVERY movie chunk AND its matches verified. */
export interface ShortSegmentState {
  /** minute number within the short video (0-based) */
  index: number
  /** ABSOLUTE seconds within the short video */
  start: number
  end: number
  status: ShortSegmentStatus
  /** per-movie-chunk states for THIS short segment (source of truth) */
  chunks: ChunkState[]
  /** user minute selection: false = skipped by the scheduler (default true) */
  selected?: boolean
  /** PER-MINUTE movie search range (ABSOLUTE original-movie seconds).
   *  When set, this minute is scanned ONLY against movie chunks overlapping
   *  this range — all other chunks are skipped (API quota saver).
   *  Unset = search the whole trim window. */
  movieRangeStart?: number
  movieRangeEnd?: number
  /** PER-MINUTE exact movie-minute allow-list (ABSOLUTE original-movie minute
   *  numbers, e.g. [7,8,9,66,67]). When set, this short minute is scanned ONLY
   *  against chunks whose absolute minute is in this list — gaps between
   *  minutes are skipped. Takes priority over movieRangeStart/End. */
  movieMinutes?: number[]
  /** TWELVE LABS PRE-FILTER (optional): chunk indexes selected by embedding
   *  similarity for THIS minute (already includes ±1 buffer chunks).
   *  Unset = no pre-filter — scan every chunk (normal full scan). */
  prefilterChunks?: number[]
  /** TL confidence per selected chunk (chunkIndex -> best cosine similarity).
   *  Drives high→low confidence ordering for chunk scan + verification. */
  chunkConfidence?: Record<string, number>
  /** Expected short-video windows (ABSOLUTE short seconds) from TwelveLabs —
   *  EARLY-STOP: jab har window ka candidate mil jaye AUR har matched chunk ka
   *  1 segment verify ho jaye, to is minute ke bache chunks scan nahi hote. */
  tlWindows?: { start: number; end: number }[]
  /** chunks skipped by the early-stop system in the last run (quota saved) */
  earlyStopSavedChunks?: number
}

// ---------- Render / Export ----------

export type RenderResolution = '480p' | '720p' | '1080p' | '2k' | '4k'

export const RENDER_FPS_OPTIONS = [24, 30, 40, 50, 60] as const
export type RenderFps = (typeof RENDER_FPS_OPTIONS)[number]

export function isRenderFps(value: unknown): value is RenderFps {
  return typeof value === 'number' && (RENDER_FPS_OPTIONS as readonly number[]).includes(value)
}

export interface RenderSettings {
  resolution: RenderResolution
  /** supported output frame rate; kept fixed so scene and concat frame grids match */
  fps: RenderFps
  /** video bitrate in kbps */
  videoBitrateKbps: number
  /** audio bitrate in kbps */
  audioBitrateKbps: number
  /** optional head/start padding in seconds (expands movie clip earlier) */
  headPaddingSec?: number
  /** optional tail/end padding in seconds (expands movie clip later) */
  tailPaddingSec?: number
}

export type RenderStatus = 'idle' | 'rendering' | 'done' | 'error'

export interface RenderJob {
  status: RenderStatus
  settings: RenderSettings | null
  /** 0-100 */
  pct: number
  /** estimated seconds remaining (from ffmpeg speed=) */
  etaSeconds: number | null
  /** total duration of the stitched output in seconds */
  totalOutputSeconds: number
  /** number of scene segments being stitched */
  segmentCount: number
  error: string | null
  startedAt: number | null
  finishedAt: number | null
  /** final rendered file size in bytes */
  fileSize: number | null
  /** short coverage of the scenes actually being rendered (+ MISSING list) */
  coverage?: ShortCoverage
  /** short duration the output is compared against */
  shortSeconds?: number
}

export interface LogEntry {
  t: number
  level: 'info' | 'warn' | 'error' | 'success'
  msg: string
}

export type ScanStatus =
  | 'created'
  | 'uploading'
  | 'chunking'
  | 'ready'
  | 'scanning'
  /** candidate-verification phase: verifier + rescan requests in flight */
  | 'verifying'
  | 'done'
  | 'stopped'
  | 'error'

// ---------- Missing Scene Window Finder ----------

export interface MissingSceneTarget {
  id: string
  shortStart: number
  shortEnd: number
  duration: number
  clipStart?: number
  clipEnd?: number
}

export interface MissingSceneWindowHit {
  windowIndex: number
  windowStart: number
  windowEnd: number
  movieMinute: number
  sceneId?: string
  shortStart: number
  shortEnd: number
  evidence?: string
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW'
}

export interface MissingSceneCandidate {
  id: string
  sceneId: string
  shortStart: number
  shortEnd: number
  movieMinute: number
  chunkIndex: number
  movieStart: number
  movieEnd: number
  model: string
  confidence?: number
  reason?: string
  verified?: boolean
  verifierModel?: string
  verifierReason?: string
  status: 'pending' | 'scanning_chunk' | 'verifying' | 'confirmed' | 'rejected'
}

export interface MissingSceneScanState {
  status: 'idle' | 'preparing' | 'scanning_windows' | 'scanning_chunks' | 'verifying' | 'done' | 'stopped' | 'error'
  progress?: string
  selectedScenes: MissingSceneTarget[]
  windowHits?: MissingSceneWindowHit[]
  candidates: MissingSceneCandidate[]
  addedMatches?: ChunkMatch[]
  totalWindows?: number
  completedWindows?: number
  activeWindows?: number
  totalChunks?: number
  completedChunks?: number
  activeChunks?: number
  activeWorkers?: Array<{ type: 'window' | 'chunk'; label: string; model: string; keyIdx: number }>
  error?: string | null
  startedAt?: number | null
  finishedAt?: number | null
}

// ---------- Batch Minute Verifier System (All-in-One 24fps) ----------

export interface BatchVerifyPart {
  partIndex: number
  /** Unique stable ID of the ChunkMatch */
  matchId?: string
  /** Chunk index of the matched movie chunk */
  chunkIndex?: number
  /** Index of the corresponding ChunkMatch in scan.matches */
  matchIndex?: number
  /** ABSOLUTE seconds in original short video */
  shortStart: number
  shortEnd: number
  /** ABSOLUTE seconds in original movie video */
  movieStart: number
  movieEnd: number
  /** Offset within the concatenated 24fps verification clip */
  localStart: number
  localEnd: number
  duration: number
  verdict?: 'CONFIRMED' | 'REJECTED' | 'PENDING'
  confidence?: number
  dialogueQuote?: string
  visualAnchorProof?: string
  reason?: string
  rescanRequired?: boolean
}

export interface BatchMinuteResult {
  minuteIndex: number // 0-based: 0 = 0-60s, 1 = 60-120s, etc.
  shortStart: number
  shortEnd: number
  status: 'idle' | 'preparing' | 'verifying' | 'done' | 'error'
  model?: string
  error?: string
  totalScenes: number
  confirmedCount: number
  rejectedCount: number
  parts: BatchVerifyPart[]
  startedAt?: number
  finishedAt?: number
  updatedAt: number
}

export interface BatchVerifyState {
  status: 'idle' | 'running' | 'done' | 'stopped' | 'error'
  progress?: string
  startedAt?: number | null
  finishedAt?: number | null
  activeMinutes?: number[]
  results: Record<number, BatchMinuteResult>
}

// ---------- Candidate + Verifier system ----------

export type CandidateVerdict = 'pending' | 'verifying' | 'same' | 'different' | 'error'
export type RescanState = 'none' | 'pending' | 'rescanning' | 'found' | 'not_found' | 'error'

/** One movie-window candidate for a short segment (one parsed chunk match). */
export interface CandidateEntry {
  /** short video window for this specific candidate (if different from group window) */
  shortStart?: number
  shortEnd?: number
  /** ABSOLUTE movie seconds */
  movieStart: number
  movieEnd: number
  chunkIndex: number
  /** model that produced this candidate during the chunk phase */
  model: string
  confidence?: number
  /** verifier verdict for this exact window */
  verdict: CandidateVerdict
  verifierModel?: string
  verifierReason?: string
  /** rescan of this candidate's full 1-minute chunk (runs only if verify said different) */
  rescan: RescanState
  /** window found by the rescan (ABSOLUTE movie seconds), if any */
  rescanMovieStart?: number
  rescanMovieEnd?: number
  /** verifier verdict for the rescan-found window */
  rescanVerdict?: CandidateVerdict
  rescanReason?: string
}

export type CandidateGroupStatus =
  | 'pending' // waiting for a verifier worker
  | 'verifying' // verifier requests in flight
  | 'rescanning' // all candidates failed verify — rescanning their chunks
  | 'confirmed' // a candidate (or rescan window) was verified SAME
  | 'rejected' // every candidate + every rescan failed — final decision: not a match
  | 'unverified' // could not verify due to repeated API errors — original match kept, flagged

/** All candidates that claim the SAME short-video segment, verified as one unit. */
export interface CandidateGroup {
  id: string
  /** seconds within the short video */
  shortStart: number
  shortEnd: number
  status: CandidateGroupStatus
  candidates: CandidateEntry[]
  /** index into candidates[] of the confirmed window (rescan window if confirmedViaRescan) */
  confirmedIndex: number | null
  confirmedViaRescan: boolean
  attempts: number
  /** where the group's candidates came from ('chunk' when unset — legacy scans) */
  origin?: MatchOrigin
  /** gap-backup only: 20-min movie window (#index) that found this short part */
  originWindow?: number
  /** SUPERSEDED: settled as rejected WITHOUT a verifier call because a confirmed
   *  group already owns this short window. Never kept in the merge (duplicate). */
  superseded?: boolean
  /** USER CHOICE (preview/compare "Make main"): which candidate window the
   *  user wants as the main clip for this short window. Wins over the AI
   *  verdict in scan.matches → preview → export. Unset = AI decision. */
  userPick?: {
    /** index into candidates[] */
    index: number
    /** use the candidate's rescan window instead of its original window */
    viaRescan: boolean
    at: number
  }
}

// ---------- Twelve Labs pre-filter (optional) ----------

export type TwelveLabsIndexStatus = 'none' | 'indexing' | 'ready' | 'error'

/** Movie indexing state on Twelve Labs (Marengo embeddings). Fully optional —
 *  when absent, the app behaves exactly as before (normal full scan). */
export interface TwelveLabsState {
  status: TwelveLabsIndexStatus
  indexId?: string
  taskId?: string
  videoId?: string
  /** number of 6-second segment embeddings saved locally */
  segmentCount?: number
  indexedAt?: number
  /** human-readable indexing progress note */
  progress?: string
  /** indexing start time — UI elapsed/estimate tracking */
  startedAt?: number
  /** total time the whole indexing job took (upload → ready → embeddings), ms */
  totalMs?: number
  error?: string | null
}

/** Result of the pre-filter decision for the LAST scan run. */
export interface PrefilterInfo {
  /** 'prefiltered' = Twelve Labs selected the chunks; 'full' = normal full scan */
  mode: 'prefiltered' | 'full'
  /** chunks sent to Gemini (pending ones) vs total chunk count */
  selectedChunks: number
  totalChunks: number
  /** why the scan fell back to full (only when mode = 'full' and TL was attempted) */
  reason?: string
  at: number
}

// ---------- Auto Merge → Index → Pegasus Segmentation pipeline ----------

export type MergePipelineStatus =
  | 'idle'
  | 'checking' // ffprobe both files → target = movie resolution/fps
  | 'merging' // precise re-encode merge (short + movie normalized, parallel parts, one join)
  | 'uploading' // merged video → TwelveLabs asset
  | 'indexing' // Marengo index via indexed-assets + embeddings download
  | 'splitting' // time-split embeddings at short-end into short/movie sets
  | 'segmenting' // Pegasus 1.5 segmentation (analyze/tasks)
  | 'suggesting' // building the minute list from segment_4
  | 'awaiting_approval' // minute list shown — waiting for the user
  | 'approved' // user approved — Gemini scan kicked off
  | 'error'

/** One suggested movie minute to check (built from Pegasus segment_4). */
export interface MinuteSuggestion {
  /** ORIGINAL-movie minute number (0-based: minute 30 = 30:00–31:00) */
  minute: number
  /** how many segment_4 scenes pointed at this minute */
  sceneCount: number
  /** confidence strings straight from segment_4 metadata */
  confidences: string[]
  /** PART A (short) windows these scenes came from (ABSOLUTE short seconds) */
  shortWindows: { start: number; end: number }[]
}

/** One raw Pegasus segment (for UI/debug display). */
export interface PegasusSegment {
  start: number
  end: number
  metadata: Record<string, unknown>
}

export interface MergePipelineState {
  status: MergePipelineStatus
  /** live human-readable progress note for the current step */
  progress?: string
  /** PART A boundary = short duration in seconds */
  shortEnd?: number
  mergedDuration?: number
  assetId?: string
  segTaskId?: string
  /** merged > 2h — Pegasus segmentation was skipped (index still completed) */
  segmentationSkipped?: boolean
  minuteSuggestions?: MinuteSuggestion[]
  /** raw Pegasus segmentation output per definition id (debug/UI) */
  segments?: Record<string, PegasusSegment[]>
  approvedMinutes?: number[]
  error?: string | null
  startedAt?: number | null
  finishedAt?: number | null
}

// ---------- Gemini Minute Finder (TwelveLabs/Pegasus alternative) ----------

/** Which minute finder runs after upload + trim confirm.
 *  'gemini' (default) = Gemini Minute Finder (20-min windows @ 10fps/1fps),
 *  'twelvelabs' = old merge → Marengo → Pegasus → approval flow (unchanged),
 *  'off' = no finder; user presses Start for a normal full scan. */
export type MinuteFinderMode = 'gemini' | 'twelvelabs' | 'off'

export type GeminiPrescanStatus =
  | 'idle'
  | 'preparing' // ffmpeg upload-copy of the trimmed movie
  | 'uploading' // short + movie copy → Gemini Files API (per key)
  | 'scanning' // 20-minute windows in flight
  | 'backup' // BACKUP pass: missing short parts (high fps clip) re-searched in every window
  | 'starting_scan' // minutes found — kicking off the chunk scan
  | 'done'
  | 'error'

export type GeminiPrescanWindowStatus = 'pending' | 'running' | 'done' | 'failed'

export interface GeminiPrescanWindow {
  index: number
  /** seconds within the MOVIE COPY (trim-relative) */
  startOffset: number
  endOffset: number
  status: GeminiPrescanWindowStatus
  /** "key N · model" lane that produced the result */
  lane?: string
  /** usageMetadata.totalTokenCount of the last response */
  tokens?: number
  /** parsed MATCH + POSSIBLE lines */
  matches?: number
  /** ABSOLUTE original-movie minutes this window contributed */
  minutes?: number[]
  raw?: string
  error?: string
  attempts?: number
  /** Set to true when this window encountered a policy violation and completed its 1 sanitized retry */
  policyRetried?: boolean
}

export interface GeminiUploadProgressInfo {
  bytesUploaded: number
  totalBytes: number
  pct: number
  speedStr: string
  stage: 'uploading' | 'processing' | 'done' | 'idle' | 'error'
  error?: string
}

export interface GeminiPrescanUpload {
  shortUri: string
  shortName: string
  movieUri: string
  movieName: string
  uploadedAt: number
  /** Muted/sanitized short video upload URI used for policy-blocked window retries */
  sanitizedShortUri?: string
  sanitizedShortName?: string
  movieProgress?: GeminiUploadProgressInfo
  shortProgress?: GeminiUploadProgressInfo
}

/** One PART of the backup clip = one missing short range (already padded ±2 s). */
export interface GeminiBackupPart {
  /** 1-based PART number as written in the prompt's PART MAP */
  index: number
  /** seconds within the CONCATENATED backup clip */
  clipStart: number
  clipEnd: number
  /** ABSOLUTE seconds within the short video */
  shortStart: number
  shortEnd: number
  /** model's TYPE tag from HISSA 1 (MOVIE-FOOTAGE / TEXT-CARD / LOGO-INTRO-OUTRO / NON-MOVIE) — best of all windows */
  type?: string
  /** final verdict across every backup window */
  result?: 'found' | 'possible' | 'not_in_movie' | 'non_movie' | 'pending'
}

export type GeminiBackupStatus = 'idle' | 'skipped' | 'preparing' | 'uploading' | 'scanning' | 'done' | 'error'

/**
 * BACKUP MINUTE FINDER (second pass). Short parts that NO normal window matched
 * (neither MATCH nor POSSIBLE) are cut out, concatenated (1 s black + silence
 * between parts) and searched again in EVERY window at a HIGH fps. The movie
 * side is unchanged (same 20-min windows @ 1 fps, same Files API upload).
 */
export interface GeminiBackupState {
  status: GeminiBackupStatus
  progress?: string
  /** why the pass was skipped (short fully covered / gaps all < 4 s) */
  skipReason?: string
  parts: GeminiBackupPart[]
  clip?: {
    path: string
    durationSec: number
    sizeBytes: number
    /** fps = clamp(floor(900 / clipSeconds), 5, 24) */
    fps: number
    /** JSON of the part list the clip was built from — a different gap set invalidates the clip */
    signature: string
  }
  /** keyed by apiKeyHash — clip upload per key */
  uploads: Record<string, { uri: string; name: string; uploadedAt: number; sanitizedUri?: string; sanitizedName?: string }>
  /** same offsets as the normal windows; queue order is smart (found range first) */
  windows: GeminiPrescanWindow[]
  /** FOUND_SUMMARY text given to the model as context */
  foundSummary?: string
  /** ABSOLUTE movie minutes the backup pass ADDED on top of the normal pass */
  addedMinutes?: number[]
  error?: string | null
  startedAt?: number | null
  finishedAt?: number | null
}

export interface GeminiPrescanState {
  status: GeminiPrescanStatus
  progress?: string
  windowLen: number
  /** second pass for the short parts the normal windows missed */
  backup?: GeminiBackupState
  movieCopy?: {
    path: string
    durationSec: number
    sizeBytes: number
    reencoded: boolean
    /** trim range the copy was cut from — a different trim invalidates the copy + movie uploads */
    trimStart: number
    trimEnd: number
  }
  /** keyed by apiKeyHash — Gemini files are project-scoped, so one upload per key */
  uploads: Record<string, GeminiPrescanUpload>
  windows: GeminiPrescanWindow[]
  minuteSuggestions?: MinuteSuggestion[]
  /** minutes handed to the chunk scan (absolute original-movie minutes, 0-based) */
  appliedMinutes?: number[]
  error?: string | null
  startedAt?: number | null
  finishedAt?: number | null
}

// ---------- Short coverage + GAP BACKUP pass (post-verification) ----------

/** A [start, end) range of the SHORT video (absolute seconds). */
export interface ShortRange {
  start: number
  end: number
}

/** How much of the short video the current match set covers (union of every
 *  match's short window — verified, unverified AND rejected-kept). */
export interface ShortCoverage {
  coveredSec: number
  totalSec: number
  /** 0-100, rounded to 1 decimal */
  pct: number
  /** short ranges with NO match at all (gaps < 0.500 s ignored) */
  gaps: ShortRange[]
  missingSec: number
  at: number
}

export type GapBackupStatus =
  | 'idle'
  | 'skipped'
  | 'cutting'
  | 'uploading'
  | 'searching'
  | 'awaiting_review'
  | 'done'
  | 'stopped'
  | 'error'

/** One exact uncovered range. Finder results remain pending until the user reviews them. */
export interface GapBackupPart {
  index: number
  minuteIndex: number
  shortStart: number
  shortEnd: number
  gapStart: number
  gapEnd: number
  clipStart: number
  clipEnd: number
  result?: 'pending' | 'found' | 'accepted' | 'rejected' | 'unresolved'
}

export interface GapBackupCandidate {
  id: string
  part: number
  shortStart: number
  shortEnd: number
  movieStart: number
  movieEnd: number
  source: 'gap-backup'
  chunkIndex: number
  model: string
  confidence: number
  reason: string
  review: 'pending' | 'accepted' | 'rejected'
  createdAt: number
}

export interface GapBackupRequest {
  id: string
  minuteIndex: number
  batch: number
  chunkIndex: number
  chunkStart: number
  chunkEnd: number
  lane: string
  model: string
  status: 'queued' | 'uploading' | 'running' | 'done' | 'failed' | 'cancelled'
  raw?: string
  tokens?: number
  matches?: number
  error?: string
  queuedAt?: number
  startedAt?: number
  uploadedAt?: number
  finishedAt?: number
}

export interface GapBackupMinute {
  index: number
  start: number
  end: number
  status: 'queued' | 'preparing' | 'uploading' | 'searching' | 'awaiting_review' | 'done' | 'failed'
  partIds: number[]
  candidateChunks: number[]
  completedChunks: number[]
  currentBatch?: number[]
  clip?: { path: string; durationSec: number; sizeBytes: number; fps: 24 }
  preparedAt?: number
  uploadedAt?: number
  startedAt?: number
  finishedAt?: number
  error?: string
}

/** Durable, manual-only missing-scene finder state. */
export interface GapBackupState {
  status: GapBackupStatus
  progress?: string
  runs?: number
  parts: GapBackupPart[]
  minutes: GapBackupMinute[]
  requests: GapBackupRequest[]
  candidates: GapBackupCandidate[]
  addedMatches: ChunkMatch[]
  requestCount?: number
  tokenCount?: number
  activeBatch?: number[]
  error?: string | null
  startedAt?: number | null
  finishedAt?: number | null
}

export interface ModelLiveState {
  state: 'idle' | 'active' | 'cooling' | 'exhausted' | 'waiting'
  currentChunk: number | null
  cooldownUntil: number | null
  usedToday: number
}

export interface KeyLaneModelLiveState {
  id: string
  state: 'idle' | 'active' | 'cooling' | 'exhausted' | 'waiting'
}

export interface KeyLaneLiveState {
  idx: number
  status: 'idle' | 'active' | 'error' | 'exhausted'
  lastError?: string
  models: KeyLaneModelLiveState[]
}

export interface ScanReport {
  totalScanTimeMs: number
  chunksScanned: number
  chunksFailed: number
  /** chunks never completed: still pending / re-queued / in flight when the report froze (Stop, quota) */
  chunksPending?: number
  /** true when the report was built before the scan finished (Stop / quota pause) */
  partial?: boolean
  modelsUsed: string[]
  /** all parsed matches across all chunks (absolute movie seconds) */
  matches: ChunkMatch[]
  /** verifier pipeline stats (present when the verification phase ran) */
  groupsTotal?: number
  groupsConfirmed?: number
  groupsRejected?: number
  groupsUnverified?: number
  /** groups still pending / verifying / rescanning when the report froze — total = confirmed + rejected + unverified + pending */
  groupsPending?: number
  /** rejected groups whose best candidate is KEPT in the merge (flagged rejected) */
  matchesRejectedKept?: number
  /** matches per provenance: chunk / rescan / gap-backup / user */
  originCounts?: Partial<Record<MatchOrigin, number>>
  /** gap-backup breakdown */
  gapBackup?: { candidates: number; confirmed: number; rejectedKept: number; unverified: number; unresolved: number }
  /** how much of the short the final match set covers (+ exact MISSING list) */
  coverage?: ShortCoverage
  /** how the chunk set was chosen: 'twelvelabs' pre-filter, 'gemini' minute finder, or normal 'full' scan */
  prefilterMode?: 'twelvelabs' | 'full' | 'gemini'
  prefilterSelected?: number
  prefilterTotal?: number
}

export interface Scan {
  id: string
  createdAt: number
  /** Custom human-readable name set by user for history / notifications. */
  customName?: string | null
  /** Account that owns this scan and its background worker quota. */
  ownerUsername?: string
  /** Durable queue state; persisted so queued work can recover after restart. */
  background?: {
    state: 'queued' | 'running' | 'done' | 'stopped' | 'error'
    enqueuedAt: number
    startedAt?: number
    position?: number
    resume?: boolean
    error?: string | null
  }
  /** Last save timestamp — used to pick the freshest copy across serverless instances. */
  updatedAt?: number
  status: ScanStatus
  shortName: string | null
  movieName: string | null
  shortSize: number | null
  movieSize: number | null
  shortDuration: number | null
  movieDuration: number | null
  chunkCount: number
  chunkingProgress: number
  /** movie uploaded but the trim window is not confirmed yet — chunking waits */
  awaitingTrim?: boolean
  /** confirmed trim window (ABSOLUTE movie seconds) — chunks cover ONLY this range.
   *  All reported movie timestamps stay absolute to the ORIGINAL movie. */
  movieTrimStart?: number
  movieTrimEnd?: number
  /** MIRROR of the current/active short segment's chunks (kept for UI compat).
   *  Source of truth per segment lives in shortSegments[i].chunks. */
  chunks: ChunkState[]
  /** 1-minute segments of the short video, scanned sequentially (minute-by-minute) */
  shortSegments?: ShortSegmentState[]
  /** index of the short segment currently being scanned/verified */
  currentShortSegment?: number
  /** background cutting of the short into 1-minute segment files (0-100) */
  shortSegmentingProgress?: number
  /** render/export job state (present after a render is started) */
  renderJob?: RenderJob
  /** all parsed matches across all chunks, sorted by shortStart (absolute movie seconds) */
  matches: ChunkMatch[]
  /** Candidate + verifier pipeline: one group per claimed short segment */
  candidateGroups?: CandidateGroup[]
  /** Verifier system toggle: true (default, auto-verify candidates at 24fps) | false (verifier off, skip verification) */
  verifierEnabled?: boolean
  /** Auto mode toggle: true (default, auto full-short, full-movie, auto-start window minute finder) | false (manual choose/trim) */
  autoMode?: boolean
  /** OPTIONAL Twelve Labs pre-filter: movie indexing state (absent = feature unused) */
  twelveLabs?: TwelveLabsState
  /** pre-filter decision of the LAST scan run (for the UI) */
  prefilter?: PrefilterInfo
  /** AUTO pipeline: merge → TL asset → Marengo index → Pegasus segmentation → minute approval */
  mergePipeline?: MergePipelineState
  /** GEMINI MINUTE FINDER: 20-minute window pre-scan → minute list → auto chunk scan */
  geminiPrescan?: GeminiPrescanState
  /** GAP BACKUP PASS (post-verification): never-found short parts re-searched in every window */
  gapBackup?: GapBackupState
  /** MISSING SCENE SCANNER: user-triggered targeted search for selected missing short scenes */
  missingSceneScan?: MissingSceneScanState
  /** BATCH MINUTE VERIFIER: all-in-one 24fps stitched verification across minutes */
  batchVerify?: BatchVerifyState
  logs: LogEntry[]
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  report: ScanReport | null
  modelStates: Record<string, ModelLiveState>
  keyLanes?: KeyLaneLiveState[]
}

export interface ScanSummary {
  id: string
  createdAt: number
  customName?: string | null
  ownerUsername?: string
  background?: Scan['background']
  status: ScanStatus
  movieName: string | null
  shortName: string | null
  movieDuration: number | null
  matchCount: number
  finishedAt: number | null
}
