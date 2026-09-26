import { NextResponse } from 'next/server'
import { getFreshScan } from '@/lib/store'
import { getSession } from '@/lib/users'
import { getAllUserApiKeys } from '@/lib/user-keys'
import { gapBackupPreview, gapBackupRunning, reviewGapCandidate, startGapBackup, stopGapBackup } from '@/lib/gap-backup'

export const runtime = 'nodejs'

function canAccess(session: { username: string; role: string }, scan: { ownerUsername?: string }) {
  return session.role === 'admin' || scan.ownerUsername === session.username
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await ctx.params
  const scan = await getFreshScan(id)
  if (!scan || !canAccess(session, scan)) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })
  const preview = gapBackupPreview(scan)
  return NextResponse.json({ ...preview, running: gapBackupRunning(id) })
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await ctx.params
  const scan = await getFreshScan(id)
  if (!scan || !canAccess(session, scan)) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })
  const body = await req.json().catch(() => ({})) as {
    action?: string
    candidateId?: string
    models?: string[]
    selectedGaps?: Array<{ start: number; end: number }>
  }
  if (body.action === 'stop') return NextResponse.json({ ok: stopGapBackup(id) })
  if ((body.action === 'accept' || body.action === 'reject') && body.candidateId) {
    const result = reviewGapCandidate(scan, body.candidateId, body.action)
    return NextResponse.json(result, { status: result.ok ? 200 : 404 })
  }
  const keys = await getAllUserApiKeys(session.username)
  const result = startGapBackup(
    id,
    keys,
    Array.isArray(body.models) ? body.models : undefined,
    Array.isArray(body.selectedGaps) ? body.selectedGaps : undefined,
  )
  return NextResponse.json(result, { status: result.ok ? 200 : 409 })
}
