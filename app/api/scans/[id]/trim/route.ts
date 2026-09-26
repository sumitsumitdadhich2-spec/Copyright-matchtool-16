import { NextResponse } from 'next/server'
import path from 'node:path'
import { getScan, saveScan, addLog, scanMediaDir } from '@/lib/store'
import { chunkMovie } from '@/lib/ffmpeg'
import { CHUNK_SECONDS } from '@/lib/models'
import { getSession } from '@/lib/users'
import { pipelineReady } from '@/lib/merge-pipeline'
import { dispatchMinuteFinder } from '@/lib/minute-finder-dispatch'
import { isMinuteFinderRunning, stopAndWaitMinuteFinder } from '@/lib/gemini-minute-finder'
import { findAndReuseMovieChunks } from '@/lib/media'

export const runtime = 'nodejs'

/** Confirm the movie trim window (or the full movie) and start chunking.
 *  Chunks cover ONLY the confirmed range; all reported movie timestamps stay
 *  ABSOLUTE to the ORIGINAL movie (the scheduler adds the trim offset). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const scan = getScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })
  if (!scan.movieDuration) return NextResponse.json({ error: 'Upload a movie first' }, { status: 400 })
  if (scan.status === 'chunking') return NextResponse.json({ error: 'Chunking already in progress' }, { status: 409 })
  if (scan.status === 'scanning' || scan.status === 'verifying') {
    return NextResponse.json({ error: 'Cannot change the trim while a scan is running' }, { status: 409 })
  }
  // A Gemini Minute Finder run on the OLD trim range is stale now — stop it
  // before the chunk layout is reset (the dispatcher below starts a fresh run).
  if (isMinuteFinderRunning(id)) await stopAndWaitMinuteFinder(id, 'trim range badla', 10_000)

  const dur = scan.movieDuration
  const body = (await req.json().catch(() => ({}))) as { start?: number; end?: number }
  let start = Number.isFinite(Number(body.start)) ? Number(body.start) : 0
  let end = Number.isFinite(Number(body.end)) ? Number(body.end) : dur
  start = Math.min(Math.max(0, start), dur)
  end = Math.min(Math.max(start, end), dur)
  if (end - start < 1) return NextResponse.json({ error: 'Trim range must be at least 1 second' }, { status: 400 })

  const isFull = start <= 0.01 && end >= dur - 0.01
  scan.movieTrimStart = isFull ? undefined : start
  scan.movieTrimEnd = isFull ? undefined : end
  scan.awaitingTrim = false

  const rangeDur = end - start
  const count = Math.ceil(rangeDur / CHUNK_SECONDS)
  scan.chunkCount = count
  scan.chunks = Array.from({ length: count }, (_, i) => ({ index: i, status: 'pending' as const, attempts: 0 }))
  // Fresh chunk layout — reset any per-minute chunk states from a previous trim.
  if (scan.shortSegments) {
    for (const seg of scan.shortSegments) {
      seg.chunks = []
      if (seg.status !== 'pending') seg.status = 'pending'
    }
  }
  scan.matches = []
  scan.candidateGroups = []
  scan.status = 'chunking'
  scan.chunkingProgress = 0
  addLog(
    scan,
    'info',
    isFull
      ? `Trim confirmed: FULL movie (${fmtDur(dur)}) — cutting into ${count} one-minute chunks`
      : `Trim confirmed: ${fmtDur(start)} → ${fmtDur(end)} (${fmtDur(rangeDur)}) — cutting ONLY this range into ${count} chunk(s); reported movie timestamps stay absolute to the original`,
  )
  saveScan(scan)

  // AUTO MINUTE FINDER trigger: trim confirm hone ke baad, agar short bhi
  // uploaded hai → user ke toggle ke hisaab se:
  //   gemini     → Gemini Minute Finder (trimmed movie copy → 20-min windows → auto chunk scan)
  //   twelvelabs → merge → upload → index → Pegasus pipeline (old flow, fire-and-forget)
  //   off        → kuch nahi, manual Start
  try {
    if (pipelineReady(scan)) {
      const session = await getSession()
      await dispatchMinuteFinder(id, session ? { username: session.username, role: session.role } : null)
    }
  } catch (err) {
    console.error('[trim] minute finder auto-trigger failed:', err instanceof Error ? err.message : err)
  }

  const mediaDir = scanMediaDir(id)
  const dest = path.join(mediaDir, 'movie.mp4')
  // Chunk in the background; the client polls chunkingProgress.
  void (async () => {
    try {
      // Check if this movie's chunks were already cut in an earlier scan
      const reused = await findAndReuseMovieChunks(
        id,
        scan.movieName || '',
        scan.movieSize || 0,
        isFull ? 0 : start,
        isFull ? dur : end,
        count,
      )
      if (reused.ok) {
        const s = getScan(id)
        if (s) {
          s.chunkCount = reused.count
          s.chunks = Array.from({ length: reused.count }, (_, i) => ({ index: i, status: 'pending' as const, attempts: 0 }))
          s.status = 'ready'
          s.chunkingProgress = 100
          addLog(s, 'success', `Movie chunks pehle se cut hain (scan ${reused.sourceId}) — ${reused.count} chunks turant reuse ho gaye (no re-cut)`)
          saveScan(s)
        }
        return
      }

      const actual = await chunkMovie(
        dest,
        path.join(mediaDir, 'chunks'),
        dur,
        (pct) => {
          const s = getScan(id)
          if (s) {
            s.chunkingProgress = pct
            saveScan(s)
          }
        },
        isFull ? 0 : start,
        isFull ? undefined : end,
        { owner: id },
      )
      const s = getScan(id)
      if (s) {
        if (actual !== s.chunkCount) {
          s.chunkCount = actual
          s.chunks = Array.from({ length: actual }, (_, i) => ({ index: i, status: 'pending' as const, attempts: 0 }))
        }
        s.status = 'ready'
        s.chunkingProgress = 100
        addLog(s, 'success', `Chunking complete: ${actual} chunk(s) ready`)
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

  return NextResponse.json({ ok: true, chunkCount: count, trimStart: scan.movieTrimStart ?? 0, trimEnd: scan.movieTrimEnd ?? dur })
}

function fmtDur(sec: number): string {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0 ? `${h}h ${m}m ${ss}s` : `${m}m ${ss}s`
}
