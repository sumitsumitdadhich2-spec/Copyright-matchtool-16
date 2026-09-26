import { NextResponse } from 'next/server'
import { listScans, newScan, saveScan, pruneOldScans, deleteScan, MAX_SCANS, SCANS_DIR } from '@/lib/store'
import { restoreScans } from '@/lib/scan-store'
import { getStorageUsage, invalidateUsageCache, STORAGE_LIMIT_BYTES } from '@/lib/media'
import { getSession } from '@/lib/users'
import { ensureBackgroundWorkers, stopBackgroundScan, MAX_BACKGROUND_SCANS_PER_USER } from '@/lib/background-queue'
import { scheduler } from '@/lib/scheduler'
import { isMinuteFinderRunning, stopGeminiMinuteFinder } from '@/lib/gemini-minute-finder'
import { cancelRender } from '@/lib/render'
import { getUserVerifierEnabled, getUserAutoMode } from '@/lib/user-keys'

export const runtime = 'nodejs'

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await restoreScans(SCANS_DIR)
  await ensureBackgroundWorkers()
  const used = await getStorageUsage()
  const scans = listScans().filter((scan) => session.role === 'admin' || scan.ownerUsername === session.username)
  return NextResponse.json({ scans, storage: { used, limit: STORAGE_LIMIT_BYTES }, backgroundLimit: MAX_BACKGROUND_SCANS_PER_USER })
}

export async function POST() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await restoreScans(SCANS_DIR)
  const scan = newScan(session.username)
  if (session.username) {
    try {
      scan.verifierEnabled = await getUserVerifierEnabled(session.username)
      scan.autoMode = await getUserAutoMode(session.username)
      saveScan(scan)
    } catch {}
  }
  // Keep at most MAX_SCANS scans: creating one more removes the oldest one
  // (its JSON record, its local video files, and its S3 backup).
  const deleted = pruneOldScans(MAX_SCANS)
  return NextResponse.json({ id: scan.id, deleted, maxScans: MAX_SCANS })
}

/** Delete all scans for current user (videos, work dirs, and remote backups). */
export async function DELETE() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await restoreScans(SCANS_DIR)
  const scans = listScans().filter((scan) => session.role === 'admin' || scan.ownerUsername === session.username)
  for (const s of scans) {
    await stopBackgroundScan(s.id)
    if (scheduler.isRunning(s.id)) scheduler.stop(s.id)
    if (isMinuteFinderRunning(s.id)) stopGeminiMinuteFinder(s.id)
    cancelRender(s.id)
    deleteScan(s.id)
  }
  invalidateUsageCache()
  return NextResponse.json({ ok: true, deletedCount: scans.length })
}

