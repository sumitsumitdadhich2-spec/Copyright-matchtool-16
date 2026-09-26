import 'server-only'

import {
  apiKeyHash,
  getModelUsage,
  setModelExhausted,
  isModelDailyQuotaExhausted,
  geminiUsageDay,
  checkDailyReset,
} from './store'
import { pacingIntervalMs, CHUNK_COOLDOWN_MS, displayModelName } from './models'

export interface CandidateLane {
  apiKey: string
  keyIdx: number
  modelId: string
  slot?: number
  rpd?: number
}

interface LaneWaiter {
  scanId: string
  scanTitle: string
  operation: string
  resolve: (releaseFn: (actualVideoSec?: number, cooldownOverrideMs?: number) => void) => void
  reject: (err: Error) => void
  isStopping?: () => boolean
}

interface GlobalLaneState {
  laneKey: string
  keyHash: string
  keyIdx: number
  modelId: string
  slot: number
  activeScanId: string | null
  activeScanTitle: string | null
  activeOperation: string | null
  activeSince: number | null
  lastCompletedAt?: number | null
  lastOperation: string | null
  lastOperationVideoSec: number | null
  nextFreeAt: number
  cooldownUntil: number
  consecutiveQuotaErrors?: number
  isExhausted: boolean
  waiters: LaneWaiter[]
}

class GlobalGeminiCoordinator {
  private lanes = new Map<string, GlobalLaneState>()
  private currentActiveDay = geminiUsageDay()

  /** Total verifier + rescan requests currently active / in-flight across ALL scans */
  private activeVerifyRescanCount = 0
  /** Maximum simultaneous verifier + rescan requests allowed globally across all scans combined */
  private readonly MAX_GLOBAL_VERIFY_RESCAN = 3
  /** Timestamp of the last outgoing verifier/rescan dispatch across any scan */
  private lastGlobalVerifyDispatchAt = 0
  /** Minimum spacing (ms) between any two outgoing verifier/rescan dispatches across all scans */
  private readonly GLOBAL_VERIFY_DISPATCH_MIN_GAP_MS = 2000

  /**
   * Checks if an operation is a Verifier or Rescan (NOT chunk mapping).
   * Strict rule: Chunks are never throttled or delayed by verifier limits!
   */
  public isVerifyOrRescan(operation: string): boolean {
    const lower = operation.toLowerCase()
    return (
      lower.includes('verify') ||
      lower.includes('rescan') ||
      lower.includes('missing scene')
    )
  }

  /**
   * Central coordinator orchestrator for Verifier & Rescan:
   * Checks from above across ALL parallel scans if capacity and stagger gap allow dispatch right now.
   */
  public canDispatchVerifyOrRescan(
    apiKey: string,
    modelId: string,
    rpdCap: number = 500,
  ): { ok: boolean; reason?: string; waitMs?: number; cooling?: boolean } {
    this.checkDayRollover()

    // 1. Quota check against Settings data: if used < rpdCap, quota is STILL AVAILABLE!
    const used = getModelUsage(modelId, apiKey)
    if (used >= rpdCap) {
      return { ok: false, reason: `Daily quota limit reached in Settings (${used}/${rpdCap} RPD)`, waitMs: 60000 }
    }

    // 2. Specific lane busy/cooldown check
    const laneStatus = this.isLaneBusy(apiKey, modelId, 0, rpdCap)
    if (laneStatus.busy) {
      return {
        ok: false,
        reason: laneStatus.cooling ? '429 cooldown active on this model' : 'Lane busy in another scan',
        waitMs: (laneStatus.waitSec || 2) * 1000,
        cooling: laneStatus.cooling,
      }
    }

    // 3. Central global verifier/rescan concurrency limit across ALL scans
    if (this.activeVerifyRescanCount >= this.MAX_GLOBAL_VERIFY_RESCAN) {
      return {
        ok: false,
        reason: `Global verifier capacity full (${this.activeVerifyRescanCount}/${this.MAX_GLOBAL_VERIFY_RESCAN} active across all scans). Queuing...`,
        waitMs: 1500,
      }
    }

    // 4. Central global dispatch stagger gap (min 2.0s between any two outgoing dispatches)
    const now = Date.now()
    const gapNeeded = (this.lastGlobalVerifyDispatchAt + this.GLOBAL_VERIFY_DISPATCH_MIN_GAP_MS) - now
    if (gapNeeded > 0) {
      return {
        ok: false,
        reason: `Global verifier dispatch stagger (${Math.ceil(gapNeeded / 1000)}s gap)...`,
        waitMs: gapNeeded,
      }
    }

    return { ok: true }
  }

