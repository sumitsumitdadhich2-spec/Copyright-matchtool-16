import 'server-only'

import fs from 'node:fs'
import path from 'node:path'
import { getScan, saveScan, addLog, apiKeyHash, scanMediaDir, getModelUsage, incrementModelUsage, setModelExhausted, checkDailyReset, geminiUsageDay } from './store'
import { ensureLocalMedia, localMediaPath } from './media'
import { buildBackupClip, chunkPath, extractClipPrecise } from './ffmpeg'
import { CHUNK_MODEL_POOL, GAP_FINDER_AVAILABLE_MODELS } from './models'
import { deleteFileQuiet, cleanupOrphanedGeminiFiles, getClient, parseGapFinderOutput, runGapFinderChunk, uploadVideo, classifyError, GeminiError, type GapFinderPartSpec } from './gemini'
import { COVERAGE_MIN_GAP_SEC, coverageFromRanges, gapsOf, mergeRanges, shortTotalOf } from './short-coverage'
import { scheduler } from './scheduler'
import { sameShortSegment, applyGroupMatches } from './candidate-pick'
import { invalidateRenderedOutput } from './render'
import type { GapBackupCandidate, GapBackupMinute, GapBackupPart, GapBackupRequest, GapBackupState, Scan, ShortRange } from './types'

const BATCH_SIZE = 4
const active = new Map<string, { stopping: boolean }>()

function emptyState(): GapBackupState {
  return { status: 'idle', parts: [], minutes: [], requests: [], candidates: [], addedMatches: [], requestCount: 0, tokenCount: 0 }
}

function is503OrBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  return (
    lower.includes('503') ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('spikes in demand') ||
    lower.includes('temporarily unavailable') ||
    lower.includes('overloaded') ||
    lower.includes('backend error')
  )
}

function persist(scan: Scan, state: GapBackupState) {
  scan.gapBackup = state
  saveScan(scan, { immediate: true })
}

function log(scan: Scan, level: 'info' | 'warn' | 'error' | 'success', msg: string) {
  addLog(scan, level, msg)
  saveScan(scan)
}

function coverageMatches(scan: Scan) {
  // Coverage Review intentionally keeps rejected ranges covered so the same
  // short footage is not searched again by the manual recovery pass.
  return scan.matches || []
}

function uncovered(scan: Scan): ShortRange[] {
  const total = shortTotalOf(scan)
  return gapsOf(mergeRanges(coverageMatches(scan).map((match) => ({ start: match.shortStart, end: match.shortEnd }))), total)
    .filter((gap) => gap.end - gap.start >= COVERAGE_MIN_GAP_SEC)
}

function buildParts(gaps: ShortRange[]): GapBackupPart[] {
  const parts: GapBackupPart[] = []
  for (const gap of gaps) {
    let cursor = gap.start
    while (cursor < gap.end - 0.001) {
      const minuteIndex = Math.floor(cursor / 60)
      const end = Math.min(gap.end, (minuteIndex + 1) * 60)
      parts.push({
        index: parts.length + 1,
        minuteIndex,
        shortStart: cursor,
        shortEnd: end,
        gapStart: cursor,
        gapEnd: end,
        clipStart: 0,
        clipEnd: 0,
        result: 'pending',
      })
      cursor = end
    }
  }
  return parts
}

function orderedCandidateChunks(scan: Scan, minuteIndex: number): number[] {
  const segment = scan.shortSegments?.find((item) => item.index === minuteIndex)
  const trimStart = scan.movieTrimStart ?? 0
  const maxChunk = Math.max(0, scan.chunkCount - 1)
  const suggested = [...new Set((segment?.movieMinutes || []).map((minute) => Math.floor((minute * 60 - trimStart) / 60)))]
    .filter((index) => index >= 0 && index <= maxChunk)
  const minuteStart = minuteIndex * 60
  const minuteEnd = minuteStart + 60
  const accepted = coverageMatches(scan)
  const before = accepted.filter((match) => match.shortEnd <= minuteStart).sort((a, b) => b.shortEnd - a.shortEnd)[0]
  const after = accepted.filter((match) => match.shortStart >= minuteEnd).sort((a, b) => a.shortStart - b.shortStart)[0]
  const anchors = [before?.chunkIndex, after?.chunkIndex].filter((value): value is number => typeof value === 'number')
  const allowed = [...new Set([...anchors.filter((index) => suggested.includes(index)), ...suggested])]
  return allowed.sort((a, b) => {
    const da = anchors.length ? Math.min(...anchors.map((anchor) => Math.abs(anchor - a))) : suggested.indexOf(a)
    const db = anchors.length ? Math.min(...anchors.map((anchor) => Math.abs(anchor - b))) : suggested.indexOf(b)
    return da - db || suggested.indexOf(a) - suggested.indexOf(b)
  })
}

