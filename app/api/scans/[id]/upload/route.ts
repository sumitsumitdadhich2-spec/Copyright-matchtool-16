import { NextResponse } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { addLog, getScan, saveScan, scanMediaDir, SCANS_DIR } from '@/lib/store'
import { restoreScans } from '@/lib/scan-store'
import {
  finalizeUploadedMedia,
  findReusableMedia,
  localMediaPath,
  mirrorMediaToStorage,
  mirrorReusedMedia,
  reuseMedia,
  type MediaKind,
} from '@/lib/media'
import { getSession } from '@/lib/users'
import { pipelineReady } from '@/lib/merge-pipeline'
import { dispatchMinuteFinder } from '@/lib/minute-finder-dispatch'
import { UPLOAD_PROTOCOL, UPLOAD_PROTOCOL_HEADER } from '@/lib/upload-protocol'

export const runtime = 'nodejs'

/**
 * SINGLE-STREAM, RESUMABLE upload — the ONLY upload path.
 *
 *   browser ──(one request body)──▶ Caddy ──▶ this handler ──▶ EBS disk
 *
 * The request body is streamed straight from the socket onto the disk in
 * ~4 MB writes at its byte offset. Nothing is buffered in RAM, so the file
 * can be far larger than memory and the network stays the only bottleneck.
 *
 * Resume: a sidecar `.meta` file remembers how many CONTIGUOUS bytes of this
 * exact file (fingerprint `session` = name + size + lastModified) have landed.
 * If the connection breaks, the browser asks `GET ?session=` for that number
 * and opens a new stream from there. Different fingerprint → fresh `.part`.
 *
 * IMPORTANT: this route is EXCLUDED from proxy.ts on purpose. When the proxy
 * runs on a request, Next.js clones the body into memory (capped at
 * `proxyClientMaxBodySize`, 10 MB by default) and silently truncates the rest.
 * Auth is therefore checked inside the handlers below.
 *
 *   GET  ?kind=short|movie&session=&total=&name=      → { received, reuse? }
 *        reuse = { scanId, source } when an earlier scan already holds this
 *        exact video (same name + size) on disk or in S3 → no upload needed.
 *   POST ?kind=&name=&total=&reuse=<scanId>            (empty body)
 *        → { ok, done, duration, size, reused: true } linked/fetched server-side
 *   POST ?kind=short|movie&name=&total=&session=&offset=   body = bytes from offset
 *        → { ok, received }            more bytes still needed (resume)
 *        → { ok, done, duration, size } file complete + ffprobe OK
 */

interface PartMeta {
  session: string
  total: number
  name: string
  /** Contiguous bytes from 0 that are on disk. */
  received: number
  updatedAt: number
}

/** Coalesce socket chunks into writes of this size (fewer syscalls). */
const WRITE_BUF = 4 * 1024 * 1024
/** Persist `received` this often during a stream (crash → resume from here). */
const META_EVERY = 64 * 1024 * 1024
/** How long a new request waits for a dying stream on the same file to let go. */
const LOCK_WAIT_MS = 15_000

const unauthorized = () => NextResponse.json({ error: 'Unauthorized — please log in' }, { status: 401 })

function readMeta(metaPath: string): PartMeta | null {
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ metaPath)) return null
    const m = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as PartMeta
    if (typeof m.received !== 'number' || !Number.isFinite(m.received)) return null
    return m
  } catch {
    return null
  }
}

