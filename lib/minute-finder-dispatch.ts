import 'server-only'

import { getScan, saveScan, addLog } from './store'
import { getAllUserApiKeys, getUserTwelveLabsKey, getUserMinuteFinderMode } from './user-keys'
import { startMergePipeline, pipelineReady, isPipelineRunning } from './merge-pipeline'
import { startGeminiMinuteFinder, isMinuteFinderRunning, stopAndWaitMinuteFinder } from './gemini-minute-finder'
import type { MinuteFinderMode } from './types'

export interface DispatchUser {
  username: string
  role: 'admin' | 'user'
}

/**
 * SINGLE auto-trigger entry point used by the upload (short-after-movie) and
 * trim (movie-after-short) routes once both videos are in and the trim is
 * confirmed. Reads the user's `minuteFinder` toggle:
 *
 *   'gemini'     → Gemini Minute Finder (20-min windows → minute list → auto chunk scan)
 *   'twelvelabs' → the OLD merge → Marengo → Pegasus → approval flow (unchanged)
 *   'off'        → nothing; the user presses Start for a normal Full scan
 *
 * A running pipeline is never interrupted — a toggle change applies from the
 * next upload/trim. Errors are logged on the scan, never thrown to the route.
 */
export async function dispatchMinuteFinder(scanId: string, user: DispatchUser | null): Promise<MinuteFinderMode | null> {
  const scan = getScan(scanId)
  if (!scan || !pipelineReady(scan)) return null
  if (!user) return null

  const mode = await getUserMinuteFinderMode(user.username)

  if (mode === 'off') {
    addLog(scan, 'info', 'Minute finder OFF — manual Start dabao (normal Full scan)')
    saveScan(scan)
    return mode
  }

  if (mode === 'twelvelabs') {
    // ---- OLD BEHAVIOUR, verbatim: only fresh pipelines auto-start ----
    if (isPipelineRunning(scanId)) return mode
    const st = scan.mergePipeline?.status
    if (st && st !== 'idle') return mode
    const tlKey = await getUserTwelveLabsKey(user.username)
    if (!tlKey) {
      addLog(scan, 'info', 'TwelveLabs key nahi — auto merge pipeline skip, app normal flow me chalega')
      saveScan(scan)
    } else {
      startMergePipeline(scanId, tlKey)
    }
    return mode
  }

  // ---- 'gemini' ----
  const keys = await getAllUserApiKeys(user.username)
  if (keys.length === 0) {
    addLog(scan, 'warn', 'Gemini API key nahi — Minute Finder skip. Settings me key add karo ya manual Start (Full scan) dabao')
    saveScan(scan)
    return mode
  }

  if (isMinuteFinderRunning(scanId)) {
    // A new upload/trim arrived while an older run is still going — its
    // windows point at the OLD range, so stop it and start fresh once its
    // in-flight request has settled (can take up to ~2 min). Background.
    void (async () => {
      const idle = await stopAndWaitMinuteFinder(scanId, 'naya upload/trim aaya — purana run stale tha', 5 * 60_000)
      if (!idle) {
        const s = getScan(scanId)
        if (s) {
          addLog(s, 'warn', 'Purana minute finder abhi bhi band nahi hua — Auto Pipeline panel se "Start minute finder" dabao')
          saveScan(s)
        }
        return
      }
      const s = getScan(scanId)
      if (!s || !pipelineReady(s)) return
      const r = startGeminiMinuteFinder(scanId, keys, user, 'start')
      if (!r.ok && r.error) {
        const fresh = getScan(scanId)
        if (fresh) {
          addLog(fresh, 'info', `Gemini Minute Finder auto-start skip: ${r.error}`)
          saveScan(fresh)
        }
      }
    })()
    return mode
  }

  const result = startGeminiMinuteFinder(scanId, keys, user, 'start')
  if (!result.ok && result.error) {
    // "already complete for this trim" etc. — informational only.
    const fresh = getScan(scanId)
    if (fresh) {
      addLog(fresh, 'info', `Gemini Minute Finder auto-start skip: ${result.error}`)
      saveScan(fresh)
    }
  }
  return mode
}
