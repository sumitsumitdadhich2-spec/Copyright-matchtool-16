import path from 'node:path'
import fs from 'node:fs'
import type { GoogleGenAI } from '@google/genai'
import type { Scan, ChunkState, ChunkMatch, CandidateGroup, ShortSegmentState, ScanReport, ShortCoverage } from './types'
import {
  MODEL_POOL,
  CHUNK_MODEL_POOL,
  VERIFY_MODEL_POOL,
  RESCAN_MODEL_POOL,
  RESCAN_BACKUP_POOL,
  isRescanModel,
  MAX_QUALITY_RETRIES,
  MODEL_MIN_INTERVAL_MS,
  CHUNK_COOLDOWN_MS,
  CHUNK_SECONDS,
  pacingIntervalMs,
  type ModelSpec,
  getModelDailyCap,
} from './models'
import {
  getScan,
  saveScan,
  addLog,
  getModelUsage,
  incrementModelUsage,
  setModelExhausted,
  checkDailyReset,
  geminiUsageDay,
  scanMediaDir,
  listScans,
} from './store'
import { chunkPath, cleanupClips, extractClipPrecise, extractSegment, sanitizeVideoMute, segmentPath } from './ffmpeg'
import { chunkOverlapsSegRange, segMovieRange, segHasMinuteList, formatMinuteList } from './segment-range'
import {
  ensureIndex,
  createIndexTask,
  pollTaskUntilReady,
  fetchVideoEmbeddings,
  loadEmbeddings,
  saveEmbeddings,
  computePrefilterChunks,
  TL_SIMILARITY_THRESHOLD,
} from './twelvelabs'
import {
  getClient,
  uploadVideo,
  deleteFileQuiet,
  cleanupOrphanedGeminiFiles,
  mapChunkRequest,
  CHUNK_MAP_SANITIZED_PROMPT,
  parseChunkMatches,
  verifyRequest,
  rescanRequest,
  parseVerdict,
  parseRescanMatch,
  isSuspiciousChunkOutput,
  GeminiError,
  classifyError,
} from './gemini'
import { applyGroupMatches, bestRejectedCandidate, groupMatchOrigin, originTag, sameShortSegment } from './candidate-pick'
import { computeShortCoverage, coverageLine } from './short-coverage'
import { globalGeminiCoordinator } from './global-gemini-coordinator'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Max real attempts per chunk before it is marked failed (infra/transient/rate errors never count). */
const MAX_CHUNK_ATTEMPTS = 6

/** One API key lane (1-20). Gemini Files API uploads are PER KEY,
 *  so each lane keeps its own uploaded short-SEGMENT URIs (one per minute). */
interface KeyLane {
  idx: number
  apiKey: string
  ai: GoogleGenAI
  /** uploaded short-segment URIs keyed by segment index */
  segUris: Map<number, string>
  /** per-segment in-flight upload locks so two workers never double-upload */
  segUriPromises: Map<number, Promise<string>>
  /** PIPELINING: pre-cut + pre-uploaded movie chunks on THIS key —
   *  chunkIndex -> in-flight/finished upload. Consumed (removed) on use,
   *  because every chunk upload is one-shot (deleted after its request). */
  chunkUploads: Map<number, Promise<{ uri: string; name: string }>>
  /** verifier groups currently in flight on THIS key (capped by VERIFY_PER_LANE) */
  verifyActive: number
  /** verifier groups in flight per model on THIS key (capped by VERIFY_CONCURRENCY_PER_MODEL) */
  verifyActiveByModel: Map<string, number>
}

/** Concurrency per model on each API key: 1 exclusive request per model lane.
 * Across keys × 2 verify models = parallel verify requests across distinct lanes!
 * Serialized per key/model to strictly prevent 429 rate collisions. */
const VERIFY_CONCURRENCY_PER_MODEL = 1

/** Max verifier groups in flight per key: 1 request per model. */
const VERIFY_PER_LANE = VERIFY_MODEL_POOL.length * VERIFY_CONCURRENCY_PER_MODEL

interface Job {
  scan: Scan
  lanes: KeyLane[]
  /** PREFETCH OWNERSHIP: chunkIndex -> lane idx that pre-uploaded it. One lane
   *  per chunk, so the same chunk is never uploaded on 5 keys at once. Workers
   *  pull "their" pre-uploaded chunks first (lane affinity). */
  prefetchOwner: Map<number, number>
  /** OPTIONAL Twelve Labs key — enables the embedding pre-filter. null = normal full scan. */
  tlKey: string | null
  /** the short segment (minute) currently being scanned — workers read this */
  seg: ShortSegmentState | null
  /** chunk queue (indexes) for the CURRENT segment */
  queue: number[]
  inFlight: Set<number>
  /** verification phase: candidate-group queue (indexes into scan.candidateGroups) */
  verifyQueue: number[]
  verifyInFlight: Set<number>
  /** true once ALL minutes' chunk workers have drained — the GLOBAL verify
   *  workers keep waiting for new candidates until this flips to true. */
  chunkPhaseDone: boolean
  /** set when a rejected group revived early-stop-skipped chunks — triggers an extra scan pass */
  earlyStopRevived: boolean
  stopping: boolean
  /** pacing state keyed by `${laneIdx}|${modelId}`: earliest time the next request may be sent.
   *  Set after every request from its actual token size so every model runs at full TPM capacity. */
  nextFreeAt: Record<string, number>
  cooldownUntil: Record<string, number>
  dirty: boolean
  saverTimer: ReturnType<typeof setInterval> | null
}

/** Max attempts (non-rate errors) per candidate group before it is kept as unverified. */
const MAX_GROUP_ATTEMPTS = 4

