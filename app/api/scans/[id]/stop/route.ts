import { NextResponse } from 'next/server'
import { scheduler } from '@/lib/scheduler'
import { getSession } from '@/lib/users'
import { getScan } from '@/lib/store'
import { stopBackgroundScan } from '@/lib/background-queue'

export const runtime = 'nodejs'

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await ctx.params
  const scan = getScan(id)
  if (!scan || (session.role !== 'admin' && scan.ownerUsername !== session.username)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (scheduler.isRunning(id)) {
    const result = scheduler.stop(id)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
    return NextResponse.json({ ok: true })
  }
  const stopped = await stopBackgroundScan(id)
  if (!stopped) return NextResponse.json({ error: 'Scan is not queued' }, { status: 400 })
  return NextResponse.json({ ok: true })
}
