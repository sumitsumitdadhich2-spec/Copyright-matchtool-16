import 'server-only'

import { getScan, listScans, saveScan } from './store'
import { scheduler } from './scheduler'
import { getAllUserApiKeys, getUserTwelveLabsKey } from './user-keys'
import type { Scan } from './types'

export const MAX_BACKGROUND_SCANS_PER_USER = 10
const MAX_ACTIVE_BACKGROUND_WORKERS = 10
const POLL_MS = 1500

type QueueState = NonNullable<Scan['background']>['state']

let pumpRunning = false
let recoveryStarted = false
const activeWorkers = new Set<string>()

function isQueued(scan: Scan) {
  return scan.background?.state === 'queued' || scan.background?.state === 'running'
}

function ownerScans(username: string) {
  return listScans()
    .map((summary) => getScan(summary.id))
    .filter((scan): scan is Scan => scan !== null && scan.ownerUsername === username && isQueued(scan))
}

function setState(scan: Scan, state: QueueState, error?: string) {
  const previous = scan.background || { enqueuedAt: Date.now(), state }
  scan.background = {
    ...previous,
    state,
    error: error || null,
    position: state === 'queued' ? previous.position : undefined,
    startedAt: state === 'running' ? Date.now() : previous.startedAt,
  }
  saveScan(scan)
}

function refreshPositions() {
  const queued = listScans()
    .map((summary) => getScan(summary.id))
    .filter((scan): scan is Scan => scan !== null && scan.background?.state === 'queued')
    .sort((a, b) => (a.background?.enqueuedAt || 0) - (b.background?.enqueuedAt || 0))

  const positions = new Map<string, number>()
  queued.forEach((scan, index) => positions.set(scan.id, index + 1))
  for (const scan of queued) {
    if (scan.background && scan.background.position !== positions.get(scan.id)) {
      scan.background = { ...scan.background, position: positions.get(scan.id) }
      saveScan(scan)
    }
  }
}

async function runWorker(scanId: string) {
  const scan = getScan(scanId)
  if (!scan || !scan.ownerUsername || activeWorkers.has(scanId)) return
  activeWorkers.add(scanId)
  setState(scan, 'running')

  try {
    const keys = await getAllUserApiKeys(scan.ownerUsername)
    if (keys.length === 0) throw new Error('No Gemini API key configured for this account.')
    const tlKey = await getUserTwelveLabsKey(scan.ownerUsername)
    const result = await scheduler.start(scanId, Boolean(scan.background?.resume), keys, tlKey)
    if (!result.ok) throw new Error(result.error || 'Could not start background scan')

    while (scheduler.isRunning(scanId)) await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    const finished = getScan(scanId)
    if (finished?.status === 'error') setState(finished, 'error', finished.error || 'Background scan failed')
    else if (finished && finished.status !== 'stopped') setState(finished, 'done')
    else if (finished) setState(finished, 'stopped')
  } catch (error) {
    const failed = getScan(scanId)
    if (failed) {
      failed.status = 'error'
      failed.error = error instanceof Error ? error.message : String(error)
      setState(failed, 'error', failed.error)
    }
  } finally {
    activeWorkers.delete(scanId)
  }
}

async function pump() {
  if (pumpRunning) return
  pumpRunning = true
  try {
    while (activeWorkers.size < MAX_ACTIVE_BACKGROUND_WORKERS) {
      refreshPositions()
      const activeByOwner = new Map<string, number>()
      for (const activeId of activeWorkers) {
        const owner = getScan(activeId)?.ownerUsername
        if (owner) activeByOwner.set(owner, (activeByOwner.get(owner) || 0) + 1)
      }
      const candidates = listScans()
        .map((summary) => getScan(summary.id))
        .filter((scan): scan is Scan => scan !== null && scan.background?.state === 'queued' && !activeWorkers.has(scan.id))
        .sort((a, b) => {
          const activeDifference = (activeByOwner.get(a.ownerUsername || '') || 0) - (activeByOwner.get(b.ownerUsername || '') || 0)
          return activeDifference || (a.background?.enqueuedAt || 0) - (b.background?.enqueuedAt || 0)
        })
      const next = candidates[0]
      if (!next) break
      void runWorker(next.id).finally(() => void pump())
    }
  } finally {
    pumpRunning = false
  }
}

export async function ensureBackgroundWorkers() {
  if (!recoveryStarted) {
    recoveryStarted = true
    for (const summary of listScans()) {
      const scan = getScan(summary.id)
      if (scan?.background?.state === 'running' && !scheduler.isRunning(scan.id)) {
        scan.background = { ...scan.background, state: 'queued', position: undefined, resume: true }
        saveScan(scan)
      }
    }
  }
  await pump()
}

export async function enqueueBackgroundScan(scanId: string, username: string, resume: boolean) {
  const scan = getScan(scanId)
  if (!scan) return { ok: false as const, error: 'Scan not found' }
  const current = ownerScans(username)
  if (scan.ownerUsername && scan.ownerUsername !== username) return { ok: false as const, error: 'This scan belongs to another user.' }
  if (activeWorkers.has(scanId) || scheduler.isRunning(scanId)) return { ok: false as const, error: 'Scan is already running.' }
  if (scan.background?.state === 'queued') return { ok: false as const, error: 'Scan is already queued.' }
  if (current.length >= MAX_BACKGROUND_SCANS_PER_USER && !isQueued(scan)) {
    return { ok: false as const, error: `Maximum ${MAX_BACKGROUND_SCANS_PER_USER} background scans per user reached. Wait for one to finish.` }
  }
  scan.ownerUsername = username
  scan.background = {
    ...(scan.background || {}),
    state: 'queued',
    enqueuedAt: Date.now(),
    position: undefined,
    error: null,
    resume,
  }
  saveScan(scan)
  await ensureBackgroundWorkers()
  return { ok: true as const }
}

export async function stopBackgroundScan(scanId: string) {
  const scan = getScan(scanId)
  if (scan?.background?.state !== 'queued') return false
  if (activeWorkers.has(scanId)) return false
  scan.background = { ...scan.background, state: 'stopped', error: null, position: undefined }
  saveScan(scan)
  return true
}

export function backgroundWorkerCount() {
  return activeWorkers.size
}
