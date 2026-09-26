import type { Scan } from './types'

export interface ErrorCountDetails {
  highDemandOrRateLimit: number // 503 / 429 / Empty Response / Server Busy (No tokens billed)
  notFound404: number // 404 model / clip not found (No tokens billed)
  invalidKey: number // Invalid / expired key (No tokens billed)
  dailyExhausted: number // Daily 25M token or 20 RPD cap reached
  prohibitedPolicy: number // Prohibited content / Google safety filter blocked (Retried with sanitized audio/neutral prompt)
  other: number
}

export interface ModelUsageCategory {
  chunkScan: number
  rescan: number
  verifier: number
  minuteFinder: number
  missingScene: number
  total: number // Total attempts made
  effective: number // Completed successful requests (Actual tokens/quota consumed)
  errors: ErrorCountDetails
}

export interface ScanUsageSummary {
  totalRequests: number // Total attempts made across all models
  effectiveRequests: number // Vastav me safal requests (Token quota deduct hua)
  totalErrors: number // Total failed/retried attempts (No token quota charged)
  errorBreakdown: ErrorCountDetails
  byModel: Record<string, ModelUsageCategory>
  byStage: {
    chunkScan: number
    rescan: number
    verifier: number
    minuteFinder: number
    missingScene: number
  }
  mainModels: {
    gemini37: number
    gemini38: number
    gemini36: number
    others: number
  }
}

/**
 * Computes exact AI request counts, distinguishing between effective (successful)
 * requests that consumed quota vs failed/high-demand/rate-limited/empty attempts.
 */