  /**
   * Checks if the date has rolled over (midnight Pacific Time).
   * Automatically clears all exhaustion flags across all lanes so the new day's quota is instantly active!
   */
  public checkDayRollover(): boolean {
    const today = geminiUsageDay()
    if (today !== this.currentActiveDay) {
      console.log(`[Global Coordinator] Daily quota rollover detected (${this.currentActiveDay} -> ${today}). Resetting all lane exhaustion flags!`)
      this.currentActiveDay = today
      for (const lane of this.lanes.values()) {
        lane.isExhausted = false
        lane.cooldownUntil = 0
      }
      checkDailyReset()
      return true
    }
    return false
  }

  /**
   * Instant, zero-wait quota check against Settings data:
   * Verifies if a model on a given API key has exhausted its daily quota (RPD).
   * CRITICAL: If getModelUsage < rpdCap, quota is STILL AVAILABLE in Settings!
   * Never marks exhausted prematurely!
   */
  public isModelExhausted(apiKey: string, modelId: string, rpdCap: number = 500): boolean {
    this.checkDayRollover()
    const used = getModelUsage(modelId, apiKey)
    if (used < rpdCap) {
      const lane = this.getOrCreateLane(apiKey, modelId, 0)
      lane.isExhausted = false
      return false
    }
    const lane = this.getOrCreateLane(apiKey, modelId, 0)
    lane.isExhausted = true
    return true
  }

  private getLaneKey(apiKey: string, modelId: string): string {
    // Quotas and rate limits (RPM / TPM) in Google Gemini are strictly per (API Key × Model).
    // All requests for the same (apiKey, modelId) must coordinate through the exact same exclusive lane
    // so parallel scans, verifiers, rescans and chunk workers never collide on the same model.
    return `${apiKeyHash(apiKey)}:${modelId}`
  }

  private getOrCreateLane(apiKey: string, modelId: string, slot: number = 0, keyIdx: number = 1): GlobalLaneState {
    const key = this.getLaneKey(apiKey, modelId, slot)
    let lane = this.lanes.get(key)
    if (!lane) {
      lane = {
        laneKey: key,
        keyHash: apiKeyHash(apiKey),
        keyIdx,
        modelId,
        slot,
        activeScanId: null,
        activeScanTitle: null,
        activeOperation: null,
        activeSince: null,
        lastCompletedAt: null,
        lastOperation: null,
        lastOperationVideoSec: null,
        nextFreeAt: 0,
        cooldownUntil: 0,
        isExhausted: false,
        waiters: [],
      }
      this.lanes.set(key, lane)
    }
    if (keyIdx > 0) lane.keyIdx = keyIdx
    return lane
  }

  /** Check if a lane is currently in use by ANY scan, in cooldown/pacing, or exhausted */
  public isLaneBusy(apiKey: string, modelId: string, slot: number = 0, rpdCap: number = 500): {
    busy: boolean
    exhausted?: boolean
    activeScanId?: string
    activeScanTitle?: string
    activeOperation?: string
    waitSec?: number
    cooling?: boolean
  } {
    this.checkDayRollover()
    const lane = this.getOrCreateLane(apiKey, modelId, slot)
    const now = Date.now()

    if (lane.isExhausted || isModelDailyQuotaExhausted(modelId, apiKey, rpdCap)) {
      lane.isExhausted = true
      return {
        busy: true,
        exhausted: true,
        activeOperation: 'Exhausted for today',
      }
    }

    if (lane.activeScanId) {
      return {
        busy: true,
        activeScanId: lane.activeScanId,
        activeScanTitle: lane.activeScanTitle || undefined,
        activeOperation: lane.activeOperation || undefined,
      }
    }

    if (lane.cooldownUntil > now) {
      return {
        busy: true,
        cooling: true,
        waitSec: Math.ceil((lane.cooldownUntil - now) / 1000),
      }
    }

    if (lane.nextFreeAt > now) {
      return {
        busy: true,
        waitSec: Math.ceil((lane.nextFreeAt - now) / 1000),
      }
    }

    return { busy: false }
  }

