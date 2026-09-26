import { NextResponse } from 'next/server'
import { getScan, saveScan, addLog } from '@/lib/store'
import { scheduler } from '@/lib/scheduler'
import { applyGroupMatches, sameShortSegment } from '@/lib/candidate-pick'
import { fmtTime } from '@/lib/format'
import { getSession } from '@/lib/users'
import { invalidateRenderedOutput, isRenderActive } from '@/lib/render'

export const runtime = 'nodejs'

/** USER CHOICE: make one candidate window the MAIN clip for its short window.
 *
 *  Body: { groupId, candidateIndex, viaRescan? }  → pick that candidate
 *        { groupId, candidateIndex: null }         → clear the pick (back to AI verdict)
 *
 *  Rewrites scan.matches for that group only, so the stitched preview, the
 *  side-by-side compare and the export (all built from scan.matches) update
 *  together. Works for confirmed, unverified, rejected AND not-yet-checked
 *  groups — the choice is the user's. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const scan = getScan(id)
  if (!scan || (session.role !== 'admin' && scan.ownerUsername !== session.username)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (isRenderActive(id) || scan.renderJob?.status === 'rendering') {
    return NextResponse.json({ error: 'Render chal raha hai — finish ya cancel hone ke baad main clip badlo' }, { status: 409 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    groupId?: string
    candidateIndex?: number | null
    viaRescan?: boolean
    shortStart?: number
    shortEnd?: number
    movieStart?: number
    movieEnd?: number
    chunkIndex?: number
    model?: string
  }

  if (scheduler.isRunning(id)) {
    const res = scheduler.applyUserPick(
      id,
      body.groupId || '',
      body.candidateIndex === null ? null : body.candidateIndex,
      body.viaRescan === true,
      body,
    )
    if (!res.ok) {
      return NextResponse.json({ error: res.error || 'Choice apply nahi ho saki' }, { status: 400 })
    }
    invalidateRenderedOutput(scan)
    return NextResponse.json({ ok: true })
  }
  scan.candidateGroups = scan.candidateGroups || []
  let g = scan.candidateGroups.find((x) => x.id === body.groupId)
  if (!g && body.shortStart != null && body.shortEnd != null) {
    g = scan.candidateGroups.find((x) => sameShortSegment(x.shortStart, x.shortEnd, body.shortStart!, body.shortEnd!))
  }
  if (!g) {
    if (body.shortStart != null && body.shortEnd != null && body.movieStart != null && body.movieEnd != null) {
      g = {
        id: body.groupId || `g-${Date.now()}`,
        shortStart: body.shortStart,
        shortEnd: body.shortEnd,
        status: 'confirmed',
        confirmedIndex: 0,
        confirmedViaRescan: false,
        candidates: [
          {
            shortStart: body.shortStart,
            shortEnd: body.shortEnd,
            movieStart: body.movieStart,
            movieEnd: body.movieEnd,
            chunkIndex: body.chunkIndex ?? 0,
            model: body.model ?? 'gemini-3.7-flash',
            verdict: 'same',
            rescan: 'none',
          },
        ],
      }
      scan.candidateGroups.push(g)
    } else {
      return NextResponse.json({ error: 'Candidate group not found' }, { status: 404 })
    }
  }

  if (body.candidateIndex === null) {
    delete g.userPick
    applyGroupMatches(scan, g)
    addLog(scan, 'info', `User choice cleared for short ${fmtTime(g.shortStart)}–${fmtTime(g.shortEnd)} — AI verdict (${g.status}) restored`)
  } else {
    let idx = Number(body.candidateIndex)
    if (idx < 0 || idx >= g.candidates.length) {
      if (body.movieStart != null && body.movieEnd != null) {
        const found = g.candidates.findIndex(
          (c) => Math.abs(c.movieStart - body.movieStart!) < 0.5 && Math.abs(c.movieEnd - body.movieEnd!) < 0.5,
        )
        if (found >= 0) {
          idx = found
        } else {
          idx = g.candidates.length
          g.candidates.push({
            shortStart: body.shortStart ?? g.shortStart,
            shortEnd: body.shortEnd ?? g.shortEnd,
            movieStart: body.movieStart,
            movieEnd: body.movieEnd,
            chunkIndex: body.chunkIndex ?? 0,
            model: body.model ?? 'gemini-3.7-flash',
            verdict: 'same',
            rescan: 'none',
          })
        }
      } else {
        return NextResponse.json({ error: 'Invalid candidate index' }, { status: 400 })
      }
    }
    const c = g.candidates[idx]
    const viaRescan = body.viaRescan === true
    if (viaRescan && (c.rescanMovieStart == null || c.rescanMovieEnd == null)) {
      return NextResponse.json({ error: 'This candidate has no rescan window' }, { status: 400 })
    }
    g.userPick = { index: idx, viaRescan, at: Date.now() }
    applyGroupMatches(scan, g)
    const ms = viaRescan ? c.rescanMovieStart! : c.movieStart
    const me = viaRescan ? c.rescanMovieEnd! : c.movieEnd
    addLog(
      scan,
      'success',
      `USER CHOICE: short ${fmtTime(g.shortStart)}–${fmtTime(g.shortEnd)} → movie ${fmtTime(ms)}–${fmtTime(me)} (candidate #${idx + 1}${viaRescan ? ', rescan window' : ''}, chunk ${c.chunkIndex}) set as MAIN clip — AI verdict was ${g.status}. Preview + export input updated.`,
    )
  }

  // A completed MP4 contains the old match list; never leave it playable or
  // downloadable beside a preview that already shows the new main clip.
  if (invalidateRenderedOutput(scan)) {
    addLog(scan, 'warn', 'Previous export cleared because the main clip changed — render again to export the updated merge')
  }

  // Keep the frozen report in sync so the report tab matches preview/export.
  if (scan.report) scan.report.matches = scan.matches
  saveScan(scan, { immediate: true })
  return NextResponse.json({ ok: true, matches: scan.matches.length })
}
