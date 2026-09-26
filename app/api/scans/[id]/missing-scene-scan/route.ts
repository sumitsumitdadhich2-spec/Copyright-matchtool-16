import { NextResponse } from 'next/server'
import { getSession } from '@/lib/users'
import { getAllUserApiKeys } from '@/lib/user-keys'
import { getScan, getFreshScan } from '@/lib/store'
import {
  getDetectedMissingScenes,
  isMissingSceneScannerRunning,
  startMissingSceneScanner,
  stopMissingSceneScanner,
  reviewMissingSceneCandidate,
} from '@/lib/missing-scene-scanner'

export const runtime = 'nodejs'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const scan = isMissingSceneScannerRunning(id) ? getScan(id) : await getFreshScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const running = isMissingSceneScannerRunning(id)
  const detectedGaps = getDetectedMissingScenes(scan)

  return NextResponse.json({
    ok: true,
    running,
    state: scan.missingSceneScan || null,
    detectedGaps,
  })
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as {
    action?: 'accept' | 'reject'
    candidateId?: string
    scenes?: Array<{ start: number; end: number; id?: string }>
    windowIndices?: number[]
  }

  const scan = isMissingSceneScannerRunning(id) ? getScan(id) : await getFreshScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  // If action is accept or reject for a candidate
  if (body.action && body.candidateId) {
    const res = reviewMissingSceneCandidate(scan, body.candidateId, body.action)
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 })
    return NextResponse.json({ ok: true, state: scan.missingSceneScan, matches: scan.matches })
  }

  const keys = await getAllUserApiKeys(session.username)
  if (keys.length === 0) {
    return NextResponse.json({ error: 'Gemini API key nahi hai — Settings me apni key add karo.' }, { status: 400 })
  }

  const scenes = body.scenes || []
  if (scenes.length === 0) {
    return NextResponse.json({ error: 'Kam se kam 1 missing scene select karo.' }, { status: 400 })
  }

  const result = await startMissingSceneScanner(
    id,
    keys,
    { username: session.username, role: session.role },
    scenes,
    body.windowIndices,
  )

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409 })
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const result = stopMissingSceneScanner(id)
  return NextResponse.json(result)
}