  /**
   * Check if an API key has any active lanes currently executing in another scan.
   * Useful for load-balancing parallel scans so that each scan prefers idle keys.
   */
  public isKeyActiveInOtherScan(apiKey: string, currentScanId: string): boolean {
    const hash = apiKeyHash(apiKey)
    for (const lane of this.lanes.values()) {
      if (lane.keyHash === hash && lane.activeScanId !== null && lane.activeScanId !== currentScanId) {
        return true
      }
    }
    return false
  }

  /**
   * Reset all in-memory lane exhaustion and cooldown flags.
   * Called when user manually resets daily counters via Settings.
   */
  public resetAllLanes(): void {
    for (const lane of this.lanes.values()) {
      lane.isExhausted = false
      lane.cooldownUntil = 0
      lane.nextFreeAt = 0
    }
    console.log('[Global Coordinator] All lane exhaustion and cooldown states reset.')
  }

  /**
   * Acquire an exclusive lock on a (Key × Model × Slot) lane across ALL scans in the entire application.
   * If another scan is using the lane or if the lane is in TPM pacing / 429 cooldown,
   * this will wait and yield gracefully without triggering duplicate requests or 429 collisions.
   */
  public async acquireLane(opts: {
    scanId: string
    scanTitle?: string
    apiKey: string
    keyIdx?: number
    modelId: string
    slot?: number
    operation: string
    videoSeconds?: number
    rpd?: number
    onWait?: (msg: string, waitSec: number) => void
    isStopping?: () => boolean
  }): Promise<(actualVideoSec?: number) => void> {
    const {
      scanId,
      scanTitle = scanId,
      apiKey,
      keyIdx = 1,
      modelId,
      slot = 0,
      operation,
      videoSeconds = 60,
      rpd = 500,
      onWait,
      isStopping,
    } = opts

    this.checkDayRollover()
    const lane = this.getOrCreateLane(apiKey, modelId, slot, keyIdx)

    // Pre-flight quota check: if daily quota is already exhausted, abort immediately without waiting or uploading!
    if (this.isModelExhausted(apiKey, modelId, rpd)) {
      lane.isExhausted = true
      throw new Error(`[Global Coordinator] Key ${keyIdx} (${modelId}) daily quota (${rpd} RPD) is exhausted for today. Skipping immediately.`)
    }

    return new Promise<(actualVideoSec?: number, cooldownOverrideMs?: number) => void>((resolve, reject) => {
      const tryAcquireOrQueue = async () => {
        if (isStopping && isStopping()) {
          reject(new Error('Stop requested — lane acquisition cancelled'))
          return
        }

        if (this.isModelExhausted(apiKey, modelId, rpd)) {
          lane.isExhausted = true
          reject(new Error(`[Global Coordinator] Key ${keyIdx} (${modelId}) daily quota (${rpd} RPD) is exhausted for today. Skipping immediately.`))
          return
        }

        const now = Date.now()

        // If lane is currently active in another scan OR there are earlier waiters queued
        const hasOtherActive = lane.activeScanId !== null
        const isQueuedBehindOthers = lane.waiters.length > 0 && lane.waiters[0]?.scanId !== scanId

        if (hasOtherActive || isQueuedBehindOthers) {
          const waitMsg = hasOtherActive
            ? `[Global Coordinator] Key ${lane.keyIdx} · ${modelId} is busy in Scan "${lane.activeScanTitle || lane.activeScanId}" (${lane.activeOperation || 'working'}). Waiting for lane to become free...`
            : `[Global Coordinator] Key ${lane.keyIdx} · ${modelId} is queued behind other scans. Waiting turn...`

          onWait?.(waitMsg, 5)

          lane.waiters.push({
            scanId,
            scanTitle,
            operation,
            resolve: (releaseFn) => resolve(releaseFn),
            reject,
            isStopping,
          })
          return
        }

        // Check 429 Cooldown
        if (lane.cooldownUntil > now) {
          const waitMs = lane.cooldownUntil - now
          const waitSec = Math.ceil(waitMs / 1000)
          onWait?.(
            `[Global Coordinator] Key ${lane.keyIdx} · ${displayModelName(modelId)} is in 429 rate cooldown (${waitSec}s remaining). Waiting for rate limit reset...`,
            waitSec,
          )

          setTimeout(() => {
            if (isStopping && isStopping()) {
              reject(new Error('Stop requested during cooldown'))
              return
            }
            void this.processNext(lane)
          }, waitMs + 50)

          lane.waiters.push({
            scanId,
            scanTitle,
            operation,
            resolve: (releaseFn) => resolve(releaseFn),
            reject,
            isStopping,
          })
          return
        }

        // Check TPM pacing interval
        if (lane.nextFreeAt > now) {
          const waitMs = lane.nextFreeAt - now
          const waitSec = Math.ceil(waitMs / 1000)
          onWait?.(
            `[Global Coordinator] Key ${lane.keyIdx} · ${modelId} pacing wait (${waitSec}s for TPM quota). Pacing request...`,
            waitSec,
          )

          setTimeout(() => {
            if (isStopping && isStopping()) {
              reject(new Error('Stop requested during pacing wait'))
              return
            }
            void this.processNext(lane)
          }, waitMs + 20)

          lane.waiters.push({
            scanId,
            scanTitle,
            operation,
            resolve: (releaseFn) => resolve(releaseFn),
            reject,
            isStopping,
          })
          return
        }

        // Lock is free! Acquire exclusively now.
        const isVerRes = this.isVerifyOrRescan(operation)
        if (isVerRes) {
          // Check central global verifier/rescan concurrency cap across all scans
          if (this.activeVerifyRescanCount >= this.MAX_GLOBAL_VERIFY_RESCAN) {
            onWait?.(`[Global Coordinator] Global verifier/rescan capacity full (${this.activeVerifyRescanCount}/${this.MAX_GLOBAL_VERIFY_RESCAN} active across all scans). Queued...`, 2)
            lane.waiters.push({
              scanId,
              scanTitle,
              operation,
              resolve: (releaseFn) => resolve(releaseFn),
              reject,
              isStopping,
            })
            const staggerWait = 1000 + Math.floor(Math.random() * 800)
            setTimeout(() => {
              void this.processNext(lane)
            }, staggerWait)
            return
          }

          // Check central global dispatch stagger gap (min 2.0s between any two outgoing verifier/rescan dispatches across all scans)
          const nowMs = Date.now()
          const gapNeeded = (this.lastGlobalVerifyDispatchAt + this.GLOBAL_VERIFY_DISPATCH_MIN_GAP_MS) - nowMs
          if (gapNeeded > 0) {
            onWait?.(`[Global Coordinator] Staggering verifier dispatch (~${Math.ceil(gapNeeded / 1000)}s gap)...`, 1)
            await new Promise((r) => setTimeout(r, gapNeeded + Math.floor(Math.random() * 300)))
          }

          this.activeVerifyRescanCount++
          this.lastGlobalVerifyDispatchAt = Date.now()
        }

        lane.activeScanId = scanId
        lane.activeScanTitle = scanTitle
        lane.activeOperation = operation
        lane.activeSince = Date.now()

        const releaseFn = (actualVideoSec?: number, cooldownOverrideMs?: number) => {
          this.releaseLane(lane, actualVideoSec ?? videoSeconds, cooldownOverrideMs)
        }

        resolve(releaseFn)
      }

      void tryAcquireOrQueue()
    })
  }

