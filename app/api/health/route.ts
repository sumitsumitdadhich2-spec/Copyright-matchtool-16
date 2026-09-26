import { type NextRequest, NextResponse } from 'next/server'
import fs from 'node:fs'
import os from 'node:os'
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session'
import { poolSnapshot } from '@/lib/ffmpeg-pool'
import { bootWorkDirs, ramWorkUsed } from '@/lib/work-dir'
import { diskFree } from '@/lib/media'
import { storageEnabled, storageHealthy } from '@/lib/storage'
import { DATA_DIR, WORK_DIR, WORK_RAM_BUDGET_BYTES, MAX_SCANS } from '@/lib/paths'
import { getFfmpegPathSync } from '@/lib/ffmpeg-bin'
import { UPLOAD_PROTOCOL } from '@/lib/upload-protocol'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/health — used by the Docker HEALTHCHECK and for a quick look at the
 * box: cores/engines, active ffmpeg jobs, RAM + tmpfs usage, disk free, S3.
 * Reachable without a cookie (proxy.ts allows it) so the Docker HEALTHCHECK
 * works — but the detailed payload (paths, job labels, disk numbers) is only
 * returned to a logged-in user; anonymous callers get `{ status, uptimeSec }`.
 * Returns 503 when the data dir is not writable or ffmpeg is missing — S3
 * being down only flags `degraded` (uploads/scans keep working from disk).
 */
export async function GET(request: NextRequest) {
  const authed = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value) !== null
  bootWorkDirs()
  const pool = poolSnapshot()
  const disk = diskFree()
  const mem = { total: os.totalmem(), free: os.freemem() }

  let tmpfs: { total: number; free: number } | null = null
  try {
    const st = fs.statfsSync(WORK_DIR)
    tmpfs = { total: Number(st.blocks) * Number(st.bsize), free: Number(st.bavail) * Number(st.bsize) }
  } catch {
    tmpfs = null
  }

  let dataWritable = true
  try {
    fs.accessSync(DATA_DIR, fs.constants.W_OK)
  } catch {
    dataWritable = false
  }

  let ffmpeg: string | null = null
  try {
    ffmpeg = getFfmpegPathSync()
  } catch {
    ffmpeg = null
  }

  const s3 = storageEnabled() ? await storageHealthy() : { ok: false, error: 'S3_BUCKET not set' }
  const ok = dataWritable && ffmpeg !== null
  const status = !ok ? 'error' : s3.ok ? 'ok' : 'degraded'
  const headers = { 'Cache-Control': 'no-store' }

  // `upload` tells you which uploader the running build has — after a
  // `docker compose up -d --build` it must read "stream-v2" (single stream);
  // anything else means an old image is still serving.
  if (!authed) {
    return NextResponse.json({ status, uptimeSec: Math.round(process.uptime()), upload: UPLOAD_PROTOCOL }, { status: ok ? 200 : 503, headers })
  }

  return NextResponse.json(
    {
      status,
      uptimeSec: Math.round(process.uptime()),
      upload: UPLOAD_PROTOCOL,
      cpu: { cores: pool.cores, engines: pool.engines },
      ffmpeg: { bin: ffmpeg, active: pool.active, queued: pool.queued, jobs: pool.jobs },
      ram: { totalBytes: mem.total, freeBytes: mem.free, processRssBytes: process.memoryUsage().rss },
      work: {
        dir: WORK_DIR,
        usedBytes: ramWorkUsed(),
        budgetBytes: WORK_RAM_BUDGET_BYTES,
        tmpfs,
      },
      disk: { dir: DATA_DIR, writable: dataWritable, freeBytes: disk.free, totalBytes: disk.total },
      s3: { enabled: storageEnabled(), reachable: s3.ok, error: s3.ok ? undefined : s3.error },
      limits: { maxScans: MAX_SCANS },
    },
    { status: ok ? 200 : 503, headers },
  )
}
