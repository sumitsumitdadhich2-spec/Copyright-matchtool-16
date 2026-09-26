import { NextResponse } from 'next/server'
import { getScan, getApiKey, getAllUsage, deleteScan, SCANS_DIR } from '@/lib/store'
import { restoreScans } from '@/lib/scan-store'
import { invalidateUsageCache } from '@/lib/media'
import { scheduler } from '@/lib/scheduler'
import { ensureBackgroundWorkers, stopBackgroundScan } from '@/lib/background-queue'
import { getSession } from '@/lib/users'
import { isMinuteFinderRunning, stopGeminiMinuteFinder } from '@/lib/gemini-minute-finder'
import { cancelRender } from '@/lib/render'

export const runtime = 'nodejs'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ensureBackgroundWorkers()
  const { id } = await ctx.params
  // Single long-lived server: the local JSON is always the freshest copy.
  let scan = getScan(id)
  if (!scan) {
    // Fresh instance: the record may only exist in S3.
    await restoreScans(SCANS_DIR)
    scan = getScan(id)
  }
  if (!scan) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (session.role !== 'admin' && scan.ownerUsername !== session.username) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const key = getApiKey()
  return NextResponse.json({
    scan,
    running: scheduler.isRunning(id),
    usage: key ? getAllUsage(key) : null,
  })
}

/** Delete a scan completely: record + local files + work dirs + ALL S3 objects. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  await restoreScans(SCANS_DIR)
  const scan = getScan(id)
  if (!scan) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (session.role !== 'admin' && scan.ownerUsername !== session.username) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Stop queued/running scan work, minute finder, and renders before removing files.
  await stopBackgroundScan(id)
  if (scheduler.isRunning(id)) scheduler.stop(id)
  if (isMinuteFinderRunning(id)) stopGeminiMinuteFinder(id)
  cancelRender(id)

  deleteScan(id)
  invalidateUsageCache()
  return NextResponse.json({ ok: true, deleted: id })
}

/** Update scan properties (e.g. verifierEnabled toggle). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const scan = getScan(id)
  if (!scan) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (session.role !== 'admin' && scan.ownerUsername !== session.username) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const body = (await req.json().catch(() => ({}))) as { verifierEnabled?: boolean; autoMode?: boolean; customName?: string }
  let updated = false

  if (body.customName !== undefined) {
    scan.customName = typeof body.customName === 'string' ? body.customName.trim() || null : null
    updated = true
  }

  if (body.verifierEnabled !== undefined) {
    const enabled = Boolean(body.verifierEnabled)
    scan.verifierEnabled = enabled
    scheduler.setVerifierEnabled(id, enabled)
    updated = true
  }

  if (body.autoMode !== undefined) {
    const enabled = Boolean(body.autoMode)
    scan.autoMode = enabled
    updated = true
  }

  if (updated) {
    const { saveScan } = await import('@/lib/store')
    saveScan(scan, { immediate: true })
  }

  return NextResponse.json({ ok: true, customName: scan.customName, verifierEnabled: scan.verifierEnabled, autoMode: scan.autoMode })
}

