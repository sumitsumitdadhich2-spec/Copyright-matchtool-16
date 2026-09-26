// ---------------------------------------------------------------------------
// Browser-side video upload engine: ONE continuous stream, auto-resume.
//
//   browser ──(single HTTP body, full speed)──▶ Caddy ──▶ Node ──▶ EBS disk
//
// The file is NOT sliced into chunks. The browser opens a single request and
// streams the whole file (or the remainder after a resume) as one body, so
// the connection stays saturated and the server writes straight to disk.
//
// Stability comes from RESUME, not from chunking: the server persists how many
// contiguous bytes it has for this exact file (fingerprint = name + size +
// lastModified). If the connection drops, stalls, or the page is refreshed,
// the browser asks the server for that number and continues from there with a
// new single stream. Nothing already transferred is ever sent twice.
//
// Speed meter: XHR upload progress sampled every 250 ms, rate over a 3 s
// sliding window with light smoothing → one steady Mbps number + ETA.
// ---------------------------------------------------------------------------

import { UPLOAD_PROTOCOL, UPLOAD_PROTOCOL_HEADER } from './upload-protocol'

export type UploadKind = 'short' | 'movie'

export type UploadPhase =
  /** Asking the server how many bytes it already has. */
  | 'probing'
  /** Bytes are flowing. */
  | 'uploading'
  /** Every byte was handed to the network — waiting for the server to write the
   *  tail, verify the size and run ffprobe. */
  | 'finalizing'
  /** Connection dropped or stalled — backing off before resuming. */
  | 'reconnecting'
  /** The server already has this exact video from an earlier scan — it is
   *  linking / fetching it server-side, nothing is uploaded. */
  | 'linking'

export interface UploadProgress {
  phase: UploadPhase
  /** Bytes confirmed by the server + bytes of the current stream on the wire. */
  sent: number
  total: number
  /** Smoothed upload rate in bytes/second (null until ~1 s of samples). */
  bytesPerSec: number | null
  /** Highest smoothed rate seen during this upload. */
  peakBytesPerSec: number
  /** Average rate since this upload session started (bytes actually moved /
   *  seconds spent uploading — reconnect pauses excluded). */
  avgBytesPerSec: number | null
  /** Estimated seconds left (null until the rate is known). */
  etaSec: number | null
  /** Number of reconnects so far (0 on a clean run). */
  reconnects: number
  /** Byte offset the current stream started from (0 unless resumed). */
  resumedFrom: number
  /** true while the browser reports it has no network — waiting for it to come back. */
  offline: boolean
}

export interface UploadResult {
  duration: number
  size: number
  /** true when no bytes were uploaded — the server linked an earlier copy. */
  reused: boolean
}

export class UploadError extends Error {
  /** true = no point retrying (bad file, auth, cancelled). */
  readonly fatal: boolean
  constructor(message: string, fatal = false) {
    super(message)
    this.name = 'UploadError'
    this.fatal = fatal
  }
}

/** No new bytes accepted by the network for this long → abort and resume. */
const STALL_MS = 30_000
/** After the last byte left the browser, how long to wait for the server's
 *  verdict (draining proxies + ffprobe on a multi-GB file). */
const FINALIZE_TIMEOUT_MS = 5 * 60_000
/** CONSECUTIVE failed attempts (no new byte reached the server) before giving
 *  up. A stream that moved even one byte resets the counter, so a long upload
 *  on a flaky line keeps going for as long as it keeps making progress. */
const MAX_CONSECUTIVE_FAILURES = 15
/** GET probe attempts before falling back to the last confirmed byte count. */
const PROBE_ATTEMPTS = 4
/** Server-reported "body cut short by a proxy" rounds before giving up. */
const MAX_TRUNCATIONS = 3
const SAMPLE_MS = 250
const WINDOW_MS = 3_000

/** Stable across page reloads for the same file on the same machine. */
export function fileFingerprint(file: File): string {
  let h = 0
  const s = `${file.name}|${file.size}|${file.lastModified}`
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return `${(h >>> 0).toString(36)}${file.size.toString(36)}`
}

class SpeedMeter {
  private samples: { t: number; n: number }[] = []
  rate: number | null = null
  peak = 0

