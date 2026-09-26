import 'server-only'

import fs from 'node:fs'
import path from 'node:path'
import {
  getClient,
  uploadVideo,
  deleteFileQuiet,
  classifyError,
  CHUNK_MAP_SANITIZED_PROMPT,
  type UploadProgress,
} from './gemini'
import { CHUNK_MODEL_POOL, CHUNK_COOLDOWN_MS, getModelDailyCap } from './models'
import { buildBackupClip, chunkPath, extractClipPrecise, sanitizeVideoMute, preparePrescanMovieCopy } from './ffmpeg'
import { localMediaPath, findAndReusePrescanMovie, findReusableGeminiMovieUpload, findAndReuseMovieChunks } from './media'
import { addLog, getScan, saveScan, scanMediaDir, incrementModelUsage, apiKeyHash } from './store'
import { gapsOf, mergeRanges } from './short-coverage'
import { globalGeminiCoordinator } from './global-gemini-coordinator'
import { applyGroupMatches, sameShortSegment } from './candidate-pick'
import { invalidateRenderedOutput } from './render'
import type { ChunkMatch, MissingSceneCandidate, MissingSceneScanState, MissingSceneTarget, MissingSceneWindowHit, Scan } from './types'

const MINUTE_FINDER_WINDOW_SEC = 20 * 60 // 20 minutes

interface ScannerCtrl {
  scanId: string
  stopping: boolean
}

const activeControllers = new Map<string, ScannerCtrl>()

export function isMissingSceneScannerRunning(scanId: string): boolean {
  return activeControllers.has(scanId)
}

export function stopMissingSceneScanner(scanId: string): { ok: boolean; error?: string } {
  const ctrl = activeControllers.get(scanId)
  if (!ctrl) return { ok: false, error: 'Missing scene scan is not running' }
  ctrl.stopping = true
  const scan = getScan(scanId)
  if (scan?.missingSceneScan) {
    scan.missingSceneScan.status = 'stopped'
    scan.missingSceneScan.progress = 'Stopped by user'
    scan.missingSceneScan.finishedAt = Date.now()
    saveScan(scan)
    addLog(scan, 'warn', '[Missing Scene Finder] Search stopped by user')
  }
  return { ok: true }
}