export function computeScanUsage(scan: Scan | null | undefined): ScanUsageSummary {
  const summary: ScanUsageSummary = {
    totalRequests: 0,
    effectiveRequests: 0,
    totalErrors: 0,
    errorBreakdown: {
      highDemandOrRateLimit: 0,
      notFound404: 0,
      invalidKey: 0,
      dailyExhausted: 0,
      prohibitedPolicy: 0,
      other: 0,
    },
    byModel: {},
    byStage: {
      chunkScan: 0,
      rescan: 0,
      verifier: 0,
      minuteFinder: 0,
      missingScene: 0,
    },
    mainModels: {
      gemini37: 0,
      gemini38: 0,
      gemini36: 0,
      others: 0,
    },
  }

  if (!scan) return summary

  const getModelBucket = (modelId: string): ModelUsageCategory => {
    const cleanId = modelId.trim().toLowerCase()
    if (!summary.byModel[cleanId]) {
      summary.byModel[cleanId] = {
        chunkScan: 0,
        rescan: 0,
        verifier: 0,
        minuteFinder: 0,
        missingScene: 0,
        total: 0,
        effective: 0,
        errors: {
          highDemandOrRateLimit: 0,
          notFound404: 0,
          invalidKey: 0,
          dailyExhausted: 0,
          prohibitedPolicy: 0,
          other: 0,
        },
      }
    }
    return summary.byModel[cleanId]
  }

  const recordRequest = (
    modelId: string,
    stage: keyof ScanUsageSummary['byStage'],
    isEffective: boolean,
    errorType?: keyof ErrorCountDetails,
  ) => {
    if (!modelId) return
    const cleanId = modelId.trim().toLowerCase()
    const bucket = getModelBucket(cleanId)

    bucket[stage] += 1
    bucket.total += 1
    summary.totalRequests += 1

    if (isEffective) {
      bucket.effective += 1
      summary.effectiveRequests += 1
      summary.byStage[stage] += 1

      if (cleanId.includes('3.7')) {
        summary.mainModels.gemini37 += 1
      } else if (cleanId.includes('3.8')) {
        summary.mainModels.gemini38 += 1
      } else if (cleanId.includes('3.6')) {
        summary.mainModels.gemini36 += 1
      } else {
        summary.mainModels.others += 1
      }
    } else {
      summary.totalErrors += 1
      const errKey = errorType || 'highDemandOrRateLimit'
      bucket.errors[errKey] += 1
      summary.errorBreakdown[errKey] += 1
    }
  }

  const loggedErrors = new Set<string>()
  const loggedEffective = new Set<string>()

  // 1. Parse Scan Logs with precise error vs effective request differentiation
  if (Array.isArray(scan.logs)) {
    for (const entry of scan.logs) {
      const msg = entry.msg || ''
      const lower = msg.toLowerCase()
      const timeKey = entry.t || (entry as { time?: number }).time || msg

      // Check if this log represents an Error / Retry attempt
      let isError = false
      let errorCategory: keyof ErrorCountDetails = 'highDemandOrRateLimit'

      if (
        lower.includes('prohibited') ||
        lower.includes('policy') ||
        lower.includes('safety_ratings_blocked') ||
        lower.includes('flagged by google policy') ||
        lower.includes('prompt block reason')
      ) {
        isError = true
        errorCategory = 'prohibitedPolicy'
      } else if (
        lower.includes('daily quota') ||
        lower.includes('quota exhausted') ||
        lower.includes('daily limit') ||
        lower.includes('rpd')
      ) {
        isError = true
        errorCategory = 'dailyExhausted'
      } else if (lower.includes('404') || lower.includes('unavailable')) {
        isError = true
        errorCategory = 'notFound404'
      } else if (lower.includes('invalid/expired') || lower.includes('invalid api key')) {
        isError = true
        errorCategory = 'invalidKey'
      } else if (
        lower.includes('rate limit') ||
        lower.includes('empty response') ||
        lower.includes('high demand') ||
        lower.includes('503') ||
        lower.includes('429') ||
        lower.includes('re-queued') ||
        lower.includes('overloaded') ||
        lower.includes('cooldown') ||
        lower.includes('api busy') ||
        lower.includes('failed on') ||
        (lower.includes('attempt') && lower.includes('failed'))
      ) {
        isError = true
        errorCategory = 'highDemandOrRateLimit'
      }

      if (isError) {
        let modelMatch = msg.match(/(gemini-[\w.-]+)/i)
        let stage: keyof ScanUsageSummary['byStage'] = 'chunkScan'
        if (lower.includes('rescan')) stage = 'rescan'
        else if (lower.includes('verifier') || lower.includes('verify')) stage = 'verifier'
        else if (lower.includes('missing-scene') || lower.includes('missing scene')) stage = 'missingScene'
        else if (lower.includes('window') || lower.includes('minute finder') || lower.includes('prescan')) stage = 'minuteFinder'

        // If log message lacks model name, deduce it from chunk index
        if (!modelMatch && stage === 'chunkScan') {
          const cNumMatch = msg.match(/Chunk\s+(\d+)/i)
          if (cNumMatch) {
            const cIdx = parseInt(cNumMatch[1], 10)
            const matchedChunk =
              scan.chunks?.find((c) => c.index === cIdx) ||
              scan.shortSegments?.flatMap((s) => s.chunks || []).find((c) => c.index === cIdx)
            if (matchedChunk?.model) {
              modelMatch = [matchedChunk.model, matchedChunk.model]
            }
          }
        }

        const defaultModelForStage =
          stage === 'verifier' ? 'gemini-3.5-flash-lite' : stage === 'rescan' ? 'gemini-3-flash-preview' : 'gemini-3.7-flash'
        const rawModel = normalizeModelName(modelMatch ? modelMatch[1] : defaultModelForStage)

        // Differentiate retry vs initial policy hits so they are never deduped away
        const isRetryPolicy = lower.includes('after sanitized retry')
        const isInitialPolicy = lower.includes('triggering 1 sanitized retry')
        const policyPhase = isRetryPolicy ? '-retry' : isInitialPolicy ? '-initial' : ''
        const key = `err-${timeKey}-${rawModel}${policyPhase}-${msg.slice(0, 75)}`
        if (!loggedErrors.has(key)) {
          loggedErrors.add(key)
          recordRequest(rawModel, stage, false, errorCategory)
        }
        continue
      }

      // Check for Completed / Successful Work (Effective Requests)
      // 1a. Chunk mapping completion
      const chunkMatch = msg.match(/Chunk\s+(\d+).*?on\s+(gemini-[\w.-]+)/i)
      if (chunkMatch && (lower.includes('matched') || lower.includes('found') || lower.includes('no segments'))) {
        const rawModel = normalizeModelName(chunkMatch[2])
        const key = `chunk-eff-${timeKey}-${chunkMatch[1]}-${rawModel}`
        if (!loggedEffective.has(key)) {
          loggedEffective.add(key)
          recordRequest(rawModel, 'chunkScan', true)
        }
      }

      // 1b. Rescan completion
      const rescanMatch = msg.match(/rescan.*?on\s+(gemini-[\w.-]+)/i)
      if (rescanMatch && (lower.includes('found') || lower.includes('hunt') || lower.includes('re-verify'))) {
        const rawModel = normalizeModelName(rescanMatch[1])
        const key = `rescan-eff-${timeKey}-${rawModel}`
        if (!loggedEffective.has(key)) {
          loggedEffective.add(key)
          recordRequest(rawModel, 'rescan', true)
        }
      }

      // 1c. Verifier completion
      const verifierMatch = msg.match(/(?:verifier|confirmed|different).*?(?:on|verifier:)\s*(gemini-[\w.-]+)/i)
      if (verifierMatch) {
        const rawModel = normalizeModelName(verifierMatch[1])
        const key = `verifier-eff-${timeKey}-${rawModel}`
        if (!loggedEffective.has(key)) {
          loggedEffective.add(key)
          recordRequest(rawModel, 'verifier', true)
        }
      }

      // 1d. Missing scene finder completion
      const missingMatch = msg.match(/missing-scene.*?on\s+(gemini-[\w.-]+)/i)
      if (missingMatch && (lower.includes('candidate') || lower.includes('found') || lower.includes('done'))) {
        const rawModel = normalizeModelName(missingMatch[1])
        const key = `missing-eff-${timeKey}-${rawModel}`
        if (!loggedEffective.has(key)) {
          loggedEffective.add(key)
          recordRequest(rawModel, 'missingScene', true)
        }
      }

      // 1e. Minute finder window completion
      const windowMatch = msg.match(/(?:window|minute finder).*?on\s+(gemini-[\w.-]+)/i)
      if (windowMatch && (lower.includes('hit') || lower.includes('done') || lower.includes('completed'))) {
        const rawModel = normalizeModelName(windowMatch[1])
        const key = `window-eff-${timeKey}-${rawModel}`
        if (!loggedEffective.has(key)) {
          loggedEffective.add(key)
          recordRequest(rawModel, 'minuteFinder', true)
        }
      }
    }
  }

  // 2. Structural sync from scan data objects (guarantees accurate counts even with sparse logs)
  if (scan.geminiPrescan?.windows && Array.isArray(scan.geminiPrescan.windows)) {
    const prescanDone = scan.geminiPrescan.windows.filter((w) => w.status === 'done' || w.hits !== undefined)
    for (const w of prescanDone) {
      const laneModel = w.lane?.split('·')[1]?.trim()
      const model = normalizeModelName(laneModel || 'gemini-3.7-flash')
      const key = `struct-win-${w.index}-${model}`
      if (!loggedEffective.has(key)) {
        loggedEffective.add(key)
        recordRequest(model, 'minuteFinder', true)
      }
    }
    // Prohibited policy retries on minute finder windows (both initial hit and retry hit if failed)
    for (const w of scan.geminiPrescan.windows) {
      if (w.policyRetried) {
        const laneModel = w.lane?.split('·')[1]?.trim()
        const model = normalizeModelName(laneModel || 'gemini-3.7-flash')
        const key1 = `struct-win-policy-initial-${w.index}-${model}`
        if (!loggedErrors.has(key1)) {
          loggedErrors.add(key1)
          recordRequest(model, 'minuteFinder', false, 'prohibitedPolicy')
        }
        if (w.status === 'failed') {
          const key2 = `struct-win-policy-retry-${w.index}-${model}`
          if (!loggedErrors.has(key2)) {
            loggedErrors.add(key2)
            recordRequest(model, 'minuteFinder', false, 'prohibitedPolicy')
          }
        }
      }
    }
  }

  // Backup pass windows
  if (scan.geminiPrescan?.backup?.windows && Array.isArray(scan.geminiPrescan.backup.windows)) {
    const backupDone = scan.geminiPrescan.backup.windows.filter((w) => w.status === 'done' || w.hits !== undefined)
    for (const w of backupDone) {
      const laneModel = w.lane?.split('·')[1]?.trim()
      const model = normalizeModelName(laneModel || 'gemini-3.7-flash')
      const key = `struct-bwin-${w.index}-${model}`
      if (!loggedEffective.has(key)) {
        loggedEffective.add(key)
        recordRequest(model, 'minuteFinder', true)
      }
    }
    for (const w of scan.geminiPrescan.backup.windows) {
      if (w.policyRetried) {
        const laneModel = w.lane?.split('·')[1]?.trim()
        const model = normalizeModelName(laneModel || 'gemini-3.7-flash')
        const key1 = `struct-bwin-policy-initial-${w.index}-${model}`
        if (!loggedErrors.has(key1)) {
          loggedErrors.add(key1)
          recordRequest(model, 'minuteFinder', false, 'prohibitedPolicy')
        }
        if (w.status === 'failed') {
          const key2 = `struct-bwin-policy-retry-${w.index}-${model}`
          if (!loggedErrors.has(key2)) {
            loggedErrors.add(key2)
            recordRequest(model, 'minuteFinder', false, 'prohibitedPolicy')
          }
        }
      }
    }
  }

  const segments = scan.shortSegments || []
  const chunks = segments.flatMap((s) => s.chunks || [])
  const chunkList = chunks.length > 0 ? chunks : scan.chunks || []
  const completedChunks = chunkList.filter((c) => c && (c.status === 'match' || c.status === 'no_match'))

  for (const c of completedChunks) {
    const model = normalizeModelName(c.model || 'gemini-3.7-flash')
    const key = `struct-chunk-${c.index}-${model}`
    if (!loggedEffective.has(key)) {
      loggedEffective.add(key)
      recordRequest(model, 'chunkScan', true)
    }
  }

  // Chunk policy retries: count initial attempt, and if status is policy_blocked, count retry attempt too
  for (const c of chunkList) {
    if (c.policyRetried) {
      const model = normalizeModelName(c.model || 'gemini-3.7-flash')
      const key1 = `struct-chunk-policy-initial-${c.index}-${model}`
      if (!loggedErrors.has(key1)) {
        loggedErrors.add(key1)
        recordRequest(model, 'chunkScan', false, 'prohibitedPolicy')
      }
      if (c.status === 'policy_blocked') {
        const key2 = `struct-chunk-policy-retry-${c.index}-${model}`
        if (!loggedErrors.has(key2)) {
          loggedErrors.add(key2)
          recordRequest(model, 'chunkScan', false, 'prohibitedPolicy')
        }
      }
    }
  }

  if (scan.candidateGroups && Array.isArray(scan.candidateGroups)) {
    for (const g of scan.candidateGroups) {
      for (const c of g.candidates || []) {
        if (c.verdict === 'same' || c.verdict === 'different') {
          const model = normalizeModelName(c.verifierModel || 'gemini-3.5-flash-lite')
          const key = `struct-verif-${g.id}-${c.chunkIndex}-${model}`
          if (!loggedEffective.has(key)) {
            loggedEffective.add(key)
            recordRequest(model, 'verifier', true)
          }
        }
        if (c.rescan === 'found' || c.rescan === 'not_found') {
          const model = normalizeModelName(c.rescanModel || 'gemini-3-flash-preview')
          const key = `struct-rescan-${g.id}-${c.chunkIndex}-${model}`
          if (!loggedEffective.has(key)) {
            loggedEffective.add(key)
            recordRequest(model, 'rescan', true)
          }
        }
      }
    }
  }

  // Ensure default models exist in summary
  const defaultModels = ['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.6-flash']
  for (const m of defaultModels) {
    getModelBucket(m)
  }

  return summary
}

function normalizeModelName(name: string): string {
  if (!name) return 'gemini-3.7-flash'
  let clean = name.toLowerCase().trim()
  if (clean.includes('shiva')) {
    clean = clean.replace('shiva', 'flash')
  }
  if (!clean.startsWith('gemini-')) {
    clean = `gemini-${clean}`
  }
  if (clean.includes('3.7')) return 'gemini-3.7-flash'
  if (clean.includes('3.8')) return 'gemini-3.8-flash'
  if (clean.includes('3.6')) return 'gemini-3.6-flash'
  if (clean.includes('3.5-flash-lite') || clean.includes('3.5-lite')) return 'gemini-3.5-flash-lite'
  if (clean.includes('3.1-flash-lite') || clean.includes('3.1-lite')) return 'gemini-3.1-flash-lite'
  if (clean.includes('3.5-flash') || clean.includes('3.5')) return 'gemini-3.5-flash'
  if (clean.includes('3-flash-preview')) return 'gemini-3-flash-preview'
  return clean
}