  /**
   * Dynamically search across multiple candidate lanes (different API keys and/or models).
   * 1. If any candidate lane is immediately free (not in use, not cooling, not pacing, not exhausted),
   *    grab that free lane instantly with ZERO wait!
   * 2. If all candidate lanes are busy, poll/re-evaluate EVERY 1 SECOND across ALL candidates.
   *    As soon as ANY lane (e.g. Key 3 · 3.8, or Key 2 · 3.6) frees up first,
   *    immediately shift to that newly freed lane and acquire it!
   */
  public async acquireFirstAvailableLane(opts: {
    scanId: string
    scanTitle?: string
    candidates: CandidateLane[]
    operation: string
    videoSeconds?: number
    onWait?: (msg: string, waitSec: number, candidateSummary: string) => void
    isStopping?: () => boolean
  }): Promise<{
    selected: CandidateLane
    release: (actualVideoSec?: number, cooldownOverrideMs?: number) => void
  }> {
    const {
      scanId,
      scanTitle = scanId,
      candidates,
      operation,
      videoSeconds = 60,
      onWait,
      isStopping,
    } = opts

    if (!candidates || candidates.length === 0) {
      throw new Error('No candidate lanes provided for execution')
    }

    const isVerRes = this.isVerifyOrRescan(operation)
    let lastLoggedWaitMsg = ''

    while (true) {
      if (isStopping && isStopping()) {
        throw new Error('Stop requested — lane acquisition cancelled')
      }

      const now = Date.now()

      this.checkDayRollover()

      // 1. Filter out permanently exhausted / disabled lanes using Settings data
      const availableCandidates = candidates.filter((c) => {
        return !this.isModelExhausted(c.apiKey, c.modelId, c.rpd || 500)
      })

      if (availableCandidates.length === 0) {
        throw new Error('All candidate keys/models have reached their daily quota or are exhausted')
      }

      // If this is a verifier/rescan operation and global verifier capacity is full across all scans:
      if (isVerRes && this.activeVerifyRescanCount >= this.MAX_GLOBAL_VERIFY_RESCAN) {
        const fullMsg = `[Global Coordinator] Global verifier/rescan capacity full (${this.activeVerifyRescanCount}/${this.MAX_GLOBAL_VERIFY_RESCAN} active). Pacing parallel scans...`
        if (fullMsg !== lastLoggedWaitMsg) {
          lastLoggedWaitMsg = fullMsg
          onWait?.(fullMsg, 2, 'all scans')
        }
        const jitterMs = 1200 + Math.floor(Math.random() * 600)
        await new Promise((r) => setTimeout(r, jitterMs))
        continue
      }

      // Sort candidates to prioritize same-key multi-model usage before switching keys:
      // Group by keyIdx ascending, and test available models on the current key first
      const sortedCandidates = [...availableCandidates].sort((a, b) => {
        if (a.keyIdx !== b.keyIdx) return a.keyIdx - b.keyIdx
        const aUsage = getModelUsage(a.modelId, a.apiKey)
        const bUsage = getModelUsage(b.modelId, b.apiKey)
        return aUsage - bUsage
      })

      // 2. Check for immediately FREE lanes (no active scan, no cooldown, no pacing wait, no waiters)
      for (const cand of sortedCandidates) {
        const lane = this.getOrCreateLane(cand.apiKey, cand.modelId, cand.slot || 0, cand.keyIdx)
        const isFree =
          lane.activeScanId === null &&
          lane.cooldownUntil <= now &&
          lane.nextFreeAt <= now &&
          lane.waiters.length === 0

        if (isFree) {
          if (isVerRes) {
            // Enforce central global dispatch stagger gap (min 2.0s between outgoing verifier dispatches)
            const nowMs = Date.now()
            const gapNeeded = (this.lastGlobalVerifyDispatchAt + this.GLOBAL_VERIFY_DISPATCH_MIN_GAP_MS) - nowMs
            if (gapNeeded > 0) {
              onWait?.(`[Global Coordinator] Staggering verifier dispatch (~${Math.ceil(gapNeeded / 1000)}s gap)...`, 1, `Key ${cand.keyIdx}`)
              await new Promise((r) => setTimeout(r, gapNeeded + Math.floor(Math.random() * 300)))
            }
            this.activeVerifyRescanCount++
            this.lastGlobalVerifyDispatchAt = Date.now()
          }

          // Immediately grab this free lane!
          lane.activeScanId = scanId
          lane.activeScanTitle = scanTitle
          lane.activeOperation = operation
          lane.activeSince = Date.now()

          const release = (actualVideoSec?: number, cooldownOverrideMs?: number) => {
            this.releaseLane(lane, actualVideoSec ?? videoSeconds, cooldownOverrideMs)
          }

          return { selected: cand, release }
        }
      }

      // 3. None are immediately free. Calculate estimated shortest wait time across all candidate lanes
      const waits = sortedCandidates.map((c) => {
        const lane = this.getOrCreateLane(c.apiKey, c.modelId, c.slot || 0, c.keyIdx)
        const cdWait = Math.max(0, lane.cooldownUntil - now)
        const paceWait = Math.max(0, lane.nextFreeAt - now)
        const activeWait = lane.activeScanId ? 4000 : 0
        const totalWait = Math.max(cdWait, paceWait, activeWait)
        return { c, lane, totalWait }
      })

      waits.sort((a, b) => a.totalWait - b.totalWait)
      const shortest = waits[0]
      const waitSec = Math.max(1, Math.ceil(shortest.totalWait / 1000))

      const candidateSummary = availableCandidates
        .map((c) => `Key ${c.keyIdx} (${c.modelId})`)
        .slice(0, 4)
        .join(', ')

      const waitMsg = `[Global Coordinator] All candidate lanes busy (${candidateSummary}${availableCandidates.length > 4 ? '...' : ''}). Re-checking every 1s for the first available lane (next free ~${waitSec}s)...`

      if (waitMsg !== lastLoggedWaitMsg) {
        lastLoggedWaitMsg = waitMsg
        onWait?.(waitMsg, waitSec, candidateSummary)
      }

      // 4. Sleep with jitter (1000ms - 1500ms) so parallel scans/workers do not wake at the exact same millisecond after cooldown!
      const jitterMs = 1000 + Math.floor(Math.random() * 500)
      await new Promise((r) => setTimeout(r, jitterMs))
    }
  }