/** Compute gaps in short video based on existing confirmed/verified matches */
export function getDetectedMissingScenes(scan: Scan): MissingSceneTarget[] {
  const shortDur = scan.shortDuration || 0
  if (shortDur <= 0) return []
  // Matches that genuinely cover the short video (excluding rejected ones)
  const matches = (scan.matches || [])
    .filter((m) => !m.rejected && m.batchVerified !== 'rejected')
    .map((m) => ({ start: m.shortStart, end: m.shortEnd }))
  const covered = mergeRanges(matches)
  const gaps = gapsOf(covered, shortDur).filter((g) => g.end - g.start >= 0.4)
  return gaps.map((g, idx) => ({
    id: `gap-${idx + 1}-${Math.round(g.start)}-${Math.round(g.end)}`,
    shortStart: Number(g.start.toFixed(3)),
    shortEnd: Number(g.end.toFixed(3)),
    duration: Number((g.end - g.start).toFixed(3)),
  }))
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.floor((sec % 1) * 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

function fmtMinSec(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function parseTs(ts: string): number | null {
  const m = ts.trim().match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/)
  if (!m) return null
  const sec = Number(m[1]) * 60 + Number(m[2])
  return Number.isFinite(sec) ? sec : null
}

export async function startMissingSceneScanner(
  scanId: string,
  apiKeys: string[],
  user: { username: string; role: string },
  selectedScenes: Array<{ start: number; end: number; id?: string }>,
  windowIndices?: number[],
): Promise<{ ok: boolean; error?: string }> {
  const scan = getScan(scanId)
  if (!scan) return { ok: false, error: 'Scan not found' }
  if (activeControllers.has(scanId)) return { ok: false, error: 'Missing scene scan is already running' }
  if (apiKeys.length === 0) return { ok: false, error: 'Gemini API key is required' }
  if (!selectedScenes || selectedScenes.length === 0) {
    return { ok: false, error: 'Kripya kam se kam 1 missing scene select karein' }
  }

  const shortFile = localMediaPath(scanId, 'short')
  const movieFile = localMediaPath(scanId, 'movie')
  if (!fs.existsSync(/*turbopackIgnore: true*/ shortFile) || !fs.existsSync(/*turbopackIgnore: true*/ movieFile)) {
    return { ok: false, error: 'Short ya movie video file missing hai' }
  }

  const ctrl: ScannerCtrl = { scanId, stopping: false }
  activeControllers.set(scanId, ctrl)

  // Asynchronous background execution
  void runMissingSceneScanner(ctrl, scanId, apiKeys, selectedScenes, windowIndices).finally(() => {
    activeControllers.delete(scanId)
  })

  return { ok: true }
}

async function runMissingSceneScanner(
  ctrl: ScannerCtrl,
  scanId: string,
  apiKeys: string[],
  selectedScenes: Array<{ start: number; end: number; id?: string }>,
  windowIndices?: number[],
) {
  const scan = getScan(scanId)
  if (!scan) return

  const mediaDir = scanMediaDir(scanId)
  const chunksDir = path.join(mediaDir, 'chunks')
  fs.mkdirSync(chunksDir, { recursive: true })

  const shortFile = localMediaPath(scanId, 'short')
  const movieFile = localMediaPath(scanId, 'movie')

  const trimStart = scan.movieTrimStart ?? 0
  const trimEnd = scan.movieTrimEnd ?? scan.movieDuration ?? 0
  const copyDuration = Math.max(1, trimEnd - trimStart)

  const targets: MissingSceneTarget[] = selectedScenes.map((s, idx) => ({
    id: s.id || `scene-${idx + 1}-${Math.round(s.start)}-${Math.round(s.end)}`,
    shortStart: Number(s.start.toFixed(3)),
    shortEnd: Number(s.end.toFixed(3)),
    duration: Number((s.end - s.start).toFixed(3)),
  }))

  const state: MissingSceneScanState = {
    status: 'preparing',
    progress: `Preparing clip(s) for ${targets.length} missing scene(s)...`,
    selectedScenes: targets,
    windowHits: [],
    candidates: [],
    addedMatches: [],
    startedAt: Date.now(),
  }
  scan.missingSceneScan = state
  saveScan(scan)
  addLog(scan, 'info', `[Missing Scene Finder] Initialized for ${targets.length} scene(s): ${targets.map((t) => `${fmtTime(t.shortStart)}–${fmtTime(t.shortEnd)}`).join(', ')}`)

  // Find all active movie uploads across the user's keys
  const keysWithMovie: Array<{ apiKey: string; keyIdx: number; movieUri: string; movieName: string }> = []
  
  // 1. Check current scan's geminiPrescan.uploads
  if (scan.geminiPrescan?.uploads) {
    for (let i = 0; i < apiKeys.length; i++) {
      const k = apiKeys[i]
      const kh = apiKeyHash(k)
      const up = scan.geminiPrescan.uploads[kh]
      if (up?.movieUri && up?.movieName && Date.now() - (up.uploadedAt || 0) < 47 * 3600 * 1000) {
        keysWithMovie.push({ apiKey: k, keyIdx: i + 1, movieUri: up.movieUri, movieName: up.movieName })
      }
    }
  }

  // 2. If any key still doesn't have an upload in this scan, check reusable from other scans
  for (let i = 0; i < apiKeys.length; i++) {
    const k = apiKeys[i]
    if (keysWithMovie.some((x) => x.apiKey === k)) continue
    const kh = apiKeyHash(k)
    const reusable = findReusableGeminiMovieUpload(
      scan.movieName || '',
      scan.movieSize || 0,
      kh,
      trimStart,
      trimEnd,
      scanId,
    )
    if (reusable?.movieUri && reusable?.movieName) {
      keysWithMovie.push({ apiKey: k, keyIdx: i + 1, movieUri: reusable.movieUri, movieName: reusable.movieName })
    }
  }

  if (keysWithMovie.length > 0) {
    addLog(
      scan,
      'info',
      `[Missing Scene Finder] Found active cached movie upload on ${keysWithMovie.length} key(s) (0s movie upload wait)`,
    )
  }

  const primaryApiKey = keysWithMovie[0]?.apiKey || apiKeys[0]
  const uploadedFilesToClean: Array<{ key: string; name: string }> = []

  try {
    // 1. Cut the target short clip (single scene or merged multi-scene)
    const clipOutFile = path.join(mediaDir, `missing-scene-clip-${Date.now()}.mp4`)
    let partMapText = ''
    let sceneParts: Array<{ partNum: number; clipStart: number; clipEnd: number; target: MissingSceneTarget }> = []

    if (targets.length === 1) {
      const t = targets[0]
      state.progress = `Cutting clip for scene ${fmtTime(t.shortStart)}–${fmtTime(t.shortEnd)}...`
      saveScan(scan)
      await extractClipPrecise(shortFile, t.shortStart, t.shortEnd, clipOutFile)
      t.clipStart = 0
      t.clipEnd = t.duration
      sceneParts = [{ partNum: 1, clipStart: 0, clipEnd: t.duration, target: t }]
      partMapText = `Part 1: Clip time 00:00 - ${fmtMinSec(t.duration)} (Original Short Video timestamp: ${fmtTime(t.shortStart)} - ${fmtTime(t.shortEnd)})`
    } else {
      state.progress = `Merging ${targets.length} missing scenes into single clip with 1s gap...`
      saveScan(scan)
      const res = await buildBackupClip(
        shortFile,
        targets.map((t) => ({ start: t.shortStart, end: t.shortEnd })),
        clipOutFile,
      )
      sceneParts = res.parts.map((p, idx) => {
        const t = targets[idx]
        t.clipStart = p.clipStart
        t.clipEnd = p.clipEnd
        return { partNum: idx + 1, clipStart: p.clipStart, clipEnd: p.clipEnd, target: t }
      })
      partMapText = sceneParts
        .map(
          (p) =>
            `Part ${p.partNum}: Clip time ${fmtMinSec(p.clipStart)} - ${fmtMinSec(p.clipEnd)} (Original Short Video timestamp: ${fmtTime(p.target.shortStart)} - ${fmtTime(p.target.shortEnd)})`,
        )
        .join('\n')
    }

    if (ctrl.stopping) return

    // Cache uploaded missing scene clip per API key so requests on any key have proper access permissions
    const clipUploadsByKey = new Map<string, { uri: string; name: string }>()
    async function getClipForApiKey(key: string, onProgress?: (p: UploadProgress) => void): Promise<{ uri: string; name: string }> {
      const kh = apiKeyHash(key)
      const existing = clipUploadsByKey.get(kh)
      if (existing) return existing
      const keyAi = getClient(key)
      const up = await uploadVideo(keyAi, clipOutFile, onProgress, () => ctrl.stopping)
      uploadedFilesToClean.push({ key, name: up.name })
      clipUploadsByKey.set(kh, up)
      return up
    }

    // 2. Ensure initial clip is uploaded to primary key
    state.progress = 'Uploading missing scene clip to Gemini...'
    saveScan(scan)
    const onClipProgress = (p: UploadProgress) => {
      const statusText = p.stage === 'processing'
        ? `Google Gemini server processing clip (${p.speedStr})....`
        : `Uploading missing scene clip (${p.pct}% @ ${p.speedStr})...`
      state.progress = statusText
      saveScan(scan)
    }
    await getClipForApiKey(primaryApiKey, onClipProgress)

    // 3. Ensure movie copy is available and uploaded on at least one key
    if (keysWithMovie.length === 0) {
      let movieCopyPath = path.join(mediaDir, 'prescan-movie.mp4')
      if (!fs.existsSync(/*turbopackIgnore: true*/ movieCopyPath)) {
        const reused = await findAndReusePrescanMovie(scanId, scan.movieName || '', scan.movieSize || 0, trimStart, trimEnd)
        if (reused) {
          movieCopyPath = reused.copyPath
        } else {
          state.progress = 'Preparing optimized movie copy for Gemini window scan...'
          saveScan(scan)
          const prep = await preparePrescanMovieCopy(movieFile, mediaDir, trimStart, trimEnd)
          movieCopyPath = prep.path
        }
      }

      state.progress = 'Uploading movie copy to Gemini Files API...'
      saveScan(scan)
      const onMovieProgress = (p: UploadProgress) => {
        const statusText = p.stage === 'processing'
          ? `Google Gemini server transcoding & indexing movie (${p.speedStr})...`
          : `Uploading movie copy (${p.pct}% @ ${p.speedStr})...`
        state.progress = statusText
        saveScan(scan)
      }
      const up = await uploadVideo(getClient(primaryApiKey), movieCopyPath, onMovieProgress, () => ctrl.stopping)
      uploadedFilesToClean.push({ key: primaryApiKey, name: up.name })

      // Store in scan.geminiPrescan.uploads for instant reuse in subsequent runs
      const kh = apiKeyHash(primaryApiKey)
      if (!scan.geminiPrescan) {
        scan.geminiPrescan = { status: 'idle', windowLen: 1200, uploads: {}, windows: [] }
      }
      if (!scan.geminiPrescan.uploads) {
        scan.geminiPrescan.uploads = {}
      }
      scan.geminiPrescan.uploads[kh] = {
        shortUri: '',
        shortName: '',
        movieUri: up.uri,
        movieName: up.name,
        uploadedAt: Date.now(),
      }
      saveScan(scan)
      keysWithMovie.push({ apiKey: primaryApiKey, keyIdx: 1, movieUri: up.uri, movieName: up.name })
    }

    if (ctrl.stopping) return

    // 4. Windows generation (20-min chunks)
    const allWindows: Array<{ index: number; start: number; end: number }> = []
    for (let t = 0, i = 0; t < copyDuration - 0.5; t += MINUTE_FINDER_WINDOW_SEC, i++) {
      allWindows.push({ index: i, start: t, end: Math.min(t + MINUTE_FINDER_WINDOW_SEC, copyDuration) })
    }

    const selectedIndices = windowIndices && windowIndices.length > 0 ? new Set(windowIndices) : null
    const windowsToScan = allWindows.filter((w) => (selectedIndices ? selectedIndices.has(w.index) : true))

    state.status = 'scanning_windows'
    state.totalWindows = windowsToScan.length
    state.completedWindows = 0
    state.activeWindows = 0
    state.totalChunks = 0
    state.completedChunks = 0
    state.activeChunks = 0
    state.progress = `Scanning ${windowsToScan.length} movie window(s) in parallel...`
    saveScan(scan)
    addLog(scan, 'info', `[Missing Scene Finder] 🚀 Starting parallel window scanner + instant pipelined chunk finder across ${windowsToScan.length} window(s)...`)

    // Reuse existing chunks from this scan or other scans immediately
    await findAndReuseMovieChunks(scanId, scan.movieName || '', scan.movieSize || 0, trimStart, trimEnd, scan.chunkCount || 0)

    // Build the window prompt
    const windowPrompt = `You are a forensic video analyst searching for SPECIFIC MISSING SCENE(S) from an edited short video in a movie window.

Video 1: A clip containing ${targets.length} missing scene(s) from the short video:
${partMapText}

Video 2: A 20-MINUTE WINDOW of the original movie.
Your mission:
Check if ANY of the missing scene(s) in Video 1 appear in Video 2 (this 20-minute window).
Identify the EXACT MOVIE MINUTE (e.g. Minute 42 = 42:00 to 43:00) where the scene appears so we can scan and verify the chunk at 24 fps.

Respond in Hinglish:
=====================
HISSA 1 — SCENE SUMMARY & DIALOGUE
=====================
For each Part in Video 1, note actors, actions, and verbatim quoted dialogue.

=====================
HISSA 2 — WINDOW SEARCH RESULTS
=====================
For each Part:
If MATCH:
PART <n>: MATCH | Movie time mm:ss - mm:ss | Movie Minute: <number> | Confidence: HIGH/MEDIUM | Evidence: "<dialogue quote or exact visual action>"

If NOT FOUND:
PART <n>: NOT FOUND — not in this 20-minute window`

    const windowHits: MissingSceneWindowHit[] = []
    const processedMinutes = new Set<number>()
    const chunkQueue: number[] = []
    const candidates: MissingSceneCandidate[] = []

    // Build candidate lanes across all keys that have the active movie upload, filtering out any exhausted lanes instantly
    const windowCandLanes = keysWithMovie.flatMap((kw) =>
      CHUNK_MODEL_POOL.filter((m) => !globalGeminiCoordinator.isModelExhausted(kw.apiKey, m.id, m.rpd)).map((m) => ({
        apiKey: kw.apiKey,
        keyIdx: kw.keyIdx,
        modelId: m.id,
        rpd: m.rpd,
      })),
    )

    const activeKeys = apiKeys && apiKeys.length > 0 ? apiKeys : [primaryApiKey]
    const chunkCandLanes = activeKeys.flatMap((k: string, ki: number) =>
      CHUNK_MODEL_POOL.filter((m) => !globalGeminiCoordinator.isModelExhausted(k, m.id, m.rpd)).map((m) => ({
        apiKey: k,
        keyIdx: ki + 1,
        modelId: m.id,
        rpd: m.rpd,
      })),
    )

    let completedWindowsCount = 0
    const windowQueue = [...windowsToScan]
    let windowInFlight = 0
    let chunkInFlight = 0
    let isWindowPhaseDone = false

    const MAX_PARALLEL_WINDOWS = Math.max(2, Math.min(windowCandLanes.length, 6))
    const MAX_PARALLEL_CHUNKS = Math.max(3, Math.min(chunkCandLanes.length, 8))

    function updateProgressSummary() {
      const activeWinCount = windowInFlight
      const activeChkCount = chunkInFlight
      const winDone = completedWindowsCount
      const winTotal = windowsToScan.length
      const chkTotal = state.totalChunks || 0
      const chkDone = state.completedChunks || 0

      let progText = ''
      if (activeWinCount > 0 && activeChkCount > 0) {
        progText = `Parallel Scan: Windows (${winDone}/${winTotal} done, ${activeWinCount} active) · Chunks (${chkDone}/${chkTotal} done, ${activeChkCount} active)...`
      } else if (activeWinCount > 0) {
        progText = `Scanning ${winTotal} movie window(s) in parallel (${winDone}/${winTotal} done, ${activeWinCount} active)...`
      } else if (activeChkCount > 0) {
        progText = `Scanning 1-min chunks in parallel (${chkDone}/${chkTotal} done, ${activeChkCount} active)...`
      } else if (isWindowPhaseDone && chunkQueue.length === 0 && activeChkCount === 0) {
        progText = candidates.length > 0
          ? `Scan finished! ${candidates.length} candidate match(es) found.`
          : 'Scan complete — no matches found.'
      }

      state.progress = progText
      state.completedWindows = winDone
      state.activeWindows = activeWinCount
      state.completedChunks = chkDone
      state.activeChunks = activeChkCount
      saveScan(scan)
    }

    // Trigger instant pipelined chunk scanning as soon as a window finds a minute
    function triggerChunkScan(minute: number) {
      if (processedMinutes.has(minute)) return
      processedMinutes.add(minute)
      chunkQueue.push(minute)
      state.totalChunks = processedMinutes.size
      updateProgressSummary()
      void processChunkQueue()
    }

    // Chunk processor worker
    async function processChunkQueue() {
      while (chunkQueue.length > 0 && chunkInFlight < MAX_PARALLEL_CHUNKS && !ctrl.stopping) {
        const minute = chunkQueue.shift()
        if (minute === undefined) break

        chunkInFlight++
        updateProgressSummary()

        void (async () => {
          try {
            await scanSingleChunk(minute)
          } finally {
            chunkInFlight--
            state.completedChunks = (state.completedChunks || 0) + 1
            updateProgressSummary()
            void processChunkQueue()
          }
        })()
      }
    }

    // Single Chunk Scanner (runs concurrently on free keys/models)
    async function scanSingleChunk(minute: number) {
      if (ctrl.stopping) return

      const chunkIdx = minute
      const chunkStart = chunkIdx * 60
      const chunkEnd = chunkStart + 60
      const chunkFile = chunkPath(chunksDir, chunkIdx)

      addLog(
        scan,
        'info',
        `[Missing Scene Finder] 🚀 Instant Chunk Scan: Minute ${minute} (Movie ${fmtMinSec(chunkStart)}–${fmtMinSec(chunkEnd)})...`,
      )

      if (!fs.existsSync(/*turbopackIgnore: true*/ chunkFile)) {
        await extractClipPrecise(movieFile, chunkStart, chunkEnd, chunkFile)
      }

      let chunkSuccess = false
      let chunkAttempt = 0
      const maxChunkAttempts = 5

      while (!chunkSuccess && chunkAttempt < maxChunkAttempts && !ctrl.stopping) {
        chunkAttempt++
        let releaseChunkLock: ((sec?: number) => void) | null = null
        try {
          const { selected, release } = await globalGeminiCoordinator.acquireFirstAvailableLane({
            scanId,
            scanTitle: scan.shortName || scanId,
            candidates: chunkCandLanes,
            operation: `Missing Scene Chunk ${chunkIdx + 1} Map`,
            videoSeconds: 60,
            onWait: (msg) => addLog(scan, 'info', msg),
            isStopping: () => ctrl.stopping,
          })
          releaseChunkLock = release

          const runnerAi = getClient(selected.apiKey)
          const keyClip = await getClipForApiKey(selected.apiKey)

          // Upload chunk file directly under the selected API key to guarantee 100% permission access
          const up = await uploadVideo(runnerAi, chunkFile)
          uploadedFilesToClean.push({ key: selected.apiKey, name: up.name })

          const chunkPrompt = `You are a forensic video analyst.
- Video 1: Missing scene clip from the short video:
${partMapText}

- Video 2: 1-minute chunk cut from the movie (Minute ${minute} = ${fmtMinSec(chunkStart)} to ${fmtMinSec(chunkEnd)}).

Find if any part of Video 1 appears in Video 2.
Respond in Hinglish:
HISSA 1 — SHORT SCENE TIME MAP
mm:ss - mm:ss: <short description + exact quoted dialogue>

HISSA 2 — MOVIE MAP TIME
Map the scene to Video 2:
Short mm:ss.mmm - mm:ss.mmm --> Movie mm:ss.mmm - mm:ss.mmm
or:
Short mm:ss.mmm - mm:ss.mmm --> NOT FOUND`

          let cText = ''
          try {
            const resp = await runnerAi.models.generateContent({
              model: selected.modelId,
              contents: [
                {
                  role: 'user',
                  parts: [
                    { fileData: { fileUri: keyClip.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: 24 } },
                    { fileData: { fileUri: up.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: 24 } },
                    { text: chunkPrompt },
                  ],
                },
              ],
            })
            cText = resp.text || ''
            incrementModelUsage(selected.modelId, selected.apiKey)
            globalGeminiCoordinator.recordSuccess(selected.apiKey, selected.modelId, 0)
          } catch (reqErr) {
            const re = classifyError(reqErr)
            if (re.kind === 'rate' || re.kind === 'rpd') {
              const outcome = globalGeminiCoordinator.handleQuotaOrRateError(
                selected.apiKey,
                selected.modelId,
                0,
                selected.rpd || getModelDailyCap(selected.modelId),
                re.kind === 'rpd',
              )
              addLog(
                scan,
                'warn',
                `[Missing Scene Finder] Chunk ${chunkIdx + 1}: ${outcome.reason} (attempt ${chunkAttempt}/${maxChunkAttempts})`,
              )
              continue
            }

            const isPolicyBlocked =
              re.kind === 'policy_blocked' ||
              /prohibited_content|blocked_by_safety|safety_ratings_blocked|prompt block reason/i.test(re.message)

            if (isPolicyBlocked) {
              addLog(
                scan,
                'warn',
                `[Missing Scene Finder] Chunk ${chunkIdx + 1}: Flagged by Google Policy (PROHIBITED_CONTENT) on ${selected.modelId} — triggering 1 sanitized retry with Audio Stripped (-an Mute) + Neutral prompt...`,
              )

              // Sanitize muted chunk video
              const sanitizedDir = path.join(mediaDir, 'sanitized')
              fs.mkdirSync(sanitizedDir, { recursive: true })
              const sanitizedChunkFile = path.join(sanitizedDir, `missing-chunk-${String(chunkIdx).padStart(4, '0')}-muted.mp4`)
              if (!fs.existsSync(sanitizedChunkFile)) {
                await sanitizeVideoMute(chunkFile, sanitizedChunkFile)
              }
              const sanitizedUp = await uploadVideo(runnerAi, sanitizedChunkFile)
              uploadedFilesToClean.push({ key: selected.apiKey, name: sanitizedUp.name })

              try {
                const sanitizedResp = await runnerAi.models.generateContent({
                  model: selected.modelId,
                  contents: [
                    {
                      role: 'user',
                      parts: [
                        { fileData: { fileUri: keyClip.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: 24 } },
                        { fileData: { fileUri: sanitizedUp.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: 24 } },
                        { text: CHUNK_MAP_SANITIZED_PROMPT },
                      ],
                    },
                  ],
                })
                cText = sanitizedResp.text || ''
                incrementModelUsage(selected.modelId, selected.apiKey)
                addLog(scan, 'success', `[Missing Scene Finder] Chunk ${chunkIdx + 1}: Sanitized retry succeeded after policy flag bypass`)
              } catch (retryErr) {
                const retryRe = classifyError(retryErr)
                if (retryRe.kind === 'rate') {
                  globalGeminiCoordinator.reportRateLimit(selected.apiKey, selected.modelId)
                  continue
                }
                throw retryErr
              }
            } else {
              throw reqErr
            }
          }

          chunkSuccess = true
          const mapRegex = /(\d{1,2}:\d{2}(?:\.\d+)?)\s*-\s*(\d{1,2}:\d{2}(?:\.\d+)?)\s*-->\s*(?:Movie\s*)?(\d{1,2}:\d{2}(?:\.\d+)?)\s*-\s*(\d{1,2}:\d{2}(?:\.\d+)?)/gi
          let match: RegExpExecArray | null

          while ((match = mapRegex.exec(cText)) !== null) {
            const s1 = parseTs(match[1])
            const s2 = parseTs(match[2])
            const m1 = parseTs(match[3])
            const m2 = parseTs(match[4])

            if (s1 !== null && s2 !== null && m1 !== null && m2 !== null) {
              let matchedTarget = targets[0]
              for (const sp of sceneParts) {
                if (s1 >= sp.clipStart - 1 && s1 <= sp.clipEnd + 1) {
                  matchedTarget = sp.target
                  break
                }
              }

              const absShortStart = matchedTarget.shortStart + (s1 - (matchedTarget.clipStart || 0))
              const absShortEnd = matchedTarget.shortStart + (s2 - (matchedTarget.clipStart || 0))
              const absMovieStart = chunkStart + m1
              const absMovieEnd = chunkStart + m2

              const cand: MissingSceneCandidate = {
                id: `missing-cand-${chunkIdx}-${Date.now()}-${candidates.length}`,
                sceneId: matchedTarget.id,
                shortStart: Math.max(0, Number(absShortStart.toFixed(3))),
                shortEnd: Number(absShortEnd.toFixed(3)),
                movieMinute: minute,
                chunkIndex: chunkIdx,
                movieStart: Math.max(0, Number(absMovieStart.toFixed(3))),
                movieEnd: Number(absMovieEnd.toFixed(3)),
                model: selected.modelId,
                status: 'pending',
              }
              candidates.push(cand)
              state.candidates = [...candidates]
              saveScan(scan)
              addLog(
                scan,
                'info',
                `[Missing Scene Finder] 🎯 Candidate match found: Short ${fmtTime(cand.shortStart)}–${fmtTime(cand.shortEnd)} --> Movie ${fmtTime(cand.movieStart)}–${fmtTime(cand.movieEnd)} (Minute ${minute})`,
              )
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (chunkAttempt >= maxChunkAttempts) {
            addLog(scan, 'warn', `[Missing Scene Finder] Chunk ${chunkIdx + 1} mapping error: ${msg.slice(0, 120)}`)
          }
        } finally {
          if (releaseChunkLock) releaseChunkLock(60, CHUNK_COOLDOWN_MS)
        }
      }
    }

    // Single Window Scanner
    async function scanSingleWindow(win: { index: number; start: number; end: number }) {
      const winStartAbs = trimStart + win.start
      const winEndAbs = trimStart + win.end
      const winLabel = `Window ${win.index + 1} (${fmtMinSec(winStartAbs)}–${fmtMinSec(winEndAbs)})`

      let windowSuccess = false
      let winAttempt = 0
      const maxWinAttempts = 6

      while (!windowSuccess && winAttempt < maxWinAttempts && !ctrl.stopping) {
        winAttempt++
        let releaseGlobalLock: ((sec?: number) => void) | null = null
        try {
          const { selected, release } = await globalGeminiCoordinator.acquireFirstAvailableLane({
            scanId,
            scanTitle: scan.shortName || scanId,
            candidates: windowCandLanes,
            operation: `Missing Scene ${winLabel}`,
            videoSeconds: 60,
            onWait: (msg) => addLog(scan, 'info', msg),
            isStopping: () => ctrl.stopping,
          })
          releaseGlobalLock = release

          const runnerAi = getClient(selected.apiKey)
          const keyClip = await getClipForApiKey(selected.apiKey)
          const kw = keysWithMovie.find((x) => apiKeyHash(x.apiKey) === apiKeyHash(selected.apiKey))
          const movieUploadUri = kw ? kw.movieUri : keysWithMovie[0].movieUri

          addLog(
            scan,
            'info',
            `[Missing Scene Finder] ${winLabel}: Scanning on Key ${selected.keyIdx} (${selected.modelId})...`,
          )

          let text = ''
          try {
            const resp = await runnerAi.models.generateContent({
              model: selected.modelId,
              contents: [
                {
                  role: 'user',
                  parts: [
                    { fileData: { fileUri: keyClip.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: 24 } },
                    {
                      fileData: { fileUri: movieUploadUri, mimeType: 'video/mp4' },
                      videoMetadata: { fps: 1, startOffset: `${Math.round(win.start)}s`, endOffset: `${Math.round(win.end)}s` },
                    },
                    { text: windowPrompt },
                  ],
                },
              ],
            })
            text = resp.text || ''
            incrementModelUsage(selected.modelId, selected.apiKey)
            globalGeminiCoordinator.recordSuccess(selected.apiKey, selected.modelId, 0)
          } catch (reqErr) {
            const re = classifyError(reqErr)
            if (re.kind === 'rate' || re.kind === 'rpd') {
              const outcome = globalGeminiCoordinator.handleQuotaOrRateError(
                selected.apiKey,
                selected.modelId,
                0,
                selected.rpd || getModelDailyCap(selected.modelId),
                re.kind === 'rpd',
              )
              addLog(
                scan,
                'warn',
                `[Missing Scene Finder] ${winLabel}: ${outcome.reason} (attempt ${winAttempt}/${maxWinAttempts})`,
              )
              continue
            }

            const isPolicyBlocked =
              re.kind === 'policy_blocked' ||
              /prohibited_content|blocked_by_safety|safety_ratings_blocked|prompt block reason/i.test(re.message)

            if (isPolicyBlocked) {
              addLog(
                scan,
                'warn',
                `[Missing Scene Finder] ${winLabel}: Flagged by Google Policy (PROHIBITED_CONTENT) on ${selected.modelId} — triggering 1 sanitized retry with Audio Stripped (-an Mute) + Neutral prompt...`,
              )

              // Sanitize muted clip video
              const sanitizedDir = path.join(mediaDir, 'sanitized')
              fs.mkdirSync(sanitizedDir, { recursive: true })
              const sanitizedClipFile = path.join(sanitizedDir, 'missing-scenes-clip-muted.mp4')
              if (!fs.existsSync(sanitizedClipFile)) {
                await sanitizeVideoMute(clipOutFile, sanitizedClipFile)
              }
              const sanitizedUp = await uploadVideo(runnerAi, sanitizedClipFile)
              uploadedFilesToClean.push({ key: selected.apiKey, name: sanitizedUp.name })

              const sanitizedWindowPrompt = `Analyze visual scene alignment between Video 1 and Video 2 (silent forensic matching).
For each PART in Video 1:
If visual match occurs in Video 2, report:
PART <number> MATCH: Movie Minute <N> (around <mm:ss> - <mm:ss>)
If not found, report:
PART <number>: NOT FOUND`

              try {
                const sanitizedResp = await runnerAi.models.generateContent({
                  model: selected.modelId,
                  contents: [
                    {
                      role: 'user',
                      parts: [
                        { fileData: { fileUri: sanitizedUp.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: 24 } },
                        {
                          fileData: { fileUri: movieUploadUri, mimeType: 'video/mp4' },
                          videoMetadata: { fps: 1, startOffset: `${Math.round(win.start)}s`, endOffset: `${Math.round(win.end)}s` },
                        },
                        { text: sanitizedWindowPrompt },
                      ],
                    },
                  ],
                })
                text = sanitizedResp.text || ''
                incrementModelUsage(selected.modelId, selected.apiKey)
                addLog(scan, 'success', `[Missing Scene Finder] ${winLabel}: Sanitized retry succeeded after policy flag bypass`)
              } catch (retryErr) {
                const retryRe = classifyError(retryErr)
                if (retryRe.kind === 'rate') {
                  globalGeminiCoordinator.reportRateLimit(selected.apiKey, selected.modelId)
                  continue
                }
                throw retryErr
              }
            } else {
              throw reqErr
            }
          }

          windowSuccess = true
          completedWindowsCount++
          updateProgressSummary()

          // Parse matches and IMMEDIATELY pipeline chunk scans!
          const lines = text.split('\n')
          for (const line of lines) {
            const matchRegex = /PART\s*(\d+).*?(?:MATCH|FOUND)/i
            const partMatch = line.match(matchRegex)
            if (partMatch) {
              const partNum = parseInt(partMatch[1], 10)
              const scenePart = sceneParts.find((p) => p.partNum === partNum) || sceneParts[0]

              let foundMinute: number | null = null
              const minRegex = /Movie Minute\s*:\s*(\d+)/i
              const minM = line.match(minRegex)
              if (minM) {
                foundMinute = parseInt(minM[1], 10)
              } else {
                const timeRegex = /(\d{1,2}:\d{2}(?:\.\d+)?)\s*-\s*(\d{1,2}:\d{2}(?:\.\d+)?)/
                const timeM = line.match(timeRegex)
                if (timeM) {
                  const parsedT = parseTs(timeM[1])
                  if (parsedT !== null) {
                    const absSec = parsedT < win.end ? winStartAbs + parsedT : parsedT
                    foundMinute = Math.floor(absSec / 60)
                  }
                }
              }

              if (foundMinute !== null && foundMinute >= 0) {
                const hit: MissingSceneWindowHit = {
                  windowIndex: win.index,
                  windowStart: winStartAbs,
                  windowEnd: winEndAbs,
                  movieMinute: foundMinute,
                  sceneId: scenePart.target.id,
                  shortStart: scenePart.target.shortStart,
                  shortEnd: scenePart.target.shortEnd,
                  evidence: line.slice(0, 150),
                  confidence: line.includes('HIGH') ? 'HIGH' : 'MEDIUM',
                }
                windowHits.push(hit)
                state.windowHits = [...windowHits]
                saveScan(scan)
                addLog(
                  scan,
                  'success',
                  `[Missing Scene Finder] ⚡ Instant Hit: ${winLabel} found scene ${fmtTime(scenePart.target.shortStart)}–${fmtTime(scenePart.target.shortEnd)} in Movie Min ${foundMinute}! Triggering immediate 24fps chunk scan...`,
                )
                // IMMEDIATELY trigger streaming chunk scan in parallel!
                triggerChunkScan(foundMinute)
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (winAttempt >= maxWinAttempts) {
            addLog(scan, 'warn', `[Missing Scene Finder] ${winLabel} failed after ${maxWinAttempts} attempts: ${msg.slice(0, 120)}`)
          }
        } finally {
          if (releaseGlobalLock) releaseGlobalLock(60, CHUNK_COOLDOWN_MS)
        }
      }
    }

    // Launch parallel window scanning workers
    const windowWorkers: Promise<void>[] = []
    for (let w = 0; w < MAX_PARALLEL_WINDOWS; w++) {
      windowWorkers.push(
        (async () => {
          while (windowQueue.length > 0 && !ctrl.stopping) {
            const win = windowQueue.shift()
            if (!win) break
            windowInFlight++
            updateProgressSummary()
            try {
              await scanSingleWindow(win)
            } finally {
              windowInFlight--
              updateProgressSummary()
            }
          }
        })(),
      )
    }

    await Promise.all(windowWorkers)
    isWindowPhaseDone = true

    // Wait until all pipelined chunks are finished processing
    while ((chunkQueue.length > 0 || chunkInFlight > 0) && !ctrl.stopping) {
      await new Promise((r) => setTimeout(r, 400))
    }

    if (ctrl.stopping) return

    // 5. Finish scan - manual user review
    state.status = 'done'
    state.progress = candidates.length > 0
      ? `Scan finished! ${candidates.length} candidate match(es) found — review and accept/reject below.`
      : windowHits.length > 0
      ? `Window scan found ${windowHits.length} potential hit(s), but exact frame alignment was not confirmed.`
      : `Scan finished! No matching scenes found in the selected windows.`
    state.finishedAt = Date.now()
    saveScan(scan)
    addLog(
      scan,
      'success',
      `[Missing Scene Finder] Scan finished! Found ${candidates.length} candidate scene match(es) for manual review.`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    state.status = 'error'
    state.error = msg
    state.progress = `Error: ${msg.slice(0, 150)}`
    saveScan(scan)
    addLog(scan, 'error', `[Missing Scene Finder] Error: ${msg}`)
  } finally {
    // Clean up uploaded Gemini files across all keys used
    for (const item of uploadedFilesToClean) {
      const client = getClient(item.key)
      void deleteFileQuiet(client, item.name).catch(() => {})
    }
  }
}

/**
 * Review (Accept or Reject) a candidate match found by the Missing Scene Scanner.
 */
export function reviewMissingSceneCandidate(
  scan: Scan,
  candidateId: string,
  action: 'accept' | 'reject',
): { ok: boolean; error?: string } {
  if (!scan.missingSceneScan || !Array.isArray(scan.missingSceneScan.candidates)) {
    return { ok: false, error: 'No missing scene candidates in this scan' }
  }
  const cand = scan.missingSceneScan.candidates.find((c) => c.id === candidateId)
  if (!cand) return { ok: false, error: 'Candidate not found' }

  if (action === 'accept') {
    cand.status = 'confirmed'
    cand.verified = true
    const confirmedMatch: ChunkMatch = {
      chunkIndex: cand.chunkIndex,
      shortStart: cand.shortStart,
      shortEnd: cand.shortEnd,
      movieStart: cand.movieStart,
      movieEnd: cand.movieEnd,
      reason: `Missing scene candidate accepted by user (${cand.model})`,
      model: cand.model,
      verified: true,
      userPick: true,
      origin: 'gap-backup',
    }

    // Synchronize into candidateGroups so CandidateChooser, ComparePanel, and RenderPanel
    // treat this accepted candidate as the explicit user pick (MAIN clip).
    if (!scan.candidateGroups) scan.candidateGroups = []
    let g = scan.candidateGroups.find((x) =>
      sameShortSegment(x.shortStart, x.shortEnd, cand.shortStart, cand.shortEnd),
    )
    if (!g) {
      g = {
        id: `g-missing-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        shortStart: cand.shortStart,
        shortEnd: cand.shortEnd,
        status: 'confirmed',
        confirmedIndex: 0,
        confirmedViaRescan: false,
        origin: 'gap-backup',
        candidates: [
          {
            shortStart: cand.shortStart,
            shortEnd: cand.shortEnd,
            movieStart: cand.movieStart,
            movieEnd: cand.movieEnd,
            chunkIndex: cand.chunkIndex,
            model: cand.model,
            confidence: 0.99,
            verdict: 'same',
            rescan: 'none',
          },
        ],
        userPick: { index: 0, viaRescan: false, at: Date.now() },
      }
      scan.candidateGroups.push(g)
    } else {
      let candIdx = g.candidates.findIndex(
        (c) =>
          Math.abs(c.movieStart - cand.movieStart) < 0.5 &&
          Math.abs(c.movieEnd - cand.movieEnd) < 0.5,
      )
      if (candIdx === -1) {
        candIdx = g.candidates.length
        g.candidates.push({
          shortStart: cand.shortStart,
          shortEnd: cand.shortEnd,
          movieStart: cand.movieStart,
          movieEnd: cand.movieEnd,
          chunkIndex: cand.chunkIndex,
          model: cand.model,
          confidence: 0.99,
          verdict: 'same',
          rescan: 'none',
        })
      } else {
        g.candidates[candIdx].verdict = 'same'
      }
      g.status = 'confirmed'
      g.confirmedIndex = candIdx
      g.confirmedViaRescan = false
      g.userPick = { index: candIdx, viaRescan: false, at: Date.now() }
    }

    // Apply group matches to scan.matches (strictly preserves user picks)
    applyGroupMatches(scan, g)

    scan.missingSceneScan.addedMatches = scan.missingSceneScan.addedMatches || []
    if (!scan.missingSceneScan.addedMatches.some((m) => m.shortStart === cand.shortStart && m.movieStart === cand.movieStart)) {
      scan.missingSceneScan.addedMatches.push(confirmedMatch)
    }

    // A previously completed export contains the old match list; invalidate it so re-render/download
    // encodes the newly accepted main scene into the exported MP4.
    if (invalidateRenderedOutput(scan)) {
      addLog(scan, 'warn', '[Missing Scene Finder] Previous export cleared because new main clip was accepted — render again to export the updated merge')
    }

    if (scan.report) scan.report.matches = scan.matches

    saveScan(scan, { immediate: true })
    addLog(
      scan,
      'success',
      `[Missing Scene Finder] User ACCEPTED candidate: Short ${fmtTime(cand.shortStart)}–${fmtTime(cand.shortEnd)} matches Movie ${fmtTime(cand.movieStart)}–${fmtTime(cand.movieEnd)}! Set as MAIN clip.`,
    )
    return { ok: true }
  } else {
    cand.status = 'rejected'
    cand.verified = false
    if (Array.isArray(scan.matches)) {
      scan.matches = scan.matches.filter(
        (m) => !(Math.abs(m.shortStart - cand.shortStart) < 0.25 && Math.abs(m.movieStart - cand.movieStart) < 0.5),
      )
    }
    if (Array.isArray(scan.missingSceneScan.addedMatches)) {
      scan.missingSceneScan.addedMatches = scan.missingSceneScan.addedMatches.filter(
        (m) => !(Math.abs(m.shortStart - cand.shortStart) < 0.25 && Math.abs(m.movieStart - cand.movieStart) < 0.5),
      )
    }
    const g = (scan.candidateGroups || []).find((x) =>
      sameShortSegment(x.shortStart, x.shortEnd, cand.shortStart, cand.shortEnd),
    )
    if (g && g.userPick) {
      const picked = g.candidates[g.userPick.index]
      if (picked && Math.abs(picked.movieStart - cand.movieStart) < 0.5) {
        delete g.userPick
        applyGroupMatches(scan, g)
      }
    }
    invalidateRenderedOutput(scan)
    if (scan.report) scan.report.matches = scan.matches
    saveScan(scan, { immediate: true })
    addLog(
      scan,
      'info',
      `[Missing Scene Finder] User REJECTED candidate: Short ${fmtTime(cand.shortStart)}–${fmtTime(cand.shortEnd)}`,
    )
    return { ok: true }
  }
}
