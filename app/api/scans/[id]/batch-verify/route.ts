import { NextResponse } from 'next/server'
import { getFreshScan } from '@/lib/store'
import { getSession } from '@/lib/users'
import {
  startBatchVerificationAll,
  verifySingleMinute,
  stopBatchVerification,
  getOrCreateBatchVerifyState,
} from '@/lib/batch-verifier-service'

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

  const state = getOrCreateBatchVerifyState(scan)
  return NextResponse.json({
    batchVerify: state,
    matchCount: scan.matches?.length || 0,
    shortDuration: scan.shortDuration || 0,
  })
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await ctx.params
  const scan = await getFreshScan(id)
  if (!scan || !canAccess(session, scan)) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as {
    action?: string
    minuteIndex?: number
  }

  if (body.action === 'stop') {
    stopBatchVerification(id)
    return NextResponse.json({ ok: true, message: 'Batch verification stopped' })
  }

  if (body.action === 'verify_minute' && typeof body.minuteIndex === 'number') {
    // Run single minute
    void verifySingleMinute(id, body.minuteIndex).catch((err) => {
      console.error(`[Batch Verifier] Error verifying minute ${body.minuteIndex}:`, err)
    })
    return NextResponse.json({ ok: true, message: `Verification started for minute ${body.minuteIndex + 1}` })
  }

  // Default: start all minutes
  void startBatchVerificationAll(id).catch((err) => {
    console.error(`[Batch Verifier] Error starting all-in-one verification:`, err)
  })

  return NextResponse.json({ ok: true, message: 'All-in-one batch verification started' })
}