  sample(n: number) {
    const t = performance.now()
    this.samples.push({ t, n })
    while (this.samples.length > 2 && t - this.samples[0].t > WINDOW_MS) this.samples.shift()
    const first = this.samples[0]
    const dt = (t - first.t) / 1000
    if (dt < 0.75) return
    const raw = Math.max(0, (n - first.n) / dt)
    this.rate = this.rate === null ? raw : this.rate * 0.7 + raw * 0.3
    if (this.rate > this.peak) this.peak = this.rate
  }

  /** Drop the window (a resume restarts byte accounting) but keep the peak. */
  resetWindow() {
    this.samples = []
    this.rate = null
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const id = setTimeout(done, ms)
    function done() {
      clearTimeout(id)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/** Resolve when the browser reports the network is back (or on abort). */
function waitOnline(signal?: AbortSignal) {
  if (!isOffline()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      window.removeEventListener('online', done)
      signal?.removeEventListener('abort', done)
      clearInterval(poll)
      resolve()
    }
    window.addEventListener('online', done, { once: true })
    signal?.addEventListener('abort', done, { once: true })
    // Some browsers never fire `online` reliably — poll as a fallback.
    const poll = setInterval(() => {
      if (!isOffline()) done()
    }, 2_000)
  })
}

interface ProbeResult {
  received: number
  /** Set when an earlier scan already holds this exact video. */
  reuse: { scanId: string; source: 'disk' | 's3' } | null
}

/** GET → how many contiguous bytes of this exact file the server already has
 *  (and whether the whole file already exists in another scan). */
async function probeOnce(base: string, signal?: AbortSignal): Promise<ProbeResult> {
  const res = await fetch(base, { method: 'GET', cache: 'no-store', signal })
  if (res.status === 401) throw new UploadError('Session expired — please log in again', true)
  if (res.status === 404) throw new UploadError('Scan not found — please refresh the page', true)
  if (!res.ok) throw new UploadError(`Server error while checking upload state (HTTP ${res.status})`)
  const j = (await res.json()) as { received?: number; reuse?: { scanId?: string; source?: string } }
  const reuse =
    j.reuse && typeof j.reuse.scanId === 'string' && j.reuse.scanId
      ? { scanId: j.reuse.scanId, source: j.reuse.source === 's3' ? ('s3' as const) : ('disk' as const) }
      : null
  return { received: Number.isFinite(j.received) && j.received! > 0 ? j.received! : 0, reuse }
}

/**
 * POST ?reuse= → the server hard-links (disk) or pulls (S3) the earlier copy
 * into this scan and runs the normal finalize. Resolves null when the earlier
 * copy vanished (410) so the caller falls back to a real upload.
 */
async function requestReuse(base: string, sourceScanId: string, videoType: string, signal?: AbortSignal): Promise<UploadResult | null> {
  const res = await fetch(`${base}&reuse=${encodeURIComponent(sourceScanId)}`, {
    method: 'POST',
    cache: 'no-store',
    signal,
    headers: { 'x-video-type': videoType, [UPLOAD_PROTOCOL_HEADER]: UPLOAD_PROTOCOL },
  })
  let j: { done?: boolean; duration?: number; size?: number; error?: string } = {}
  try {
    j = (await res.json()) as typeof j
  } catch {
    // handled below
  }
  if (res.status === 401) throw new UploadError('Session expired — please log in again', true)
  if (res.status === 410) return null
  if (!res.ok) throw new UploadError(j.error || `Could not link the existing video (HTTP ${res.status})`, res.status >= 400 && res.status < 500 && res.status !== 409)
  if (!j.done) return null
  return { duration: j.duration ?? 0, size: j.size ?? 0, reused: true }
}

/**
 * Probe with retries. A failed probe must NOT make us restart from 0 — that
 * would re-send gigabytes the server already has. Fatal errors (401/404)
 * propagate immediately; anything else is retried a few times, and only then
 * do we fall back to `lastKnown` (the last byte count the server confirmed to
 * us). If that is too optimistic the server answers 409 with its real count
 * and we probe again; if it is too low the overlap is rewritten identically.
 */
async function probeReceived(base: string, lastKnown: number, signal?: AbortSignal): Promise<ProbeResult> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new UploadError('Upload cancelled', true)
    try {
      return await probeOnce(base, signal)
    } catch (err) {
      if (err instanceof UploadError && err.fatal) throw err
      if (signal?.aborted) throw new UploadError('Upload cancelled', true)
      lastErr = err
      await waitOnline(signal)
      await sleep(400 * (attempt + 1), signal)
    }
  }
  console.warn(`[upload] probe failed repeatedly — continuing from last confirmed byte ${lastKnown}, server will correct us`, lastErr)
  return { received: lastKnown, reuse: null }
}