  private releaseLane(lane: GlobalLaneState, videoSeconds: number, cooldownOverrideMs?: number) {
    const op = lane.activeOperation || lane.lastOperation || ''
    if (this.isVerifyOrRescan(op)) {
      this.activeVerifyRescanCount = Math.max(0, this.activeVerifyRescanCount - 1)
      this.lastGlobalVerifyDispatchAt = Date.now()
    }

    const paceMs = cooldownOverrideMs !== undefined
      ? cooldownOverrideMs
      : (videoSeconds >= 50 ? CHUNK_COOLDOWN_MS : pacingIntervalMs(videoSeconds, lane.modelId))
    const now = Date.now()
    lane.lastCompletedAt = now
    lane.nextFreeAt = Math.max(lane.nextFreeAt, now + paceMs)
    lane.cooldownUntil = Math.max(lane.cooldownUntil, now + paceMs)
    lane.lastOperation = lane.activeOperation
    lane.lastOperationVideoSec = videoSeconds
    lane.activeScanId = null
    lane.activeScanTitle = null
    lane.activeOperation = null
    lane.activeSince = null

    // Process next waiter in queue after pacing expires (or schedule it) with staggered jitter
    if (lane.waiters.length > 0) {
      const staggerJitterMs = 50 + Math.floor(Math.random() * 250)
      setTimeout(() => {
        void this.processNext(lane)
      }, paceMs + staggerJitterMs)
    }
  }

