import 'server-only'

import {
  apiKeyHash,
  getModelUsage,
  setModelExhausted,
  clearModelExhausted,
  isModelDailyQuotaExhausted,
  geminiUsageDay,
  checkDailyReset,
} from './store'
import { pacingIntervalMs, CHUNK_COOLDOWN_MS, displayModelName, getModelDailyCap } from './models'

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

interface VerifierTicket {
  id: string
  scanId: string
  scanTitle: string
  operation: string
  candidates: CandidateLane[]
  videoSeconds: number
  onWait?: (msg: string, waitSec: number, candidateSummary: string) => void
  isStopping?: () => boolean
  resolve: (res: { selected: CandidateLane; release: (actualVideoSec?: number, cooldownOverrideMs?: number) => void }) => void
  reject: (err: Error) => void
  queuedAt: number
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
  /** Set of API key hashes currently running an active verifier or rescan (strictly max 1 per key) */
  private activeVerifyRescanKeys = new Set<string>()
  /** Maximum simultaneous verifier + rescan requests allowed globally across all scans combined */
  private readonly MAX_GLOBAL_VERIFY_RESCAN = 1
  /** Timestamp of the last outgoing verifier/rescan dispatch across any scan */
  private lastGlobalVerifyDispatchAt = 0
  /** Minimum spacing (ms) between any two outgoing verifier/rescan dispatches across all scans (anti-burst) */
  private readonly GLOBAL_VERIFY_DISPATCH_MIN_GAP_MS = 6000

