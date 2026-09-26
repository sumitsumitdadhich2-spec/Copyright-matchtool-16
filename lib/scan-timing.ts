import type { Scan } from './types'
import { fmtDuration } from './format'

export interface TaskTimingItem {
  id: string
  title: string
  badge: string
  description: string
  startedAt: number | null
  finishedAt: number | null
  durationMs: number
  durationFormatted: string
  pctOfTotal: number
  status: 'completed' | 'running' | 'not_run'
}

export interface ScanTimingBreakdown {
  tasks: TaskTimingItem[]
  totalMs: number
  totalFormatted: string
  hasCompletedTasks: boolean
}

export function computeScanTiming(scan: Scan | null | undefined): ScanTimingBreakdown {
  if (!scan) {
    return { tasks: [], totalMs: 0, totalFormatted: '0s', hasCompletedTasks: false }
  }

  const logs = Array.isArray(scan.logs) ? scan.logs : []

  // 1. Chunk Slicing / Video Preparation Time
  const chunkPrepStart: number | null = scan.createdAt || null
  let chunkPrepEnd: number | null = null
  const prepDoneLog = logs.find((l) => l?.msg && (l.msg.includes('Chunks prepared') || l.msg.includes('Chunking complete')))
  if (prepDoneLog) {
    chunkPrepEnd = prepDoneLog.t
  } else if (scan.startedAt && chunkPrepStart) {
    chunkPrepEnd = Math.max(chunkPrepStart, scan.startedAt)
  }
  const chunkPrepMs = (chunkPrepStart && chunkPrepEnd && chunkPrepEnd >= chunkPrepStart) ? chunkPrepEnd - chunkPrepStart : 0

  // 2. Gemini Minute Finder / Prescan Time
  let prescanStart: number | null = scan.geminiPrescan?.startedAt || null
  let prescanEnd: number | null = scan.geminiPrescan?.finishedAt || null
  if (!prescanStart) {
    const firstPrescanLog = logs.find((l) => l?.msg && (l.msg.includes('[Gemini Prescan]') || l.msg.includes('[Minute Finder]')))
    if (firstPrescanLog) prescanStart = firstPrescanLog.t
  }
  if (!prescanEnd && prescanStart) {
    const lastPrescanLog = logs.slice().reverse().find((l) => l?.msg && (l.msg.includes('Minute finder complete') || l.msg.includes('Prescan done')))
    if (lastPrescanLog) prescanEnd = lastPrescanLog.t
  }
  const prescanMs = (prescanStart && prescanEnd && prescanEnd >= prescanStart) ? prescanEnd - prescanStart : 0

  // 3. AI Parallel Chunk Mapping Scan Time
  let chunkScanStart: number | null = scan.startedAt || null
  const chunkScanEnd: number | null = scan.finishedAt || null
  if (!chunkScanStart) {
    const startLog = logs.find((l) => l?.msg && (l.msg.includes('Scan started') || l.msg.includes('Scanning minute')))
    if (startLog) chunkScanStart = startLog.t
  }
  const chunkScanMs = (scan.report?.totalScanTimeMs && scan.report.totalScanTimeMs > 0)
    ? scan.report.totalScanTimeMs
    : (chunkScanStart && chunkScanEnd && chunkScanEnd >= chunkScanStart)
    ? chunkScanEnd - chunkScanStart
    : 0

  // 4. Targeted Scene Rescan Time
  let rescanMs = 0
  const rescanLogs = logs.filter((l) => l?.msg && l.msg.includes('[Rescan Scene]'))
  if (rescanLogs.length >= 2) {
    const first = rescanLogs[0].t
    const last = rescanLogs[rescanLogs.length - 1].t
    if (last > first) rescanMs = last - first
  } else if (rescanLogs.length === 1) {
    rescanMs = 3000 // estimate ~3s per single rescan
  }

  // 5. 24 FPS Batch Verifier Time
  let verifierStart: number | null = scan.batchVerify?.startedAt || null
  let verifierEnd: number | null = scan.batchVerify?.finishedAt || null
  if (!verifierStart) {
    const vLog = logs.find((l) => l?.msg && (l.msg.includes('[Verifier]') || l.msg.includes('24fps batch verifier')))
    if (vLog) verifierStart = vLog.t
  }
  if (!verifierEnd && verifierStart) {
    const vDoneLog = logs.slice().reverse().find((l) => l?.msg && (l.msg.includes('Batch verification complete') || l.msg.includes('Verifier finished')))
    if (vDoneLog) verifierEnd = vDoneLog.t
  }
  const verifierMs = (verifierStart && verifierEnd && verifierEnd >= verifierStart) ? verifierEnd - verifierStart : 0

  // 6. Missing Scene Finder / Gap Backup Time
  let missingStart: number | null = scan.gapBackup?.startedAt || scan.missingSceneScan?.startedAt || null
  let missingEnd: number | null = scan.gapBackup?.finishedAt || scan.missingSceneScan?.finishedAt || null
  if (!missingStart) {
    const mLog = logs.find((l) => l?.msg && (l.msg.includes('[Gap Backup]') || l.msg.includes('[Missing Scene]')))
    if (mLog) missingStart = mLog.t
  }
  if (!missingEnd && missingStart) {
    const mDoneLog = logs.slice().reverse().find((l) => l?.msg && (l.msg.includes('Gap backup complete') || l.msg.includes('Missing scene scan done')))
    if (mDoneLog) missingEnd = mDoneLog.t
  }
  const missingMs = (missingStart && missingEnd && missingEnd >= missingStart) ? missingEnd - missingStart : 0

  // 7. Video Export & FFmpeg Stitching Render Time
  let renderStart: number | null = scan.renderJob?.startedAt || null
  let renderEnd: number | null = scan.renderJob?.finishedAt || null
  if (!renderStart) {
    const rLog = logs.find((l) => l?.msg && (l.msg.includes('[Render]') || l.msg.includes('FFmpeg render started')))
    if (rLog) renderStart = rLog.t
  }
  if (!renderEnd && renderStart) {
    const rDoneLog = logs.slice().reverse().find((l) => l?.msg && (l.msg.includes('Render complete') || l.msg.includes('Stitching finished')))
    if (rDoneLog) renderEnd = rDoneLog.t
  }
  let renderMs = (renderStart && renderEnd && renderEnd >= renderStart) ? renderEnd - renderStart : 0
  if (renderMs === 0 && scan.renderJob?.status === 'rendering' && renderStart) {
    renderMs = Date.now() - renderStart
  }

  // Calculate total combined time across all active tasks
  const rawTotalMs = chunkPrepMs + prescanMs + chunkScanMs + rescanMs + verifierMs + missingMs + renderMs

  // If scan finished, total wall time from creation to finish
  let wallTimeMs = 0
  if (scan.finishedAt && scan.createdAt && scan.finishedAt > scan.createdAt) {
    wallTimeMs = scan.finishedAt - scan.createdAt
    if (renderMs > 0 && scan.renderJob?.finishedAt) {
      wallTimeMs = scan.renderJob.finishedAt - scan.createdAt
    }
  }

  const totalMs = Math.max(rawTotalMs, wallTimeMs, 1000)

  const rawTasks: {
    id: string
    title: string
    badge: string
    description: string
    startedAt: number | null
    finishedAt: number | null
    durationMs: number
    status: 'completed' | 'running' | 'not_run'
  }[] = [
    {
      id: 'chunk_prep',
      title: 'Chunks Cut & Video Prep',
      badge: '✂️ Video Slicing',
      description: 'Slicing input video files into 1-minute chunks and stream copies',
      startedAt: chunkPrepStart,
      finishedAt: chunkPrepEnd,
      durationMs: chunkPrepMs,
      status: chunkPrepMs > 0 ? 'completed' : 'not_run',
    },
    {
      id: 'prescan',
      title: 'Gemini Minute Finder',
      badge: '🎯 Prescan Pass',
      description: 'Gemini 20-minute window pre-scan to locate relevant movie minutes',
      startedAt: prescanStart,
      finishedAt: prescanEnd,
      durationMs: prescanMs,
      status: prescanMs > 0 ? 'completed' : 'not_run',
    },
    {
      id: 'chunk_scan',
      title: 'AI Parallel Chunk Scan',
      badge: '🔍 Multi-Engine Scan',
      description: 'Parallel Gemini model lanes mapping short scenes to movie timestamps',
      startedAt: chunkScanStart,
      finishedAt: chunkScanEnd,
      durationMs: chunkScanMs,
      status: chunkScanMs > 0 ? 'completed' : 'not_run',
    },
    {
      id: 'rescan',
      title: 'Targeted Scene Rescan',
      badge: '🎯 Targeted Rescan',
      description: 'Re-evaluating chunk windows for scenes marked different or unverified',
      startedAt: null,
      finishedAt: null,
      durationMs: rescanMs,
      status: rescanMs > 0 ? 'completed' : 'not_run',
    },
    {
      id: 'verifier',
      title: '24 FPS Batch Verifier',
      badge: '👁️ 24fps Verification',
      description: 'Frame-precise stitched video verification across matched minutes',
      startedAt: verifierStart,
      finishedAt: verifierEnd,
      durationMs: verifierMs,
      status: verifierMs > 0 ? 'completed' : 'not_run',
    },
    {
      id: 'missing_scene',
      title: 'Missing Scene Finder',
      badge: '🔍 Gap Backup',
      description: 'Post-verification pass recovering missing/uncovered short gap scenes',
      startedAt: missingStart,
      finishedAt: missingEnd,
      durationMs: missingMs,
      status: missingMs > 0 ? 'completed' : 'not_run',
    },
    {
      id: 'export_render',
      title: 'Video Export & FFmpeg Stitching',
      badge: '🎞️ Video Export',
      description: 'FFmpeg high-speed re-encode merging all matched scenes with audio sync',
      startedAt: renderStart,
      finishedAt: renderEnd,
      durationMs: renderMs,
      status: scan.renderJob?.status === 'rendering' ? 'running' : renderMs > 0 ? 'completed' : 'not_run',
    },
  ]

  const tasks: TaskTimingItem[] = rawTasks
    .filter((t) => t.durationMs > 0 || t.status === 'running')
    .map((t) => ({
      ...t,
      durationFormatted: fmtDuration(t.durationMs),
      pctOfTotal: totalMs > 0 ? Math.min(100, Math.round((t.durationMs / totalMs) * 100)) : 0,
    }))

  return {
    tasks,
    totalMs,
    totalFormatted: fmtDuration(totalMs),
    hasCompletedTasks: tasks.length > 0,
  }
}