  private async processNext(lane: GlobalLaneState) {
    if (lane.activeScanId !== null) return // still busy

    while (lane.waiters.length > 0) {
      const next = lane.waiters.shift()
      if (!next) break

      if (next.isStopping && next.isStopping()) {
        next.reject(new Error('Stop requested while queued'))
        continue
      }

      const now = Date.now()
      if (lane.cooldownUntil > now) {
        // Still in cooldown, put back and wait
        lane.waiters.unshift(next)
        const waitMs = lane.cooldownUntil - now
        const staggerJitterMs = 50 + Math.floor(Math.random() * 300)
        setTimeout(() => {
          void this.processNext(lane)
        }, waitMs + staggerJitterMs)
        return
      }

      if (lane.nextFreeAt > now) {
        // Still in pacing interval, put back and wait
        lane.waiters.unshift(next)
        const waitMs = lane.nextFreeAt - now
        const staggerJitterMs = 20 + Math.floor(Math.random() * 200)
        setTimeout(() => {
          void this.processNext(lane)
        }, waitMs + staggerJitterMs)
        return
      }

      // Lane is free to take
      lane.activeScanId = next.scanId
      lane.activeScanTitle = next.scanTitle
      lane.activeOperation = next.operation
      lane.activeSince = Date.now()

      const releaseFn = (actualVideoSec?: number, cooldownOverrideMs?: number) => {
        this.releaseLane(lane, actualVideoSec ?? 60, cooldownOverrideMs)
      }

      next.resolve(releaseFn)
      return
    }
  }