  /** Central Verifier & Rescan ticket queue — coordinates all parallel scans from above */
  private verifierQueue: VerifierTicket[] = []
  private isPumpingVerifierQueue = false
  private verifierPumpTimer: NodeJS.Timeout | null = null

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
   * Remote Central Conductor for Verifier & Rescan:
   * Coordinates all verifier and rescan requests across all parallel scans from a single high-level queue.
   * Ensures:
   * 1. Strictly at most 1 verifier/rescan per API key at a time (protects 250k TPM).
   * 2. Strictly at most MAX_GLOBAL_VERIFY_RESCAN across all scans combined.
   * 3. Minimum 6.0s spacing between any two outgoing dispatches (anti-burst).
   * 4. When cooldown ends, requests dispatch ONE BY ONE sequentially with spacing (no stampede).
   */
  public pumpVerifierQueue(): void {
    if (this.isPumpingVerifierQueue) return
    this.isPumpingVerifierQueue = true

    try {
      if (this.verifierQueue.length === 0) return

      // Clean up stopped / cancelled tickets
      this.verifierQueue = this.verifierQueue.filter((t) => {
        if (t.isStopping && t.isStopping()) {
          t.reject(new Error('Stop requested — verifier ticket cancelled'))
          return false
        }
        return true
      })

      if (this.verifierQueue.length === 0) return

      this.checkDayRollover()

      // Concurrency check: max active verifier/rescan
      if (this.activeVerifyRescanCount >= this.MAX_GLOBAL_VERIFY_RESCAN) {
        return
      }

      // Stagger dispatch gap check: min 6.0s between outgoing dispatches across all scans
      const now = Date.now()
      const gapNeeded = (this.lastGlobalVerifyDispatchAt + this.GLOBAL_VERIFY_DISPATCH_MIN_GAP_MS) - now
      if (gapNeeded > 0) {
        if (this.verifierPumpTimer) clearTimeout(this.verifierPumpTimer)
        this.verifierPumpTimer = setTimeout(() => {
          this.verifierPumpTimer = null
          this.pumpVerifierQueue()
        }, gapNeeded + 50)
        return
      }

      // Find first eligible ticket and candidate lane
      let targetIdx = -1
      let chosenCand: CandidateLane | null = null
      let chosenLane: GlobalLaneState | null = null

      for (let i = 0; i < this.verifierQueue.length; i++) {
        const ticket = this.verifierQueue[i]
        const availableCands = ticket.candidates.filter(
          (c) => !this.isModelExhausted(c.apiKey, c.modelId, c.rpd),
        )

        if (availableCands.length === 0) {
          ticket.reject(new Error('All candidate keys/models have reached their daily quota in Settings'))
          this.verifierQueue.splice(i, 1)
          i--
          continue
        }

        // Sort: prioritize key with least usage, and model with least usage
        availableCands.sort((a, b) => {
          if (a.keyIdx !== b.keyIdx) return a.keyIdx - b.keyIdx
          return getModelUsage(a.modelId, a.apiKey) - getModelUsage(b.modelId, b.apiKey)
        })

        for (const cand of availableCands) {
          const kh = apiKeyHash(cand.apiKey)
          // Strictly NO concurrent verifier on the same API key!
          if (this.activeVerifyRescanKeys.has(kh)) continue

          const lane = this.getOrCreateLane(cand.apiKey, cand.modelId, cand.slot || 0, cand.keyIdx)
          const isFree =
            lane.activeScanId === null &&
            lane.cooldownUntil <= now &&
            lane.nextFreeAt <= now

          if (isFree) {
            targetIdx = i
            chosenCand = cand
            chosenLane = lane
            break
          }
        }

        if (chosenCand && chosenLane) break
      }

      if (targetIdx !== -1 && chosenCand && chosenLane) {
        const [ticket] = this.verifierQueue.splice(targetIdx, 1)
        const kh = apiKeyHash(chosenCand.apiKey)

        // ATOMIC CLAIM: lock immediately synchronously before any yield
        this.activeVerifyRescanCount++
        this.activeVerifyRescanKeys.add(kh)
        this.lastGlobalVerifyDispatchAt = Date.now()

        chosenLane.activeScanId = ticket.scanId
        chosenLane.activeScanTitle = ticket.scanTitle
        chosenLane.activeOperation = ticket.operation
        chosenLane.activeSince = Date.now()

        const selected = chosenCand
        const laneRef = chosenLane

        const release = (actualVideoSec?: number, cooldownOverrideMs?: number) => {
          this.activeVerifyRescanCount = Math.max(0, this.activeVerifyRescanCount - 1)
          this.activeVerifyRescanKeys.delete(kh)
          this.lastGlobalVerifyDispatchAt = Date.now()

          this.releaseLane(laneRef, actualVideoSec ?? ticket.videoSeconds, cooldownOverrideMs)

          // Trigger next ticket pump after a small buffer
          setTimeout(() => {
            this.pumpVerifierQueue()
          }, 1500)
        }

        ticket.resolve({ selected, release })

        // If more tickets waiting, schedule next dispatch after stagger gap
        if (this.verifierQueue.length > 0) {
          if (this.verifierPumpTimer) clearTimeout(this.verifierPumpTimer)
          this.verifierPumpTimer = setTimeout(() => {
            this.verifierPumpTimer = null
            this.pumpVerifierQueue()
          }, this.GLOBAL_VERIFY_DISPATCH_MIN_GAP_MS + 100)
        }
        return
      }

      // No lane currently free: find shortest cooldown among queued tickets to schedule next wake-up
      let shortestWait = Infinity
      for (const ticket of this.verifierQueue) {
        for (const cand of ticket.candidates) {
          const lane = this.getOrCreateLane(cand.apiKey, cand.modelId, cand.slot || 0, cand.keyIdx)
          if (lane.cooldownUntil > now && lane.cooldownUntil < shortestWait) {
            shortestWait = lane.cooldownUntil
          }
        }
      }

      if (shortestWait < Infinity) {
        const waitMs = shortestWait - now
        const waitSec = Math.max(1, Math.ceil(waitMs / 1000))
        for (const ticket of this.verifierQueue) {
          ticket.onWait?.(
            `[Global Verifier Conductor] Central queue: Model cooling down (~${waitSec}s remaining). Staggering dispatches across parallel scans to prevent quota bursts...`,
            waitSec,
            'verifier conductor queue',
          )
        }
        if (this.verifierPumpTimer) clearTimeout(this.verifierPumpTimer)
        this.verifierPumpTimer = setTimeout(() => {
          this.verifierPumpTimer = null
          this.pumpVerifierQueue()
        }, waitMs + 200)
      }
    } finally {
      this.isPumpingVerifierQueue = false
    }
  }

