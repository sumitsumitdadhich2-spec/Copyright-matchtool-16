import { NextResponse } from 'next/server'
import { getScan, getFreshScan } from '@/lib/store'
import { getSession } from '@/lib/users'
import { getAllUserApiKeys, getUserMinuteFinderMode } from '@/lib/user-keys'
import { scheduler } from '@/lib/scheduler'
import {
  startGeminiMinuteFinder,
  stopGeminiMinuteFinder,
  isMinuteFinderRunning,
  minuteFinderReady,
  MINUTE_FINDER_MAX_SHORT_SEC,
} from '@/lib/gemini-minute-finder'
import { CHUNK_MODEL_POOL } from '@/lib/models'

export const runtime = 'nodejs'

/** GET: Gemini Minute Finder state for the UI panel. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  // While the finder runs ON THIS instance its in-memory state is freshest.
  const scan = isMinuteFinderRunning(id) ? getScan(id) : await getFreshScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const [mode, keys] = await Promise.all([getUserMinuteFinderMode(session.username), getAllUserApiKeys(session.username)])
  return NextResponse.json({
    mode,
    keyCount: keys.length,
    models: CHUNK_MODEL_POOL.map((m) => m.id),
    maxShortSec: MINUTE_FINDER_MAX_SHORT_SEC,
    ready: minuteFinderReady(scan),
    running: isMinuteFinderRunning(id),
    scanRunning: scheduler.isRunning(id),
    prescan: scan.geminiPrescan ?? { status: 'idle', windowLen: 1200, uploads: {}, windows: [] },
  })
}

/** POST { action: 'start' | 'retry' | 'rerun' } — start / retry failed windows / re-run all windows.
 *  Uploads (48 h) and the movie copy are reused whenever the trim is unchanged. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as { action?: string; windowIndices?: number[] }
  const action = body.action === 'retry' ? 'retry' : body.action === 'rerun' ? 'rerun' : 'start'

  const scan = await getFreshScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const keys = await getAllUserApiKeys(session.username)
  if (keys.length === 0) {
    return NextResponse.json({ error: 'Gemini API key nahi hai — Settings me apni key add karo.' }, { status: 400 })
  }

  const result = startGeminiMinuteFinder(id, keys, { username: session.username, role: session.role }, action, body.windowIndices)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })
  return NextResponse.json({ ok: true, action })
}

/** DELETE: stop the running minute finder (pending windows resume with Retry). */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const result = stopGeminiMinuteFinder(id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })
  return NextResponse.json({ ok: true })
}
