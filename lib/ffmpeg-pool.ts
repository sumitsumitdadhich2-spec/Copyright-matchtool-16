import os from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { getFfmpegPath, getFfprobePath } from './ffmpeg-bin'
import { CHUNK_SECONDS } from './models'

// ---------------------------------------------------------------------------
// ffmpeg ENGINE POOL — one single-threaded ffmpeg process per CPU core.
//
//   boot:  os.availableParallelism() → ENGINES  (override: FFMPEG_ENGINES=n)
//   run:   every ffmpeg invocation goes through runFfmpeg(); it waits for a
//          free engine slot, spawns ffmpeg with `-threads 1` and releases the
//          slot on exit. N slots = N cores = no oversubscription.
//   slice: long tasks split their time range into ENGINES slices aligned to
//          the 60 s chunk grid (planSlices) and run them concurrently.
//   cancel: a CancelToken tracks every child it spawned; cancel() kills them
//          all and makes queued jobs bail out immediately.
//
// State lives on globalThis so dev-mode module reloads never create a second
// pool (which would double the concurrency).
// ---------------------------------------------------------------------------

interface JobInfo {
  id: number
  label: string
  owner: string
  startedAt: number
}

interface PoolState {
  cores: number
  engines: number
  active: number
  nextId: number
  queue: Array<{ start: () => void; token?: CancelToken; owner: string }>
  jobs: Map<number, JobInfo>
  booted: boolean
}

function detectCores(): number {
  try {
    return Math.max(1, os.availableParallelism())
  } catch {
    return Math.max(1, os.cpus().length || 1)
  }
}

function resolveEngines(cores: number): number {
  const raw = (process.env.FFMPEG_ENGINES || 'auto').trim().toLowerCase()
  if (raw && raw !== 'auto') {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n >= 1) return Math.min(n, 128)
  }
  return cores
}

const g = globalThis as unknown as { __cmtFfmpegPool?: PoolState }

function pool(): PoolState {
  if (!g.__cmtFfmpegPool) {
    const cores = detectCores()
    const engines = resolveEngines(cores)
    g.__cmtFfmpegPool = { cores, engines, active: 0, nextId: 1, queue: [], jobs: new Map(), booted: false }
  }
  const p = g.__cmtFfmpegPool
  if (!p.booted) {
    p.booted = true
    console.log(`[ffmpeg-pool] detected ${p.cores} cores → ${p.engines} engines`)
  }
  return p
}

/** Number of parallel ffmpeg engines (= cores unless FFMPEG_ENGINES overrides). */
export function engineCount(): number {
  return pool().engines
}

export function coreCount(): number {
  return pool().cores
}

export interface PoolSnapshot {
  cores: number
  engines: number
  active: number
  queued: number
  jobs: Array<{ label: string; owner: string; runningMs: number }>
}

/** Live pool stats for /api/health and /api/settings. */
export function poolSnapshot(): PoolSnapshot {
  const p = pool()
  const now = Date.now()
  return {
    cores: p.cores,
    engines: p.engines,
    active: p.active,
    queued: p.queue.length,
    jobs: [...p.jobs.values()].map((j) => ({ label: j.label, owner: j.owner, runningMs: now - j.startedAt })),
  }
}

// ---------- Cancellation ----------

export class FfmpegCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'FfmpegCancelled'
  }
}

/** Tracks every ffmpeg child spawned under it so cancel() can kill them all. */
export class CancelToken {
  cancelled = false
  private children = new Set<ChildProcess>()

  attach(child: ChildProcess) {
    this.children.add(child)
    child.once('close', () => this.children.delete(child))
    if (this.cancelled) this.killChild(child)
  }

  cancel() {
    if (this.cancelled) return
    this.cancelled = true
    for (const c of this.children) this.killChild(c)
  }

  get activeChildren(): number {
    return this.children.size
  }

