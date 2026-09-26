import { NextResponse } from 'next/server'
import { getScan, saveScan, addLog } from '@/lib/store'
import { scheduler } from '@/lib/scheduler'
import { chunkOverlapsSegRange } from '@/lib/segment-range'

export const runtime = 'nodejs'

/** Update which short-video minutes are selected for scanning.
 *  Unselected minutes are skipped; select them later + Resume to scan the rest
 *  — results merge into the same scan. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const scan = getScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })
  if (scheduler.isRunning(id)) {
    return NextResponse.json({ error: 'Cannot change minute selection while a scan is running' }, { status: 409 })
  }
  const segs = scan.shortSegments
  if (!segs || segs.length === 0) {
    return NextResponse.json({ error: 'No short-video minutes to select' }, { status: 400 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    selected?: number[]
    /** optional PER-MINUTE movie search ranges (absolute movie seconds); null = full trim window */
    ranges?: { index: number; start: number | null; end: number | null }[]
  }
  const selected = Array.isArray(body.selected) ? body.selected.filter((n) => Number.isInteger(n)) : null
  if (!selected || selected.length === 0) {
    return NextResponse.json({ error: 'Select at least one minute to scan' }, { status: 400 })
  }
  const set = new Set(selected)
  for (const seg of segs) seg.selected = set.has(seg.index)

  // PER-MINUTE MOVIE RANGE: validate + store each minute's movie search range.
  const trimStart = scan.movieTrimStart ?? 0
  const trimEnd = scan.movieTrimEnd ?? scan.movieDuration ?? 0
  const rangeNotes: string[] = []
  if (Array.isArray(body.ranges)) {
    for (const r of body.ranges) {
      const seg = segs.find((s) => s.index === r.index)
      if (!seg) continue
      // Manual range edit/clear overrides any Minute Finder exact-minute list —
      // but ONLY when the range actually changed. The UI re-posts every
      // minute's current range on each save (e.g. a plain checkbox toggle),
      // and that must not wipe the finder's list.
      const prevStart = typeof seg.movieRangeStart === 'number' ? Math.round(seg.movieRangeStart) : null
      const prevEnd = typeof seg.movieRangeEnd === 'number' ? Math.round(seg.movieRangeEnd) : null
      if (r.start === null || r.end === null) {
        if (prevStart !== null || prevEnd !== null) delete seg.movieMinutes
        delete seg.movieRangeStart
        delete seg.movieRangeEnd
        continue
      }
      if (!Number.isFinite(r.start) || !Number.isFinite(r.end) || r.end <= r.start) {
        return NextResponse.json({ error: `Minute ${r.index + 1}: invalid movie range (start must be before end)` }, { status: 400 })
      }
      const start = Math.max(trimStart, r.start)
      const end = Math.min(trimEnd, r.end)
      if (end <= start) {
        return NextResponse.json(
          { error: `Minute ${r.index + 1}: movie range is outside the scanned movie window (${trimStart}s–${trimEnd}s)` },
          { status: 400 },
        )
      }
      // Range covering the whole trim window = no custom range.
      if (start <= trimStart && end >= trimEnd) {
        if (prevStart !== null || prevEnd !== null) delete seg.movieMinutes
        delete seg.movieRangeStart
        delete seg.movieRangeEnd
      } else {
        if (Math.round(start) !== prevStart || Math.round(end) !== prevEnd) delete seg.movieMinutes
        seg.movieRangeStart = start
        seg.movieRangeEnd = end
        if (seg.selected !== false) rangeNotes.push(`minute ${seg.index + 1} → movie ${Math.round(start)}s–${Math.round(end)}s`)
      }
    }
  }

  // Reopen a finished scan when newly selected minutes still have work, so Resume enables.
  const hasWork = segs.some(
    (s) =>
      s.selected !== false &&
      (s.status !== 'done' ||
        s.chunks.some(
          (c) =>
            c.status === 'pending' ||
            c.status === 'scanning' ||
            (c.status === 'cancelled' && chunkOverlapsSegRange(scan, s, c.index)),
        )),
  )
  if (scan.status === 'done' && hasWork) scan.status = 'stopped'

  const picked = segs.filter((s) => s.selected !== false).map((s) => s.index + 1)
  addLog(scan, 'info', `Minute selection updated: scanning minute(s) ${picked.join(', ')} of ${segs.length}`)
  if (rangeNotes.length > 0) {
    addLog(scan, 'info', `Per-minute movie ranges set: ${rangeNotes.join('; ')} — out-of-range chunks will be skipped (quota saver)`)
  }
  saveScan(scan)
  return NextResponse.json({ ok: true, selected: picked })
}