  /**
   * Central coordinator orchestrator for Verifier & Rescan:
   * Checks from above across ALL parallel scans if capacity and stagger gap allow dispatch right now.
   */
  public canDispatchVerifyOrRescan(
    apiKey: string,
    modelId: string,
    rpdCap?: number,
  ): { ok: boolean; reason?: string; waitMs?: number; cooling?: boolean } {
    this.checkDayRollover()
    const cap = rpdCap ?? getModelDailyCap(modelId)

    // 1. Quota check against Settings data: if used < cap, quota is STILL AVAILABLE!
    const used = getModelUsage(modelId, apiKey)
    if (used >= cap) {
      return { ok: false, reason: `Daily quota limit reached in Settings (${used}/${cap} RPD)`, waitMs: 60000 }
    }

    // 2. Specific lane busy/cooldown check
    const laneStatus = this.isLaneBusy(apiKey, modelId, 0, cap)
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

    // 4. Central global dispatch stagger gap (min 6.0s between any two outgoing dispatches)
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
   * CRITICAL: If getModelUsage < cap, quota is STILL AVAILABLE in Settings!
   * Never marks exhausted prematurely!
   */
  public isModelExhausted(apiKey: string, modelId: string, rpdCap?: number): boolean {
    this.checkDayRollover()
    const cap = rpdCap ?? getModelDailyCap(modelId)
    const used = getModelUsage(modelId, apiKey)
    const lane = this.getOrCreateLane(apiKey, modelId, 0)
    if (used < cap) {
      lane.isExhausted = false
      clearModelExhausted(modelId, apiKey)
      return false
    }
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
          const kh = apiKeyHash(apiKey)
          // Strictly NO concurrent verifier on same key, or exceeding global verifier capacity
          if (this.activeVerifyRescanKeys.has(kh) || this.activeVerifyRescanCount >= this.MAX_GLOBAL_VERIFY_RESCAN) {
            onWait?.(`[Global Coordinator] Global verifier capacity full (${this.activeVerifyRescanCount}/${this.MAX_GLOBAL_VERIFY_RESCAN} active). Queuing...`, 2)
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

          // Check central global dispatch stagger gap (min 6.0s between any two outgoing verifier/rescan dispatches across all scans)
          const nowMs = Date.now()
          const gapNeeded = (this.lastGlobalVerifyDispatchAt + this.GLOBAL_VERIFY_DISPATCH_MIN_GAP_MS) - nowMs
          if (gapNeeded > 0) {
            onWait?.(`[Global Coordinator] Staggering verifier dispatch (~${Math.ceil(gapNeeded / 1000)}s gap)...`, 1)
            await new Promise((r) => setTimeout(r, gapNeeded + Math.floor(Math.random() * 300)))
          }

          this.activeVerifyRescanCount++
          this.activeVerifyRescanKeys.add(kh)
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
   * 1. If operation is Verifier or Rescan: delegates to Remote Central Overseer Queue (coordinates all scans from above).
   * 2. If operation is Chunk scan: completely unchanged direct search loop with zero interference.
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

    // 1. VERIFIER & RESCAN: Remote Central Conductor Coordinates All Scans From Above!
    // Prevents post-cooldown bursts and concurrent verifier collisions across parallel scans.
    if (this.isVerifyOrRescan(operation)) {
      return new Promise<{
        selected: CandidateLane
        release: (actualVideoSec?: number, cooldownOverrideMs?: number) => void
      }>((resolve, reject) => {
        const ticket: VerifierTicket = {
          id: `vt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          scanId,
          scanTitle,
          operation,
          candidates,
          videoSeconds,
          onWait,
          isStopping,
          resolve,
          reject,
          queuedAt: Date.now(),
        }
        this.verifierQueue.push(ticket)
        this.pumpVerifierQueue()
      })
    }

    // 2. CHUNKS SCAN (Unchanged): Direct dynamic search across candidate lanes
    let lastLoggedWaitMsg = ''

    while (true) {
      if (isStopping && isStopping()) {
        throw new Error('Stop requested — lane acquisition cancelled')
      }

      const now = Date.now()

      this.checkDayRollover()

      // Filter out permanently exhausted / disabled lanes using Settings data
      const availableCandidates = candidates.filter((c) => {
        return !this.isModelExhausted(c.apiKey, c.modelId, c.rpd)
      })

      if (availableCandidates.length === 0) {
        throw new Error('All candidate keys/models have reached their daily quota or are exhausted')
      }

      // Sort candidates to prioritize same-key multi-model usage before switching keys
      const sortedCandidates = [...availableCandidates].sort((a, b) => {
        if (a.keyIdx !== b.keyIdx) return a.keyIdx - b.keyIdx
        const aUsage = getModelUsage(a.modelId, a.apiKey)
        const bUsage = getModelUsage(b.modelId, b.apiKey)
        return aUsage - bUsage
      })

      // Check for immediately FREE lanes (no active scan, no cooldown, no pacing wait, no waiters)
      for (const cand of sortedCandidates) {
        const lane = this.getOrCreateLane(cand.apiKey, cand.modelId, cand.slot || 0, cand.keyIdx)
        const isFree =
          lane.activeScanId === null &&
          lane.cooldownUntil <= now &&
          lane.nextFreeAt <= now &&
          lane.waiters.length === 0

        if (isFree) {
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

      // None are immediately free. Calculate estimated shortest wait time across all candidate lanes
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

      // Sleep with jitter (1000ms - 1500ms) so parallel scans/workers do not wake at the exact same millisecond after cooldown
      const jitterMs = 1000 + Math.floor(Math.random() * 500)
      await new Promise((r) => setTimeout(r, jitterMs))
    }
  }

  private releaseLane(lane: GlobalLaneState, videoSeconds: number, cooldownOverrideMs?: number) {
    const op = lane.activeOperation || lane.lastOperation || ''
    if (this.isVerifyOrRescan(op)) {
      this.activeVerifyRescanCount = Math.max(0, this.activeVerifyRescanCount - 1)
      this.activeVerifyRescanKeys.delete(lane.keyHash)
      this.lastGlobalVerifyDispatchAt = Date.now()

      setTimeout(() => {
        this.pumpVerifierQueue()
      }, 1500)
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
   *    If actual used < cap, quota is STILL AVAILABLE today! NEVER mark as exhausted!
   * 2. Apply a randomized cooldown (70s - 78s) on that model so parallel scans don't wake up all at once.
   * 3. Only mark definitively exhausted if real tracked usage has actually reached the daily cap (used >= cap).
   */
  public handleQuotaOrRateError(
    apiKey: string,
    modelId: string,
    slot: number = 0,
    rpdCap?: number,
    ..._extraArgs: unknown[]
  ): {
    action: 'cooldown' | 'exhausted'
    waitSec: number
    reason: string
  } {
    void _extraArgs
    this.checkDayRollover()
    const lane = this.getOrCreateLane(apiKey, modelId, slot)
    const cap = rpdCap ?? getModelDailyCap(modelId)
    const used = getModelUsage(modelId, apiKey)

    // 1. Genuine daily exhaustion: ONLY if actual recorded usage in Settings has reached or exceeded cap!
    if (used >= cap) {
      this.reportExhausted(apiKey, modelId, slot, cap)
      return {
        action: 'exhausted',
        waitSec: 0,
        reason: `Daily quota limit reached in Settings (${used}/${cap} RPD) on ${modelId} (Key ${lane.keyIdx})`,
      }
    }

    lane.consecutiveQuotaErrors = (lane.consecutiveQuotaErrors || 0) + 1

    // 2. CRITICAL USER RULE:
    // If usage in Settings is below cap, quota is STILL REMAINING for today!
    // NEVER mark as exhausted for the day after 1, 2, or any number of rate/quota errors!
    // Put ONLY this model in 70s-78s cooldown and allow retry when cooled down!
    lane.isExhausted = false
    clearModelExhausted(modelId, apiKey)
    const jitterCooldownMs = CHUNK_COOLDOWN_MS + Math.floor(Math.random() * 8000)
    this.reportRateLimit(apiKey, modelId, jitterCooldownMs, slot)
    return {
      action: 'cooldown',
      waitSec: Math.ceil(jitterCooldownMs / 1000),
      reason: `Rate limit (429) on ${modelId} (Key ${lane.keyIdx}). Quota remaining in Settings (${used}/${cap} RPD) — cooling down for ${Math.ceil(jitterCooldownMs / 1000)}s before retry`,
    }
  }

  /** Report that a model's daily quota has been exhausted across the entire app */
  public reportExhausted(apiKey: string, modelId: string, slot: number = 0, rpdCap?: number) {
    const cap = rpdCap ?? getModelDailyCap(modelId)
    const used = getModelUsage(modelId, apiKey)
    if (used < cap) {
      // Quota is still available in Settings! Refuse to mark exhausted!
      const lane = this.getOrCreateLane(apiKey, modelId, slot)
      lane.isExhausted = false
      clearModelExhausted(modelId, apiKey)
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
            waiter.reject(new Error(`[Global Coordinator] Key ${other.keyIdx} (${modelId}) daily quota (${cap} RPD) exhausted`))
          }
        }
      }
    }

    // Persist to counters.json so subsequent workers/processes know this model is quota-capped today
    try {
      setModelExhausted(modelId, apiKey, cap)
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