function scanCoverage(scan: Scan) {
  return coverageFromRanges(coverageMatches(scan).map((match) => ({ start: match.shortStart, end: match.shortEnd })), shortTotalOf(scan))
}

export function gapBackupRunning(id: string) {
  return active.has(id)
}

export function stopGapBackup(id: string) {
  const control = active.get(id)
  if (!control) return false
  control.stopping = true
  return true
}

export function gapBackupPreview(scan: Scan) {
  const saved = scan.gapBackup
  const state = saved && Array.isArray(saved.minutes) && Array.isArray(saved.requests) ? saved : emptyState()
  return { coverage: scanCoverage(scan), gaps: uncovered(scan), state }
}

export function startGapBackup(
  id: string,
  apiKeys: string[],
  selectedModels?: string[],
  selectedGaps?: Array<{ start: number; end: number }>,
) {
  if (active.has(id)) return { ok: false, error: 'Missing-scene finder already running' }
  const scan = getScan(id)
  if (!scan) return { ok: false, error: 'Scan not found' }
  if (scheduler.isRunning(id)) return { ok: false, error: 'Scan is still running — wait for verification to finish' }
  if (!scan.shortDuration || !scan.movieDuration || scan.awaitingTrim) return { ok: false, error: 'Upload both videos and confirm the movie trim first' }
  if (scan.gapBackup?.candidates.some((candidate) => candidate.review === 'pending')) return { ok: false, error: 'Review the pending Gemini candidates before retrying unresolved ranges' }
  if (!apiKeys.length) return { ok: false, error: 'Add a Gemini API key in Settings first' }
  const isNewDay = checkDailyReset()
  if (isNewDay) {
    addLog(scan, 'success', `[Daily Quota Reset] New date detected (${geminiUsageDay()}) — all Gemini daily quotas reset to fresh state.`)
  }
  for (const k of apiKeys) {
    void cleanupOrphanedGeminiFiles(k, 24 * 60 * 60_000)
  }
  const allGaps = uncovered(scan)
  if (!allGaps.length) return { ok: false, error: 'No true uncovered ranges remain' }

  let gapsToSearch: ShortRange[] = allGaps
  if (selectedGaps && selectedGaps.length > 0) {
    const total = shortTotalOf(scan)
    const valid = selectedGaps
      .map((g) => ({
        start: Math.max(0, Number(g.start)),
        end: Math.min(total, Number(g.end)),
      }))
      .filter((g) => g.end - g.start >= 0.2)
    if (valid.length > 0) {
      gapsToSearch = valid
    }
  }

  const control = { stopping: false }
  active.set(id, control)
  void runGapBackup(scan, apiKeys, gapsToSearch, control, selectedModels).finally(() => active.delete(id))
  return { ok: true }
}

function clipSpecs(parts: GapBackupPart[]): GapFinderPartSpec[] {
  return parts.map((part) => ({ id: part.index, shortStart: part.shortStart, shortEnd: part.shortEnd, clipStart: part.clipStart, clipEnd: part.clipEnd }))
}

async function ensureChunk(scan: Scan, movieFile: string, index: number) {
  const chunksDir = path.join(scanMediaDir(scan.id), 'chunks')
  const file = chunkPath(chunksDir, index)
  if (fs.existsSync(file)) return file
  fs.mkdirSync(chunksDir, { recursive: true })
  const start = (scan.movieTrimStart ?? 0) + index * 60
  const end = Math.min(scan.movieTrimEnd ?? scan.movieDuration ?? start + 60, start + 60)
  await extractClipPrecise(movieFile, start, end, file)
  return file
}

