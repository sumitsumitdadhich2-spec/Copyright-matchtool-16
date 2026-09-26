import 'server-only'

import fs from 'node:fs'
import path from 'node:path'
import { openAsBlob } from 'node:fs'
import { putObject, getObjectJSON, deleteObject } from './storage'
import { scanMediaDir } from './store'
import { normalizeForTwelveLabs } from './ffmpeg'
import { CHUNK_SECONDS } from './models'
import type { Scan, ShortSegmentState } from './types'

// ---------------------------------------------------------------------------
// TWELVE LABS PRE-FILTER (fully optional).
//
// Confirmed technical facts (from live testing):
// - API base: https://api.twelvelabs.io/v1.3, auth header: x-api-key
// - Free/new accounts get ONLY marengo3.0 (NEVER use Pegasus).
// - Index models must be exactly: [{ model_name: "marengo3.0", model_options: ["visual","audio"] }]
// - Marengo takes NO prompt — it returns a 512-dim embedding per ~6-second
//   segment. All matching is done HERE via cosine similarity.
// - Videos need >= 360x360 resolution. A whole movie uploads in ONE task
//   (up to 4h / 4GB) — no chunking needed for indexing.
// - Indexing tasks must be polled until status is "ready".
//
// ACCURACY RULES (misses are unacceptable):
// - Similarity threshold 0.82 (quota saver: 0.75 se chunks bahut zyada bante
//   the — 0.82 par sirf strong matches select hote hain).
// - Every selected chunk also pulls in its +-1 neighbour chunks (buffer),
//   because 6-second segments can straddle chunk boundaries.
// - If ANY short segment has NO 0.82+ match anywhere in the movie, the
//   pre-filter is NOT trusted — the caller must run a normal FULL scan.
// - Any API/parse error anywhere => caller silently falls back to full scan.
// ---------------------------------------------------------------------------

const TL_BASE = 'https://api.twelvelabs.io/v1.3'
const INDEX_NAME = 'cmt-prefilter'

/** Threshold 0.82: strong matches only — kam chunks = kam quota. */
export const TL_SIMILARITY_THRESHOLD = 0.82

export class TwelveLabsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TwelveLabsError'
  }
}