/** Format seconds as mm:ss.mmm for logs. */
function ts(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`
}
const fmtTime = ts

/** ABSOLUTE original-movie window of a chunk: chunks cover ONLY the confirmed
 *  trim range, so every chunk's absolute start = trimStart + index * 60. */
function chunkAbsWindow(scan: Scan, chunkIndex: number): { start: number; end: number } {
  const trimStart = scan.movieTrimStart ?? 0
  const rangeEnd = scan.movieTrimEnd ?? scan.movieDuration ?? Number.POSITIVE_INFINITY
  const start = trimStart + chunkIndex * CHUNK_SECONDS
  return { start, end: Math.min(start + CHUNK_SECONDS, rangeEnd) }
}

class Scheduler {
  jobs = new Map<string, Job>()
  private dailyResetTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    // Periodically check if a new day has arrived (at midnight Pacific Time / new date)
    this.dailyResetTimer = setInterval(() => {
      if (checkDailyReset()) {
        this.onDailyReset()
      }
    }, 30_000)

    // Periodic Gemini Storage Cleanup every 15 minutes: sweeps old orphaned files (>24 hours) from Gemini Files API
    setInterval(() => {
      for (const [, job] of this.jobs.entries()) {
        for (const lane of job.lanes) {
          void cleanupOrphanedGeminiFiles(lane.apiKey, 24 * 60 * 60_000)
        }
      }
    }, 15 * 60_000)
  }

  /** Called whenever the date rolls over or a new day is detected.
   * Wakes up any waiting jobs, clears lane exhausted states, and resets cooldowns. */
  onDailyReset() {
    for (const [, job] of this.jobs.entries()) {
      addLog(
        job.scan,
        'success',
        `[Daily Quota Reset] New calendar day detected — all Gemini free-tier daily quotas have reset! Resuming workers with fresh capacity.`,
      )
      for (const lane of job.lanes) {
        const laneState = job.scan.keyLanes.find((l) => l.idx === lane.idx)
        if (laneState && laneState.status !== 'error') {
          for (const ms of laneState.models) {
            if (ms.state === 'exhausted') ms.state = 'idle'
          }
        }
      }
      job.cooldownUntil = {}
      this.mark(job)
    }
  }

  isRunning(scanId: string) {
    return this.jobs.has(scanId)
  }

  /** Synthesize/repair scan.shortSegments. Migration shim: old scans (short was
   *  trimmed to 1 minute) become a single segment that ADOPTS the existing
   *  scan.chunks array by reference, so all prior chunk states are preserved. */
  private ensureSegments(scan: Scan) {
    const dur = scan.shortDuration || CHUNK_SECONDS
    const segCount = Math.max(1, Math.ceil(dur / CHUNK_SECONDS))
    if (!scan.shortSegments || scan.shortSegments.length === 0) {
      scan.shortSegments = Array.from({ length: segCount }, (_, i) => ({
        index: i,
        start: i * CHUNK_SECONDS,
        end: Math.min((i + 1) * CHUNK_SECONDS, dur),
        status: 'pending' as const,
        chunks: i === 0 && Array.isArray(scan.chunks) && scan.chunks.length > 0 ? scan.chunks : [],
      }))
    }
    for (const seg of scan.shortSegments) {
      if (!Array.isArray(seg.chunks)) seg.chunks = []
      while (seg.chunks.length < scan.chunkCount) {
        seg.chunks.push({ index: seg.chunks.length, status: 'pending', attempts: 0 })
      }
      if (seg.chunks.length > scan.chunkCount) seg.chunks = seg.chunks.slice(0, scan.chunkCount)
    }
    if (scan.currentShortSegment === undefined) scan.currentShortSegment = 0
  }

  async start(
    scanId: string,
    resume: boolean,
    userApiKeys?: string[],
    tlApiKey?: string | null,
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.jobs.has(scanId)) return { ok: false, error: 'Scan already running' }
    // PER-USER KEYS ONLY: the route passes the logged-in user's own keys
    // (from their private Blob file). There is NO shared/global fallback —
    // every user scans strictly on their own keys.
    const apiKeys = userApiKeys ?? []
    if (apiKeys.length === 0) return { ok: false, error: 'No Gemini API key configured for YOUR account. Add your key in Settings first.' }
    const scan = getScan(scanId)
    if (!scan) return { ok: false, error: 'Scan not found' }
    if (!scan.shortDuration || !scan.movieDuration || scan.chunkCount === 0) {
      return { ok: false, error: 'Both videos must be uploaded and chunked before scanning.' }
    }

    // Segments: synthesize/repair the per-minute structure (migration shim for old scans).
    this.ensureSegments(scan)
    const segments = scan.shortSegments!

    // Reset orphaned "scanning" chunks + resume cancelled ones ACROSS ALL segments.
    // PER-MINUTE MOVIE RANGE: chunks outside a minute's chosen movie range are
    // marked cancelled (skipped) so only in-range chunks consume API quota.
    for (const seg of segments) {
      // TWELVE LABS PRE-FILTER: the persisted per-minute chunk selection is only
      // honoured while the user's TL key is set. No key = feature fully off —
      // clear the selection so EVERYTHING scans (normal full scan, zero impact).
      if (!tlApiKey && Array.isArray(seg.prefilterChunks)) delete seg.prefilterChunks
      for (const c of seg.chunks) {
        const inRange = chunkOverlapsSegRange(scan, seg, c.index)
        if (c.status === 'scanning') c.status = 'pending'
        // 'cancelled' is ONLY ever set by skip logic (range, pre-filter, or
        // EARLY-STOP), so revive cancelled chunks that fall inside the CURRENT
        // range — on fresh starts too, not just Resume. Otherwise changing a
        // minute's movie range after a run leaves the newly chosen part
        // permanently skipped. EXCEPTION: early-stop-skipped chunks of a DONE
        // minute stay skipped — us minute ke saare matches confirm ho chuke hain.
        if (c.status === 'cancelled' && inRange && !(c.skippedEarlyStop && seg.status === 'done')) {
          c.status = 'pending'
          delete c.skippedEarlyStop
        }
        if (c.status === 'pending' && !inRange) c.status = 'cancelled'
        // Re-apply the persisted pre-filter selection (resume path). A fresh
        // pre-filter run inside runScan() recomputes/overrides this anyway.
        if (c.status === 'pending' && Array.isArray(seg.prefilterChunks) && !seg.prefilterChunks.includes(c.index)) {
          c.status = 'cancelled'
        }
      }
      if (seg.status === 'scanning' || seg.status === 'verifying') seg.status = 'pending'
      if (seg.status === 'done' && seg.chunks.some((c) => c.status === 'pending')) seg.status = 'pending'
    }
    // MINUTE SELECTION: only segments with selected !== false take part in the
    // scan (default = all selected). Unselected minutes are skipped entirely.
    const selectedSegs = segments.filter((s) => s.selected !== false)
    const pendingChunks = selectedSegs.reduce((n, s) => n + s.chunks.filter((c) => c.status === 'pending').length, 0)
    const allSettled = selectedSegs.every((s) => s.chunks.every((c) => c.status !== 'pending' && c.status !== 'scanning'))

    // Verification-only resume: all chunks already mapped but candidate groups
    // still have pending verifier/rescan work (or matches were never verified).
    const hasVerifyWork =
      (scan.candidateGroups || []).some((g) => g.status === 'pending' || g.status === 'verifying' || g.status === 'rescanning') ||
      (scan.matches || []).some((m) => m.verified === undefined) ||
      (!scan.candidateGroups?.length && (scan.matches || []).length > 0 && allSettled)

    if (pendingChunks === 0 && !hasVerifyWork) return { ok: false, error: 'No pending chunks to scan.' }

    // Mirror the first incomplete SELECTED segment's chunks so the UI shows the right minute.
    const firstIncomplete = selectedSegs.find((s) => s.status !== 'done') || selectedSegs[0] || segments[0]
    scan.currentShortSegment = firstIncomplete.index
    scan.chunks = firstIncomplete.chunks

    const isNewDay = checkDailyReset()
    if (isNewDay) {
      addLog(
        scan,
        'success',
        `[Daily Quota Reset] New date detected (${geminiUsageDay()}) — all Gemini daily quotas reset to fresh state.`,
      )
    }

    // Proactive Storage Sweep: clean any orphaned Gemini files older than 24 hours to preserve cache for 24h
    for (const k of apiKeys) {
      void cleanupOrphanedGeminiFiles(k, 24 * 60 * 60_000)
    }

    if (!Array.isArray(scan.matches)) scan.matches = []
    scan.status = 'scanning'
    scan.error = null
    if (!scan.startedAt) scan.startedAt = Date.now()

    // PRIORITY RESERVATION: Key 1 and Key 2 are strictly reserved for Window Finder, Backup Finder, and Missing Scene Finder!
    // Chunk scans (1-minute chunk scanning) must NEVER consume Key 1 or Key 2's daily model quotas if more than 2 keys exist.
    const allKeysWithIdx = apiKeys.map((k, i) => ({ key: k, idx: i + 1 }))
    const activeChunkKeys = allKeysWithIdx.length > 2
      ? allKeysWithIdx.filter((x) => x.idx > 2)
      : allKeysWithIdx

    const lanes: KeyLane[] = activeChunkKeys.map(({ key: k, idx }) => ({
      idx,
      apiKey: k,
      ai: getClient(k),
      segUris: new Map(),
      segUriPromises: new Map(),
      chunkUploads: new Map(),
      verifyActive: 0,
      verifyActiveByModel: new Map(),
    }))

    // Sync scan.keyLanes: ensure any exhausted model whose daily usage is under RPD is reset to idle
    if (!Array.isArray(scan.keyLanes)) scan.keyLanes = []
    for (const lane of lanes) {
      let laneState = scan.keyLanes.find((l) => l.idx === lane.idx)
      if (!laneState) {
        laneState = {
          idx: lane.idx,
          status: 'idle',
          models: MODEL_POOL.map((m) => ({ id: m.id, state: 'idle' })),
        }
        scan.keyLanes.push(laneState)
      } else if (laneState.status !== 'error') {
        for (const m of laneState.models) {
          const spec = MODEL_POOL.find((item) => item.id === m.id)
          const usage = getModelUsage(m.id, lane.apiKey)
          if (spec) {
            if (usage < spec.rpd) {
              if (m.state === 'exhausted') m.state = 'idle'
            } else {
              m.state = 'exhausted'
            }
          }
        }
      }
    }

    const minuteNote = segments.length > 1 ? ` across ${segments.length} short minutes (scanned sequentially)` : ''
    addLog(
      scan,
      'info',
      resume
        ? `Resuming: ${pendingChunks} chunk(s) pending${minuteNote}`
        : `Scan started: ${pendingChunks} chunk(s) queued${minuteNote} across ${CHUNK_MODEL_POOL.length} chunk models (${CHUNK_MODEL_POOL.map((m) => m.id).join(', ')}) × ${lanes.length} API key(s) — one prompt per chunk`,
    )

    const job: Job = {
      scan,
      lanes,
      prefetchOwner: new Map(),
      tlKey: tlApiKey || null,
      seg: null,
      queue: [],
      inFlight: new Set(),
      verifyQueue: [],
      verifyInFlight: new Set(),
      chunkPhaseDone: false,
      earlyStopRevived: false,
      stopping: false,
      nextFreeAt: {},
      cooldownUntil: {},
      dirty: true,
      saverTimer: null,
    }
    this.jobs.set(scanId, job)
    // Persist on an interval instead of every mutation (logs update very often).
    job.saverTimer = setInterval(() => {
      if (job.dirty) {
        job.dirty = false
        try {
          saveScan(job.scan)
        } catch {
          /* ignore */
        }
      }
    }, 800)
    saveScan(scan)

    void this.runScan(job).catch((err) => {
      addLog(job.scan, 'error', `Fatal scheduler error: ${err instanceof Error ? err.message : String(err)}`)
      job.scan.status = 'error'
      job.scan.error = err instanceof Error ? err.message : String(err)
      this.finish(job)
    })
    return { ok: true }
  }

  stop(scanId: string): { ok: boolean; error?: string } {
    const job = this.jobs.get(scanId)
    if (!job) return { ok: false, error: 'Scan is not running' }
    job.stopping = true
    // INSTANT PARTIAL RESULTS: status TURANT 'stopped' + partial report yahin
    // ban jaata hai — user ko export/preview ke liye in-flight requests ke
    // drain hone ka wait NAHI karna padta. Baad me aane wale in-flight results
    // bhi scan.matches me merge hote rehte hain (periodic saver unhe save karta
    // hai), aur runScan ka stop-checkpoint report ko dobara refresh kar deta hai.
    job.scan.status = 'stopped'
    this.buildPartialReport(job)
    addLog(
      job.scan,
      'warn',
      'Stop requested — ab tak ke results (unverified samet) TURANT export/preview ke liye ready. In-flight requests background me settle ho rahi hain; Resume wahi se continue karega.',
    )
    job.dirty = false
    try {
      saveScan(job.scan)
    } catch {
      /* periodic saver will retry */
    }
    return { ok: true }
  }

  /** Update verifier enabled on a running job (e.g. from the UI button). */
  setVerifierEnabled(scanId: string, enabled: boolean) {
    const job = this.jobs.get(scanId)
    if (job) {
      job.scan.verifierEnabled = enabled
      if (!enabled) {
        // If turned off while running, clear the verify queue and settle pending groups as unverified
        job.verifyQueue = []
        for (const g of job.scan.candidateGroups || []) {
          if (g.status === 'pending' || g.status === 'verifying' || g.status === 'rescanning') {
            g.status = 'unverified'
            applyGroupMatches(job.scan, g)
          }
        }
        this.mark(job)
      }
    }
  }

  /** Apply a user candidate pick to a running job in memory, keeping in-flight state in sync. */
  applyUserPick(
    scanId: string,
    groupId: string,
    candidateIndex: number | null,
    viaRescan = false,
    extra?: {
      shortStart?: number
      shortEnd?: number
      movieStart?: number
      movieEnd?: number
      chunkIndex?: number
      model?: string
    },
  ): { ok: boolean; error?: string } {
    const job = this.jobs.get(scanId)
    if (!job) return { ok: false, error: 'Scan is not running' }
    job.scan.candidateGroups = job.scan.candidateGroups || []
    let g = job.scan.candidateGroups.find((x) => x.id === groupId)
    if (!g && extra?.shortStart != null && extra?.shortEnd != null) {
      g = job.scan.candidateGroups.find((x) => sameShortSegment(x.shortStart, x.shortEnd, extra.shortStart!, extra.shortEnd!))
    }
    if (!g) {
      if (extra?.shortStart != null && extra?.shortEnd != null && extra?.movieStart != null && extra?.movieEnd != null) {
        g = {
          id: groupId || `g-${Date.now()}`,
          shortStart: extra.shortStart,
          shortEnd: extra.shortEnd,
          status: 'confirmed',
          confirmedIndex: 0,
          confirmedViaRescan: false,
          candidates: [
            {
              shortStart: extra.shortStart,
              shortEnd: extra.shortEnd,
              movieStart: extra.movieStart,
              movieEnd: extra.movieEnd,
              chunkIndex: extra.chunkIndex ?? 0,
              model: extra.model ?? 'gemini-3.7-flash',
              verdict: 'same',
              rescan: 'none',
            },
          ],
        }
        job.scan.candidateGroups.push(g)
      } else {
        return { ok: false, error: 'Candidate group not found' }
      }
    }

    if (candidateIndex === null) {
      delete g.userPick
      applyGroupMatches(job.scan, g)
      addLog(
        job.scan,
        'info',
        `User choice cleared for short ${fmtTime(g.shortStart)}–${fmtTime(g.shortEnd)} — AI verdict (${g.status}) restored`,
      )
    } else {
      let idx = Number(candidateIndex)
      if (!Number.isInteger(idx) || idx < 0 || idx >= g.candidates.length) {
        if (extra?.movieStart != null && extra?.movieEnd != null) {
          const found = g.candidates.findIndex(
            (c) => Math.abs(c.movieStart - extra.movieStart!) < 0.5 && Math.abs(c.movieEnd - extra.movieEnd!) < 0.5,
          )
          if (found >= 0) {
            idx = found
          } else {
            idx = g.candidates.length
            g.candidates.push({
              shortStart: extra.shortStart ?? g.shortStart,
              shortEnd: extra.shortEnd ?? g.shortEnd,
              movieStart: extra.movieStart,
              movieEnd: extra.movieEnd,
              chunkIndex: extra.chunkIndex ?? 0,
              model: extra.model ?? 'gemini-3.7-flash',
              verdict: 'same',
              rescan: 'none',
            })
          }
        } else {
          return { ok: false, error: 'Invalid candidate index' }
        }
      }
      const c = g.candidates[idx]
      if (viaRescan && (c.rescanMovieStart == null || c.rescanMovieEnd == null)) {
        return { ok: false, error: 'This candidate has no rescan window' }
      }
      g.userPick = { index: idx, viaRescan, at: Date.now() }
      applyGroupMatches(job.scan, g)
      const pickedWin = viaRescan
        ? `${fmtTime(c.rescanMovieStart!)}–${fmtTime(c.rescanMovieEnd!)} (rescan)`
        : `${fmtTime(c.movieStart)}–${fmtTime(c.movieEnd)}`
      addLog(
        job.scan,
        'success',
        `User choice applied: short ${fmtTime(g.shortStart)}–${fmtTime(g.shortEnd)} → movie ${pickedWin} (Candidate ${idx + 1} of ${g.candidates.length})`,
      )
    }
    this.mark(job)
    saveScan(job.scan, { immediate: true })
    return { ok: true }
  }

  /** MANUAL chunk retry: reset one chunk and re-run its mapping (chunk models only).
   *  Works while a scan is running (re-queues on the live job) AND after it has
   *  finished (restarts the scheduler in resume mode; the chunk file is re-cut
   *  from the movie automatically if it was cleaned up). */
  async retryChunk(
    scanId: string,
    chunkIndex: number,
    segmentIndex?: number,
    userApiKeys?: string[],
  ): Promise<{ ok: boolean; error?: string }> {
    const job = this.jobs.get(scanId)
    const scan = job ? job.scan : getScan(scanId)
    if (!scan) return { ok: false, error: 'Scan not found' }

    // Resolve the target segment (default: the current/selected minute).
    let seg: ShortSegmentState | null = null
    let chunk: ChunkState | undefined
    if (scan.shortSegments?.length) {
      const si = segmentIndex ?? scan.currentShortSegment ?? 0
      seg = scan.shortSegments[si] ?? null
      if (!seg) return { ok: false, error: `Short minute ${si} not found` }
      chunk = seg.chunks[chunkIndex]
    } else {
      chunk = scan.chunks?.[chunkIndex]
    }
    if (!chunk) return { ok: false, error: `Chunk ${chunkIndex} not found` }

    const isFailedChunk = chunk.status === 'failed' || chunk.status === 'policy_blocked'

    // RESCAN LOCK: a manual retry on matched/no_match chunks waits while the verification
    // queue has pending candidates. But a FAILED chunk has no pending verifications and
    // must be immediately retryable so the user is never stuck!
    const pendingVerify = (scan.candidateGroups || []).filter(
      (g) => g.status === 'pending' || g.status === 'verifying' || g.status === 'rescanning',
    ).length
    if (pendingVerify > 0 && !isFailedChunk) {
      return {
        ok: false,
        error: `Verification in progress — ${pendingVerify} candidate group(s) pending. Retry tabhi milega jab saare candidates verify ho jayen${job ? '' : ' (Resume karke verification poori karo)'}.`,
      }
    }

    const isActiveSeg = !seg || !job || job.seg === seg
    if ((chunk.status === 'scanning' || job?.inFlight.has(chunkIndex)) && isActiveSeg) {
      return { ok: false, error: `Chunk ${chunkIndex} is currently in flight — wait for it to finish` }
    }
    if (job && isActiveSeg && job.queue.includes(chunkIndex)) {
      return { ok: false, error: `Chunk ${chunkIndex} is already queued` }
    }
    if (job && !isActiveSeg) {
      return {
        ok: false,
        error: `Scan is busy on minute ${(job.seg?.index ?? 0) + 1} — retry this chunk of minute ${(seg?.index ?? 0) + 1} after the scan finishes`,
      }
    }

    // Reset the chunk and wipe its old evidence — ONLY within this segment's short window.
    const segStart = seg ? seg.start : 0
    const segEnd = seg ? seg.end : Number.POSITIVE_INFINITY
    chunk.status = 'pending'
    chunk.attempts = 0
    chunk.qualityRetries = 0
    chunk.policyRetried = false
    chunk.matches = []
    scan.matches = (scan.matches || []).filter(
      (mm) => !(mm.chunkIndex === chunkIndex && mm.shortStart >= segStart && mm.shortStart < segEnd),
    )
    if (scan.candidateGroups?.length) {
      scan.candidateGroups = scan.candidateGroups.filter(
        (g) => !(g.shortStart >= segStart && g.shortStart < segEnd && g.candidates.some((c) => c.chunkIndex === chunkIndex)),
      )
    }
    if (seg && seg.status === 'done') seg.status = 'pending'
    addLog(
      scan,
      'info',
      seg && (scan.shortSegments?.length ?? 0) > 1
        ? `Manual retry: minute ${seg.index + 1} · chunk ${chunkIndex} reset and re-queued for chunk-model mapping`
        : `Manual retry: chunk ${chunkIndex} reset and re-queued for chunk-model mapping`,
    )

    if (job) {
      job.queue.push(chunkIndex)
      this.mark(job)
      return { ok: true }
    }

    // No live job — persist the reset state and restart in resume mode
    // using the SAME user's own keys that were passed in.
    if (scan.status === 'done' || scan.status === 'stopped' || scan.status === 'error') scan.status = 'stopped'
    saveScan(scan)
    return this.start(scanId, true, userApiKeys)
  }

  private mark(job: Job) {
    job.dirty = true
  }

  /** STOP-AWARE sleep: pacing waits 1 minute tak ke ho sakte hain — ye helper
   *  chhote slices me sota hai aur Stop dabate hi turant exit ho jaata hai,
   *  taaki workers minute-bhar latke na rahen. */
  private async stoppableSleep(job: Job, ms: number) {
    const until = Date.now() + ms
    while (!job.stopping) {
      const left = until - Date.now()
      if (left <= 0) return
      await sleep(Math.min(500, left))
    }
  }

  /** Persist a verbatim Gemini response on a chunk (drives the UI raw-output expander).
   *  Bounded: 20KB per entry, max 12 entries per chunk (oldest dropped). */
  private recordChunkOutput(chunk: ChunkState | undefined, model: string, text?: string) {
    if (!chunk || !text) return
    if (!chunk.rawOutputs) chunk.rawOutputs = []
    chunk.rawOutputs.push({
      model,
      t: Date.now(),
      text: text.length > 20_000 ? `${text.slice(0, 20_000)}\n... [truncated]` : text,
    })
    if (chunk.rawOutputs.length > 12) chunk.rawOutputs.splice(0, chunk.rawOutputs.length - 12)
  }

  /** modelStates key: lane 1 uses the plain model id (drives the Model Pool board);
   *  lanes 2-20 keep their own suffixed entries so keys never overwrite each other. */
  private stateKey(lane: KeyLane, m: ModelSpec) {
    return lane.idx === 1 ? m.id : `${m.id}@${lane.idx}`
  }

  private rateKey(lane: KeyLane, m: ModelSpec) {
    return `${lane.idx}|${m.id}`
  }

  private paceSlotKey(lane: KeyLane, m: ModelSpec, slot: number = 0) {
    return `${lane.idx}|${m.id}|${slot}`
  }

  private modelState(job: Job, lane: KeyLane, m: ModelSpec) {
    const key = this.stateKey(lane, m)
    const used = getModelUsage(m.id, lane.apiKey)
    if (!job.scan.modelStates[key]) {
      job.scan.modelStates[key] = { state: 'idle', currentChunk: null, cooldownUntil: null, usedToday: used }
    }
    const s = job.scan.modelStates[key]
    s.usedToday = used
    return s
  }

  /** Per-segment cut locks so concurrent lanes never cut the SAME segment file simultaneously. */
  private segCutLocks = new Map<string, Promise<string>>()

  /** Ensure the short-minute segment file exists and is cleanly extracted. */
  private async ensureSegmentFile(scan: Scan, seg: ShortSegmentState): Promise<string> {
    const mediaDir = scanMediaDir(scan.id)
    const segDir = path.join(mediaDir, 'segments')
    const file = segmentPath(segDir, seg.index)
    if (fs.existsSync(file)) {
      try {
        if (fs.statSync(file).size > 1024) return file
      } catch {
        /* re-extract */
      }
    }
    const key = `${scan.id}|seg|${seg.index}`
    let p = this.segCutLocks.get(key)
    if (!p) {
      p = (async () => {
        fs.mkdirSync(segDir, { recursive: true })
        addLog(scan, 'info', `Minute ${seg.index + 1}: preparing short segment ${ts(seg.start)}–${ts(seg.end)}`)
        await extractSegment(path.join(mediaDir, 'short.mp4'), seg.start, seg.end, file)
        return file
      })().finally(() => this.segCutLocks.delete(key))
      this.segCutLocks.set(key, p)
    }
    return p
  }

  /** Upload ONE short-minute segment file per key lane (Files API uploads are per key).
   *  The segment file is cleanly cut under an extraction lock so concurrent lanes never collide. */
  private async ensureSegmentUri(job: Job, lane: KeyLane, seg: ShortSegmentState): Promise<string> {
    const existing = lane.segUris.get(seg.index)
    if (existing) return existing
    let p = lane.segUriPromises.get(seg.index)
    if (!p) {
      p = (async () => {
        const file = await this.ensureSegmentFile(job.scan, seg)
        addLog(job.scan, 'info', `Uploading short minute ${seg.index + 1} to the scanner (key ${lane.idx})...`)
        this.mark(job)
        const f = await uploadVideo(lane.ai, file)
        lane.segUris.set(seg.index, f.uri)
        addLog(job.scan, 'success', `Short minute ${seg.index + 1} ready on the scanner (key ${lane.idx})`)
        this.mark(job)
        return f.uri
      })().catch((err) => {
        lane.segUriPromises.delete(seg.index)
        throw err
      })
      lane.segUriPromises.set(seg.index, p)
    }
    return p
  }

  /** Per-chunk cut locks so two lanes/workers never cut the SAME chunk file at once. */
  private cutLocks = new Map<string, Promise<string>>()

  /** Ensure the chunk's local file exists (re-cut from the movie if missing).
   *  Cut exactly once even when multiple lanes need it at the same time. */
  private async ensureChunkFile(scan: Scan, chunkIndex: number): Promise<string> {
    const chunksDir = path.join(scanMediaDir(scan.id), 'chunks')
    const chunkFile = chunkPath(chunksDir, chunkIndex)
    if (fs.existsSync(chunkFile)) return chunkFile
    const key = `${scan.id}|${chunkIndex}`
    let p = this.cutLocks.get(key)
    if (!p) {
      p = (async () => {
        // TRIM-AWARE: chunk N starts at trimStart + N*60 in the ORIGINAL movie.
        const { start: cs, end: ce } = chunkAbsWindow(scan, chunkIndex)
        fs.mkdirSync(chunksDir, { recursive: true })

        // Check if another scan of the same movie has this chunk already cut
        const otherScans = listScans().filter((s) => s.id !== scan.id && s.movieName === scan.movieName)
        for (const os of otherScans) {
          const fullOs = getScan(os.id)
          if (!fullOs || fullOs.movieSize !== scan.movieSize) continue
          const osWin = chunkAbsWindow(fullOs, chunkIndex)
          if (Math.abs(osWin.start - cs) < 0.1 && Math.abs(osWin.end - ce) < 0.1) {
            const candFile = chunkPath(path.join(scanMediaDir(os.id), 'chunks'), chunkIndex)
            if (fs.existsSync(candFile) && fs.statSync(candFile).size > 0) {
              try {
                fs.linkSync(candFile, chunkFile)
              } catch {
                try {
                  fs.copyFileSync(candFile, chunkFile)
                } catch {
                  // ignore
                }
              }
              if (fs.existsSync(chunkFile)) {
                addLog(scan, 'info', `Chunk ${chunkIndex}: reused from scan ${os.id} (no re-cut)`)
                return chunkFile
              }
            }
          }
        }

        addLog(scan, 'info', `Chunk ${chunkIndex}: chunk file missing — re-cutting ${cs}s–${ce}s from movie`)
        await extractClipPrecise(path.join(scanMediaDir(scan.id), 'movie.mp4'), cs, ce, chunkFile)
        return chunkFile
      })().finally(() => this.cutLocks.delete(key))
      this.cutLocks.set(key, p)
    }
    return p
  }

  /** Start (or join) the upload of one movie chunk on this key lane.
   *  Used both by the active worker and by background prefetch. */
  private startChunkUpload(job: Job, lane: KeyLane, chunkIndex: number, prefetch: boolean): Promise<{ uri: string; name: string }> {
    let p = lane.chunkUploads.get(chunkIndex)
    if (p) return p
    p = (async () => {
      // Fast pre-flight check: do not waste bandwidth or Files API uploads if all chunk models on this key are exhausted
      const hasActiveModel = CHUNK_MODEL_POOL.some((m) => !globalGeminiCoordinator.isModelExhausted(lane.apiKey, m.id, m.rpd))
      if (!hasActiveModel) {
        throw new Error(`All chunk models on key ${lane.idx} are exhausted today — upload skipped`)
      }
      const file = await this.ensureChunkFile(job.scan, chunkIndex)
      if (prefetch) {
        addLog(job.scan, 'info', `Pipeline: chunk ${chunkIndex} pre-uploading in background (key ${lane.idx}) — ready before its turn`)
        this.mark(job)
      }
      return uploadVideo(lane.ai, file)
    })()
    lane.chunkUploads.set(chunkIndex, p)
    // A failed prefetch must never poison the cache — the consumer re-uploads fresh.
    p.catch(() => lane.chunkUploads.delete(chunkIndex))
    return p
  }

  /** Consume (and remove) this lane's upload for a chunk — one-shot use,
   *  because the worker deletes the remote file right after its request. */
  private takeChunkUpload(job: Job, lane: KeyLane, chunkIndex: number): Promise<{ uri: string; name: string }> {
    const p = this.startChunkUpload(job, lane, chunkIndex, false)
    lane.chunkUploads.delete(chunkIndex)
    // The chunk is now being consumed — release the claim so a re-queue (retry)
    // can be prefetched fresh by whichever lane is free.
    job.prefetchOwner.delete(chunkIndex)
    return p
  }

  /** Try to claim a chunk for pre-upload on this lane. Returns false when another
   *  lane already owns it (its upload is in flight / ready there). */
  private claimPrefetch(job: Job, lane: KeyLane, chunkIndex: number): boolean {
    const owner = job.prefetchOwner.get(chunkIndex)
    if (owner !== undefined && owner !== lane.idx) return false
    job.prefetchOwner.set(chunkIndex, lane.idx)
    return true
  }

  /** LANE AFFINITY: pull the next chunk for this lane — prefer a queued chunk this
   *  key already pre-uploaded (zero upload wait, no duplicate upload), then a
   *  chunk no lane has claimed, then the plain queue head. */
  private pullChunkFor(job: Job, lane: KeyLane): number | undefined {
    if (job.queue.length === 0) return undefined
    let pos = job.queue.findIndex((ci) => lane.chunkUploads.has(ci))
    if (pos < 0) pos = job.queue.findIndex((ci) => !job.prefetchOwner.has(ci))
    if (pos < 0) pos = 0
    return job.queue.splice(pos, 1)[0]
  }

  /** PIPELINING: while this lane's model is busy analyzing, pre-cut + pre-upload
   *  the next queued chunks on the SAME key so the next analysis starts with
   *  ZERO upload wait. Depth 2 keeps bandwidth + Files API usage sane.
   *  Each chunk is claimed by ONE lane — before this, every lane prefetched the
   *  same 2 queue-head chunks (chunk 66 uploading on keys 1, 5, 3, 2, 6 at once). */
  private prefetchNextChunks(job: Job, lane: KeyLane) {
    if (job.stopping) return
    // Pre-flight check: if this key has no models with quota remaining, skip prefetch
    const hasActiveModel = CHUNK_MODEL_POOL.some((m) => !globalGeminiCoordinator.isModelExhausted(lane.apiKey, m.id, m.rpd))
    if (!hasActiveModel) return

    const PREFETCH_DEPTH = 2
    let owned = 0
    for (const ci of job.queue) {
      if (owned >= PREFETCH_DEPTH) break
      if (lane.chunkUploads.has(ci)) {
        owned++
        continue
      }
      if (!this.claimPrefetch(job, lane, ci)) continue
      owned++
      void this.startChunkUpload(job, lane, ci, true).catch(() => job.prefetchOwner.delete(ci))
    }
  }

  /** NEXT-MINUTE BACKGROUND PREP: while minute N is being scanned/verified,
   *  get minute N+1 fully ready in the background so it starts with ZERO wait:
   *  1) cut minute N+1's short-segment file + upload it to Gemini on EVERY key
   *     lane (the big serial cost between minutes),
   *  2) pre-cut minute N+1's pending movie-chunk files locally (free, no API).
   *  Everything is cached (segUris / chunk files on disk), so even if the scan
   *  stops, Resume picks the prepared work right back up. All failures are
   *  silent — the normal on-demand path re-does anything that failed. */
  private prepareNextSegment(job: Job, segments: ShortSegmentState[], currentIndex: number) {
    if (job.stopping) return
    const next = segments.find(
      (s) =>
        s.index > currentIndex &&
        s.selected !== false &&
        s.chunks.some((c) => c.status === 'pending'),
    )
    if (!next) return
    // Segment upload on every lane (kept in segUris cache — reused, never deleted).
    let announced = false
    for (const lane of job.lanes) {
      // Skip upload on keys where all models are exhausted
      const hasActiveModel = CHUNK_MODEL_POOL.some((m) => !globalGeminiCoordinator.isModelExhausted(lane.apiKey, m.id, m.rpd))
      if (!hasActiveModel) continue

      if (lane.segUris.has(next.index) || lane.segUriPromises.has(next.index)) continue
      if (!announced) {
        announced = true
        addLog(job.scan, 'info', `Pipeline: minute ${next.index + 1} background me ready ho raha hai (segment upload + chunk cutting) — minute ${currentIndex + 1} complete hote hi turant start hoga`)
        this.mark(job)
      }
      void this.ensureSegmentUri(job, lane, next).catch(() => {})
    }
    // Pre-cut the next minute's pending chunk files locally (ffmpeg only, no API
    // quota). Sequential to keep CPU/disk pressure low while the scan runs.
    // CONFIDENCE ORDER: highest-confidence chunks cut first — wahi sabse pehle
    // scan honge, isliye unka file + upload sabse pehle ready hona chahiye.
    const pendingIdx = this.orderByConfidence(
      next,
      next.chunks.filter((c) => c.status === 'pending').map((c) => c.index),
    )
    void (async () => {
      for (const ci of pendingIdx) {
        if (job.stopping) return
        try {
          await this.ensureChunkFile(job.scan, ci)
        } catch {
          /* silent — on-demand path re-cuts when the chunk's turn comes */
        }
      }
    })()
    // NEXT-MINUTE CHUNK PRE-UPLOAD (user request: "next minute ke chunks upload
    // karke READY rakho"): next minute ke top highest-confidence chunks Gemini
    // Files API par pehle se upload ho jaate hain — minute start hote hi pehli
    // request ZERO upload wait ke saath jaati hai. DISTRIBUTED: har chunk sirf
    // EK lane par (round-robin), same chunk saari keys par nahi — worker lane
    // affinity se apna pre-uploaded chunk hi uthata hai. Unused uploads finish()
    // me delete ho jaate hain, Files API clean rahta hai.
    const preUpload = pendingIdx.slice(0, Math.min(pendingIdx.length, job.lanes.length))
    preUpload.forEach((ci, i) => {
      const lane = job.lanes[i % job.lanes.length]
      const hasActiveModel = CHUNK_MODEL_POOL.some((m) => !globalGeminiCoordinator.isModelExhausted(lane.apiKey, m.id, m.rpd))
      if (!hasActiveModel) return
      if (lane.chunkUploads.has(ci) || !this.claimPrefetch(job, lane, ci)) return
      void this.startChunkUpload(job, lane, ci, true).catch(() => job.prefetchOwner.delete(ci))
    })
  }

  // ---------- Twelve Labs pre-filter (optional, accuracy-first) ----------

  /** OPTIONAL embedding pre-filter. Runs ONLY when the user's Twelve Labs key
   *  is set AND the movie's segment embeddings were saved at index time.
   *  Decides WHICH movie chunks each short minute is scanned against — the
   *  Gemini pipeline itself (prompts, chunk cutting, models, verification) is
   *  completely untouched. ANY error here = silent fallback to a normal full
   *  scan; the scan NEVER fails because of Twelve Labs. */
  private async applyTwelveLabsPrefilter(job: Job) {
    const { scan } = job
    const allSegs = scan.shortSegments || []
    const selectedSegs = allSegs.filter((s) => s.selected !== false)
    const countPending = () =>
      selectedSegs.reduce((n, s) => n + s.chunks.filter((c) => c.status === 'pending').length, 0)

    /** Fall back to the normal FULL scan: drop every pre-filter selection and
     *  revive pre-filter-cancelled chunks (range-skipped chunks stay skipped). */
    const fullScan = (reason: string, attempted: boolean) => {
      for (const seg of allSegs) {
        if (Array.isArray(seg.prefilterChunks)) delete seg.prefilterChunks
        delete seg.chunkConfidence
        delete seg.tlWindows
        for (const c of seg.chunks) {
          if (c.status === 'cancelled' && chunkOverlapsSegRange(scan, seg, c.index)) c.status = 'pending'
        }
        if (seg.status === 'done' && seg.chunks.some((c) => c.status === 'pending')) seg.status = 'pending'
      }
      const total = countPending()
      scan.prefilter = { mode: 'full', selectedChunks: total, totalChunks: total, reason, at: Date.now() }
      if (attempted) addLog(scan, 'warn', `Twelve Labs pre-filter skipped (${reason}) — normal FULL scan chal raha hai (accuracy 100% safe)`)
      this.mark(job)
    }

    if (!job.tlKey) {
      // No key = feature off. Don't even set scan.prefilter noise beyond mode.
      fullScan('Twelve Labs key not set', false)
      return
    }

    try {
      // 1) Movie embeddings MUST already be saved (one-time indexing via the button).
      const movieEmb = await loadEmbeddings(scan.id, 'movie')
      if (!movieEmb) {
        fullScan('movie Twelve Labs par indexed nahi hai', true)
        return
      }

      // 2) Short embeddings: reuse the cached copy, else upload + poll + save once.
      let shortEmb = await loadEmbeddings(scan.id, 'short')
      if (!shortEmb) {
        const shortFile = path.join(scanMediaDir(scan.id), 'short.mp4')
        if (!fs.existsSync(shortFile)) {
          fullScan('short video file missing locally', true)
          return
        }
        addLog(scan, 'info', 'Twelve Labs pre-filter: short video upload + indexing (embeddings ke liye)...')
        this.mark(job)
        const indexId = movieEmb.indexId || (await ensureIndex(job.tlKey))
        const { taskId } = await createIndexTask(job.tlKey, indexId, shortFile)
        const videoId = await pollTaskUntilReady(job.tlKey, taskId, { intervalMs: 5000, timeoutMs: 30 * 60_000 })
        const segs = await fetchVideoEmbeddings(job.tlKey, indexId, videoId)
        shortEmb = { indexId, videoId, savedAt: Date.now(), segments: segs }
        await saveEmbeddings(scan.id, 'short', shortEmb)
        addLog(scan, 'success', `Twelve Labs pre-filter: short ke ${segs.length} segment embedding(s) ready (cached for resume)`)
      }

      // 3) Cosine-similarity matching (threshold 0.82, ±1 buffer chunks).
      const result = computePrefilterChunks(scan, selectedSegs, shortEmb.segments, movieEmb.segments)
      if (!result.perSegment) {
        // ACCURACY RULE: some short segment matched nowhere — never trust the
        // pre-filter in that case. Full scan.
        fullScan(result.reason || 'low-confidence pre-filter', true)
        return
      }

      // 4) Apply the selection: revive selected chunks, cancel unselected pending
      //    ones. Range-skipped chunks stay skipped (existing quota-saver logic).
      const totalBefore = selectedSegs.reduce(
        (n, s) => n + s.chunks.filter((c) => c.status === 'pending' || c.status === 'cancelled').length,
        0,
      )
      for (const seg of selectedSegs) {
        const set = result.perSegment.get(seg.index) ?? new Set<number>()
        seg.prefilterChunks = [...set].sort((a, b) => a - b)
        // CONFIDENCE (high→low ordering) + EXPECTED WINDOWS (early-stop system):
        // persist both so Resume keeps the same ordering + early-stop behaviour.
        const conf = result.confidence?.get(seg.index)
        seg.chunkConfidence = conf ? Object.fromEntries([...conf.entries()].map(([k, v]) => [String(k), v])) : undefined
        const windows = result.expectedWindows?.get(seg.index)
        seg.tlWindows = windows && windows.length > 0 ? windows : undefined
        for (const c of seg.chunks) {
          const inRange = chunkOverlapsSegRange(scan, seg, c.index)
          if (c.status === 'cancelled' && set.has(c.index) && inRange) c.status = 'pending'
          if (c.status === 'pending' && !set.has(c.index)) c.status = 'cancelled'
        }
        if (seg.status === 'done' && seg.chunks.some((c) => c.status === 'pending')) seg.status = 'pending'
      }
      const selected = countPending()
      scan.prefilter = {
        mode: 'prefiltered',
        selectedChunks: selected,
        totalChunks: Math.max(totalBefore, selected),
        at: Date.now(),
      }
      addLog(
        scan,
        'success',
        `Twelve Labs pre-filter: ${selected} of ${Math.max(totalBefore, selected)} chunks selected (threshold ${TL_SIMILARITY_THRESHOLD}, ±1 buffer chunks) — sirf yehi chunks Gemini ko jayenge`,
      )
      // PER-MINUTE BREAKDOWN (UI + logs): har minute ke planned chunks + expected windows.
      for (const seg of selectedSegs) {
        const n = seg.chunks.filter((c) => c.status === 'pending').length
        if (n > 0) {
          addLog(
            scan,
            'info',
            `Twelve Labs plan — Minute ${seg.index + 1}: ${n} chunk(s) scan honge${seg.tlWindows?.length ? `, ${seg.tlWindows.length} expected match window(s) (early-stop active: sab windows confirm hote hi bache chunks skip)` : ''}`,
          )
        }
      }
      this.mark(job)
    } catch (err) {
      // ANY Twelve Labs failure = silent fallback. The scan itself never fails.
      fullScan(err instanceof Error ? err.message.slice(0, 160) : String(err), true)
    }
  }

  private async runScan(job: Job) {
    const { scan } = job
    const segments = scan.shortSegments || []
    const multi = segments.length > 1

    // OPTIONAL Twelve Labs pre-filter: decides which chunks to scan. Errors
    // here can never fail the scan — worst case is a normal full scan.
    await this.applyTwelveLabsPrefilter(job)
    if (job.stopping) {
      scan.status = 'stopped'
      this.buildPartialReport(job)
      this.finish(job)
      return
    }

    // Reset transient verify states from an interrupted run + queue any groups
    // still pending from a previous session (verification-only resume).
    this.prepareVerifyState(scan)
    this.enqueueNewGroups(job, true)

    // GLOBAL VERIFY PIPELINE: verify workers start ONCE and keep running in the
    // background for the WHOLE scan — chunk models aur verify models alag hain,
    // isliye minute N ki verification chalte hue minute N+1 ke chunks scan hote
    // hain (user request: sab chunks settle hote hi aage badho, verification ka
    // wait mat karo — wo background me chalti rahegi).
    let verifyPhase: Promise<unknown> = Promise.resolve()
    const startVerifyWorkers = () => {
      if (scan.verifierEnabled === false) {
        verifyPhase = Promise.resolve()
        return
      }
      const ws: Promise<void>[] = []
      for (const lane of job.lanes) {
        for (const m of VERIFY_MODEL_POOL) {
          ws.push(this.verifyWorker(job, lane, m, 0))
        }
      }
      verifyPhase = Promise.all(ws)
    }
    job.chunkPhaseDone = false
    startVerifyWorkers()

    // OUTER PASSES: agar early-stop ke baad koi group REJECT ho jaye aur uske
    // minute ke skipped chunks wapas pending ho jayen, to ek aur pass chalega.
    const MAX_PASSES = 6
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      job.earlyStopRevived = false

      // PER-MINUTE CHUNK PASSES: within a minute the three dedicated CHUNK models
      // map chunks while the global verify workers check candidates in parallel.
      for (const seg of segments) {
        if (job.stopping) break
        // MINUTE SELECTION: unselected minutes are skipped entirely (quota saver).
        if (seg.selected === false) continue
        const pending = seg.chunks.filter((c) => c.status === 'pending')
        if (pending.length === 0) continue

        scan.currentShortSegment = seg.index
        job.seg = seg
        // Mirror: scan.chunks IS this segment's chunks array (same reference),
        // so the existing worker code + UI keep working unchanged.
        scan.chunks = seg.chunks
        if (!job.stopping) scan.status = 'scanning'
        seg.status = 'scanning'
        // CONFIDENCE ORDER (TwelveLabs): sabse zyada confident chunks PEHLE scan
        // hote hain — matches jaldi milte hain, early-stop jaldi fire hota hai.
        job.queue = this.orderByConfidence(seg, pending.map((c) => c.index))
        const hasConf = Boolean(seg.chunkConfidence && Object.keys(seg.chunkConfidence).length > 0)
        this.mark(job)

        if (multi) {
          const r = segMovieRange(scan, seg)
          const rangeNote = segHasMinuteList(seg)
            ? ` (movie minutes [${formatMinuteList(seg.movieMinutes!)}] only — ${seg.movieMinutes!.length} listed, gap chunks skipped)`
            : r.custom
              ? ` (movie range ${ts(r.start)}–${ts(r.end)} only — baaki chunks skipped)`
              : ''
          addLog(scan, 'info', `Minute ${seg.index + 1}/${segments.length}: scanning short ${ts(seg.start)}–${ts(seg.end)} against ${pending.length} pending movie chunk(s)${rangeNote}${hasConf ? ' — confidence order high→low' : ''}`)
        }
        addLog(
          scan,
          'info',
          `Pipeline parallelism ON: chunk models (${CHUNK_MODEL_POOL.map((m) => m.id).join(', ')}) map chunks while verify models check candidates in the background — verification ke liye agla minute WAIT NAHI karta`,
        )
        this.mark(job)

        // NEXT-MINUTE PREP (fire-and-forget): while THIS minute scans, the
        // next selected minute's segment upload + chunk cutting run in the
        // background so the next pass starts instantly.
        this.prepareNextSegment(job, segments, seg.index)

        // CHUNK PIPELINE: one worker per (key lane × CHUNK model) — these
        // workers ONLY do chunk mapping, never verification.
        const chunkWorkers: Promise<void>[] = []
        for (const lane of job.lanes) {
          for (const m of CHUNK_MODEL_POOL) chunkWorkers.push(this.worker(job, lane, m))
        }
        await Promise.all(chunkWorkers)
        // Catch any candidates merged by the very last chunk.
        this.enqueueNewGroups(job)

        if (job.stopping) break
        // Quota exhausted mid-minute: chunks still pending — do NOT advance.
        if (seg.chunks.some((c) => c.status === 'pending' || c.status === 'scanning')) break

        // Minute ke saare chunks settle — turant AGLE minute par badho.
        // Is minute ki bachi verification background me poori hoti rahegi.
        const segGroups = (scan.candidateGroups || []).filter((g) => g.shortStart < seg.end && g.shortEnd > seg.start)
        const unresolved =
          scan.verifierEnabled === false
            ? []
            : segGroups.filter((g) => g.status === 'pending' || g.status === 'verifying' || g.status === 'rescanning')
        seg.status = unresolved.length > 0 ? 'verifying' : 'done'
        if (multi) {
          addLog(
            scan,
            'success',
            unresolved.length > 0
              ? `Minute ${seg.index + 1}/${segments.length}: chunk scan complete — ${unresolved.length} group(s) background me verify ho rahe hain, agla minute abhi start ho raha hai (no wait)`
              : `Minute ${seg.index + 1}/${segments.length} complete — mapped + verified against the whole movie`,
          )
        }
        this.mark(job)
      }

      // All minutes' chunk phases done (or quota-blocked) — let the verify
      // pipeline drain fully now.
      job.seg = null
      job.chunkPhaseDone = true
      // STOP GUARD: stop ke baad status kabhi 'stopped' se wapas 'verifying'
      // nahi hota — warna export/preview panel phir chhup jaata.
      if (
        !job.stopping &&
        scan.verifierEnabled !== false &&
        (job.verifyQueue.length > 0 || job.verifyInFlight.size > 0)
      ) {
        scan.status = 'verifying'
        this.mark(job)
      }
      await verifyPhase

      // EARLY-STOP REVIVE PASS: kisi rejected group ne skipped chunks wapas
      // pending kiye? To unhe scan karne ke liye ek aur pass chalao.
      const revivedPending = segments.some(
        (s) => s.selected !== false && s.chunks.some((c) => c.status === 'pending'),
      )
      if (job.stopping || !job.earlyStopRevived || !revivedPending) break
      addLog(scan, 'warn', `Early-stop revive: rejected match ki wajah se kuch skipped chunks wapas queue me hain — extra scan pass ${pass + 2} start`)
      job.chunkPhaseDone = false
      startVerifyWorkers()
    }

    // All work over. Persist final model states.
    for (const lane of job.lanes) {
      for (const m of MODEL_POOL) {
        const s = this.modelState(job, lane, m)
        if (s.state === 'active' || s.state === 'waiting') s.state = 'idle'
        s.currentChunk = null
      }
    }

    if (job.stopping) {
      scan.status = 'stopped'
      this.buildPartialReport(job)
      addLog(scan, 'warn', 'Scan stopped. Pending chunks saved — use Resume to continue. Ab tak ke results (unverified samet) export/preview ke liye ready hain.')
      this.finish(job)
      return
    }

    const groups = scan.candidateGroups || []
    const leftover = groups.filter((g) => g.status === 'pending' || g.status === 'verifying' || g.status === 'rescanning')
    const chunksLeft = segments.some((s) => s.chunks.some((c) => c.status === 'pending' || c.status === 'scanning'))

    // Quota ran out mid-scan/mid-verification: keep the scan resumable instead of finishing.
    if (leftover.length > 0 || chunksLeft) {
      scan.status = 'stopped'
      this.buildPartialReport(job)
      addLog(
        scan,
        'warn',
        leftover.length > 0
          ? `Verification paused: ${leftover.length} group(s) still pending (daily quota exhausted?). Use Resume to continue.`
          : 'Scan paused: chunks still pending (daily quota exhausted?). Use Resume to continue.',
      )
      this.finish(job)
      return
    }

    for (const seg of segments) if (seg.status !== 'done') seg.status = 'done'

    scan.status = 'done'
    scan.finishedAt = Date.now()
    scan.matches.sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)
    scan.report = this.reportStats(job, false)
    addLog(
      scan,
      'success',
      `Scan complete: ${scan.matches.length} matched segment(s)${multi ? ` across ${segments.length} short minute(s)` : ''} — ${scan.prefilter?.mode === 'prefiltered' ? 'Twelve Labs pre-filtered scan' : 'Full scan'}`,
    )
    // COVERAGE: kitna short actually merge me ja raha hai — MISSING hisse LOUD.
    this.logCoverage(job)
    cleanupClips(path.join(scanMediaDir(scan.id), 'clips'))
    addLog(scan, 'info', 'Temporary clip files cleaned up (movie chunks saved for future scan reuse)')
    this.finish(job)
  }

  // ---------- Candidate + Verifier pipeline ----------

  /** Group all chunk-phase matches by short segment: matches from different chunks that claim the
   *  same short-video scene (lesser or greater duration) become candidates of ONE group.
   *  Candidates are unlimited — every distinct movie window or chunk finding is saved. */
  private buildCandidateGroups(scan: Scan) {
    const groups: CandidateGroup[] = scan.candidateGroups || []
    const sorted = [...(scan.matches || [])]
      .sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)
    for (const m of sorted) {
      let g = groups.find((x) => sameShortSegment(x.shortStart, x.shortEnd, m.shortStart, m.shortEnd))
      if (!g) {
        g = {
          id: `g${groups.length}-${Math.random().toString(36).slice(2, 8)}`,
          shortStart: m.shortStart,
          shortEnd: m.shortEnd,
          status: m.verified ? 'confirmed' : 'pending',
          candidates: [],
          confirmedIndex: m.verified ? 0 : null,
          confirmedViaRescan: false,
          attempts: 0,
          // PROVENANCE: gap-backup matches carry their origin; everything else is the chunk scan.
          origin: m.origin ?? 'chunk',
          originWindow: m.originWindow,
        }
        groups.push(g)
      }
      // Check if this exact chunk match is already a candidate in this group
      const dup = g.candidates.some(
        (c) =>
          c.chunkIndex === m.chunkIndex &&
          Math.abs(c.movieStart - m.movieStart) < 0.5 &&
          Math.abs(c.movieEnd - m.movieEnd) < 0.5,
      )
      if (!dup) {
        g.candidates.push({
          shortStart: m.shortStart,
          shortEnd: m.shortEnd,
          movieStart: m.movieStart,
          movieEnd: m.movieEnd,
          chunkIndex: m.chunkIndex,
          model: m.model,
          confidence: m.confidence,
          verdict: m.verified ? 'same' : m.rejected ? 'different' : 'pending',
          rescan: 'none',
        })
        // If this match has longer coverage for the scene and is confirmed/active, update group range
        const mDur = m.shortEnd - m.shortStart
        const gDur = g.shortEnd - g.shortStart
        if (mDur > gDur && (m.verified || (m.confidence || 0) >= 0.5)) {
          g.shortStart = Math.min(g.shortStart, m.shortStart)
          g.shortEnd = Math.max(g.shortEnd, m.shortEnd)
        }
        // New evidence for an already-finished group (manual chunk retry) — reopen it if unverified.
        if (g.status === 'rejected' || g.status === 'unverified') g.status = 'pending'
      }

      // CRITICAL: If m has userPick, ensure g records it as userPick so applyGroupMatches preserves it!
      if (m.userPick) {
        const pickIdx = g.candidates.findIndex(
          (c) =>
            Math.abs(c.movieStart - m.movieStart) < 0.5 &&
            Math.abs(c.movieEnd - m.movieEnd) < 0.5,
        )
        if (pickIdx >= 0) {
          g.userPick = { index: pickIdx, viaRescan: !!m.viaRescan, at: Date.now() }
          g.status = 'confirmed'
          g.confirmedIndex = pickIdx
        }
      }
    }
    scan.candidateGroups = groups
    // Keep scan.matches cleanly synchronized: exactly one active match per candidate group
    for (const g of groups) {
      applyGroupMatches(scan, g)
    }
  }

  /** Reset transient candidate-group states left over from an interrupted run. */
  private prepareVerifyState(scan: Scan) {
    for (const g of scan.candidateGroups || []) {
      if (g.status === 'verifying' || g.status === 'rescanning') g.status = 'pending'
      for (const c of g.candidates) {
        if (c.verdict === 'verifying') c.verdict = 'pending'
        if (c.rescan === 'rescanning') c.rescan = 'pending'
        if (c.rescanVerdict === 'verifying') c.rescanVerdict = 'pending'
      }
    }
  }

  // ---------- TL confidence ordering + EARLY-STOP quick-confirm system ----------

  /** TwelveLabs confidence of a chunk within a minute (higher = scan/verify first). */
  private chunkConf(seg: ShortSegmentState, chunkIndex: number): number {
    return seg.chunkConfidence?.[String(chunkIndex)] ?? -1
  }

  /** Order chunk indexes by TL confidence HIGH → LOW (ties: natural order). */
  private orderByConfidence(seg: ShortSegmentState, indexes: number[]): number[] {
    return [...indexes].sort((a, b) => this.chunkConf(seg, b) - this.chunkConf(seg, a) || a - b)
  }

  /** Find the short minute a short-video timestamp belongs to. */
  private segForShortTime(scan: Scan, t: number): ShortSegmentState | null {
    return (scan.shortSegments || []).find((s) => t >= s.start && t < s.end) || null
  }

  /** Verify-priority of a candidate group = best TL confidence among its chunks. */
  private groupConfidence(scan: Scan, g: CandidateGroup): number {
    const seg = this.segForShortTime(scan, g.shortStart)
    if (!seg) return -1
    let best = -1
    for (const c of g.candidates) best = Math.max(best, this.chunkConf(seg, c.chunkIndex))
    return best
  }

  /** EARLY-STOP QUICK-CONFIRM (quota saver, accuracy-safe):
   *  Jab CURRENT minute ke SAB TwelveLabs expected windows par candidate mil
   *  chuke hain AUR har matched chunk ka kam se kam EK segment verifier se
   *  SAME confirm ho chuka hai — to us minute ke bache hue chunks scan karna
   *  band (cancelled + skippedEarlyStop). Baaki matches background me poori
   *  tarah verify hote rehte hain. Agar baad me koi group reject ho jaye to
   *  reviveEarlyStopSkipped() skipped chunks wapas queue me daal deta hai. */
  private checkEarlyStop(job: Job) {
    const { scan } = job
    const seg = job.seg
    if (!seg || job.stopping) return
    const windows = seg.tlWindows
    if (!windows || windows.length === 0) return
    // Kuch skip karne layak bacha bhi hai?
    if (!seg.chunks.some((c) => c.status === 'pending')) return

    const groups = (scan.candidateGroups || []).filter(
      (g) => g.shortStart < seg.end && g.shortEnd > seg.start && g.status !== 'rejected',
    )
    // 1) COVERAGE: har expected TL window par kam se kam ek candidate group ho.
    for (const w of windows) {
      if (!groups.some((g) => g.shortStart < w.end && g.shortEnd > w.start)) return
    }
    // 2) QUICK-CONFIRM: har contributing chunk ka apna 1 candidate SAME confirm ho
    //    (poore group ki jagah sirf 1 segment per chunk — baaki background me).
    const matchedChunks = new Set<number>()
    for (const g of groups) for (const c of g.candidates) matchedChunks.add(c.chunkIndex)
    if (matchedChunks.size === 0) return
    for (const ci of matchedChunks) {
      const confirmed = groups.some((g) =>
        g.candidates.some((c) => c.chunkIndex === ci && (c.verdict === 'same' || c.rescanVerdict === 'same')),
      )
      if (!confirmed) return
    }

    // Sab conditions poori — is minute ke bache chunks skip karo.
    let saved = 0
    for (const c of seg.chunks) {
      if (c.status === 'pending') {
        c.status = 'cancelled'
        c.skippedEarlyStop = true
        saved++
      }
    }
    job.queue = job.queue.filter((ci) => seg.chunks[ci]?.status === 'pending')
    seg.earlyStopSavedChunks = saved
    if (saved > 0) {
      addLog(
        scan,
        'success',
        `EARLY-STOP — Minute ${seg.index + 1}: sab ${windows.length} expected window(s) covered + har matched chunk (${matchedChunks.size}) ka 1 segment SAME confirm — bache ${saved} chunk(s) skip, quota saved. Baaki matches background me verify ho rahe hain.`,
      )
      this.mark(job)
    }
  }

  /** Group REJECT hone par: agar uske minute me early-stop se skip hue chunks
   *  hain aur us short window ka ab koi zinda candidate nahi bacha, to skipped
   *  chunks wapas pending karke scan me daalo — sahi match ab bhi mil sakta hai. */
  private reviveEarlyStopSkipped(job: Job, g: CandidateGroup) {
    const { scan } = job
    const seg = this.segForShortTime(scan, g.shortStart)
    if (!seg) return
    const skipped = seg.chunks.filter((c) => c.status === 'cancelled' && c.skippedEarlyStop)
    if (skipped.length === 0) return
    // Kya is short window par ab bhi koi non-rejected group hai? Ho to revive ki zaroorat nahi.
    const stillCovered = (scan.candidateGroups || []).some(
      (x) => x !== g && x.status !== 'rejected' && sameShortSegment(x.shortStart, x.shortEnd, g.shortStart, g.shortEnd),
    )
    if (stillCovered) return
    for (const c of skipped) {
      c.status = 'pending'
      delete c.skippedEarlyStop
    }
    delete seg.earlyStopSavedChunks
    if (seg.status === 'done' || seg.status === 'verifying') seg.status = 'pending'
    job.earlyStopRevived = true
    // Agar yehi minute abhi bhi active hai to chunks LIVE queue me wapas jaate
    // hain; warna scan-loop ka agla pass unhe utha lega.
    if (job.seg === seg) {
      job.queue.push(...this.orderByConfidence(seg, skipped.map((c) => c.index)))
    }
    addLog(
      scan,
      'warn',
      `Minute ${seg.index + 1}: match reject hone se coverage toot gayi — early-stop se skip hue ${skipped.length} chunk(s) wapas scan queue me (accuracy first)`,
    )
    this.mark(job)
  }

  /** Incrementally (re)build candidate groups from fresh unverified matches and
   *  push every pending group that is not already queued or in flight onto the
   *  verify queue. Called after EVERY finished chunk so verification starts the
   *  moment a chunk's candidates exist — the verify pipeline never waits for
   *  the whole chunk phase. Safe against double-queueing (single-threaded). */
  private enqueueNewGroups(job: Job, logResume = false) {
    const { scan } = job
    this.buildCandidateGroups(scan)
    if (scan.verifierEnabled === false) {
      // Verifier OFF: settle all pending candidate groups as unverified immediately
      for (const g of scan.candidateGroups || []) {
        if (g.status === 'pending' || g.status === 'verifying' || g.status === 'rescanning') {
          g.status = 'unverified'
          this.applyGroupResult(job, g)
        }
      }
      return
    }
    const groups = scan.candidateGroups || []
    let added = 0
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].status !== 'pending') continue
      if (job.verifyQueue.includes(i) || job.verifyInFlight.has(i)) continue
      job.verifyQueue.push(i)
      added++
    }
    if (added > 0) {
      // ORDER 1 — CHUNK COVERAGE FIRST (early-stop accelerator): jis group ke
      // chunks me se koi bhi abhi tak quick-confirm NAHI hua, wo group PEHLE
      // verify hota hai — taaki har matched chunk ka 1 segment jaldi se jaldi
      // SAME confirm ho aur early-stop turant fire kare. Ek hi chunk ke kai
      // groups ko baar-baar pehle verify karne me quota lagta hai, coverage nahi badhti.
      // ORDER 2 — CONFIDENCE (TwelveLabs): high→low.
      const confirmedChunks = new Set<number>()
      for (const g of groups) {
        for (const c of g.candidates) {
          if (c.verdict === 'same' || c.rescanVerdict === 'same') confirmedChunks.add(c.chunkIndex)
        }
      }
      const coversNewChunk = (g: CandidateGroup): number =>
        g.candidates.some((c) => !confirmedChunks.has(c.chunkIndex)) ? 1 : 0
      job.verifyQueue.sort(
        (a, b) =>
          coversNewChunk(groups[b]) - coversNewChunk(groups[a]) ||
          this.groupConfidence(scan, groups[b]) - this.groupConfidence(scan, groups[a]),
      )
    }
    if (added > 0) {
      addLog(
        scan,
        'info',
        logResume
          ? `Verification resume: ${added} candidate group(s) still pending — queued across ${job.lanes.length} API key(s) × ${VERIFY_MODEL_POOL.length} verify models (${VERIFY_CONCURRENCY_PER_MODEL} req/model in parallel)`
          : `Verify pipeline: ${added} new candidate group(s) queued (${job.verifyQueue.length} waiting, ${job.verifyInFlight.size} in flight) — chunk models keep scanning in parallel`,
      )
      this.mark(job)
    }
  }

  /** One verifier worker per (key lane × model) — pulls whole groups off the queue. */
  private async verifyWorker(job: Job, lane: KeyLane, m: ModelSpec, slot: number = 0) {
    const { scan } = job
    while (true) {
      if (job.stopping || scan.verifierEnabled === false) return
      const st = this.modelState(job, lane, m)

      // Fast RPD check via coordinator
      if (globalGeminiCoordinator.isModelExhausted(lane.apiKey, m.id, m.rpd)) {
        if (st.state !== 'exhausted') {
          st.state = 'exhausted'
          st.currentChunk = null
          this.mark(job)
        }
        return
      }
      if (st.state === 'exhausted') {
        st.state = 'idle'
        this.mark(job)
      }

      // Cooldown check (RPM/TPM-type 429)
      const cool = job.cooldownUntil[this.rateKey(lane, m)] || 0
      if (cool > Date.now()) {
        st.state = 'cooling'
        st.cooldownUntil = cool
        this.mark(job)
        await sleep(Math.min(2000, cool - Date.now()))
        continue
      }
      st.cooldownUntil = null

      // Central Coordinator Verifier Orchestrator (coordinates verifiers across ALL parallel scans):
      // Checks capacity and stagger delay so multiple parallel scans do not fire in a burst after cooldown!
      const dispatchCheck = globalGeminiCoordinator.canDispatchVerifyOrRescan(lane.apiKey, m.id, m.rpd || 500)
      if (!dispatchCheck.ok) {
        st.state = dispatchCheck.cooling ? 'cooling' : 'waiting'
        await sleep(Math.max(500, Math.min(2500, dispatchCheck.waitMs || 1000)))
        continue
      }

      // PER-KEY & PER-MODEL VERIFIER CAP:
      const modelActive = lane.verifyActiveByModel?.get(m.id) || 0
      if (modelActive >= VERIFY_CONCURRENCY_PER_MODEL || lane.verifyActive >= VERIFY_PER_LANE) {
        if (job.verifyQueue.length === 0 && job.verifyInFlight.size === 0 && job.chunkPhaseDone) return
        st.state = 'waiting'
        await sleep(250)
        continue
      }

      const gi = job.verifyQueue.shift()
      if (gi === undefined) {
        // PIPELINE PARALLELISM: while the chunk phase is still running, verify
        // workers idle-wait — new candidate groups arrive as chunks finish.
        // Only exit once the chunk phase is done AND nothing is in flight.
        if (job.verifyInFlight.size === 0 && job.chunkPhaseDone) {
          if (st.state !== 'idle') {
            st.state = 'idle'
            this.mark(job)
          }
          return
        }
        st.state = 'waiting'
        await sleep(150)
        continue
      }

      const g = (scan.candidateGroups || [])[gi]
      if (!g || (g.status !== 'pending' && g.status !== 'verifying' && g.status !== 'rescanning')) continue

      // SUPERSEDED: a confirmed group already covers this short window
      const winner = this.confirmedCovering(scan, g)
      if (winner) {
        this.supersedeGroup(job, g, winner)
        continue
      }

      job.verifyInFlight.add(gi)
      lane.verifyActive++
      lane.verifyActiveByModel.set(m.id, (lane.verifyActiveByModel.get(m.id) || 0) + 1)
      st.state = 'active'
      this.mark(job)

      try {
        await this.processGroup(job, lane, m, g, slot)
      } catch (err) {
        const e = err instanceof GeminiError ? err : classifyError(err)
        if (e.kind === 'invalid_key') {
          const laneState = job.scan.keyLanes.find((l) => l.idx === lane.idx)
          if (laneState) {
            laneState.status = 'error'
            laneState.lastError = 'API key invalid or expired'
          }
          job.verifyQueue.push(gi)
          addLog(scan, 'error', `Verifier: API Key ${lane.idx} is invalid/expired — disabled for this scan; group ${g.id} re-queued for another key`)
        } else if (e.kind === 'rpd' || e.kind === 'rate') {
          // EXACT SAME SYSTEM AS CHUNKS:
          const modelCap = m.rpd || getModelDailyCap(m.id)
          const quotaOutcome = globalGeminiCoordinator.handleQuotaOrRateError(
            lane.apiKey,
            m.id,
            0,
            modelCap,
            e.kind === 'rpd',
          )
          if (quotaOutcome.action === 'exhausted') {
            setModelExhausted(m.id, lane.apiKey, modelCap)
            const laneState = job.scan.keyLanes?.find((l) => l.idx === lane.idx)
            if (laneState) {
              const ms = laneState.models.find((item) => item.id === m.id)
              if (ms) ms.state = 'exhausted'
            }
            addLog(scan, 'warn', `Verifier: ${m.id} (key ${lane.idx}): ${quotaOutcome.reason}. Model set aside today; group ${g.id} re-queued for another worker.`)
          } else {
            job.cooldownUntil[this.rateKey(lane, m)] = Date.now() + CHUNK_COOLDOWN_MS
            const laneState = job.scan.keyLanes.find((l) => l.idx === lane.idx)
            if (laneState) {
              const ms = laneState.models?.find((item) => item.id === m.id)
              if (ms) ms.state = 'cooling'
            }
            addLog(scan, 'warn', `Verifier: ${m.id} (key ${lane.idx}): ${quotaOutcome.reason}. Group ${g.id} re-queued; model cooling for 1m 10s.`)
          }
          job.verifyQueue.push(gi)
        } else {
          g.attempts += 1
          if (g.attempts >= MAX_GROUP_ATTEMPTS) {
            g.status = 'unverified'
            this.applyGroupResult(job, g)
            addLog(scan, 'error', `Group ${g.id} (short ${ts(g.shortStart)}–${ts(g.shortEnd)}) could not be verified after ${g.attempts} attempts — original match kept, flagged unverified: ${e.message.slice(0, 120)} ${originTag(groupMatchOrigin(g, false), g.candidates[0]?.chunkIndex, g.originWindow)}`)
          } else {
            job.verifyQueue.push(gi)
            addLog(scan, 'warn', `Verifier attempt ${g.attempts} failed for group ${g.id} on ${m.id} (key ${lane.idx}) — re-queued: ${e.message.slice(0, 120)}`)
          }
        }
        this.mark(job)
      } finally {
        job.verifyInFlight.delete(gi)
        lane.verifyActive = Math.max(0, lane.verifyActive - 1)
        const rem = Math.max(0, (lane.verifyActiveByModel.get(m.id) || 1) - 1)
        lane.verifyActiveByModel.set(m.id, rem)
        if (rem === 0 && st.state === 'active') st.state = 'idle'
        this.mark(job)
      }
    }
  }

  /** Fraction of `inner` (short-video window) covered by `outer`. */
  private coverage(innerStart: number, innerEnd: number, outerStart: number, outerEnd: number): number {
    const len = innerEnd - innerStart
    if (len <= 0) return 0
    const overlap = Math.min(innerEnd, outerEnd) - Math.max(innerStart, outerStart)
    return overlap <= 0 ? 0 : overlap / len
  }

  /** A CONFIRMED group whose short window covers ≥ 80% of this group's short window, if any. */
  private confirmedCovering(scan: Scan, g: CandidateGroup): CandidateGroup | null {
    for (const other of scan.candidateGroups || []) {
      if (other === g || other.status !== 'confirmed') continue
      if (this.coverage(g.shortStart, g.shortEnd, other.shortStart, other.shortEnd) >= 0.8) return other
    }
    return null
  }

  /** Settle a group without a verifier call because a confirmed group already
   *  owns its short window. Counted as rejected (so totals still add up) and
   *  every candidate row is dropped from scan.matches. */
  private supersedeGroup(job: Job, g: CandidateGroup, winner: CandidateGroup) {
    const { scan } = job
    g.status = 'rejected'
    for (const c of g.candidates) {
      if (c.verdict === 'pending' || c.verdict === 'verifying') {
        c.verdict = 'different'
        c.verifierReason = `superseded — short ${ts(winner.shortStart)}–${ts(winner.shortEnd)} already confirmed (group ${winner.id})`
      }
    }
    this.applyGroupResult(job, g)
    addLog(
      scan,
      'info',
      `Group ${g.id} (short ${ts(g.shortStart)}–${ts(g.shortEnd)}) superseded by confirmed group ${winner.id} — ${g.candidates.length} duplicate candidate(s) dropped, no verifier call`,
    )
  }

  /** After a group is CONFIRMED: drop competing rows for the same short window.
   *  Adjacent chunks (66/67, 68/69 — 1-min boundary overlap) both report the same
   *  short second, so a confirmed 0:06–0:07 used to sit next to two "no" rows
   *  (1:07:00, 1:07:07) in the table and export. Pending/unfinished groups that the
   *  winner covers are settled as superseded; loose unverified matches are removed. */
  private pruneSuperseded(job: Job, winner: CandidateGroup) {
    const { scan } = job
    for (const g of scan.candidateGroups || []) {
      if (g === winner || g.status === 'confirmed') continue
      if (g.status !== 'pending' && g.status !== 'unverified') continue
      if (this.coverage(g.shortStart, g.shortEnd, winner.shortStart, winner.shortEnd) >= 0.8) {
        this.supersedeGroup(job, g, winner)
      }
    }
    scan.matches = (scan.matches || []).filter(
      (m) => m.verified === true || m.userPick === true || this.coverage(m.shortStart, m.shortEnd, winner.shortStart, winner.shortEnd) < 0.8,
    )
  }

  /** Pace + count one verifier/rescan request on this (key × model) lane.
   *  Pacing is sized from the ACTUAL video seconds so small verify clips only
   *  wait seconds while full 1-minute rescans wait the whole minute — full TPM capacity. */
  private async paceAndSend<T>(
    job: Job,
    lane: KeyLane,
    m: ModelSpec,
    videoSeconds: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (getModelUsage(m.id, lane.apiKey) >= m.rpd) throw new GeminiError('rpd', `${m.id} daily cap reached`)
    const pk = this.paceSlotKey(lane, m, 0)
    const st = this.modelState(job, lane, m)

    let releaseGlobalLock: ((sec?: number, cd?: number) => void) | null = null
    let hasRateError = false
    try {
      releaseGlobalLock = await globalGeminiCoordinator.acquireLane({
        scanId: job.scan.id,
        scanTitle: job.scan.shortName || job.scan.id,
        apiKey: lane.apiKey,
        keyIdx: lane.idx,
        modelId: m.id,
        slot: 0,
        operation: `Verify/Rescan on ${m.id}`,
        videoSeconds,
        rpd: m.rpd || 500,
        onWait: (msg) => {
          st.state = 'waiting'
          addLog(job.scan, 'info', msg)
          this.mark(job)
        },
        isStopping: () => job.stopping,
      })

      const wait = (job.nextFreeAt[pk] || 0) - Date.now()
      if (wait > 0) {
        st.state = 'waiting'
        this.mark(job)
        await this.stoppableSleep(job, wait)
      }
      // STOP CHECK: quota consume karne se PEHLE nikal jao — 'rate' kind se group
      // bina attempt-penalty ke re-queue hota hai aur worker loop stopping par exit karta hai.
      if (job.stopping) throw new GeminiError('rate', 'Stop requested — request cancelled before send')
      st.state = 'active'
      job.nextFreeAt[pk] = Date.now() + pacingIntervalMs(videoSeconds, m.id)
      try {
        const rawRes = await fn()
        st.usedToday = incrementModelUsage(m.id, lane.apiKey)
        globalGeminiCoordinator.recordSuccess(lane.apiKey, m.id, 0)
        this.mark(job)
        return rawRes
      } catch (err) {
        const e = err instanceof GeminiError ? err : classifyError(err)
        if (e.kind === 'rate' || e.kind === 'rpd') {
          hasRateError = true
          const modelCap = m.rpd || getModelDailyCap(m.id)
          const outcome = globalGeminiCoordinator.handleQuotaOrRateError(
            lane.apiKey,
            m.id,
            0,
            modelCap,
            e.kind === 'rpd',
          )
          if (outcome.action === 'exhausted') {
            setModelExhausted(m.id, lane.apiKey, modelCap)
            st.state = 'exhausted'
          } else {
            job.cooldownUntil[pk] = Date.now() + CHUNK_COOLDOWN_MS
            job.cooldownUntil[this.rateKey(lane, m)] = Date.now() + CHUNK_COOLDOWN_MS
            st.state = 'cooling'
          }
        }
        throw err
      }
    } finally {
      if (releaseGlobalLock) releaseGlobalLock(videoSeconds, hasRateError ? CHUNK_COOLDOWN_MS : undefined)
    }
  }

  /** Send verify/rescan request directly through coordinator-paced lane.
   *  On 503/server overload: retries after 2s backoff.
   *  On 429 rate limit: immediately throws 'rate' so paceAndSend + global coordinator
   *  cooldown and re-queue handle it, preventing concurrent stampedes and infinite 429 loops! */
  private async sendWithClipBackup(
    job: Job,
    lane: KeyLane,
    filePath: string,
    mainUri: string,
    uploadedNames: string[],
    send: (uri: string) => Promise<string>,
    busyLabel: string,
  ): Promise<string> {
    if (job.stopping) throw new GeminiError('rate', 'Stop requested')
    try {
      return await send(mainUri)
    } catch (err) {
      const e = err instanceof GeminiError ? err : classifyError(err)
      // Rate limits (429) & quota errors: throw immediately to paceAndSend / coordinator!
      if (e.kind === 'rate' || e.kind === 'rpd') {
        throw e
      }
      // On temporary server errors (503/overload), wait 2s and retry once
      const transient = /overload|busy|503|500|internal|try again|temporarily/i.test(e.message)
      if (!transient) throw err

      addLog(job.scan, 'warn', `${busyLabel}: API server busy (503/overload) — retrying in 2s...`)
      this.mark(job)
      await sleep(2000)
      return await send(mainUri)
    }
  }

  /** Full verify → rescan → re-verify pipeline for ONE candidate group.
   *  All clips are cut with millisecond precision and sent to Gemini at 24 fps. */
  private async processGroup(job: Job, lane: KeyLane, m: ModelSpec, g: CandidateGroup) {
    const { scan } = job
    const mediaDir = scanMediaDir(scan.id)
    const clipsDir = path.join(mediaDir, 'clips')
    if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true })
    const shortDur = Math.max(1, g.shortEnd - g.shortStart)

    // ---- PADDING (only for very small segments) ----
    // Segments shorter than 1.5s are too small for Gemini to compare reliably
    // (a 0.4s clip is ~10 frames). Pad BOTH clips equally on each side so the
    // model gets enough context, and tell it EXACTLY where the real target
    // window sits inside the padded clips (so extra padded scenes never confuse it).
    // Final report timestamps stay ORIGINAL — padding is for verification only.
    const segDur = g.shortEnd - g.shortStart
    const needsPad = segDur < 1.5
    const PAD_EACH = 0.75
    const shortTotal = scan.shortDuration || g.shortEnd
    const padBefore = needsPad ? Math.min(PAD_EACH, Math.max(0, g.shortStart)) : 0
    const padAfter = needsPad ? Math.min(PAD_EACH, Math.max(0, shortTotal - g.shortEnd)) : 0
    const tgtStart = padBefore
    const tgtEnd = padBefore + segDur
    const verifyPadNote = needsPad
      ? `IMPORTANT — PADDING NOTE (dhyan se padho):\nDono clips me asli TARGET SEGMENT sirf ${ts(tgtStart)} se ${ts(tgtEnd)} tak hai (har clip ki apni clock par). Is window ke pehle aur baad ka content sirf PADDING hai jo context ke liye joda gaya hai — wahan alag scene ho sakta hai, us se CONFUSE mat hona. SAME/DIFFERENT ka faisla SIRF target window ${ts(tgtStart)}–${ts(tgtEnd)} ke frames aur audio par karo. Agar target window ka footage exact same hai to VERDICT: SAME do, chahe padding area me kuch bhi ho.`
      : undefined
    const rescanPadNote = needsPad
      ? `IMPORTANT — PADDING NOTE (dhyan se padho):\nVideo 1 me asli TARGET SEGMENT sirf ${ts(tgtStart)} se ${ts(tgtEnd)} tak hai (Video 1 ki apni clock par). Uske pehle aur baad ka content sirf PADDING hai — context ke liye joda gaya hai. HISSA 1 me poora Video 1 map karo, lekin MATCH sirf TARGET window ${ts(tgtStart)}–${ts(tgtEnd)} ke liye do — matched movie window ki duration EXACTLY ${segDur.toFixed(3)}s honi chahiye (padding wali duration NAHI).`
      : undefined

    // VERIFY models: gemini-3.5-flash-lite + gemini-3.1-flash-lite ONLY (500 RPD each).
    // Instant pre-flight check: ensure quota remaining before cutting clips or uploading
    const pickVerifyModel = (): ModelSpec => {
      if (!globalGeminiCoordinator.isModelExhausted(lane.apiKey, m.id, m.rpd)) return m
      const fallback = VERIFY_MODEL_POOL.find((x) => !globalGeminiCoordinator.isModelExhausted(lane.apiKey, x.id, x.rpd))
      if (!fallback) {
        throw new GeminiError(
          'other',
          `Verify models (${VERIFY_MODEL_POOL.map((x) => x.id).join(', ')}) exhausted on key ${lane.idx} — group re-queued for another key`,
        )
      }
      return fallback
    }

    g.status = 'verifying'
    this.mark(job)

    // Cut + upload the short-video segment ONCE for this group (per-key upload).
    // Small segments are cut WITH padding; the padding note tells the model where the target is.
    const shortClipFile = path.join(clipsDir, `${g.id}-short.mp4`)
    await extractClipPrecise(path.join(mediaDir, 'short.mp4'), g.shortStart - padBefore, g.shortEnd + padAfter, shortClipFile)
    const shortClip = await uploadVideo(lane.ai, shortClipFile)
    const uploadedNames: string[] = [shortClip.name]

    try {
      // ----- STEP 1: verify each candidate's exact movie window -----
      for (let i = 0; i < g.candidates.length; i++) {
        if (job.stopping) return
        const c = g.candidates[i]
        if (c.verdict === 'same' || c.verdict === 'different') continue
        c.verdict = 'verifying'
        this.mark(job)

        const movieClipFile = path.join(clipsDir, `${g.id}-c${i}-movie.mp4`)
        await extractClipPrecise(path.join(mediaDir, 'movie.mp4'), Math.max(0, c.movieStart - padBefore), c.movieEnd + padAfter, movieClipFile)
        const movieClip = await uploadVideo(lane.ai, movieClipFile)
        uploadedNames.push(movieClip.name)

        const vm = pickVerifyModel()
        addLog(scan, 'info', `Verify: short ${ts(g.shortStart)}–${ts(g.shortEnd)} vs movie ${ts(c.movieStart)}–${ts(c.movieEnd)}${needsPad ? ' (padded)' : ''} on ${vm.id} (key ${lane.idx})`)
        const clipSecs = shortDur + padBefore + padAfter + Math.max(1, c.movieEnd - c.movieStart) + padBefore + padAfter
        const raw = await this.paceAndSend(
          job,
          lane,
          vm,
          clipSecs,
          () =>
            this.sendWithClipBackup(
              job,
              lane,
              movieClipFile,
              movieClip.uri,
              uploadedNames,
              (uri) => verifyRequest(lane.ai, vm.id, shortClip.uri, uri, verifyPadNote),
              `Verify short ${ts(g.shortStart)}–${ts(g.shortEnd)} on ${vm.id} (key ${lane.idx})`,
              vm,
            ),
        )
        const v = parseVerdict(raw)
        if (!v) throw new GeminiError('other', 'Verifier gave no clear VERDICT line')

        c.verifierModel = vm.id
        c.verifierReason = v.reason
        c.verdict = v.same ? 'same' : 'different'
        this.mark(job)

        if (v.same) {
          g.status = 'confirmed'
          g.confirmedIndex = i
          g.confirmedViaRescan = false
          this.applyGroupResult(job, g)
          addLog(scan, 'success', `CONFIRMED: short ${ts(g.shortStart)}–${ts(g.shortEnd)} = movie ${ts(c.movieStart)}–${ts(c.movieEnd)} (verifier: ${vm.id}) ${originTag(groupMatchOrigin(g, false), c.chunkIndex, g.originWindow)}`)
          // EARLY-STOP QUICK-CONFIRM: is chunk ka 1 segment SAME confirm hua —
          // check karo ki current minute ke bache chunks ab skip ho sakte hain.
          this.checkEarlyStop(job)
          return
        }
        addLog(scan, 'warn', `Verifier says DIFFERENT for movie ${ts(c.movieStart)}–${ts(c.movieEnd)}${g.candidates.length > i + 1 ? ' — checking next candidate' : ''}`)
      }

      // ----- STEP 2: all candidates failed → rescan each candidate's full 1-minute chunk -----
      g.status = 'rescanning'
      this.mark(job)
      addLog(scan, 'warn', `All ${g.candidates.length} candidate(s) rejected for short ${ts(g.shortStart)}–${ts(g.shortEnd)} — rescanning their full chunks`)

      for (let i = 0; i < g.candidates.length; i++) {
        if (job.stopping) return
        const c = g.candidates[i]
        if (c.rescan === 'not_found' || c.rescanVerdict === 'different') continue

        // 2a. Rescan the full 1-minute chunk with the special segment-hunt prompt.
        if (c.rescan !== 'found') {
          c.rescan = 'rescanning'
          this.mark(job)
          // TRIM-AWARE: the chunk's absolute window in the ORIGINAL movie.
          const { start: chunkStart, end: chunkEnd } = chunkAbsWindow(scan, c.chunkIndex)

          // Reuse the original chunk file if it still exists, else cut it fresh from the movie.
          let chunkFile = chunkPath(path.join(mediaDir, 'chunks'), c.chunkIndex)
          if (!fs.existsSync(/*turbopackIgnore: true*/ chunkFile)) {
            chunkFile = path.join(clipsDir, `${g.id}-c${i}-chunk.mp4`)
            await extractClipPrecise(path.join(mediaDir, 'movie.mp4'), chunkStart, chunkEnd, chunkFile)
          }
          const chunkUp = await uploadVideo(lane.ai, chunkFile)
          uploadedNames.push(chunkUp.name)

          // RESCAN models: PRIMARY = gemini-3-flash-preview / gemini-3.5-flash.
          // BACKUP = high-limit lite models (500 RPD each) — jab primaries ki
          // daily limit khatam ho jaye to rescan lite pool par continue hota
          // hai, kabhi rukta nahi. Use the worker's own model when it is a
          // primary rescan model, otherwise pick primary first, then backup.
          const primaryRm = isRescanModel(m.id) && !globalGeminiCoordinator.isModelExhausted(lane.apiKey, m.id, m.rpd)
            ? m
            : RESCAN_MODEL_POOL.find((x) => !globalGeminiCoordinator.isModelExhausted(lane.apiKey, x.id, x.rpd))
          const backupRm = primaryRm
            ? null
            : RESCAN_BACKUP_POOL.find((x) => !globalGeminiCoordinator.isModelExhausted(lane.apiKey, x.id, x.rpd))
          const rm = primaryRm || backupRm
          if (!rm) {
            throw new GeminiError(
              'other',
              `Rescan models (${[...RESCAN_MODEL_POOL, ...RESCAN_BACKUP_POOL].map((x) => x.id).join(', ')}) exhausted on key ${lane.idx} — group re-queued for another key`,
            )
          }
          if (backupRm) {
            addLog(scan, 'warn', `Rescan: primary models (${RESCAN_MODEL_POOL.map((x) => x.id).join(', ')}) exhausted on key ${lane.idx} — BACKUP model ${backupRm.id} (500 RPD) use ho raha hai`)
          }

          // CANDIDATE-FIRST HINT: chunk-mapping ne jo window claim ki thi, rescan
          // ko batao ki pehle wahan (±10s) dekhe — boundaries aksar thodi shifted
          // hoti hain. Hint galat bhi ho sakta hai isliye full scan phir bhi hota hai.
          const hintLocalStart = Math.max(0, c.movieStart - chunkStart)
          const hintLocalEnd = Math.max(0, c.movieEnd - chunkStart)
          const rescanHintNote =
            hintLocalEnd > hintLocalStart
              ? `HINT — PEHLE YAHAN DEKHO: chunk-mapping ne Video 2 me ${ts(hintLocalStart)}–${ts(hintLocalEnd)} ke aas-paas match hone ka dawa kiya tha (verifier ne exact wahi window reject ki thi — boundaries galat ho sakti hain). PASS 1 me SABSE PEHLE is region ko ±10 second ke saath frame-by-frame check karo — sahi match aksar isi ke aas-paas thoda shift hua hota hai. LEKIN agar wahan exact match NA mile to poora Video 2 (audio samet) zaroor scan karo — hint galat bhi ho sakta hai.`
              : undefined

          addLog(scan, 'info', `Rescan: hunting short ${ts(g.shortStart)}–${ts(g.shortEnd)} inside full chunk ${c.chunkIndex} on ${rm.id} (key ${lane.idx})${rescanHintNote ? ` — hint region ${ts(hintLocalStart)}–${ts(hintLocalEnd)} pehle check hoga` : ''}`)
          const raw = await this.paceAndSend(
            job,
            lane,
            rm,
            shortDur + padBefore + padAfter + (chunkEnd - chunkStart),
            () =>
              this.sendWithClipBackup(
                job,
                lane,
                chunkFile,
                chunkUp.uri,
                uploadedNames,
                (uri) => rescanRequest(lane.ai, rm.id, shortClip.uri, uri, rescanPadNote, rescanHintNote),
                `Rescan chunk ${c.chunkIndex} on ${rm.id} (key ${lane.idx})`,
                rm,
              ),
          )
          const found = parseRescanMatch(raw)
          if (!found) {
            c.rescan = 'not_found'
            this.mark(job)
            addLog(scan, 'info', `Rescan of chunk ${c.chunkIndex}: NOT FOUND`)
            continue
          }
          c.rescan = 'found'
          c.rescanMovieStart = chunkStart + found.start
          c.rescanMovieEnd = chunkStart + found.end
          this.mark(job)
        }

        // 2b. Verify the freshly found rescan window — this verdict is FINAL.
        c.rescanVerdict = 'verifying'
        this.mark(job)
        const reFile = path.join(clipsDir, `${g.id}-c${i}-rescan.mp4`)
        await extractClipPrecise(path.join(mediaDir, 'movie.mp4'), Math.max(0, c.rescanMovieStart! - padBefore), c.rescanMovieEnd! + padAfter, reFile)
        const reUp = await uploadVideo(lane.ai, reFile)
        uploadedNames.push(reUp.name)

        const rvm = pickVerifyModel()
        addLog(scan, 'info', `Re-verify rescan window movie ${ts(c.rescanMovieStart!)}–${ts(c.rescanMovieEnd!)}${needsPad ? ' (padded)' : ''} on ${rvm.id} (key ${lane.idx})`)
        const reSecs = shortDur + padBefore + padAfter + Math.max(1, c.rescanMovieEnd! - c.rescanMovieStart!) + padBefore + padAfter
        const raw2 = await this.paceAndSend(
          job,
          lane,
          rvm,
          reSecs,
          () =>
            this.sendWithClipBackup(
              job,
              lane,
              reFile,
              reUp.uri,
              uploadedNames,
              (uri) => verifyRequest(lane.ai, rvm.id, shortClip.uri, uri, verifyPadNote),
              `Re-verify rescan window on ${rvm.id} (key ${lane.idx})`,
              rvm,
            ),
        )
        const v2 = parseVerdict(raw2)
        if (!v2) throw new GeminiError('other', 'Verifier gave no clear VERDICT line (rescan window)')

        c.rescanReason = v2.reason
        c.rescanVerdict = v2.same ? 'same' : 'different'
        this.mark(job)

        if (v2.same) {
          g.status = 'confirmed'
          g.confirmedIndex = i
          g.confirmedViaRescan = true
          this.applyGroupResult(job, g)
          addLog(scan, 'success', `CONFIRMED via rescan: short ${ts(g.shortStart)}–${ts(g.shortEnd)} = movie ${ts(c.rescanMovieStart!)}–${ts(c.rescanMovieEnd!)} ${originTag(groupMatchOrigin(g, true), c.chunkIndex, g.originWindow)}`)
          // EARLY-STOP QUICK-CONFIRM: rescan-confirm bhi count hota hai.
          this.checkEarlyStop(job)
          return
        }
        addLog(scan, 'warn', `Rescan window rejected by verifier — final DIFFERENT for candidate ${i} (chunk ${c.chunkIndex})`)
      }

      // ----- STEP 3: everything failed — FINAL verdict: rejected, but KEPT in the merge -----
      // User rule: rejected matches are "almost right" — a hole in the output is
      // worse than the best candidate. applyGroupMatches keeps the best window
      // flagged rejected=true; the user can swap it via "Make main".
      g.status = 'rejected'
      this.applyGroupResult(job, g)
      const best = bestRejectedCandidate(g)
      const bestWin = best
        ? best.viaRescan
          ? `${ts(best.c.rescanMovieStart!)}–${ts(best.c.rescanMovieEnd!)}`
          : `${ts(best.c.movieStart)}–${ts(best.c.movieEnd)}`
        : 'none'
      addLog(
        scan,
        'error',
        `REJECTED (kept): short ${ts(g.shortStart)}–${ts(g.shortEnd)} — verifier said DIFFERENT for every candidate; best candidate movie ${bestWin} kept in merge, flagged rejected ${originTag(groupMatchOrigin(g, best?.viaRescan ?? false), best?.c.chunkIndex, g.originWindow)}`,
      )
      // EARLY-STOP SAFETY: is short window ki coverage toot gayi to us minute
      // ke early-stop-skipped chunks wapas scan queue me daalo (accuracy first).
      this.reviveEarlyStopSkipped(job, g)
      this.mark(job)
    } finally {
      for (const n of uploadedNames) void deleteFileQuiet(lane.ai, n)
      try {
        for (const f of fs.readdirSync(clipsDir)) {
          if (f.startsWith(g.id)) fs.unlinkSync(path.join(clipsDir, f))
        }
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * The ONE coverage line: how much of the short the current match set covers,
   * with the exact MISSING list. warn when anything is missing, success at 100 %.
   * Logged at scan end and with every partial report; the gap-backup pass logs
   * it again afterwards with the recovered seconds.
   */
  private logCoverage(job: Job, extra?: string): ShortCoverage {
    const { scan } = job
    const cov = computeShortCoverage(scan)
    const line = coverageLine(cov, extra)
    addLog(scan, line.level, line.msg)
    this.mark(job)
    return cov
  }

  /** Rewrite scan.matches for a finished group:
   *  confirmed → ONE verified match (rescan window when confirmedViaRescan),
   *  rejected → best candidate KEPT in the merge, flagged rejected (verified=false),
   *  unverified → original candidate windows kept, flagged verified=false. */
  private applyGroupResult(job: Job, g: CandidateGroup) {
    const { scan } = job
    // USER PICK (preview/compare "Make main") wins over the AI verdict — shared
    // helper so a Resume never overwrites the user's choice.
    applyGroupMatches(scan, g)
    this.mark(job)
  }

  /** PARTIAL report on Stop/pause: jitna kaam ho chuka hai wo TURANT export/preview
   *  ke liye available rahe — SAME rule as a finished scan: verified matches +
   *  unverified/pending candidates (verified flag na hone par bhi) sab included.
   *  Resume phir bhi wahi se continue karta hai (pending chunks/groups untouched). */
  private buildPartialReport(job: Job) {
    const { scan } = job
    if (!Array.isArray(scan.matches)) scan.matches = []
    scan.matches.sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)
    scan.report = this.reportStats(job, true)
    const r = scan.report
    if (scan.matches.length > 0) {
      addLog(
        scan,
        'info',
        `Partial results saved: ${scan.matches.length} match(es) (verified + unverified dono) — export/preview ab available hai, Resume karne par scan wahi se continue hoga`,
      )
      this.logCoverage(job, '(partial — Resume se aur cover hoga)')
    }
    // Make the gaps LOUD: a partial report used to say "Chunks failed: 0" while
    // re-queued chunks (fetch failed / 429) never ran, and in-flight verifier
    // groups vanished from the confirmed/rejected/unverified totals.
    if ((r.chunksPending || 0) > 0 || (r.groupsPending || 0) > 0) {
      addLog(
        scan,
        'warn',
        `INCOMPLETE: ${r.chunksPending || 0} chunk(s) never scanned (pending/re-queued) · ${r.groupsPending || 0} candidate group(s) still verifying/rescanning — ye report ke totals me alag dikhte hain, Resume se complete hoga`,
      )
    }
    this.mark(job)
  }

  /** Report stats shared by the final and partial report. EVERY chunk and EVERY
   *  candidate group lands in exactly one bucket, so the totals add up:
   *  chunks = scanned + failed + pending, groups = confirmed + rejected + unverified + pending. */
  private reportStats(job: Job, partial: boolean): ScanReport {
    const { scan } = job
    const segments = scan.shortSegments || []
    const allChunks = segments.flatMap((s) => s.chunks)
    const groups = scan.candidateGroups || []
    const now = Date.now()
    const matches = scan.matches || []
    // PROVENANCE totals: chunk / rescan / gap-backup / user.
    const originCounts: Partial<Record<NonNullable<ChunkMatch['origin']>, number>> = {}
    for (const m of matches) {
      const o = m.origin ?? 'chunk'
      originCounts[o] = (originCounts[o] || 0) + 1
    }
    const gapGroups = groups.filter((g) => g.origin === 'gap-backup')
    const gb = scan.gapBackup
    const gapBackup =
      gapGroups.length > 0 || (gb && gb.status !== 'idle')
        ? {
            candidates: gb?.candidates.length ?? 0,
            confirmed: gapGroups.filter((g) => g.status === 'confirmed').length,
            rejectedKept: gapGroups.filter((g) => g.status === 'rejected' && !g.superseded).length,
            unverified: gapGroups.filter((g) => g.status === 'unverified').length,
            unresolved: gb?.parts.filter((p) => p.result === 'unresolved').length ?? 0,
          }
        : undefined
    return {
      totalScanTimeMs: (scan.finishedAt || now) - (scan.startedAt || now),
      chunksScanned: allChunks.filter((c) => c.status === 'match' || c.status === 'no_match').length,
      chunksFailed: allChunks.filter((c) => c.status === 'failed').length,
      // pending (never started / re-queued after fetch failed or 429), scanning
      // (in flight at Stop) and cancelled all mean "this chunk was NOT scanned".
      chunksPending: allChunks.filter((c) => c.status === 'pending' || c.status === 'scanning' || c.status === 'cancelled').length,
      partial: partial || undefined,
      modelsUsed: MODEL_POOL.filter((m) => job.lanes.some((l) => getModelUsage(m.id, l.apiKey) > 0)).map((m) => m.id),
      matches: scan.matches,
      groupsTotal: groups.length,
      groupsConfirmed: groups.filter((g) => g.status === 'confirmed').length,
      groupsRejected: groups.filter((g) => g.status === 'rejected').length,
      groupsUnverified: groups.filter((g) => g.status === 'unverified').length,
      groupsPending: groups.filter((g) => g.status === 'pending' || g.status === 'verifying' || g.status === 'rescanning').length,
      matchesRejectedKept: matches.filter((m) => m.rejected === true && m.userPick !== true).length,
      originCounts,
      gapBackup,
      coverage: computeShortCoverage(scan),
      // How the chunk set was chosen for THIS run (results themselves are 100% Gemini).
      prefilterMode:
        scan.prefilter?.mode === 'prefiltered' ? 'twelvelabs' : scan.geminiPrescan?.appliedMinutes?.length ? 'gemini' : 'full',
      prefilterSelected: scan.prefilter?.selectedChunks,
      prefilterTotal: scan.prefilter?.totalChunks,
    }
  }

  private finish(job: Job) {
    // Pipelining cleanup: delete any pre-uploaded chunks that were never consumed
    // (best effort — Files API entries expire on their own anyway).
    for (const lane of job.lanes) {
      for (const p of lane.chunkUploads.values()) {
        p.then((f) => deleteFileQuiet(lane.ai, f.name)).catch(() => {})
      }
      lane.chunkUploads.clear()
      // Background sweep on this lane's API key to keep storage clean
      void cleanupOrphanedGeminiFiles(lane.apiKey, 24 * 60 * 60_000)
    }
    if (job.saverTimer) clearInterval(job.saverTimer)
    saveScan(job.scan)
    this.jobs.delete(job.scan.id)
  }

  /** Merge a chunk's parsed matches into the scan-level list. Replaces ONLY this
   *  chunk's old entries WITHIN the given short-minute window — the same movie
   *  chunk can legitimately hold matches from other short minutes. */
  private mergeMatches(scan: Scan, chunkIndex: number, matches: ChunkMatch[], seg: ShortSegmentState | null) {
    const segStart = seg ? seg.start : 0
    const segEnd = seg ? seg.end : Number.POSITIVE_INFINITY
    scan.matches = (scan.matches || []).filter(
      (m) => !(m.chunkIndex === chunkIndex && m.shortStart >= segStart && m.shortStart < segEnd && !m.userPick),
    )
    scan.matches.push(...matches)
    scan.matches.sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)
    // Synchronize candidate groups immediately so overlapping matches from other chunks
    // become alternative candidates of that scene instead of colliding on the timeline
    this.buildCandidateGroups(scan)
  }

  /** Worker: one per (key lane × model). Pulls chunks from the shared queue until drained. */
  private async worker(job: Job, lane: KeyLane, m: ModelSpec) {
    const { scan } = job

    while (true) {
      if (job.stopping) return
      const st = this.modelState(job, lane, m)

      // Fast RPD check via coordinator — instant background check, never send request N+1 past daily cap.
      if (globalGeminiCoordinator.isModelExhausted(lane.apiKey, m.id, m.rpd)) {
        if (st.state !== 'exhausted') {
          st.state = 'exhausted'
          st.currentChunk = null
          addLog(scan, 'warn', `${m.id} (key ${lane.idx}) exhausted for today (${m.rpd}/${m.rpd} RPD) — removed from pool`)
          this.mark(job)
        }
        return
      }
      if (st.state === 'exhausted') {
        st.state = 'idle'
        this.mark(job)
      }

      // Cooldown check (RPM/TPM-type 429).
      const cool = job.cooldownUntil[this.rateKey(lane, m)] || 0
      if (cool > Date.now()) {
        st.state = 'cooling'
        st.cooldownUntil = cool
        st.currentChunk = null
        this.mark(job)
        await sleep(Math.min(2000, cool - Date.now()))
        continue
      }
      st.cooldownUntil = null

      // Global Coordinator Availability check:
      // If this specific key/model lane is currently busy (working in another scan or in pacing delay),
      // sleep 1 second and DO NOT pull chunk yet.
      // This allows any other worker on an idle/free key (e.g. Key 3 · gemini-3.8, Key 2 · gemini-3.6)
      // to pull from job.queue immediately without any wait!
      const laneBusy = globalGeminiCoordinator.isLaneBusy(lane.apiKey, m.id, 0)
      if (laneBusy.busy) {
        st.state = laneBusy.cooling ? 'cooling' : 'waiting'
        st.currentChunk = null
        await sleep(1000)
        continue
      }

      // Pull next chunk (lane affinity: this key's pre-uploaded chunk first).
      // When the queue is empty but other workers are still in flight, wait —
      // a failed chunk may be re-queued for retry.
      const chunkIndex = this.pullChunkFor(job, lane)
      if (chunkIndex === undefined) {
        if (job.inFlight.size === 0) {
          if (st.state !== 'idle') {
            st.state = 'idle'
            st.currentChunk = null
            this.mark(job)
          }
          return
        }
        st.state = 'waiting'
        st.currentChunk = null
        await sleep(1000)
        continue
      }

      const chunk = scan.chunks[chunkIndex]
      if (!chunk || chunk.status !== 'pending') continue
      const seg = job.seg
      if (!seg) return
      const minutePrefix = (scan.shortSegments?.length ?? 0) > 1 ? `Minute ${seg.index + 1} · ` : ''
      job.inFlight.add(chunkIndex)
      chunk.status = 'scanning'
      chunk.model = m.id
      st.state = 'active'
      st.currentChunk = chunkIndex
      this.mark(job)

      let chunkFileName: string | null = null
      /** consumed backup uploads (deleted in finally) */
      const backupNames: string[] = []
      let releaseGlobalLock: ((sec?: number, cooldownOverrideMs?: number) => void) | null = null
      try {
        releaseGlobalLock = await globalGeminiCoordinator.acquireLane({
          scanId: scan.id,
          scanTitle: scan.shortName || scan.id,
          apiKey: lane.apiKey,
          keyIdx: lane.idx,
          modelId: m.id,
          slot: 0,
          operation: `Chunk ${chunkIndex} map`,
          videoSeconds: 60,
          rpd: m.rpd || 500,
          onWait: (msg) => {
            st.state = 'waiting'
            addLog(scan, 'info', msg)
            this.mark(job)
          },
          isStopping: () => job.stopping,
        })

        // PARALLEL UPLOADS: the short-minute segment + THIS movie chunk upload
        // AT THE SAME TIME (Promise.all) — and the per-model pacing wait
        // (TPM ≈ 1 request/min per model per key) overlaps with those uploads
        // too, so nothing waits on anything it doesn't have to.
        const rk = this.rateKey(lane, m)
        const uploadsP = Promise.all([
          this.ensureSegmentUri(job, lane, seg),
          this.takeChunkUpload(job, lane, chunkIndex),
        ])
        // Rejection is handled at the await below — this only prevents an
        // unhandled-rejection crash while the pacing sleep is running.
        uploadsP.catch(() => {})

        // PIPELINING: start pre-cutting + pre-uploading the NEXT queued chunks
        // on this key in the background right away.
        this.prefetchNextChunks(job, lane)

        const wait = (job.nextFreeAt[rk] || 0) - Date.now()
        if (wait > 0) {
          st.state = 'waiting'
          this.mark(job)
          await this.stoppableSleep(job, wait)
          st.state = 'active'
          this.mark(job)
        }

        // STOP CHECK: request bhejne / quota consume karne se PEHLE nikal jao —
        // chunk wapas 'pending' ho jaata hai (no attempt penalty), Resume par wahi se chalega.
        if (job.stopping) {
          chunk.status = 'pending'
          this.mark(job)
          return
        }

        const [shortUri, uploaded] = await uploadsP
        chunkFileName = uploaded.name

        job.nextFreeAt[rk] = Date.now() + MODEL_MIN_INTERVAL_MS

        addLog(scan, 'info', `${minutePrefix}Chunk ${chunkIndex}: mapping short → movie minute ${chunkIndex} on ${m.id} (key ${lane.idx})`)
        chunk.model = m.id
        chunk.keyIdx = lane.idx
        // PIPELINING: while Gemini analyzes THIS chunk, the next chunk's
        // cut + upload runs in the background — analysis khatam hote hi agla
        // segment ready milta hai, wait zero.
        this.prefetchNextChunks(job, lane)
        let raw: string
        const alreadySanitized = Boolean(chunk.policyRetried)
        let effectiveUploadedUri = uploaded.uri
        let effectiveShortUri = shortUri
        const effectivePrompt = alreadySanitized ? CHUNK_MAP_SANITIZED_PROMPT : undefined

        if (alreadySanitized) {
          const mediaDir = scanMediaDir(scan.id)
          const sanitizedDir = path.join(mediaDir, 'sanitized')
          const sanitizedChunkFile = path.join(sanitizedDir, `chunk-${String(chunkIndex).padStart(4, '0')}-muted.mp4`)
          if (fs.existsSync(sanitizedChunkFile)) {
            const sanitizedUploaded = await uploadVideo(lane.ai, sanitizedChunkFile)
            backupNames.push(sanitizedUploaded.name)
            effectiveUploadedUri = sanitizedUploaded.uri
          }
          const sanitizedShortFile = path.join(sanitizedDir, `short-${String(seg.index + 1).padStart(4, '0')}-muted.mp4`)
          if (fs.existsSync(sanitizedShortFile)) {
            const sanitizedShortUp = await uploadVideo(lane.ai, sanitizedShortFile)
            backupNames.push(sanitizedShortUp.name)
            effectiveShortUri = sanitizedShortUp.uri
          }
        }

        try {
          // Request Attempt 1: Call Gemini
          raw = await mapChunkRequest(lane.ai, m.id, effectiveShortUri, effectiveUploadedUri, effectivePrompt)
          job.nextFreeAt[rk] = Date.now() + CHUNK_COOLDOWN_MS
          const used = incrementModelUsage(m.id, lane.apiKey)
          st.usedToday = used
          globalGeminiCoordinator.recordSuccess(lane.apiKey, m.id, 0)
          chunk.requestCount = (chunk.requestCount || 0) + 1
          this.mark(job)
        } catch (reqErr) {
          const re = classifyError(reqErr)
          const isPolicyBlocked =
            re.kind === 'policy_blocked' ||
            /prohibited_content|blocked_by_safety|safety_ratings_blocked|prompt block reason/i.test(re.message)

          chunk.requestCount = (chunk.requestCount || 0) + 1
          this.mark(job)

          if (isPolicyBlocked && !chunk.policyRetried) {
            chunk.policyRetried = true
            addLog(
              scan,
              'warn',
              `${minutePrefix}Chunk ${chunkIndex}: Flagged by Google Policy (PROHIBITED_CONTENT) on ${m.id} (key ${lane.idx}) — triggering 1 sanitized retry with Audio Stripped (-an Mute) + Neutral Frame Alignment prompt...`,
            )
            this.mark(job)

            // Prepare sanitized muted chunk video
            const mediaDir = scanMediaDir(scan.id)
            const sanitizedDir = path.join(mediaDir, 'sanitized')
            fs.mkdirSync(sanitizedDir, { recursive: true })
            const originalChunkFile = chunkPath(path.join(mediaDir, 'chunks'), chunkIndex)
            const sanitizedChunkFile = path.join(sanitizedDir, `chunk-${String(chunkIndex).padStart(4, '0')}-muted.mp4`)

            if (!fs.existsSync(sanitizedChunkFile) && fs.existsSync(originalChunkFile)) {
              await sanitizeVideoMute(originalChunkFile, sanitizedChunkFile)
            }

            const fileToUpload = fs.existsSync(sanitizedChunkFile) ? sanitizedChunkFile : originalChunkFile
            const sanitizedUploaded = await uploadVideo(lane.ai, fileToUpload)
            backupNames.push(sanitizedUploaded.name)

            // Prepare sanitized muted short video to remove audio triggers from short clip as well
            let sanitizedShortUri = shortUri
            try {
              const originalShortFile = await this.ensureSegmentFile(scan, seg)
              const sanitizedShortFile = path.join(sanitizedDir, `short-${String(seg.index + 1).padStart(4, '0')}-muted.mp4`)
              if (!fs.existsSync(sanitizedShortFile) && fs.existsSync(originalShortFile)) {
                await sanitizeVideoMute(originalShortFile, sanitizedShortFile)
              }
              if (fs.existsSync(sanitizedShortFile)) {
                const sanitizedShortUp = await uploadVideo(lane.ai, sanitizedShortFile)
                backupNames.push(sanitizedShortUp.name)
                sanitizedShortUri = sanitizedShortUp.uri
              }
            } catch (muteErr) {
              console.warn(`Could not sanitize short segment audio: ${muteErr}`)
            }

            // Request Attempt 2: Sanitized Retry with neutral prompt
            try {
              raw = await mapChunkRequest(lane.ai, m.id, sanitizedShortUri, sanitizedUploaded.uri, CHUNK_MAP_SANITIZED_PROMPT)
              job.nextFreeAt[rk] = Date.now() + CHUNK_COOLDOWN_MS
              const usedRetry = incrementModelUsage(m.id, lane.apiKey)
              st.usedToday = usedRetry
              chunk.requestCount = (chunk.requestCount || 0) + 1
              addLog(scan, 'success', `${minutePrefix}Chunk ${chunkIndex}: Sanitized retry succeeded on ${m.id} (key ${lane.idx}) after policy flag bypass`)
              this.mark(job)
            } catch (retryErr) {
              chunk.requestCount = (chunk.requestCount || 0) + 1
              this.mark(job)
              throw retryErr
            }
          } else {
            // RATE LIMIT (429): do NOT retry immediately with zero wait on the same key!
            // Throw immediately so it enters cooldown and is re-queued for another key.
            if (re.kind === 'rate') throw reqErr

            // On temporary server errors (503 / overload / 5xx), do ONE retry with 2s backoff
            const isServerOverload = /overload|busy|503|500|internal|try again|temporarily/i.test(re.message)
            if (!isServerOverload) throw reqErr

            addLog(scan, 'warn', `${minutePrefix}Chunk ${chunkIndex}: Gemini model server busy (503/overload) on ${m.id} (key ${lane.idx}) — retrying in 2s...`)
            this.mark(job)
            await sleep(2000)
            try {
              raw = await mapChunkRequest(lane.ai, m.id, shortUri, uploaded.uri)
              job.nextFreeAt[rk] = Date.now() + CHUNK_COOLDOWN_MS
              const usedRetry = incrementModelUsage(m.id, lane.apiKey)
              st.usedToday = usedRetry
              chunk.requestCount = (chunk.requestCount || 0) + 1
              this.mark(job)
            } catch (retry503Err) {
              chunk.requestCount = (chunk.requestCount || 0) + 1
              this.mark(job)
              throw retry503Err
            }
          }
        }

        this.recordChunkOutput(chunk, m.id, raw)

        // Model timestamps are LOCAL to the 1-minute segment file — shift them by
        // seg.start so every stored match carries ABSOLUTE short-video seconds.
        // Movie offset is TRIM-AWARE: reported movie times stay absolute to the ORIGINAL movie.
        // ORDERING SAFETY: the segment file is physically at most (seg.end - seg.start)
        // seconds long, so any local timestamp beyond that is a model hallucination.
        // Clamp into the segment window (and drop fully-outside matches) so a
        // minute-2 match can NEVER land at a wrong absolute time and break ordering.
        const segLocalDur = seg.end - seg.start
        const matches = parseChunkMatches(raw, chunkIndex, chunkAbsWindow(scan, chunkIndex).start, m.id)
          .filter((mm) => mm.shortStart < segLocalDur - 0.02 && mm.shortEnd > 0)
          .map((mm) => ({
            ...mm,
            shortStart: seg.start + Math.min(Math.max(0, mm.shortStart), segLocalDur),
            shortEnd: seg.start + Math.min(Math.max(0, mm.shortEnd), segLocalDur),
          }))
          .filter((mm) => mm.shortEnd - mm.shortStart > 0.02)

        // FALSE-RESULT DETECTOR: no NOT FOUND anywhere / fixed-offset A-to-Z
        // extrapolation => auto retry ONCE, then accept whatever comes.
        const suspicion = isSuspiciousChunkOutput(raw, matches)
        if (suspicion && (chunk.qualityRetries || 0) < MAX_QUALITY_RETRIES) {
          chunk.qualityRetries = (chunk.qualityRetries || 0) + 1
          chunk.status = 'pending'
          chunk.matches = []
          job.queue.push(chunkIndex)
          addLog(scan, 'warn', `${minutePrefix}Chunk ${chunkIndex}: SUSPICIOUS output on ${m.id} — ${suspicion}. Auto-retry ${chunk.qualityRetries}/${MAX_QUALITY_RETRIES} queued`)
          this.mark(job)
          continue
        }
        if (suspicion) {
          addLog(scan, 'warn', `Chunk ${chunkIndex}: output still suspicious after ${MAX_QUALITY_RETRIES} auto-retry (${suspicion}) — accepting result, use manual Retry if needed`)
        }

        chunk.matches = matches
        chunk.status = matches.length > 0 ? 'match' : 'no_match'
        this.mergeMatches(scan, chunkIndex, matches, seg)
        // PIPELINE PARALLELISM: this chunk's candidates go to the verify queue
        // IMMEDIATELY — the concurrent verify workers pick them up while this
        // chunk model moves straight on to the next chunk.
        if (matches.length > 0) this.enqueueNewGroups(job)

        if (matches.length > 0) {
          addLog(scan, 'success', `${minutePrefix}Chunk ${chunkIndex}: ${matches.length} matched segment(s) found`)
        } else {
          addLog(scan, 'info', `${minutePrefix}Chunk ${chunkIndex}: no segments found in this minute`)
        }
        this.mark(job)
      } catch (err) {
        const e = err instanceof GeminiError ? err : classifyError(err)

        // Always record error & diagnostic in chunk output so user can click 'AI output' and see what happened.
        this.recordChunkOutput(
          chunk,
          m.id,
          `[ERROR / DIAGNOSTIC]\nModel: ${m.id} (Key ${lane.idx})\nError: ${e.message}\nTime: ${new Date().toISOString()}`,
        )

        // INFRASTRUCTURE / TRANSIENT ERROR CHECK:
        // Quota limits, rate limits, model exhaustions, empty responses, temporary 503s, and network/upload hiccups
        // are properties of the API key/Gemini service — NEVER the chunk video itself!
        // These MUST NOT consume chunk.attempts, so transient bursts never mark a chunk as 'failed'!
        const isPolicyBlocked =
          e.kind === 'policy_blocked' ||
          /prohibited_content|blocked_by_safety|safety_ratings_blocked|prompt block reason/i.test(e.message)

        const isTransientInfra =
          isPolicyBlocked ||
          e.kind === 'rate' ||
          e.kind === 'rpd' ||
          e.kind === 'unavailable' ||
          e.kind === 'invalid_key' ||
          e.kind === 'empty' ||
          /empty model response|empty response|no text returned|blockreason|safety|file upload|processing timed out|socket|econnreset|etimedout|500|502|503|504|overload/i.test(e.message)

        if (!isTransientInfra) {
          chunk.attempts = (chunk.attempts || 0) + 1
        }

        if (isPolicyBlocked) {
          chunk.status = 'policy_blocked'
          // CRITICAL QUOTA SAVER: Do NOT re-queue this chunk on other keys!
          // The sanitized retry also hit Google hard policy — stop retries for this chunk to protect API keys quota!
          addLog(
            scan,
            'warn',
            `${minutePrefix}Chunk ${chunkIndex}: Flagged by Google Policy (PROHIBITED_CONTENT) after sanitized retry on ${m.id} (key ${lane.idx}) — automatic retries stopped to protect API keys quota; moving to next chunk`,
          )
        } else if (chunk.attempts >= MAX_CHUNK_ATTEMPTS) {
          chunk.status = 'failed'
          addLog(scan, 'error', `${minutePrefix}Chunk ${chunkIndex} reached max retry limit (${chunk.attempts}/${MAX_CHUNK_ATTEMPTS} attempts) — stopped: ${e.message.slice(0, 140)}`)
        } else if (e.kind === 'invalid_key') {
          const laneState = job.scan.keyLanes.find((l) => l.idx === lane.idx)
          if (laneState) {
            laneState.status = 'error'
            laneState.lastError = 'API key invalid or expired'
          }
          chunk.status = 'pending'
          job.queue.push(chunkIndex)
          addLog(scan, 'error', `API Key ${lane.idx} is invalid/expired — disabled for this scan; Chunk ${chunkIndex} re-queued for another key`)
        } else if (e.kind === 'rpd' || e.kind === 'rate') {
          const modelCap = m.rpd || getModelDailyCap(m.id)
          const quotaOutcome = globalGeminiCoordinator.handleQuotaOrRateError(
            lane.apiKey,
            m.id,
            0,
            modelCap,
            e.kind === 'rpd',
          )
          if (quotaOutcome.action === 'exhausted') {
            setModelExhausted(m.id, lane.apiKey, modelCap)
            const laneState = job.scan.keyLanes?.find((l) => l.idx === lane.idx)
            if (laneState) {
              const ms = laneState.models.find((item) => item.id === m.id)
              if (ms) ms.state = 'exhausted'
            }
            addLog(scan, 'warn', `${m.id} (key ${lane.idx}): ${quotaOutcome.reason}. Model set aside today; remaining models on key ${lane.idx} continue. Chunk ${chunkIndex} re-queued.`)
          } else {
            job.cooldownUntil[this.rateKey(lane, m)] = Date.now() + CHUNK_COOLDOWN_MS
            const laneState = job.scan.keyLanes.find((l) => l.idx === lane.idx)
            if (laneState) {
              const ms = laneState.models.find((item) => item.id === m.id)
              if (ms) ms.state = 'cooling'
            }
            addLog(scan, 'warn', `${m.id} (key ${lane.idx}): ${quotaOutcome.reason}. Chunk ${chunkIndex} re-queued.`)
          }
          chunk.status = 'pending'
          job.queue.push(chunkIndex)
        } else if (e.kind === 'empty') {
          chunk.status = 'pending'
          job.queue.push(chunkIndex)
          addLog(scan, 'warn', `${minutePrefix}Chunk ${chunkIndex}: empty response on ${m.id} (key ${lane.idx}) — diagnostic saved in AI Output; chunk safely re-queued for another worker`)
        } else {
          chunk.status = 'pending'
          job.queue.push(chunkIndex)
          addLog(scan, 'warn', `Chunk ${chunkIndex} attempt ${chunk.attempts}/${MAX_CHUNK_ATTEMPTS} failed on ${m.id} (key ${lane.idx}) — re-queued: ${e.message.slice(0, 120)}`)
        }
        this.mark(job)
      } finally {
        if (releaseGlobalLock) releaseGlobalLock(60, CHUNK_COOLDOWN_MS)
        // The short video is reused across chunks; the chunk upload is one-shot.
        if (chunkFileName) void deleteFileQuiet(lane.ai, chunkFileName)
        // Backup uploads: used copies — sab delete.
        for (const n of backupNames) void deleteFileQuiet(lane.ai, n)
        job.inFlight.delete(chunkIndex)
        st.currentChunk = null
        if (st.state === 'active') st.state = 'idle'
        this.mark(job)
      }
    }
  }
}

const globalForScheduler = globalThis as unknown as { __cmtScheduler?: Scheduler }
export const scheduler = globalForScheduler.__cmtScheduler || (globalForScheduler.__cmtScheduler = new Scheduler())
