import { NextResponse } from 'next/server'
import { getFreshScan } from '@/lib/store'
import { getSession } from '@/lib/users'
import { getUserTwelveLabsKey } from '@/lib/user-keys'
import { startMergePipeline, isPipelineRunning, pipelineReady } from '@/lib/merge-pipeline'

export const runtime = 'nodejs'

/** GET: auto-pipeline state for the UI (status + minute suggestions + logs live in scan.logs). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const scan = await getFreshScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const tlKey = await getUserTwelveLabsKey(session.username)
  return NextResponse.json({
    hasKey: Boolean(tlKey),
    ready: pipelineReady(scan),
    running: isPipelineRunning(id),
    pipeline: scan.mergePipeline ?? { status: 'idle' },
    twelveLabs: scan.twelveLabs ?? { status: 'none' },
    prefilter: scan.prefilter ?? null,
  })
}

/** POST { action: 'start' | 'retry' }: kick off (or resume) the auto pipeline.
 *  Retry resumes from the failed step — cached merge/asset/embeddings/segments
 *  are reused, nothing is redone unnecessarily. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as { action?: string }
  const action = body.action === 'retry' ? 'retry' : 'start'

  const tlKey = await getUserTwelveLabsKey(session.username)
  if (!tlKey) {
    return NextResponse.json({ error: 'TwelveLabs API key set nahi hai — Settings me add karo.' }, { status: 400 })
  }

  const scan = await getFreshScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })
  if (!pipelineReady(scan)) {
    return NextResponse.json(
      { error: 'Short + movie upload aur trim confirm hone ke baad hi pipeline chalti hai.' },
      { status: 400 },
    )
  }
  if (action === 'retry' && scan.mergePipeline) {
    // Clear the error so the state machine can resume from cached steps.
    scan.mergePipeline.error = null
  }

  const result = startMergePipeline(id, tlKey)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })
  return NextResponse.json({ ok: true, started: true })
}