async function tlFetch(apiKey: string, pathname: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${TL_BASE}${pathname}`, {
    ...init,
    headers: {
      'x-api-key': apiKey,
      ...(init?.headers || {}),
    },
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // non-JSON response body
  }
  if (!res.ok) {
    const msg =
      json && typeof json === 'object' && 'message' in (json as Record<string, unknown>)
        ? String((json as Record<string, unknown>).message)
        : text.slice(0, 200)
    throw new TwelveLabsError(`Twelve Labs ${init?.method || 'GET'} ${pathname} failed (${res.status}): ${msg}`)
  }
  return json
}

// ---------- Index management ----------

/** Find (by name) or create the Marengo-only index. Returns the index id. */
export async function ensureIndex(apiKey: string): Promise<string> {
  try {
    const listed = (await tlFetch(apiKey, `/indexes?index_name=${encodeURIComponent(INDEX_NAME)}&page_limit=1`)) as {
      data?: { _id?: string; id?: string }[]
    }
    const found = listed?.data?.[0]
    const foundId = found?._id || found?.id
    if (foundId) return foundId
  } catch {
    // list failed — try create anyway
  }
  const created = (await tlFetch(apiKey, '/indexes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      index_name: INDEX_NAME,
      // ONLY marengo3.0 — free/new accounts have no Pegasus access.
      models: [{ model_name: 'marengo3.0', model_options: ['visual', 'audio'] }],
    }),
  })) as { _id?: string; id?: string }
  const id = created?._id || created?.id
  if (!id) throw new TwelveLabsError('Index create returned no id')
  return id
}

// ---------- Upload + poll ----------

/** Upload one local video file as an indexing task. Returns { taskId, videoId }. */
export async function createIndexTask(
  apiKey: string,
  indexId: string,
  filePath: string,
): Promise<{ taskId: string; videoId: string | null }> {
  // TL rejects videos outside 1:1–2.4:1 aspect ratio or under 360px/side.
  // Auto-fix by uploading a padded COPY (black bars) — the original file and
  // the Gemini scan pipeline are never touched. Normalize failure is silent:
  // we upload the original and let TL report its own error if any.
  let uploadPath = filePath
  try {
    const normalized = await normalizeForTwelveLabs(filePath)
    if (normalized) uploadPath = normalized
  } catch {
    // padding failed — try the original as-is
  }
  const form = new FormData()
  form.append('index_id', indexId)
  const blob = await openAsBlob(uploadPath)
  form.append('video_file', blob, path.basename(uploadPath))
  const res = (await tlFetch(apiKey, '/tasks', { method: 'POST', body: form })) as {
    _id?: string
    id?: string
    video_id?: string
  }
  const taskId = res?._id || res?.id
  if (!taskId) throw new TwelveLabsError('Task create returned no id')
  return { taskId, videoId: res?.video_id || null }
}

export interface TaskStatus {
  status: string
  videoId: string | null
}

export async function getTask(apiKey: string, taskId: string): Promise<TaskStatus> {
  const res = (await tlFetch(apiKey, `/tasks/${taskId}`)) as { status?: string; video_id?: string }
  return { status: res?.status || 'unknown', videoId: res?.video_id || null }
}

/** Poll an indexing task until it is ready (or failed). */
export async function pollTaskUntilReady(
  apiKey: string,
  taskId: string,
  opts?: { intervalMs?: number; timeoutMs?: number; onTick?: (status: string) => void },
): Promise<string> {
  const intervalMs = opts?.intervalMs ?? 10_000
  const timeoutMs = opts?.timeoutMs ?? 4 * 60 * 60_000 // indexing a 4h movie can take a while
  const startedAt = Date.now()
  while (true) {
    const t = await getTask(apiKey, taskId)
    opts?.onTick?.(t.status)
    if (t.status === 'ready') {
      if (!t.videoId) throw new TwelveLabsError('Task ready but no video_id')
      return t.videoId
    }
    if (t.status === 'failed' || t.status === 'error') {
      throw new TwelveLabsError(`Indexing task ${taskId} failed (status: ${t.status})`)
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new TwelveLabsError(`Indexing task ${taskId} timed out (last status: ${t.status})`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

// ---------- Embedding retrieval ----------

export interface TLSegment {
  /** seconds within the video */
  start: number
  end: number
  /** embedding option/space (e.g. visual-text / audio) — only same-option pairs are compared */
  option: string
  embedding: number[]
}

interface RawSegment {
  embedding_option?: string
  embedding_scope?: string
  start_offset_sec?: number
  end_offset_sec?: number
  float?: number[]
  embeddings_float?: number[]
}

function parseSegments(payload: unknown): TLSegment[] {
  // Defensive parsing: accept the documented shape plus minor variants.
  const root = payload as Record<string, unknown> | null
  const embedding = (root?.embedding ?? root) as Record<string, unknown> | null
  const videoEmbedding = (embedding?.video_embedding ?? embedding) as Record<string, unknown> | null
  const rawSegments = (videoEmbedding?.segments ?? []) as RawSegment[]
  if (!Array.isArray(rawSegments)) return []
  const out: TLSegment[] = []
  for (const s of rawSegments) {
    const vec = Array.isArray(s.float) ? s.float : Array.isArray(s.embeddings_float) ? s.embeddings_float : null
    if (!vec || vec.length === 0) continue
    // Only per-segment ("clip") embeddings are useful for localization.
    if (s.embedding_scope && s.embedding_scope !== 'clip') continue
    out.push({
      start: typeof s.start_offset_sec === 'number' ? s.start_offset_sec : 0,
      end: typeof s.end_offset_sec === 'number' ? s.end_offset_sec : 0,
      option: s.embedding_option || 'visual',
      embedding: vec,
    })
  }
  return out
}

/** Fetch every 6-second segment embedding for an indexed video. */
export async function fetchVideoEmbeddings(apiKey: string, indexId: string, videoId: string): Promise<TLSegment[]> {
  // Try the option names both Marengo generations use; keep whichever returns data.
  const optionSets = [
    ['visual-text', 'audio'],
    ['visual', 'audio'],
  ]
  for (const options of optionSets) {
    const qs = options.map((o) => `embedding_option=${encodeURIComponent(o)}`).join('&')
    try {
      const payload = await tlFetch(apiKey, `/indexes/${indexId}/videos/${videoId}?${qs}`)
      const segs = parseSegments(payload)
      if (segs.length > 0) return segs
    } catch {
      // try the next option set
    }
  }
  throw new TwelveLabsError('No segment embeddings returned for the indexed video')
}

// ---------- Local + S3 persistence of embeddings ----------
// Saved once at index time, reused on every scan — the API is NOT hit again.

export interface StoredEmbeddings {
  indexId: string
  videoId: string
  savedAt: number
  segments: TLSegment[]
}

function embFile(scanId: string, kind: 'movie' | 'short'): string {
  return path.join(scanMediaDir(scanId), `tl-${kind}-embeddings.json`)
}

function embStorageKey(scanId: string, kind: 'movie' | 'short'): string {
  return `tl/${scanId}-${kind}.json`
}

/** Persist embeddings locally (fast reuse) AND to S3 (survives instance loss). */
export async function saveEmbeddings(scanId: string, kind: 'movie' | 'short', data: StoredEmbeddings): Promise<void> {
  // Round to 5 decimals to keep a 4h movie's JSON manageable.
  const compact: StoredEmbeddings = {
    ...data,
    segments: data.segments.map((s) => ({ ...s, embedding: s.embedding.map((v) => Math.round(v * 100000) / 100000) })),
  }
  const json = JSON.stringify(compact)
  try {
    fs.writeFileSync(embFile(scanId, kind), json)
  } catch {
    // local write is best-effort — S3 is the durable copy
  }
  try {
    await putObject(embStorageKey(scanId, kind), json, 'application/json')
  } catch {
    // S3 backup is best-effort — the local copy still works this session
  }
}

/** Delete saved embeddings (local + S3) — used when a video is re-uploaded
 *  so a stale merged-index split can never be reused. Best-effort. */
export async function deleteEmbeddings(scanId: string, kind: 'movie' | 'short'): Promise<void> {
  try {
    const local = embFile(scanId, kind)
    if (fs.existsSync(local)) fs.unlinkSync(local)
  } catch {
    // best-effort
  }
  try {
    await deleteObject(embStorageKey(scanId, kind))
  } catch {
    // best-effort
  }
}

/** Load saved embeddings: local file first, S3 mirror as fallback. */
export async function loadEmbeddings(scanId: string, kind: 'movie' | 'short'): Promise<StoredEmbeddings | null> {
  try {
    const local = embFile(scanId, kind)
    if (fs.existsSync(local)) {
      const data = JSON.parse(fs.readFileSync(local, 'utf8')) as StoredEmbeddings
      if (Array.isArray(data?.segments) && data.segments.length > 0) return data
    }
  } catch {
    // fall through to S3
  }
  try {
    const data = await getObjectJSON<StoredEmbeddings>(embStorageKey(scanId, kind))
    if (!data || !Array.isArray(data.segments) || data.segments.length === 0) return null
    try {
      fs.writeFileSync(embFile(scanId, kind), JSON.stringify(data))
    } catch {
      // cache refresh is best-effort
    }
    return data
  } catch {
    return null
  }
}

// ---------- Matching (cosine similarity) ----------

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

export interface PrefilterComputation {
  /** null = pre-filter must NOT be trusted — run a normal FULL scan */
  perSegment: Map<number, Set<number>> | null
  /** per short-minute: chunkIndex -> best cosine similarity (confidence high→low ordering) */
  confidence?: Map<number, Map<number, number>>
  /** per short-minute: expected short-video windows (ABSOLUTE short seconds)
   *  that MUST each get a matched candidate — drives the early-stop system */
  expectedWindows?: Map<number, { start: number; end: number }[]>
  reason?: string
}

/**
 * Decide which movie chunks each short minute needs, purely from embeddings.
 *
 * Returns perSegment = Map<shortSegmentIndex, Set<chunkIndex>> or null when
 * the pre-filter cannot be trusted (some short segment found NO 0.75+ match
 * anywhere) — in that case the caller MUST run the normal full scan.
 */
export function computePrefilterChunks(
  scan: Pick<Scan, 'movieTrimStart' | 'movieTrimEnd' | 'movieDuration' | 'chunkCount'>,
  shortSegments: Pick<ShortSegmentState, 'index' | 'start' | 'end'>[],
  shortEmb: TLSegment[],
  movieEmb: TLSegment[],
): PrefilterComputation {
  if (shortEmb.length === 0 || movieEmb.length === 0) {
    return { perSegment: null, reason: 'no embeddings available' }
  }
  const trimStart = scan.movieTrimStart ?? 0
  const chunkCount = scan.chunkCount

  // Group movie segments by embedding option — only same-space vectors compare.
  const movieByOption = new Map<string, TLSegment[]>()
  for (const m of movieEmb) {
    const list = movieByOption.get(m.option) || []
    list.push(m)
    movieByOption.set(m.option, list)
  }

  /** movie hits per SHORT TL segment: each hit carries its movie time + similarity */
  const matchesByShortSeg = new Map<TLSegment, { bestSim: number; hits: { t: number; sim: number }[] }>()

  for (const s of shortEmb) {
    const candidates = movieByOption.get(s.option) || []
    let bestSim = -1
    const hits: { t: number; sim: number }[] = []
    for (const m of candidates) {
      const sim = cosineSimilarity(s.embedding, m.embedding)
      if (sim > bestSim) bestSim = sim
      // Include EVERY 0.82+ window — strong matches only (quota saver).
      if (sim >= TL_SIMILARITY_THRESHOLD) {
        hits.push({ t: m.start, sim }, { t: m.end, sim })
      }
    }
    const prev = matchesByShortSeg.get(s)
    if (!prev) matchesByShortSeg.set(s, { bestSim, hits })
  }

  // ACCURACY RULE: a short TL segment counts as "matched" when ANY of its
  // embedding options found a 0.82+ window. Group by time window first.
  const byWindow = new Map<string, { start: number; end: number; matched: boolean; hits: { t: number; sim: number }[] }>()
  for (const [seg, res] of matchesByShortSeg) {
    const key = `${seg.start.toFixed(1)}-${seg.end.toFixed(1)}`
    const w = byWindow.get(key) || { start: seg.start, end: seg.end, matched: false, hits: [] }
    if (res.hits.length > 0) w.matched = true
    w.hits.push(...res.hits)
    byWindow.set(key, w)
  }

  // If ANY short time-window has NO match anywhere => full scan (never trust a gap).
  for (const w of byWindow.values()) {
    if (!w.matched) {
      return {
        perSegment: null,
        reason: `short ${w.start.toFixed(0)}s–${w.end.toFixed(0)}s had no ${TL_SIMILARITY_THRESHOLD}+ match anywhere — full scan for safety`,
      }
    }
  }

  const timeToChunk = (t: number): number => Math.floor((t - trimStart) / CHUNK_SECONDS)

  const perSegment = new Map<number, Set<number>>()
  const confidence = new Map<number, Map<number, number>>()
  const expectedWindows = new Map<number, { start: number; end: number }[]>()
  for (const shortMin of shortSegments) {
    const set = new Set<number>()
    const conf = new Map<number, number>()
    const windows: { start: number; end: number }[] = []
    for (const w of byWindow.values()) {
      // Does this short TL window overlap this short minute?
      if (w.start >= shortMin.end || w.end <= shortMin.start) continue
      // Expected window (clipped to the minute) — early-stop needs each of
      // these covered by at least one candidate before chunk scan can stop.
      windows.push({ start: Math.max(w.start, shortMin.start), end: Math.min(w.end, shortMin.end) })
      for (const h of w.hits) {
        const ci = timeToChunk(h.t)
        // Selected chunk + its +-1 neighbours (buffer for boundary-straddling segments).
        for (const c of [ci - 1, ci, ci + 1]) {
          if (c >= 0 && c < chunkCount) {
            set.add(c)
            // Neighbour chunks inherit a slightly lower confidence than the direct hit.
            const sim = c === ci ? h.sim : h.sim - 0.03
            if ((conf.get(c) ?? -1) < sim) conf.set(c, sim)
          }
        }
      }
    }
    perSegment.set(shortMin.index, set)
    confidence.set(shortMin.index, conf)
    expectedWindows.set(shortMin.index, windows)
  }

  return { perSegment, confidence, expectedWindows }
}