  /** Record successful request on this lane — resets consecutive error counters */
  public recordSuccess(apiKey: string, modelId: string, slot: number = 0) {
    const lane = this.getOrCreateLane(apiKey, modelId, slot)
    lane.consecutiveQuotaErrors = 0
  }

  /** Report a 429 Rate Limit error on a lane across the entire app with randomized stagger */
  public reportRateLimit(apiKey: string, modelId: string, cooldownMs: number = CHUNK_COOLDOWN_MS, slot: number = 0) {
    const kh = apiKeyHash(apiKey)
    const now = Date.now()
    // Staggered cooldown: add 0-8 seconds random spread so multiple rate-limited lanes never expire together!
    const jitterCooldown = cooldownMs + Math.floor(Math.random() * 8000)
    const lane = this.getOrCreateLane(apiKey, modelId, slot)
    lane.cooldownUntil = Math.max(lane.cooldownUntil, now + jitterCooldown)
    lane.nextFreeAt = Math.max(lane.nextFreeAt, now + jitterCooldown)

    // Cooldown only slots for THIS specific model on this API key.
    // Each model has its own independent 250k TPM and 15 RPM quota!
    for (const other of this.lanes.values()) {
      if (other.keyHash === kh && other.modelId === modelId) {
        other.cooldownUntil = Math.max(other.cooldownUntil, now + jitterCooldown)
        other.nextFreeAt = Math.max(other.nextFreeAt, now + jitterCooldown)
      }
    }
  }

  /**
   * Smart Quota/Rate Limit handler according to user rules:
   * 1. Check Settings where usage data is stored!
   *    If actual used < rpdCap, quota is STILL AVAILABLE today! NEVER mark as exhausted!
   * 2. Apply a randomized cooldown (70s - 78s) on that model so parallel scans don't wake up all at once.
   * 3. Only mark definitively exhausted if real tracked usage has actually reached the daily cap (used >= rpdCap).
   */
  public handleQuotaOrRateError(
    apiKey: string,
    modelId: string,
    slot: number = 0,
    rpdCap: number = 20,
    isExplicitDailyMsg: boolean = false,
  ): {
    action: 'cooldown' | 'exhausted'
    waitSec: number
    reason: string
  } {
    this.checkDayRollover()
    const lane = this.getOrCreateLane(apiKey, modelId, slot)
    const used = getModelUsage(modelId, apiKey)

    // 1. Genuine daily exhaustion: only if actual recorded usage in Settings has reached or exceeded rpdCap!
    if (used >= rpdCap) {
      this.reportExhausted(apiKey, modelId, slot, rpdCap)
      return {
        action: 'exhausted',
        waitSec: 0,
        reason: `Daily quota limit reached in Settings (${used}/${rpdCap} RPD) on ${modelId} (Key ${lane.keyIdx})`,
      }
    }

    lane.consecutiveQuotaErrors = (lane.consecutiveQuotaErrors || 0) + 1

    // 2. CRITICAL USER RULE:
    // If usage in Settings is below rpdCap, quota is STILL REMAINING for today!
    // NEVER mark as exhausted for the day after 2 requests/errors!
    // Put ONLY this model in 70s-78s cooldown and allow retry when cooled down!
    if (used < rpdCap && !isExplicitDailyMsg) {
      lane.isExhausted = false
      const jitterCooldownMs = CHUNK_COOLDOWN_MS + Math.floor(Math.random() * 8000)
      this.reportRateLimit(apiKey, modelId, jitterCooldownMs, slot)
      return {
        action: 'cooldown',
        waitSec: Math.ceil(jitterCooldownMs / 1000),
        reason: `Temporary rate limit (429) on ${modelId} (Key ${lane.keyIdx}). Quota remaining in Settings (${used}/${rpdCap} RPD) — cooling down for ${Math.ceil(jitterCooldownMs / 1000)}s before retry`,
      }
    }

    // 3. Explicit daily quota message from Google AND usage is near cap (>= rpdCap - 1)
    if (isExplicitDailyMsg && used >= Math.max(1, rpdCap - 1)) {
      this.reportExhausted(apiKey, modelId, slot, rpdCap)
      return {
        action: 'exhausted',
        waitSec: 0,
        reason: `Daily quota confirmed exhausted on ${modelId} (Key ${lane.keyIdx}) (${used}/${rpdCap} RPD)`,
      }
    }

    // 4. Fallback: quota is still remaining in Settings! Do not exhaust!
    lane.isExhausted = false
    const fallbackCooldownMs = CHUNK_COOLDOWN_MS + Math.floor(Math.random() * 8000)
    this.reportRateLimit(apiKey, modelId, fallbackCooldownMs, slot)
    return {
      action: 'cooldown',
      waitSec: Math.ceil(fallbackCooldownMs / 1000),
      reason: `Rate limit on ${modelId} (Key ${lane.keyIdx}). Quota remaining in Settings (${used}/${rpdCap} RPD) — cooling down for ${Math.ceil(fallbackCooldownMs / 1000)}s before retry`,
    }
  }

