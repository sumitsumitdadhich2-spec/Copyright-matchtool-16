import fs from 'node:fs'
import path from 'node:path'
import { getScan, saveScan, addLog, scanMediaDir, listScans } from './store'
import type { Scan } from './types'
import { probeDuration, chunkShort, cleanupSegments, chunkPath, chunkMovie, triggerFastPreview } from './ffmpeg'
import { CHUNK_SECONDS } from './models'
import { deleteEmbeddings } from './twelvelabs'
import { copyObject, getFile, objectExists, putFile, storageEnabled } from './storage'
import { MEDIA_DIR, DISK_LIMIT_BYTES } from './paths'

export type MediaKind = 'short' | 'movie'

// Originals live on the EBS disk (DATA_DIR/media/<id>/<kind>.mp4) — that is
// what ffmpeg reads. Each file is copied to S3 (media/<id>/<kind>.mp4) in the
// background for durability; if the local file ever goes missing (fresh
// instance / disk replaced) it is pulled back down from S3 on demand.

export function mediaStorageKey(id: string, kind: MediaKind): string {
  return `media/${id}/${kind}.mp4`
}

export function localMediaPath(id: string, kind: MediaKind): string {
  return path.join(scanMediaDir(id), `${kind}.mp4`)
}

// Only one download per (id, kind) at a time — parallel requests share it.
const inflight = new Map<string, Promise<string | null>>()

/**
 * Make sure the video exists locally for ffmpeg/preview. Only hits S3 when
 * the local file is missing. Pass force=true to replace a stale local copy.
 */