  private killChild(c: ChildProcess) {
    try {
      c.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

// ---------- Slot acquisition ----------

function acquire(owner: string, token?: CancelToken): Promise<void> {
  const p = pool()
  if (token?.cancelled) return Promise.reject(new FfmpegCancelled())
  if (p.active < p.engines) {
    p.active++
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const entry = {
      token,
      owner,
      start: () => {
        if (token?.cancelled) {
          reject(new FfmpegCancelled())
          release(owner)
          return
        }
        resolve()
      },
    }
    p.queue.push(entry)
  })
}

function release(completedOwner: string) {
  const p = pool()
  // If another scan/task is waiting, hand the next free engine to it before
  // continuing the completed owner's backlog. This keeps all scans moving.
  const otherOwnerIndex = p.queue.findIndex((entry) => entry.owner !== completedOwner)
  const nextIndex = otherOwnerIndex >= 0 ? otherOwnerIndex : 0
  const [next] = p.queue.splice(nextIndex, 1)
  if (next) {
    // hand the slot straight over (active count unchanged)
    next.start()
  } else {
    p.active = Math.max(0, p.active - 1)
  }
}

// ---------- Running ffmpeg ----------

export interface RunOptions {
  /** Shown in /api/health and logs. */
  label?: string
  /** Scan id or stable task id used to rotate engines fairly across callers. */
  owner?: string
  token?: CancelToken
  /** Raw stderr chunks (progress lines). */
  onStderr?: (chunk: string) => void
}

/** Insert `-threads 1` before the first `-i` (decoder side) unless present. */
function withSingleThread(args: string[]): string[] {
  if (args.includes('-threads')) return args
  const i = args.indexOf('-i')
  const out = [...args]
  out.splice(Math.max(0, i), 0, '-threads', '1')
  return out
}

/**
 * Run one ffmpeg process inside the pool. Resolves on exit 0, rejects with
 * the stderr tail otherwise (or FfmpegCancelled when the token was cancelled).
 */
export async function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<void> {
  const bin = await getFfmpegPath()
  const owner = opts.owner || 'shared'
  await acquire(owner, opts.token)
  const p = pool()
  const id = p.nextId++
  const info: JobInfo = { id, label: opts.label || 'ffmpeg', owner, startedAt: Date.now() }
  p.jobs.set(id, info)
  try {
    await new Promise<void>((resolve, reject) => {
      if (opts.token?.cancelled) return reject(new FfmpegCancelled())
      const child = spawn(bin, ['-hide_banner', '-nostdin', ...withSingleThread(args)])
      opts.token?.attach(child)
      let tail = ''
      child.stderr?.on('data', (d: Buffer) => {
        const s = d.toString()
        tail = (tail + s).slice(-1600)
        opts.onStderr?.(s)
      })
      child.on('error', (err) => reject(new Error(`ffmpeg failed to start: ${err.message}`)))
      child.on('close', (code) => {
        if (opts.token?.cancelled) return reject(new FfmpegCancelled())
        if (code === 0) return resolve()
        reject(new Error(`ffmpeg exited ${code}: ${tail.slice(-600)}`))
      })
    })
  } finally {
    p.jobs.delete(id)
    release(owner)
  }
}

/** ffprobe is cheap and short — it does not take an engine slot. */
export async function runFfprobe(args: string[]): Promise<string> {
  const bin = await getFfprobePath()
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${stderr.slice(-800)}`))
    })
  })
}

// ---------- Progress parsing ----------

/** Parse an ffmpeg stderr progress line into { time, speed } (either may be null). */
export function parseProgressLine(line: string): { time: number | null; speed: number | null } {
  const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
  const time = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null
  const sm = line.match(/speed=\s*(\d+(?:\.\d+)?)x/)
  const speed = sm ? Number.parseFloat(sm[1]) : null
  return { time, speed }
}

// ---------- Time slicing ----------

export interface TimeSlice {
  /** 0-based slice number. */
  index: number
  /** Absolute seconds in the SOURCE file. */
  start: number
  end: number
  /** First chunk index (relative to the range start) this slice produces. */
  firstChunk: number
  /** Number of chunks in this slice. */
  chunkCount: number
}

/**
 * Split [rangeStart, rangeEnd) into up to `engines` slices whose edges sit on
 * the CHUNK_SECONDS grid (measured from rangeStart) so slice edges == chunk
 * edges and the global chunk numbering is unchanged. Chunks are spread as
 * evenly as possible; a range shorter than `engines` chunks yields fewer slices.
 */
export function planSlices(
  rangeStart: number,
  rangeEnd: number,
  opts: { engines?: number; align?: number } = {},
): TimeSlice[] {
  const align = opts.align ?? CHUNK_SECONDS
  const engines = Math.max(1, opts.engines ?? engineCount())
  const total = Math.max(0, rangeEnd - rangeStart)
  if (total <= 0) return []
  const chunks = Math.max(1, Math.ceil(total / align - 1e-6))
  const n = Math.min(engines, chunks)
  const base = Math.floor(chunks / n)
  const rem = chunks % n
  const out: TimeSlice[] = []
  let firstChunk = 0
  for (let i = 0; i < n; i++) {
    const count = base + (i < rem ? 1 : 0)
    const start = rangeStart + firstChunk * align
    const end = Math.min(rangeEnd, start + count * align)
    out.push({ index: i, start, end, firstChunk, chunkCount: count })
    firstChunk += count
  }
  return out
}

/**
 * Aggregate per-slice progress into one total. Returns a factory: call
 * `forSlice(i, sliceDuration)` to get an onStderr handler for slice i.
 * `onTotal` receives (doneSeconds, aggregateSpeed) where speed is the sum of
 * per-slice encode speeds (realtime multiples), i.e. the pool throughput.
 */
export function sliceProgress(onTotal: (doneSeconds: number, speed: number | null, perSlice: number[]) => void) {
  const done: number[] = []
  const speeds: (number | null)[] = []
  let lastEmit = 0
  const emit = (force = false) => {
    const now = Date.now()
    if (!force && now - lastEmit < 300) return
    lastEmit = now
    let total = 0
    for (const d of done) total += d || 0
    let speed: number | null = null
    for (const s of speeds) if (s !== null && s !== undefined) speed = (speed ?? 0) + s
    onTotal(total, speed, done.slice())
  }
  return {
    forSlice(i: number, sliceDuration: number) {
      done[i] = 0
      speeds[i] = null
      return (line: string) => {
        const { time, speed } = parseProgressLine(line)
        if (time !== null) done[i] = Math.min(sliceDuration, time)
        if (speed !== null) speeds[i] = speed
        emit()
      }
    },
    complete(i: number, sliceDuration: number) {
      done[i] = sliceDuration
      speeds[i] = null
      emit(true)
    },
  }
}

/** Run `tasks` with at most `limit` in flight (defaults to the engine count). */
export async function parallelMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  limit = engineCount(),
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  let firstError: unknown = null
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (firstError === null) {
      const i = next++
      if (i >= items.length) return
      try {
        results[i] = await fn(items[i], i)
      } catch (err) {
        firstError = err
        return
      }
    }
  })
  await Promise.all(workers)
  if (firstError !== null) throw firstError
  return results
}