  /** Report that a model's daily quota has been exhausted across the entire app */
  public reportExhausted(apiKey: string, modelId: string, slot: number = 0, rpdCap: number = 20) {
    const used = getModelUsage(modelId, apiKey)
    if (used < rpdCap) {
      // Quota is still available in Settings! Refuse to mark exhausted!
      const lane = this.getOrCreateLane(apiKey, modelId, slot)
      lane.isExhausted = false
      return
    }

    const kh = apiKeyHash(apiKey)
    const lane = this.getOrCreateLane(apiKey, modelId, slot)
    lane.isExhausted = true

    // Mark ALL slots for this model on this API key as exhausted!
    for (const other of this.lanes.values()) {
      if (other.keyHash === kh && other.modelId === modelId) {
        other.isExhausted = true
        // Reject all queued waiters on this exhausted lane immediately with an error so they don't wait forever!
        while (other.waiters.length > 0) {
          const waiter = other.waiters.shift()
          if (waiter) {
            waiter.reject(new Error(`[Global Coordinator] Key ${other.keyIdx} (${modelId}) daily quota (${rpdCap} RPD) exhausted`))
          }
        }
      }
    }

    // Persist to counters.json so subsequent workers/processes know this model is quota-capped today
    try {
      setModelExhausted(modelId, apiKey, rpdCap)
    } catch {}
  }

  /** Get snapshot summary of all active/busy lanes across the application */
  public getSnapshot(): Array<{
    laneKey: string
    keyIdx: number
    modelId: string
    activeScanId: string | null
    activeScanTitle: string | null
    activeOperation: string | null
    waitingCount: number
    cooling: boolean
    pacingWaitSec: number
  }> {
    const now = Date.now()
    return Array.from(this.lanes.values()).map((l) => ({
      laneKey: l.laneKey,
      keyIdx: l.keyIdx,
      modelId: l.modelId,
      activeScanId: l.activeScanId,
      activeScanTitle: l.activeScanTitle,
      activeOperation: l.activeOperation,
      waitingCount: l.waiters.length,
      cooling: l.cooldownUntil > now,
      pacingWaitSec: Math.max(0, Math.ceil((Math.max(l.nextFreeAt, l.cooldownUntil) - now) / 1000)),
    }))
  }
}

// Global Singleton instance shared across the entire Node.js server process
const globalCoordinatorKey = Symbol.for('__global_gemini_coordinator__')
const globalObj = globalThis as unknown as { [globalCoordinatorKey]?: GlobalGeminiCoordinator }

if (!globalObj[globalCoordinatorKey]) {
  globalObj[globalCoordinatorKey] = new GlobalGeminiCoordinator()
}

export const globalGeminiCoordinator = globalObj[globalCoordinatorKey]!