export async function ensureLocalMedia(id: string, kind: MediaKind, force = false): Promise<string | null> {
  const local = localMediaPath(id, kind)
  if (!force && fs.existsSync(/*turbopackIgnore: true*/ local) && fs.statSync(local).size > 0) return local
  if (!storageEnabled()) return null

  const key = `${id}/${kind}`
  const existing = inflight.get(key)
  if (existing) return existing

  const job = (async (): Promise<string | null> => {
    try {
      const startedAt = Date.now()
      const ok = await getFile(mediaStorageKey(id, kind), local)
      if (!ok) return null
      console.log(`[media] restored ${kind} of ${id} from S3 in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
      return local
    } catch (err) {
      console.error('[media] download from S3 failed:', err instanceof Error ? err.message : err)
      return null
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, job)
  return job
}

// ---------- Local → S3 mirror ----------
// Runs in the background right after an upload finishes — never blocks the
// user, ffmpeg starts on the local file immediately. De-duplicated per
// (id, kind).

const mirroring = new Map<string, Promise<boolean>>()

export function mirrorMediaToStorage(id: string, kind: MediaKind, contentType = 'video/mp4'): Promise<boolean> {
  const key = `${id}/${kind}`
  const existing = mirroring.get(key)
  if (existing) return existing

  const job = (async (): Promise<boolean> => {
    const local = localMediaPath(id, kind)
    try {
      if (!storageEnabled()) return false
      if (!fs.existsSync(/*turbopackIgnore: true*/ local)) return false
      const size = fs.statSync(local).size
      if (size === 0) return false
      const startedAt = Date.now()
      await putFile(mediaStorageKey(id, kind), local, contentType)
      console.log(`[media] backed up ${kind} of ${id} to S3 (${(size / 1048576).toFixed(1)} MB in ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`)
      return true
    } catch (err) {
      console.error('[media] S3 backup failed:', err instanceof Error ? err.message : err)
      return false
    } finally {
      mirroring.delete(key)
    }
  })()
  mirroring.set(key, job)
  return job
}

// ---------- Re-use an already uploaded video (no second upload) ----------
// Same file name + same byte size in an earlier scan = same video. If that
// scan's original is still on the EBS disk we hard-link it into the new scan
// (instant, zero extra bytes); if only the S3 backup survives we pull it down
// from S3 (server-side, LAN speed) — either way the browser sends nothing.

export interface ReusableMedia {
  scanId: string
  /** Where the bytes are right now. */
  source: 'disk' | 's3'
  duration: number | null
}

function fileSizeSafe(p: string): number {
  try {
    return fs.statSync(/*turbopackIgnore: true*/ p).size
  } catch {
    return 0
  }
}

/**
 * Find a previous scan that holds THIS exact video (name + size match) and
 * still has the bytes somewhere (local disk first, then S3). Newest first.
 */
export async function findReusableMedia(kind: MediaKind, name: string, size: number, excludeId?: string): Promise<ReusableMedia | null> {
  if (!name || !Number.isFinite(size) || size <= 0) return null
  const nameKey = kind === 'short' ? 'shortName' : 'movieName'
  const sizeKey = kind === 'short' ? 'shortSize' : 'movieSize'
  const durKey = kind === 'short' ? 'shortDuration' : 'movieDuration'

  const candidates = listScans()
    .filter((s) => s.id !== excludeId && s[nameKey] === name)
    .map((s) => getScan(s.id))
    .filter((s): s is Scan => Boolean(s) && s![sizeKey] === size)

  // 1) Local disk — instant.
  for (const s of candidates) {
    const local = localMediaPath(s.id, kind)
    if (fileSizeSafe(local) === size) return { scanId: s.id, source: 'disk', duration: s[durKey] }
  }
  // 2) S3 backup — server pulls it, browser still sends nothing.
  if (storageEnabled()) {
    for (const s of candidates) {
      try {
        if (await objectExists(mediaStorageKey(s.id, kind))) return { scanId: s.id, source: 's3', duration: s[durKey] }
      } catch (err) {
        console.warn('[media] S3 head failed while looking for a reusable video:', err instanceof Error ? err.message : err)
      }
    }
  }
  return null
}

/**
 * Put the bytes of `sourceId`'s video into `targetId` without an upload.
 * Hard-link when the source is on disk (falls back to a copy across devices),
 * otherwise download from S3 straight into the target path. Resolves the
 * local path or null when the source vanished in the meantime.
 */
export async function reuseMedia(targetId: string, kind: MediaKind, sourceId: string, expectedSize: number): Promise<string | null> {
  const dest = localMediaPath(targetId, kind)
  if (sourceId === targetId) return fileSizeSafe(dest) === expectedSize ? dest : null

  const src = localMediaPath(sourceId, kind)
  const startedAt = Date.now()
  if (fileSizeSafe(src) === expectedSize) {
    try {
      fs.unlinkSync(dest)
    } catch {
      // nothing to replace
    }
    try {
      fs.linkSync(src, dest)
      console.log(`[media] reused ${kind} of ${sourceId} → ${targetId} via hard link (instant)`)
    } catch {
      fs.copyFileSync(src, dest)
      console.log(`[media] reused ${kind} of ${sourceId} → ${targetId} via copy in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
    }
    return fileSizeSafe(dest) === expectedSize ? dest : null
  }

  if (!storageEnabled()) return null
  try {
    const ok = await getFile(mediaStorageKey(sourceId, kind), dest)
    if (!ok) return null
    console.log(`[media] reused ${kind} of ${sourceId} → ${targetId} from S3 in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
  } catch (err) {
    console.error('[media] S3 fetch for reuse failed:', err instanceof Error ? err.message : err)
    return null
  }
  return fileSizeSafe(dest) === expectedSize ? dest : null
}

/**
 * Durable copy for a reused video: S3→S3 server-side copy when the source is
 * already backed up (no bytes leave AWS), otherwise a normal mirror upload.
 */
export async function mirrorReusedMedia(targetId: string, kind: MediaKind, sourceId: string, contentType = 'video/mp4'): Promise<boolean> {
  if (!storageEnabled()) return false
  if (sourceId !== targetId) {
    try {
      if (await copyObject(mediaStorageKey(sourceId, kind), mediaStorageKey(targetId, kind), contentType)) {
        console.log(`[media] S3 copy media/${sourceId}/${kind}.mp4 → media/${targetId}/${kind}.mp4`)
        return true
      }
    } catch (err) {
      console.warn('[media] S3 server-side copy failed, falling back to upload:', err instanceof Error ? err.message : err)
    }
  }
  return mirrorMediaToStorage(targetId, kind, contentType)
}

// ---------- Re-use 480p prescan copy, chunks, and Gemini uploads across scans ----------

/**
 * Check if the 1-minute cut chunks for THIS exact movie and trim range already
 * exist from a previous scan. If so, hard-link (or copy) all chunk files into targetId's
 * chunks dir so heavy ffmpeg chunk cutting is completely skipped.
 */
export async function findAndReuseMovieChunks(
  targetId: string,
  movieName: string,
  movieSize: number,
  trimStart: number,
  trimEnd: number,
  expectedCount: number,
): Promise<{ ok: boolean; count: number; sourceId?: string }> {
  if (!movieName || !Number.isFinite(movieSize) || movieSize <= 0 || expectedCount <= 0) {
    return { ok: false, count: 0 }
  }

  const targetChunksDir = path.join(scanMediaDir(targetId), 'chunks')
  const candidates = listScans()
    .filter((s) => s.id !== targetId && s.movieName === movieName)
    .map((s) => getScan(s.id))
    .filter((s): s is Scan => Boolean(s) && s.movieSize === movieSize)

  for (const cand of candidates) {
    const candStart = cand.movieTrimStart ?? 0
    const candEnd = cand.movieTrimEnd ?? cand.movieDuration ?? 0
    // Check if the trim range is identical (within 0.1s tolerance)
    if (Math.abs(candStart - trimStart) >= 0.1 || Math.abs(candEnd - trimEnd) >= 0.1) continue

    const candChunksDir = path.join(scanMediaDir(cand.id), 'chunks')
    if (!fs.existsSync(candChunksDir)) continue

    // Check if all expected chunks exist and are non-empty
    let allExist = true
    for (let i = 0; i < expectedCount; i++) {
      const p = chunkPath(candChunksDir, i)
      try {
        if (!fs.existsSync(p) || fs.statSync(p).size === 0) {
          allExist = false
          break
        }
      } catch {
        allExist = false
        break
      }
    }
    if (!allExist) continue

    // Reusable chunks found! Hard-link or copy into targetId's chunks dir
    try {
      fs.mkdirSync(targetChunksDir, { recursive: true })
      let linked = 0
      for (let i = 0; i < expectedCount; i++) {
        const srcP = chunkPath(candChunksDir, i)
        const dstP = chunkPath(targetChunksDir, i)
        if (fs.existsSync(dstP) && fs.statSync(dstP).size > 0) {
          linked++
          continue
        }
        try {
          fs.rmSync(dstP, { force: true })
        } catch {
          // ignore
        }
        try {
          fs.linkSync(srcP, dstP)
          linked++
        } catch {
          try {
            fs.copyFileSync(srcP, dstP)
            linked++
          } catch (err) {
            console.warn(`[media] could not link chunk ${i} from scan ${cand.id}:`, err)
            break
          }
        }
      }
      if (linked === expectedCount) {
        console.log(`[media] reused ${expectedCount} movie chunk(s) from scan ${cand.id} → ${targetId}`)
        return { ok: true, count: expectedCount, sourceId: cand.id }
      }
    } catch (err) {
      console.warn(`[media] failed reusing chunks from scan ${cand.id}:`, err)
    }
  }

  return { ok: false, count: 0 }
}

/**
 * Check if the re-encoded 480p movie upload copy already exists for THIS exact
 * movie and trim range from a previous scan. If so, hard-link (or copy) it into
 * targetId's media dir and return its metadata so 480p re-encoding is skipped.
 */
export async function findAndReusePrescanMovie(
  targetId: string,
  movieName: string,
  movieSize: number,
  trimStart: number,
  trimEnd: number,
): Promise<{ ok: boolean; copyPath: string; durationSec: number; sizeBytes: number; reencoded: boolean; sourceId: string } | null> {
  if (!movieName || !Number.isFinite(movieSize) || movieSize <= 0) return null

  const candidates = listScans()
    .filter((s) => s.id !== targetId && s.movieName === movieName)
    .map((s) => getScan(s.id))
    .filter((s): s is Scan => Boolean(s) && s.movieSize === movieSize)

  const targetCopy = path.join(scanMediaDir(targetId), 'prescan-movie.mp4')

  for (const cand of candidates) {
    const candStart = cand.movieTrimStart ?? 0
    const candEnd = cand.movieTrimEnd ?? cand.movieDuration ?? 0
    if (Math.abs(candStart - trimStart) >= 0.1 || Math.abs(candEnd - trimEnd) >= 0.1) continue

    const candCopy = path.join(scanMediaDir(cand.id), 'prescan-movie.mp4')
    if (!fs.existsSync(candCopy)) continue
    const size = fs.statSync(candCopy).size
    if (size < 1000) continue
    // Gemini limit check: do not reuse if copy is larger than 1.95 GB
    if (size > 1.95 * 1024 * 1024 * 1024) continue

    try {
      fs.mkdirSync(path.dirname(targetCopy), { recursive: true })
      if (targetCopy !== candCopy) {
        try {
          fs.rmSync(targetCopy, { force: true })
        } catch {
          // ignore
        }
        try {
          fs.linkSync(candCopy, targetCopy)
        } catch {
          fs.copyFileSync(candCopy, targetCopy)
        }
      }
      const durationSec = cand.geminiPrescan?.movieCopy?.durationSec || (await probeDuration(targetCopy))
      const reencoded = cand.geminiPrescan?.movieCopy?.reencoded ?? false
      console.log(`[media] reused prescan movie copy from scan ${cand.id} → ${targetId} (${durationSec.toFixed(1)}s, ${size} bytes, ${reencoded ? '480p' : 'direct'})`)
      return {
        ok: true,
        copyPath: targetCopy,
        durationSec,
        sizeBytes: size,
        reencoded,
        sourceId: cand.id,
      }
    } catch (err) {
      console.warn(`[media] failed reusing prescan movie copy from scan ${cand.id}:`, err)
    }
  }

  return null
}

/**
 * Find if the prescan movie copy is already active in Gemini Files API on this key
 * from an earlier scan of the same movie and trim (cached ≤ 47h).
 */
export function findReusableGeminiMovieUpload(
  movieName: string,
  movieSize: number,
  keyId: string,
  trimStart: number,
  trimEnd: number,
  excludeId?: string,
): { movieUri: string; movieName: string; uploadedAt: number; sourceId: string } | null {
  if (!movieName || !Number.isFinite(movieSize) || movieSize <= 0) return null

  const candidates = listScans()
    .filter((s) => s.id !== excludeId && s.movieName === movieName)
    .map((s) => getScan(s.id))
    .filter((s): s is Scan => Boolean(s) && s.movieSize === movieSize)

  for (const cand of candidates) {
    const candStart = cand.movieTrimStart ?? 0
    const candEnd = cand.movieTrimEnd ?? cand.movieDuration ?? 0
    if (Math.abs(candStart - trimStart) >= 0.1 || Math.abs(candEnd - trimEnd) >= 0.1) continue

    const up = cand.geminiPrescan?.uploads?.[keyId]
    if (up?.movieName && up?.movieUri && Date.now() - (up.uploadedAt || 0) < 47 * 3600 * 1000) {
      return { movieUri: up.movieUri, movieName: up.movieName, uploadedAt: up.uploadedAt, sourceId: cand.id }
    }
  }
  return null
}

// ---------- Storage usage (local EBS disk) ----------

export const STORAGE_LIMIT_BYTES = DISK_LIMIT_BYTES

let usageCache: { used: number; at: number } | null = null
let refreshPromise: Promise<number> | null = null
let cacheGeneration = 0

const CACHE_TTL_MS = 60_000

function createConcurrencyLimiter(concurrency: number) {
  let active = 0
  const queue: Array<() => void> = []

  const dispatch = () => {
    while (active < concurrency && queue.length > 0) {
      active++
      const task = queue.shift()!
      task()
    }
  }

  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = () => {
        try {
          Promise.resolve(fn())
            .then(resolve, reject)
            .finally(() => {
              active--
              dispatch()
            })
        } catch (err) {
          reject(err)
          active--
          dispatch()
        }
      }
      queue.push(task)
      dispatch()
    })
  }
}

async function dirSize(dir: string): Promise<number> {
  const seenInodes = new Set<number>()
  let total = 0
  const limit = createConcurrencyLimiter(10)

  async function walk(currentDir: string): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await limit(() => fs.promises.readdir(currentDir, { withFileTypes: true }))
    } catch {
      return
    }

    const subTasks: Promise<void>[] = []

    for (const e of entries) {
      const p = path.join(currentDir, e.name)
      try {
        if (e.isDirectory()) {
          subTasks.push(walk(p))
        } else if (e.isFile()) {
          subTasks.push(
            limit(async () => {
              try {
                const st = await fs.promises.stat(p)
                if (!seenInodes.has(st.ino)) {
                  seenInodes.add(st.ino)
                  total += st.size
                }
              } catch {
                // file vanished mid-walk or permission issue
              }
            })
          )
        }
      } catch {
        // ignore entry error
      }
    }

    await Promise.all(subTasks)
  }

  await walk(dir)
  return total
}

function startUsageComputation(): Promise<number> {
  const currentGen = cacheGeneration
  let p: Promise<number> | null = null
  p = (async () => {
    try {
      const used = await dirSize(MEDIA_DIR)
      if (cacheGeneration === currentGen) {
        usageCache = { used, at: Date.now() }
      }
      return used
    } catch (err) {
      console.error('[media] storage usage calculation failed:', err)
      return usageCache?.used ?? 0
    } finally {
      if (refreshPromise === p) {
        refreshPromise = null
      }
    }
  })()
  refreshPromise = p
  return p
}

/** Bytes used by all scan media on the local disk. Non-blocking & cached (stale-while-revalidate). */
export async function getStorageUsage(): Promise<number> {
  const now = Date.now()

  // 1. Return fresh cached value immediately if available (< 60s)
  if (usageCache && now - usageCache.at < CACHE_TTL_MS) {
    return usageCache.used
  }

  // 2. Return stale cached value immediately and trigger async background refresh
  if (usageCache) {
    if (!refreshPromise) {
      startUsageComputation().catch(() => {})
    }
    return usageCache.used
  }

  // 3. Cold start (no cache yet): await the first non-blocking async computation
  if (!refreshPromise) {
    startUsageComputation()
  }
  return refreshPromise!
}

export function invalidateUsageCache() {
  usageCache = null
  cacheGeneration++
  refreshPromise = null
}

/** Free bytes on the volume that holds DATA_DIR (for /api/health). */
export function diskFree(): { free: number; total: number } {
  try {
    const st = fs.statfsSync(MEDIA_DIR)
    return { free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize) }
  } catch {
    return { free: 0, total: 0 }
  }
}

// ---------- Post-upload finalize ----------
// Runs after the browser uploaded the video straight to the server (local
// disk): probe duration, set up segments/chunk state, cut scan copies.
// No Blob round-trip — ffmpeg works on the local file immediately.

export async function finalizeUploadedMedia(
  scan: Scan,
  kind: MediaKind,
  name: string,
): Promise<{ ok: true; duration: number; size: number } | { ok: false; error: string }> {
  const id = scan.id
  const dest = localMediaPath(id, kind)
  if (!fs.existsSync(/*turbopackIgnore: true*/ dest) || fs.statSync(dest).size === 0) {
    return { ok: false, error: 'Video not found on the server — upload may have failed. Please try again.' }
  }
  const size = fs.statSync(/*turbopackIgnore: true*/ dest).size
  const mediaDir = scanMediaDir(id)

  // A fresh short/movie upload invalidates any previous auto-merge pipeline
  // output — stale merged.mp4 / asset / embeddings / segmentation must never
  // be reused (dono kinds ki embeddings ek hi merged index se aati hain).
  try {
    const staleMerged = path.join(mediaDir, 'merged.mp4')
    if (fs.existsSync(/*turbopackIgnore: true*/ staleMerged)) fs.unlinkSync(staleMerged)
  } catch {
    // ignore cleanup failure
  }
  if (scan.mergePipeline && scan.mergePipeline.status !== 'idle') {
    scan.mergePipeline = { status: 'idle' }
  }
  await Promise.all([deleteEmbeddings(id, 'short'), deleteEmbeddings(id, 'movie')])
  if (scan.twelveLabs && scan.twelveLabs.status !== 'none') {
    scan.twelveLabs = { status: 'none' }
  }

  let duration: number
  try {
    duration = await probeDuration(dest)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[media] probeDuration failed:', msg)
    // Binary missing/setup failure is a SERVER problem, not a bad video.
    if (msg.includes('binary not found') || msg.includes('ENOENT')) {
      return { ok: false, error: 'Video processing setup failed on the server. Please try again in a moment.' }
    }
    // A missing moov atom means the file was cut off mid-transfer (or is still
    // downloading/syncing on the user's device) — the video itself may be fine.
    if (msg.includes('moov atom not found')) {
      return {
        ok: false,
        error: 'The file arrived incomplete (missing MP4 index). If it is syncing from cloud storage, wait for it to finish downloading, then upload again.',
      }
    }
    // Surface the real ffprobe reason so "invalid video" errors are debuggable.
    const detail = msg.replace(/^ffprobe exited \d+:\s*/i, '').split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 200)
    return {
      ok: false,
      error: `Could not read video file. Is it a valid video?${detail ? ` (${detail})` : ''}`,
    }
  }

  if (kind === 'short') {
    // The ORIGINAL short is NEVER overwritten: preview, verifier clips and the
    // render pipeline use it at full quality. Scanning uses separate re-encoded
    // 1-minute segment files cut in the background.
    scan.shortName = name
    scan.shortSize = size
    scan.shortDuration = duration
    const segCount = Math.max(1, Math.ceil(duration / CHUNK_SECONDS))
    scan.shortSegments = Array.from({ length: segCount }, (_, i) => ({
      index: i,
      start: i * CHUNK_SECONDS,
      end: Math.min((i + 1) * CHUNK_SECONDS, duration),
      status: 'pending' as const,
      chunks: [],
    }))
    scan.currentShortSegment = 0
    scan.shortSegmentingProgress = 0
    addLog(
      scan,
      'info',
      segCount > 1
        ? `Short video uploaded: ${name} (${fmtDur(duration)}) — scanned minute-by-minute (${segCount} segments), original preserved`
        : `Short video uploaded: ${name} (${fmtDur(duration)}) — original preserved, scan copy cut in background`,
    )
    saveScan(scan, { immediate: true })

    // Immediately trigger lightweight web preview generation in background for ultra-fast UI playback
    triggerFastPreview(id, dest, mediaDir, 'short')

    // Background: cut 24 fps / 640px scan segments — original untouched.
    const segDir = path.join(mediaDir, 'segments')
    void (async () => {
      try {
        cleanupSegments(segDir)
        const actual = await chunkShort(dest, segDir, duration, (pct) => {
          const s = getScan(id)
          if (s) {
            s.shortSegmentingProgress = pct
            saveScan(s)
          }
        }, { owner: id })
        const s = getScan(id)
        if (s) {
          s.shortSegmentingProgress = 100
          if (actual !== s.shortSegments?.length) {
            s.shortSegments = Array.from({ length: actual }, (_, i) => ({
              index: i,
              start: i * CHUNK_SECONDS,
              end: Math.min((i + 1) * CHUNK_SECONDS, duration),
              status: 'pending' as const,
              chunks: [],
            }))
          }
          addLog(s, 'success', `Short scan segments ready: ${actual} × 1-minute file(s) at 24 fps`)
          saveScan(s)
        }
      } catch (err) {
        const s = getScan(id)
        if (s) {
          s.shortSegmentingProgress = 100
          addLog(s, 'warn', `Short segment cutting failed (segments will be re-cut on demand during the scan): ${err instanceof Error ? err.message : String(err)}`)
          saveScan(s)
        }
      }
    })()
  } else {
    scan.movieName = name
    scan.movieSize = size
    scan.movieDuration = duration
    const isAuto = scan.autoMode !== false

    // Immediately trigger lightweight web preview generation in background for ultra-fast UI playback
    const dest = localMediaPath(id, 'movie')
    triggerFastPreview(id, dest, mediaDir)

    if (isAuto) {
      scan.awaitingTrim = false
      scan.movieTrimStart = undefined
      scan.movieTrimEnd = undefined
      const count = Math.max(1, Math.ceil(duration / CHUNK_SECONDS))
      scan.chunkCount = count
      scan.chunks = Array.from({ length: count }, (_, i) => ({ index: i, status: 'pending' as const, attempts: 0 }))
      scan.status = 'chunking'
      scan.chunkingProgress = 0
      addLog(
        scan,
        'info',
        `Movie uploaded: ${name} (${fmtDur(duration)}) — Auto mode ON: full movie auto-selected (${count} chunks), cutting in background`,
      )
      saveScan(scan, { immediate: true })

      // Background chunking for full movie
      const dest = localMediaPath(id, 'movie')
      void (async () => {
        try {
          const reused = await findAndReuseMovieChunks(id, scan.movieName || '', scan.movieSize || 0, 0, duration, count)
          if (reused.ok) {
            const s = getScan(id)
            if (s) {
              s.chunkCount = reused.count
              s.chunks = Array.from({ length: reused.count }, (_, i) => ({ index: i, status: 'pending' as const, attempts: 0 }))
              s.status = 'ready'
              s.chunkingProgress = 100
              addLog(s, 'success', `Reused ${reused.count} 1-min movie chunks from previous scan (no re-cutting needed)`)
              saveScan(s)
            }
            return
          }
          const actual = await chunkMovie(
            dest,
            path.join(mediaDir, 'chunks'),
            duration,
            (pct) => {
              const s = getScan(id)
              if (s) {
                s.chunkingProgress = pct
                saveScan(s)
              }
            },
            0,
            duration,
            { owner: id },
          )
          const s = getScan(id)
          if (s) {
            s.chunkCount = actual
            s.chunks = Array.from({ length: actual }, (_, i) => ({ index: i, status: 'pending' as const, attempts: 0 }))
            s.status = 'ready'
            s.chunkingProgress = 100
            addLog(s, 'success', `Movie chunking complete: ${actual} 1-minute chunk(s) created`)
            saveScan(s)
          }
        } catch (err) {
          const s = getScan(id)
          if (s) {
            s.status = 'error'
            s.error = `Chunking failed: ${err instanceof Error ? err.message : String(err)}`
            addLog(s, 'error', s.error)
            saveScan(s)
          }
        }
      })()
    } else {
      // Chunking WAITS for the trim confirmation — the user can select just the
      // range that holds their scene (saves API quota) or confirm the full movie.
      scan.chunkCount = 0
      scan.chunks = []
      scan.awaitingTrim = true
      scan.movieTrimStart = undefined
      scan.movieTrimEnd = undefined
      scan.status = 'created'
      scan.chunkingProgress = 0
      addLog(
        scan,
        'info',
        `Movie uploaded: ${name} (${fmtDur(duration)}) — select a trim range (optional) and confirm to start chunking`,
      )
    }
  }

  saveScan(scan, { immediate: true })
  invalidateUsageCache()
  return { ok: true, duration, size }
}

function fmtDur(sec: number): string {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0 ? `${h}h ${m}m ${ss}s` : `${m}m ${ss}s`
}