function writeMeta(metaPath: string, meta: PartMeta) {
  const tmp = `${metaPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(meta))
  fs.renameSync(tmp, metaPath)
}

function safeUnlink(p: string) {
  try {
    fs.unlinkSync(p)
  } catch {
    // ignore
  }
}

function fileSize(p: string): number {
  try {
    return fs.statSync(/*turbopackIgnore: true*/ p).size
  } catch {
    return 0
  }
}

async function loadScan(id: string) {
  let scan = getScan(id)
  if (!scan) {
    await restoreScans(SCANS_DIR)
    scan = getScan(id)
  }
  return scan
}

function parseKind(v: string | null): MediaKind | null {
  return v === 'short' || v === 'movie' ? v : null
}

// ---- One stream per (scan, kind) at a time. A browser that aborted a stalled
// request re-probes immediately; make it wait until the old stream has
// flushed and recorded its byte count so the probe answer is exact.
const active = new Map<string, Promise<void>>()

async function waitIdle(key: string): Promise<boolean> {
  const p = active.get(key)
  if (!p) return true
  return Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), LOCK_WAIT_MS)),
  ])
}

async function writeAll(fh: fs.promises.FileHandle, buf: Buffer, len: number, position: number) {
  let off = 0
  while (off < len) {
    const { bytesWritten } = await fh.write(buf, off, len - off, position + off)
    if (bytesWritten <= 0) throw new Error('disk write returned 0 bytes')
    off += bytesWritten
  }
}

/** Resume probe: how many contiguous bytes of this exact file are on disk? */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) return unauthorized()
  const { id } = await ctx.params
  const scan = await loadScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })
  const sessionUser = await getSession()
  if (!sessionUser || (sessionUser.role !== 'admin' && scan.ownerUsername !== sessionUser.username)) {
    return NextResponse.json({ error: 'Scan not found' }, { status: 404 })
  }

  const url = new URL(req.url)
  const kind = parseKind(url.searchParams.get('kind'))
  if (!kind) return NextResponse.json({ error: 'kind must be short or movie' }, { status: 400 })
  const session = (url.searchParams.get('session') || '').slice(0, 64)
  const total = Number.parseInt(url.searchParams.get('total') || '', 10)

  await waitIdle(`${id}/${kind}`)

  const dest = localMediaPath(id, kind)
  const part = `${dest}.part`
  const meta = readMeta(`${dest}.meta`)
  if (!meta || meta.session !== session || meta.total !== total || !fs.existsSync(/*turbopackIgnore: true*/ part)) {
    // Nothing partial for this file — but maybe it was ALREADY uploaded in an
    // earlier scan (same name + size). Offer the server-side link instead of a
    // second multi-GB upload. Sirf dhundhna hai, copy POST ?reuse= par hoti hai.
    const name = (url.searchParams.get('name') || '').trim()
    if (name && Number.isFinite(total) && total > 0) {
      const reuse = await findReusableMedia(kind, name, total)
      if (reuse) {
        console.log(`[upload] ${kind} "${name}" (${total} bytes) already in scan ${reuse.scanId} (${reuse.source}) — offering reuse to ${id}`)
        return NextResponse.json({ received: 0, reuse: { scanId: reuse.scanId, source: reuse.source } })
      }
    }
    return NextResponse.json({ received: 0, uploadKey: `${id}/${kind}`, scanId: id, kind })
  }
  // Never promise more than what is physically on disk.
  return NextResponse.json({ received: Math.min(meta.received, fileSize(part), total), uploadKey: `${id}/${kind}`, scanId: id, kind })
}

/** POST ?reuse=<scanId> — link/fetch an already-uploaded video into this scan. */
async function reuseFromScan(req: Request, id: string, kind: MediaKind, name: string, total: number, sourceId: string): Promise<NextResponse> {
  const startedAt = Date.now()
  const dest = localMediaPath(id, kind)
  safeUnlink(`${dest}.part`)
  safeUnlink(`${dest}.meta`)

  const local = await reuseMedia(id, kind, sourceId, total)
  if (!local) {
    // Source vanished between probe and now (pruned) → browser falls back to a real upload.
    return NextResponse.json({ error: 'Previous copy of this video is no longer available — uploading normally', received: 0 }, { status: 410 })
  }

  const scan = getScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })
  const result = await finalizeUploadedMedia(scan, kind, name)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  const fresh = getScan(id)
  if (fresh) {
    if (kind === 'movie') {
      // Proactively link prescan-movie.mp4 ONLY if source scan copy was re-encoded (never uncompressed stream copies)
      const srcScan = getScan(sourceId)
      const isReencoded = srcScan?.geminiPrescan?.movieCopy?.reencoded === true
      const srcPrescan = path.join(scanMediaDir(sourceId), 'prescan-movie.mp4')
      const dstPrescan = path.join(scanMediaDir(id), 'prescan-movie.mp4')
      if (isReencoded && fs.existsSync(srcPrescan) && fs.statSync(srcPrescan).size > 1000 && !fs.existsSync(dstPrescan)) {
        try {
          fs.linkSync(srcPrescan, dstPrescan)
        } catch {
          try {
            fs.copyFileSync(srcPrescan, dstPrescan)
          } catch {
            // ignore
          }
        }
      }
    }
    addLog(fresh, 'success', `${kind === 'short' ? 'Short' : 'Movie'} "${name}" pehle se server par tha (scan ${sourceId}) — bina upload ${((Date.now() - startedAt) / 1000).toFixed(1)}s me link ho gaya`)
    saveScan(fresh, { immediate: true })
  }

  void mirrorReusedMedia(id, kind, sourceId, req.headers.get('x-video-type') || 'video/mp4')
  await afterMediaReady(id)
  return NextResponse.json({ ok: true, done: true, reused: true, duration: result.duration, size: result.size })
}

/** Post-upload hooks shared by the stream path and the reuse path. */
async function afterMediaReady(id: string) {
  // AUTO MINUTE FINDER trigger: agar dono videos (short + movie) ready hain
  // aur trim confirmed / auto-confirmed hai → user ke toggle ke hisaab se
  // Gemini Minute Finder (Window mode) auto-start ho jayega.
  try {
    const fresh = getScan(id)
    if (fresh && pipelineReady(fresh)) {
      const s = await getSession()
      await dispatchMinuteFinder(id, s ? { username: s.username, role: s.role } : null)
    }
  } catch (err) {
    console.error('[upload] minute finder auto-trigger failed:', err instanceof Error ? err.message : err)
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sessionUser = await getSession()
  if (!sessionUser) return unauthorized()
  const { id } = await ctx.params
  const scan = await loadScan(id)
  if (!scan || (sessionUser.role !== 'admin' && scan.ownerUsername !== sessionUser.username)) {
    return NextResponse.json({ error: 'Scan not found' }, { status: 404 })
  }

  // Old cached bundle (chunked uploader) → tell the user to reload instead of
  // accepting 16 MB slices that this handler can no longer make sense of.
  if (req.headers.get(UPLOAD_PROTOCOL_HEADER) !== UPLOAD_PROTOCOL) {
    console.warn(`[upload] rejected request without ${UPLOAD_PROTOCOL_HEADER}=${UPLOAD_PROTOCOL} (old browser bundle?) for ${req.url}`)
    return NextResponse.json(
      { error: 'This tab is running an old version of the app — please hard-refresh the page (Ctrl+Shift+R) and upload again.' },
      { status: 400 },
    )
  }

  const url = new URL(req.url)
  const kind = parseKind(url.searchParams.get('kind'))
  if (!kind) return NextResponse.json({ error: 'kind must be short or movie' }, { status: 400 })
  const name = (url.searchParams.get('name') || '').trim() || 'video.mp4'
  const total = Number.parseInt(url.searchParams.get('total') || '', 10)

  // Re-use path: no body, the bytes already live in another scan.
  const reuseId = (url.searchParams.get('reuse') || '').trim()
  if (reuseId) {
    if (!/^[a-f0-9]{16}$/i.test(reuseId)) return NextResponse.json({ error: 'Invalid reuse id' }, { status: 400 })
    if (!Number.isFinite(total) || total <= 0) return NextResponse.json({ error: 'Invalid total' }, { status: 400 })
    const key = `${id}/${kind}`
    if (!(await waitIdle(key))) {
      return NextResponse.json({ error: 'A previous stream for this file is still closing — retrying', received: 0 }, { status: 409 })
    }
    let release: () => void = () => {}
    active.set(
      key,
      new Promise<void>((r) => {
        release = r
      }),
    )
    try {
      return await reuseFromScan(req, id, kind, name, total, reuseId)
    } finally {
      active.delete(key)
      release()
    }
  }

  const offset = Number.parseInt(url.searchParams.get('offset') || '', 10)
  const session = (url.searchParams.get('session') || '').slice(0, 64) || 'legacy'
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(offset) || offset < 0 || offset > total) {
    return NextResponse.json({ error: 'Invalid offset/total' }, { status: 400 })
  }
  // Reject an over-long body BEFORE reading it (browser always sends Content-Length).
  const declared = Number.parseInt(req.headers.get('content-length') || '', 10)
  if (Number.isFinite(declared) && declared > 0 && offset + declared > total) {
    return NextResponse.json(
      { error: `Body of ${declared.toLocaleString()} bytes from offset ${offset.toLocaleString()} exceeds the file size ${total.toLocaleString()}` },
      { status: 400 },
    )
  }

  const key = `${id}/${kind}`
  if (!(await waitIdle(key))) {
    return NextResponse.json({ error: 'A previous stream for this file is still closing — retrying', received: 0 }, { status: 409 })
  }
  let release: () => void = () => {}
  active.set(
    key,
    new Promise<void>((r) => {
      release = r
    }),
  )
  try {
    return await streamToDisk(req, { id, kind, name, offset, total, session, declared: Number.isFinite(declared) && declared > 0 ? declared : null })
  } finally {
    active.delete(key)
    release()
  }
}

interface StreamParams {
  id: string
  kind: MediaKind
  name: string
  offset: number
  total: number
  session: string
  /** Content-Length the browser announced (null if absent). */
  declared: number | null
}

async function streamToDisk(req: Request, p: StreamParams): Promise<NextResponse> {
  const { id, kind, name, offset, total, session, declared } = p
  const dest = localMediaPath(id, kind)
  const part = `${dest}.part`
  const metaPath = `${dest}.meta`

  // ---- Open or start the .part for this exact file.
  let meta = readMeta(metaPath)
  const fresh = !meta || meta.session !== session || meta.total !== total || !fs.existsSync(/*turbopackIgnore: true*/ part)
  if (fresh) {
    if (offset !== 0) {
      // Browser thinks it can resume but we have nothing for this file.
      return NextResponse.json({ error: 'Server has no data for this file yet — restarting from 0', received: 0 }, { status: 409 })
    }
    safeUnlink(part)
    safeUnlink(metaPath)
    fs.closeSync(fs.openSync(part, 'w'))
    meta = { session, total, name, received: 0, updatedAt: Date.now() }
    writeMeta(metaPath, meta)
  } else {
    meta!.received = Math.min(meta!.received, fileSize(part), total)
    if (offset > meta!.received) {
      return NextResponse.json({ error: 'Resuming from the last confirmed byte', received: meta!.received }, { status: 409 })
    }
  }
  const state = meta!

  // ---- Stream the body onto the disk at `offset`.
  let pos = offset
  let cutShort: string | null = null
  let overflow = false
  const startedAt = Date.now()

  if (offset < total) {
    if (!req.body) return NextResponse.json({ error: 'Missing request body' }, { status: 400 })
    const source = Readable.fromWeb(req.body as unknown as WebReadableStream<Uint8Array>)
    // Safety net: if the client vanishes and the body stream does not end on its
    // own, tear it down ourselves so the per-file lock is always released.
    const onAbort = () => source.destroy(new Error('client aborted'))
    req.signal.addEventListener('abort', onAbort, { once: true })
    const fh = await fs.promises.open(part, 'r+')
    const buf = Buffer.allocUnsafe(WRITE_BUF)
    let fill = 0
    let sinceMeta = 0

    const persist = () => {
      state.received = Math.max(state.received, pos)
      state.updatedAt = Date.now()
      writeMeta(metaPath, state)
      sinceMeta = 0
    }
    const flush = async () => {
      if (fill === 0) return
      await writeAll(fh, buf, fill, pos)
      pos += fill
      sinceMeta += fill
      fill = 0
      if (sinceMeta >= META_EVERY) persist()
    }

    try {
      for await (const raw of source) {
        const u8 = raw as Uint8Array
        const chunk = Buffer.isBuffer(u8) ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)
        if (pos + fill + chunk.length > total) {
          overflow = true
          throw new Error('body longer than declared total')
        }
        if (chunk.length >= WRITE_BUF) {
          await flush()
          await writeAll(fh, chunk, chunk.length, pos)
          pos += chunk.length
          sinceMeta += chunk.length
          if (sinceMeta >= META_EVERY) persist()
        } else {
          if (fill + chunk.length > WRITE_BUF) await flush()
          chunk.copy(buf, fill)
          fill += chunk.length
        }
      }
      await flush()
    } catch (err) {
      // Client went away / connection reset / proxy cut the body. Keep every
      // byte that made it to disk — the browser resumes from `received`.
      cutShort = err instanceof Error ? err.message : String(err)
      try {
        if (!overflow) await flush()
      } catch {
        // disk error while flushing the tail — received stays at last good pos
      }
    } finally {
      req.signal.removeEventListener('abort', onAbort)
      try {
        await fh.close()
      } catch {
        // ignore
      }
      persist()
    }
  }

  // Server-side throughput of THIS stream — the number to compare with the
  // Mbps shown in the browser when debugging a slow link (docker compose logs).
  {
    const got = Math.max(0, pos - offset)
    const sec = Math.max(0.001, (Date.now() - startedAt) / 1000)
    if (got > 0) {
      console.log(
        `[upload] ${kind} of ${id}: +${(got / 1048576).toFixed(1)} MB in ${sec.toFixed(1)}s = ${((got * 8) / 1e6 / sec).toFixed(1)} Mbps (${(pos / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB on disk)`,
      )
    }
  }

  if (overflow) {
    safeUnlink(part)
    safeUnlink(metaPath)
    return NextResponse.json({ error: 'Upload sent more bytes than the file size — please try again.' }, { status: 400 })
  }

  const received = Math.min(state.received, total)
  if (received < total) {
    const got = Math.max(0, pos - offset)
    // The body ENDED CLEANLY but was shorter than the browser's Content-Length:
    // something between the browser and this handler swallowed the tail. The
    // usual culprit is proxy.ts running on this route (Next.js buffers the body
    // in RAM and cuts it at proxyClientMaxBodySize = 10 MB) or a proxy body
    // limit. The browser resumes anyway, but flag it so it is visible.
    const truncated = !cutShort && declared !== null && got < declared
    if (truncated) {
      console.error(
        `[upload] ${kind} of ${id}: BODY TRUNCATED — browser sent ${declared.toLocaleString()} bytes, only ${got.toLocaleString()} arrived. ` +
          `Check that /api/scans/<id>/upload is excluded from the proxy.ts matcher and that no proxy limits request bodies.`,
      )
    } else if (cutShort) {
      console.warn(`[upload] ${kind} of ${id}: stream ended at ${received}/${total} bytes (${cutShort}) — browser will resume`)
    }
    return NextResponse.json({ ok: true, received, truncated, uploadKey: `${id}/${kind}`, scanId: id, kind })
  }

  // ---- Every byte is on disk: verify, move into place, probe.
  const size = fileSize(part)
  if (size !== total) {
    safeUnlink(part)
    safeUnlink(metaPath)
    console.error(`[upload] size mismatch after final byte: expected ${total}, got ${size}`)
    return NextResponse.json(
      { error: `Upload incomplete — received ${size.toLocaleString()} of ${total.toLocaleString()} bytes. Please try again.` },
      { status: 400 },
    )
  }
  fs.renameSync(part, dest)
  safeUnlink(metaPath)

  const scan = getScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })
  const result = await finalizeUploadedMedia(scan, kind, name)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  // Durable copy to S3 in the background — the user never waits for it.
  void mirrorMediaToStorage(id, kind, req.headers.get('x-video-type') || 'video/mp4')
  await afterMediaReady(id)

  return NextResponse.json({ ok: true, done: true, duration: result.duration, size: result.size, uploadKey: `${id}/${kind}`, scanId: id, kind })
}