async function runGapBackup(scan: Scan, apiKeys: string[], gaps: ShortRange[], control: { stopping: boolean }, selectedModels?: string[]) {
  const previous = scan.gapBackup
  const parts = buildParts(gaps)
  const minuteIndexes = [...new Set(parts.map((part) => part.minuteIndex))]
  const minutes: GapBackupMinute[] = minuteIndexes.map((index) => ({
    index,
    start: index * 60,
    end: Math.min(scan.shortDuration!, (index + 1) * 60),
    status: 'queued',
    partIds: parts.filter((part) => part.minuteIndex === index).map((part) => part.index),
    candidateChunks: orderedCandidateChunks(scan, index),
    completedChunks: [],
  }))
  const state: GapBackupState = {
    ...emptyState(),
    status: 'cutting',
    progress: 'Missing short ranges ko minute-wise 24 fps clips me prepare kar rahe hain',
    runs: (previous?.runs || 0) + 1,
    parts,
    minutes,
    candidates: (previous?.candidates || []).filter((candidate) => candidate.review === 'accepted' && Boolean(candidate.id)),
    addedMatches: (scan.matches || []).filter((match) => match.origin === 'gap-backup'),
    startedAt: Date.now(),
  }
  persist(scan, state)
  log(scan, 'info', `Manual missing-scene finder started: ${parts.length} unresolved part(s) across ${minutes.length} short minute(s)`)
  const uploadedResources: Array<{ ai: ReturnType<typeof getClient>; name: string }> = []

  try {
    const shortFile = (await ensureLocalMedia(scan.id, 'short')) || localMediaPath(scan.id, 'short')
    const movieFile = (await ensureLocalMedia(scan.id, 'movie')) || localMediaPath(scan.id, 'movie')
    const mediaDir = scanMediaDir(scan.id)

    for (const minute of minutes) {
      if (control.stopping) break
      minute.status = 'preparing'
      minute.startedAt = Date.now()
      state.progress = `Short minute ${minute.index + 1}: 24 fps clip prepare ho raha hai`
      persist(scan, state)
      log(scan, 'info', `Missing-scene minute ${minute.index + 1}: preparing ${minute.partIds.length} gap part(s) at 24 fps`)
      const minuteParts = parts.filter((part) => minute.partIds.includes(part.index))
      const clipFile = path.join(mediaDir, 'gap-backup', `short-minute-${String(minute.index).padStart(3, '0')}.mp4`)
      const built = await buildBackupClip(shortFile, minuteParts.map((part) => ({ start: part.shortStart, end: part.shortEnd })), clipFile)
      minute.clip = { path: clipFile, durationSec: built.durationSec, sizeBytes: built.sizeBytes, fps: 24 }
      minute.preparedAt = Date.now()
      minuteParts.forEach((part, index) => {
        part.clipStart = built.parts[index].clipStart
        part.clipEnd = built.parts[index].clipEnd
      })
      if (!minute.candidateChunks.length) {
        minute.status = 'failed'
        minute.finishedAt = Date.now()
        minute.error = 'Original minute finder ne is short minute ke liye koi movie-minute suggestion nahi diya'
        log(scan, 'warn', `Missing-scene minute ${minute.index + 1}: no minute-finder movie suggestions; skipped`)
      } else {
        log(scan, 'info', `Missing-scene minute ${minute.index + 1}: clip ready (${built.durationSec.toFixed(2)}s); chunk order ${minute.candidateChunks.map((value) => value + 1).join(', ')}`)
      }
      persist(scan, state)
    }

    interface GapLane {
      key: string
      keyIndex: number
      model: (typeof GAP_FINDER_AVAILABLE_MODELS)[number]
      ai: ReturnType<typeof getClient>
      keyId: string
      cooldownUntil: number
      dead: boolean
    }

    const chosenModels = (selectedModels && selectedModels.length > 0)
      ? GAP_FINDER_AVAILABLE_MODELS.filter((m) => selectedModels.includes(m.id))
      : CHUNK_MODEL_POOL.map((m) => GAP_FINDER_AVAILABLE_MODELS.find((g) => g.id === m.id) || { id: m.id, name: m.id, rpd: m.rpd, rpm: m.rpm, description: '' })

    const allLanes: GapLane[] = apiKeys.flatMap((key, keyIndex) =>
      chosenModels.map((model) => ({
        key,
        keyIndex,
        model,
        ai: getClient(key),
        keyId: apiKeyHash(key),
        cooldownUntil: 0,
        dead: false,
      }))
    )

    log(scan, 'info', `[Missing Scene Finder] Running with ${chosenModels.length} selected model(s): ${chosenModels.map((m) => m.name || m.id).join(', ')} across ${apiKeys.length} key(s)`)

    const pickLane = (): GapLane | null => {
      const now = Date.now()
      const available = allLanes.filter(
        (l) => !l.dead && getModelUsage(l.model.id, l.key) < l.model.rpd && l.cooldownUntil <= now
      )
      if (available.length === 0) return null
      return available[Math.floor(Math.random() * available.length)]
    }

    const shortUploadPromises = new Map<string, Promise<{ uri: string; name: string }>>()
    const getShortUpload = (lane: GapLane, minute: GapBackupMinute) => {
      const cacheKey = `${minute.index}|${lane.keyId}`
      let p = shortUploadPromises.get(cacheKey)
      if (!p) {
        p = uploadVideo(lane.ai, minute.clip!.path).then((res) => {
          uploadedResources.push({ ai: lane.ai, name: res.name })
          return res
        })
        shortUploadPromises.set(cacheKey, p)
      }
      return p
    }

    for (let minutePosition = 0; minutePosition < minutes.length; minutePosition++) {
      const minute = minutes[minutePosition]
      if (control.stopping) break
      if (minute.status === 'failed' || !minute.clip) continue

      minute.status = 'searching'
      state.status = 'searching'
      log(scan, 'info', `Missing-scene minute ${minute.index + 1}: Gemini chunk search started with auto-retry system`)
      const unresolved = () => minute.partIds.filter((partId) => !state.candidates.some((candidate) => candidate.part === partId && candidate.review !== 'rejected'))

      interface QueueItem {
        chunkIndex: number
        attempts: number
      }

      const queue: QueueItem[] = minute.candidateChunks.map((chunkIndex) => ({ chunkIndex, attempts: 0 }))
      const inFlight = new Set<number>()
      const CONCURRENCY = Math.min(BATCH_SIZE, Math.max(1, apiKeys.length * 2))

      const processWorker = async () => {
        while (queue.length > 0 && unresolved().length > 0 && !control.stopping) {
          const item = queue.shift()
          if (!item) break
          inFlight.add(item.chunkIndex)

          let lane = pickLane()
          while (!lane && !control.stopping) {
            const anyAlive = allLanes.some((l) => !l.dead && getModelUsage(l.model.id, l.key) < l.model.rpd)
            if (!anyAlive) {
              log(scan, 'error', 'Missing-scene finder: Saari Gemini chunk-model aur backup lanes ki daily quota exhausted hai')
              throw new Error('Saari Gemini chunk-model aur fallback lanes ki daily quota exhausted hai')
            }
            const cooldowns = allLanes
              .filter((l) => !l.dead && getModelUsage(l.model.id, l.key) < l.model.rpd && l.cooldownUntil > Date.now())
              .map((l) => l.cooldownUntil)
            const waitMs = cooldowns.length > 0 ? Math.max(500, Math.min(...cooldowns) - Date.now()) : 1000
            await new Promise((r) => setTimeout(r, Math.min(waitMs, 4000)))
            lane = pickLane()
          }

          if (control.stopping || !lane) {
            inFlight.delete(item.chunkIndex)
            break
          }

          const chunkIndex = item.chunkIndex
          const chunkStart = (scan.movieTrimStart ?? 0) + chunkIndex * 60
          const chunkEnd = Math.min(scan.movieTrimEnd ?? scan.movieDuration!, chunkStart + 60)
          const request: GapBackupRequest = {
            id: `${minute.index}-${chunkIndex}-${Date.now()}-${item.attempts}`,
            minuteIndex: minute.index,
            batch: Math.floor(minute.completedChunks.length / BATCH_SIZE) + 1,
            chunkIndex,
            chunkStart,
            chunkEnd,
            lane: `key ${lane.keyIndex + 1} · ${lane.model.id}`,
            model: lane.model.id,
            status: 'uploading',
            queuedAt: Date.now(),
            startedAt: Date.now(),
          }
          state.requests.push(request)
          state.activeBatch = Array.from(inFlight)
          state.progress = `Minute ${minute.index + 1}: chunk ${chunkIndex + 1} on ${lane.model.id} (key ${lane.keyIndex + 1})`
          persist(scan, state)

          let uploadedChunkName: string | null = null
          try {
            const chunkFile = await ensureChunk(scan, movieFile, chunkIndex)
            const [shortRes, chunkRes] = await Promise.all([
              getShortUpload(lane, minute),
              uploadVideo(lane.ai, chunkFile),
            ])
            uploadedChunkName = chunkRes.name
            uploadedResources.push({ ai: lane.ai, name: chunkRes.name })

            request.uploadedAt = Date.now()
            request.status = 'running'
            state.requestCount = (state.requestCount || 0) + 1
            persist(scan, state)

            const partList = parts.filter((part) => unresolved().includes(part.index))
            const specs = clipSpecs(partList)
            const response = await runGapFinderChunk(
              lane.ai,
              lane.model.id,
              shortRes.uri,
              chunkRes.uri,
              specs,
              chunkStart,
              chunkEnd,
            )

            // Increment usage ONLY after call succeeds
            incrementModelUsage(lane.model.id, lane.key)

            const hits = parseGapFinderOutput(response.text, specs, chunkStart, chunkEnd)
            request.raw = response.text
            request.tokens = response.tokens ?? undefined
            request.matches = hits.length
            request.status = 'done'
            request.finishedAt = Date.now()
            state.tokenCount = (state.tokenCount || 0) + (response.tokens || 0)

            for (const hit of hits) {
              if (state.candidates.some((candidate) => candidate.part === hit.part && Math.abs(candidate.movieStart - hit.movieStart) < 0.5 && candidate.review !== 'rejected')) continue
              const targetPart = parts.find((part) => part.index === hit.part)
              if (!targetPart) continue
              const candidate: GapBackupCandidate = {
                id: `${hit.part}-${chunkIndex}-${Math.round(hit.movieStart * 1000)}`,
                part: hit.part,
                shortStart: targetPart.gapStart,
                shortEnd: targetPart.gapEnd,
                movieStart: hit.movieStart,
                movieEnd: hit.movieEnd,
                source: 'gap-backup',
                chunkIndex,
                model: lane.model.id,
                confidence: 1,
                reason: hit.evidence,
                review: 'pending',
                createdAt: Date.now(),
              }
              state.candidates.push(candidate)
              const part = parts.find((item) => item.index === hit.part)
              if (part) part.result = 'found'
            }

            minute.completedChunks.push(chunkIndex)
            log(
              scan,
              hits.length > 0 ? 'success' : 'info',
              `Missing-scene minute ${minute.index + 1}, chunk ${chunkIndex + 1}: ${hits.length > 0 ? `${hits.length} strict match(es) found` : 'no matching scene'} on ${lane.model.id} (key ${lane.keyIndex + 1})`,
            )
            persist(scan, state)
          } catch (err) {
            const e = err instanceof GeminiError ? err : classifyError(err)
            item.attempts = (item.attempts || 0) + 1
            const isPolicyBlocked =
              e.kind === 'policy_blocked' ||
              /prohibited_content|blocked_by_safety|safety_ratings_blocked|prompt block reason/i.test(e.message)

            if (isPolicyBlocked) {
              incrementModelUsage(lane.model.id, lane.key)
              request.status = 'failed'
              request.error = 'Flagged by Google Policy (PROHIBITED_CONTENT) — stopped to protect quota'
              request.finishedAt = Date.now()
              log(
                scan,
                'warn',
                `Missing-scene minute ${minute.index + 1}, chunk ${chunkIndex + 1}: Flagged by Google Policy (PROHIBITED_CONTENT) on ${lane.model.id} (key ${lane.keyIndex + 1}) — automatic retries stopped to protect API keys quota; moving to next chunk`,
              )
            } else if (item.attempts >= 7) {
              request.status = 'failed'
              request.error = e.message.slice(0, 500)
              request.finishedAt = Date.now()
              log(scan, 'error', `Missing-scene minute ${minute.index + 1}, chunk ${chunkIndex + 1} reached max retry limit (${item.attempts}/7) — skipping to protect quota: ${e.message.slice(0, 120)}`)
            } else if (e.kind === 'invalid_key') {
              for (const l of allLanes) {
                if (l.key === lane.key) {
                  l.dead = true
                }
              }
              queue.push(item)
              log(scan, 'error', `Missing-scene finder: Key ${lane.keyIndex + 1} is invalid/expired — disabled for this scan; chunk ${chunkIndex + 1} attempt ${item.attempts}/7 re-queued for another key`)
            } else if (e.kind === 'rpd') {
              setModelExhausted(lane.model.id, lane.key, lane.model.rpd)
              lane.dead = true
              queue.push(item)
              log(scan, 'warn', `Missing-scene finder: ${lane.model.id} (key ${lane.keyIndex + 1}) daily token/request quota exhausted — model lane removed, key ${lane.keyIndex + 1}'s other models remain active; chunk ${chunkIndex + 1} attempt ${item.attempts}/7 re-queued`)
            } else if (e.kind === 'empty') {
              lane.cooldownUntil = Date.now() + 3_000
              queue.push(item)
              log(scan, 'warn', `Missing-scene finder: Empty response on ${lane.model.id} (key ${lane.keyIndex + 1}) [No quota cut] — chunk ${chunkIndex + 1} attempt ${item.attempts}/7 re-queued for alternative model`)
            } else if (e.kind === 'rate' || is503OrBusyError(err)) {
              lane.cooldownUntil = Date.now() + 5_000
              queue.push(item)
              log(scan, 'warn', `Missing-scene finder: Rate limit / High demand on ${lane.model.id} (key ${lane.keyIndex + 1}) [No quota cut] — chunk ${chunkIndex + 1} attempt ${item.attempts}/7 re-queued (cooldown 5s)`)
            } else {
              queue.push(item)
              log(scan, 'warn', `Missing-scene finder: Chunk ${chunkIndex + 1} attempt ${item.attempts}/7 failed on ${lane.model.id} (key ${lane.keyIndex + 1}) [${e.message.slice(0, 100)}] — auto-retrying on another lane...`)
            }
            persist(scan, state)
          } finally {
            if (uploadedChunkName) {
              void deleteFileQuiet(lane.ai, uploadedChunkName).catch(() => {})
            }
            inFlight.delete(item.chunkIndex)
            state.activeBatch = Array.from(inFlight)
            persist(scan, state)
          }
        }
      }

      await Promise.all(Array.from({ length: CONCURRENCY }, () => processWorker()))

      // Auto-retry pass for unresolved parts if any candidate chunks failed or were skipped
      if (unresolved().length > 0 && !control.stopping) {
        const remainingChunks = minute.candidateChunks.filter((chunkIdx) => !minute.completedChunks.includes(chunkIdx))
        if (remainingChunks.length > 0) {
          log(scan, 'warn', `Missing-scene minute ${minute.index + 1}: ${unresolved().length} part(s) unresolved — starting auto-retry pass on ${remainingChunks.length} remaining chunk(s)...`)
          queue.push(...remainingChunks.map((chunkIndex) => ({ chunkIndex, attempts: 0 })))
          await Promise.all(Array.from({ length: CONCURRENCY }, () => processWorker()))
        }
      }

      minute.currentBatch = undefined
      for (const partId of unresolved()) {
        const part = parts.find((item) => item.index === partId)
        if (part?.result === 'pending') part.result = 'unresolved'
      }
      minute.status = state.candidates.some((candidate) => minute.partIds.includes(candidate.part) && candidate.review === 'pending') ? 'awaiting_review' : 'done'
      minute.finishedAt = Date.now()
      persist(scan, state)
    }

    await Promise.allSettled(shortUploadPromises.values())
    await Promise.allSettled(uploadedResources.map(({ ai, name }) => deleteFileQuiet(ai, name)))
    state.activeBatch = undefined
    if (control.stopping) {
      state.status = 'stopped'
      state.progress = 'User ne finder stop kiya; completed replies save hain aur Retry se unresolved work continue hoga'
    } else if (state.candidates.some((candidate) => candidate.review === 'pending')) {
      state.status = 'awaiting_review'
      state.progress = 'Gemini search complete — candidates ko side-by-side review karke Accept ya Reject karein'
    } else {
      state.status = 'done'
      state.progress = 'Search complete — koi strict pending candidate nahi mila'
    }
    state.finishedAt = Date.now()
    persist(scan, state)
    log(scan, 'success', `Missing-scene finder finished: ${state.candidates.filter((candidate) => candidate.review === 'pending').length} candidate(s) awaiting review`)
  } catch (error) {
    await Promise.allSettled(uploadedResources.map(({ ai, name }) => deleteFileQuiet(ai, name)))
    state.status = 'error'
    state.error = error instanceof Error ? error.message : String(error)
    state.progress = 'Finder error par ruk gaya; details niche request logs me hain'
    state.finishedAt = Date.now()
    persist(scan, state)
    log(scan, 'error', `Missing-scene finder failed: ${state.error}`)
  }
}