type StreamOutcome = { done: true; duration: number; size: number } | { done: false; received: number; truncated: boolean }

/** One single-body request from `offset` to the end of the file. */
function sendStream(
  base: string,
  file: File,
  offset: number,
  videoType: string,
  hooks: { onWire: (bytes: number) => void; onFinalizing: () => void; signal?: AbortSignal },
): Promise<StreamOutcome> {
  return new Promise((resolve, reject) => {
    const body = offset > 0 ? file.slice(offset) : file
    const xhr = new XMLHttpRequest()
    let loaded = 0
    let lastProgressAt = performance.now()
    let allSentAt: number | null = null

    const watchdog = setInterval(() => {
      const now = performance.now()
      if (allSentAt === null) {
        if (now - lastProgressAt > STALL_MS) xhr.abort()
      } else if (now - allSentAt > FINALIZE_TIMEOUT_MS) {
        xhr.abort()
      }
    }, 1000)

    const onAbort = () => xhr.abort()
    hooks.signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => {
      clearInterval(watchdog)
      hooks.signal?.removeEventListener('abort', onAbort)
    }

    xhr.open('POST', `${base}&offset=${offset}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('x-video-type', videoType)
    xhr.setRequestHeader(UPLOAD_PROTOCOL_HEADER, UPLOAD_PROTOCOL)

    xhr.upload.onprogress = (e) => {
      if (e.loaded > loaded) {
        loaded = Math.min(e.loaded, body.size)
        lastProgressAt = performance.now()
        hooks.onWire(loaded)
      }
    }
    // Every byte left the browser — now it is the server's turn.
    xhr.upload.onload = () => {
      loaded = body.size
      hooks.onWire(loaded)
      allSentAt = performance.now()
      hooks.onFinalizing()
    }

    xhr.onload = () => {
      cleanup()
      let j: { done?: boolean; duration?: number; size?: number; received?: number; truncated?: boolean; error?: string } = {}
      try {
        j = JSON.parse(xhr.responseText)
      } catch {
        // non-JSON body (proxy error page) — handled below
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (j.done) resolve({ done: true, duration: j.duration ?? 0, size: j.size ?? file.size })
        else resolve({ done: false, received: Number.isFinite(j.received) ? j.received! : offset, truncated: j.truncated === true })
        return
      }
      const msg = j.error || `Upload failed (HTTP ${xhr.status})`
      if (xhr.status === 401) reject(new UploadError('Session expired — please log in again', true))
      // 409 = the server's byte count differs from ours → re-probe and continue.
      // 408 = the request was cut by a timeout → resume.
      else if (xhr.status === 409 || xhr.status === 408) reject(new UploadError(msg, false))
      else if (xhr.status >= 400 && xhr.status < 500) reject(new UploadError(msg, true))
      else reject(new UploadError(msg, false))
    }
    xhr.onerror = () => {
      cleanup()
      reject(new UploadError('Network error — connection lost', false))
    }
    xhr.onabort = () => {
      cleanup()
      if (hooks.signal?.aborted) reject(new UploadError('Upload cancelled', true))
      else if (allSentAt !== null) reject(new UploadError('Server did not confirm the file in time', false))
      else reject(new UploadError('Connection stalled', false))
    }
    xhr.send(body)
  })
}

export interface UploadOptions {
  scanId: string
  kind: UploadKind
  file: File
  onProgress: (p: UploadProgress) => void
  signal?: AbortSignal
}

/**
 * Upload a video as ONE continuous stream, resuming from the server's last
 * confirmed byte whenever the connection breaks. Resolves once the server has
 * the complete file on disk and ffprobe accepted it. Throws UploadError.
 */
export async function uploadVideoStream({ scanId, kind, file, onProgress, signal }: UploadOptions): Promise<UploadResult> {
  const session = fileFingerprint(file)
  const base = `/api/scans/${scanId}/upload?kind=${kind}&name=${encodeURIComponent(file.name)}&total=${file.size}&session=${session}`
  const videoType = file.type || 'video/mp4'
  const meter = new SpeedMeter()

  let phase: UploadPhase = 'probing'
  let confirmed = 0
  let wire = 0
  /** Total reconnects (shown in the UI). */
  let reconnects = 0
  /** Failures in a row with NO new byte reaching the server — this is what ends the upload. */
  let consecutiveFailures = 0
  /** Rounds where the server reported a cleanly-ended but short body (proxy limit). */
  let truncations = 0
  let resumedFrom = 0
  let offline = false
  /** Server-side link attempted once; on failure we upload for real. */
  let reuseTried = false

  // Average speed = bytes moved during this session / seconds spent in the
  // 'uploading' phase (probing / reconnect pauses are not counted).
  let uploadingMs = 0
  let uploadingSince: number | null = null
  let sessionStartByte: number | null = null
  const uploadingElapsedMs = () => uploadingMs + (uploadingSince !== null ? performance.now() - uploadingSince : 0)
  const setPhase = (next: UploadPhase) => {
    if (phase === 'uploading' && next !== 'uploading' && uploadingSince !== null) {
      uploadingMs += performance.now() - uploadingSince
      uploadingSince = null
    }
    if (next === 'uploading' && phase !== 'uploading') uploadingSince = performance.now()
    phase = next
  }

  const emit = () => {
    const sent = Math.min(file.size, confirmed + wire)
    const rate = meter.rate
    const elapsedSec = uploadingElapsedMs() / 1000
    const moved = sessionStartByte === null ? 0 : sent - sessionStartByte
    onProgress({
      phase,
      sent,
      total: file.size,
      bytesPerSec: rate,
      peakBytesPerSec: meter.peak,
      avgBytesPerSec: elapsedSec >= 1 && moved > 0 ? moved / elapsedSec : null,
      etaSec: rate && rate > 0 && phase === 'uploading' ? Math.max(0, (file.size - sent) / rate) : null,
      reconnects,
      resumedFrom,
      offline,
    })
  }

  const ticker = setInterval(() => {
    if (phase === 'uploading') meter.sample(confirmed + wire)
    emit()
  }, SAMPLE_MS)

  try {
    for (;;) {
      if (signal?.aborted) throw new UploadError('Upload cancelled', true)

      setPhase('probing')
      wire = 0
      emit()
      const before = confirmed
      const probe = await probeReceived(base, confirmed, signal)

      // FAST PATH: the server already has this exact video (same name + size)
      // from an earlier scan. Link it server-side — zero bytes uploaded.
      if (probe.reuse && !reuseTried) {
        reuseTried = true
        setPhase('linking')
        emit()
        console.log(`[upload] ${kind} "${file.name}" already on server in scan ${probe.reuse.scanId} (${probe.reuse.source}) — linking instead of uploading`)
        try {
          const linked = await requestReuse(base, probe.reuse.scanId, videoType, signal)
          if (linked) {
            confirmed = file.size
            wire = 0
            emit()
            return linked
          }
          console.warn('[upload] earlier copy vanished — falling back to a normal upload')
        } catch (err) {
          if (err instanceof UploadError && err.fatal) throw err
          if (signal?.aborted) throw new UploadError('Upload cancelled', true)
          console.warn('[upload] reuse failed — falling back to a normal upload:', err)
        }
        continue
      }

      confirmed = Math.min(probe.received, file.size)
      // The server has more than after the last attempt → the line is moving
      // data, however flaky. Only attempts that land NOTHING count towards
      // giving up (see MAX_CONSECUTIVE_FAILURES).
      if (confirmed > before) consecutiveFailures = 0
      resumedFrom = confirmed
      if (sessionStartByte === null) sessionStartByte = confirmed
      if (confirmed > 0) console.log(`[upload] resuming ${kind} from byte ${confirmed} of ${file.size}`)

      setPhase('uploading')
      meter.resetWindow()
      emit()

      try {
        const out = await sendStream(base, file, confirmed, videoType, {
          onWire: (n) => {
            wire = n
          },
          onFinalizing: () => {
            setPhase('finalizing')
            emit()
          },
          signal,
        })
        if (out.done) {
          confirmed = file.size
          wire = 0
          emit()
          return { duration: out.duration, size: out.size, reused: false }
        }
        // Server accepted bytes but the body ended before the declared size
        // (a proxy cut it short). Loop: re-probe and stream the remainder.
        const progressed = out.received > confirmed
        consecutiveFailures = progressed ? 0 : consecutiveFailures + 1
        confirmed = Math.max(confirmed, out.received)
        console.warn(`[upload] server has ${out.received}/${file.size} bytes — streaming the rest`)
        if (out.truncated) {
          // The server saw the body end cleanly but SHORTER than what we sent:
          // a proxy between us and the disk is cutting bodies. Each round still
          // lands a slice, so "progress" never trips the failure counter �� stop
          // after a few rounds with a message that names the real cause instead
          // of crawling through a 5 GB file 10 MB at a time.
          truncations++
          if (truncations >= MAX_TRUNCATIONS) {
            throw new UploadError(
              'The server keeps receiving a cut-off body — a proxy in between is limiting request bodies (Next.js proxy.ts matcher / proxyClientMaxBodySize or a reverse-proxy body limit). The server was rebuilt with an old config; redeploy and try again.',
              true,
            )
          }
        }
        if (!progressed) {
          // Something between us and the disk drops the body before a single
          // byte lands. Back off like a network error instead of hammering.
          reconnects++
          if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
            throw new UploadError(
              'The server keeps receiving an empty body — a proxy in between is dropping the upload. Check the Caddy/Next.js body-size settings on the server.',
              true,
            )
          }
          setPhase('reconnecting')
          wire = 0
          emit()
          await sleep(Math.min(8_000, 500 * 2 ** Math.min(consecutiveFailures, 6)), signal)
        }
        continue
      } catch (err) {
        if (err instanceof UploadError && err.fatal) throw err
        if (signal?.aborted) throw new UploadError('Upload cancelled', true)
        reconnects++
        // Counted as a failure for now; the probe at the top of the loop resets
        // the counter if the server confirms that new bytes actually landed.
        consecutiveFailures++
        if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
          throw new UploadError(
            `Upload failed after ${MAX_CONSECUTIVE_FAILURES} attempts in a row without progress (${err instanceof Error ? err.message : 'network error'}). Check your connection and try again — it will resume where it stopped.`,
            true,
          )
        }
        setPhase('reconnecting')
        wire = 0
        emit()
        // No network at all → wait for it to come back instead of burning retries.
        if (isOffline()) {
          offline = true
          emit()
          await waitOnline(signal)
          offline = false
          emit()
          if (signal?.aborted) throw new UploadError('Upload cancelled', true)
        }
        // 0.5 s, 1 s, 2 s ... capped at 8 s, plus jitter.
        await sleep(Math.min(8_000, 500 * 2 ** Math.min(consecutiveFailures, 6)) + Math.random() * 300, signal)
      }
    }
  } finally {
    clearInterval(ticker)
  }
}

// ---- Formatting helpers for the UI ----

/** Megabits per second, the number people compare with their internet plan. */
export function fmtMbps(bytesPerSec: number): string {
  const mbps = (bytesPerSec * 8) / 1_000_000
  if (mbps >= 100) return `${Math.round(mbps)} Mbps`
  if (mbps >= 10) return `${mbps.toFixed(1)} Mbps`
  if (mbps >= 1) return `${mbps.toFixed(2)} Mbps`
  return `${Math.round(mbps * 1000)} Kbps`
}

export function fmtEta(sec: number): string {
  const s = Math.max(1, Math.round(sec))
  if (s < 60) return `${s}s left`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s left`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m left`
}