export function reviewGapCandidate(scan: Scan, candidateId: string, decision: 'accept' | 'reject') {
  const state = scan.gapBackup
  const candidate = state?.candidates.find((item) => item.id === candidateId)
  if (!state || !candidate) return { ok: false, error: 'Candidate not found' }
  if (decision === 'accept') {
    for (const item of state.candidates) if (item.part === candidate.part && item.id !== candidate.id && item.review === 'pending') item.review = 'rejected'
    candidate.review = 'accepted'

    if (!scan.candidateGroups) scan.candidateGroups = []
    let g = scan.candidateGroups.find((x) =>
      sameShortSegment(x.shortStart, x.shortEnd, candidate.shortStart, candidate.shortEnd),
    )
    if (!g) {
      g = {
        id: `g-gap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        shortStart: candidate.shortStart,
        shortEnd: candidate.shortEnd,
        status: 'confirmed',
        confirmedIndex: 0,
        confirmedViaRescan: false,
        origin: 'gap-backup',
        candidates: [
          {
            shortStart: candidate.shortStart,
            shortEnd: candidate.shortEnd,
            movieStart: candidate.movieStart,
            movieEnd: candidate.movieEnd,
            chunkIndex: candidate.chunkIndex,
            model: candidate.model,
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
          Math.abs(c.movieStart - candidate.movieStart) < 0.5 &&
          Math.abs(c.movieEnd - candidate.movieEnd) < 0.5,
      )
      if (candIdx === -1) {
        candIdx = g.candidates.length
        g.candidates.push({
          shortStart: candidate.shortStart,
          shortEnd: candidate.shortEnd,
          movieStart: candidate.movieStart,
          movieEnd: candidate.movieEnd,
          chunkIndex: candidate.chunkIndex,
          model: candidate.model,
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

    applyGroupMatches(scan, g)
    state.addedMatches = scan.matches.filter((item) => item.origin === 'gap-backup')
    const part = state.parts.find((item) => item.index === candidate.part)
    if (part) part.result = 'accepted'
    invalidateRenderedOutput(scan)
    if (scan.report) scan.report.matches = scan.matches
  } else {
    candidate.review = 'rejected'
    const part = state.parts.find((item) => item.index === candidate.part)
    if (part && !state.candidates.some((item) => item.part === candidate.part && item.review === 'pending')) part.result = 'rejected'
  }
  if (!state.candidates.some((item) => item.review === 'pending')) {
    state.status = 'done'
    state.progress = 'Sab Gemini candidates review ho gaye'
  }
  persist(scan, state)
  return { ok: true }
}
