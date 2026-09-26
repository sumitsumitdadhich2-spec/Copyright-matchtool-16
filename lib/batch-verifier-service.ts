import fs from 'node:fs'
import { GoogleGenAI } from '@google/genai'
import { getScan, saveScan, addLog, getAllApiKeys, incrementModelUsage } from './store'
import { getAllUserApiKeys } from './user-keys'
import { globalGeminiCoordinator, type CandidateLane } from './global-gemini-coordinator'
import { uploadVideo, deleteFileQuiet, extractResponseText, classifyError, getClient } from './gemini'
import { planMinuteSegments, stitchMinuteVerificationClips } from './batch-minute-stitcher'
import { buildBatchVerifierPrompt, fmtMs } from './batch-verifier-prompt'
import { CancelToken } from './ffmpeg-pool'
import { sameShortSegment } from './candidate-pick'
import { CHUNK_COOLDOWN_MS } from './models'
import type { Scan, BatchMinuteResult, BatchVerifyPart, BatchVerifyState, ChunkMatch } from './types'

const BATCH_VERIFY_MODELS = ['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.6-flash']

// In-memory registry of cancel tokens per scan
const activeCancelTokens = new Map<string, CancelToken>()

function logScan(scanId: string, level: 'info' | 'warn' | 'error' | 'success', msg: string) {
  const scan = getScan(scanId)
  if (scan) {
    addLog(scan, level, msg)
    saveScan(scan)
  }
}

export function getOrCreateBatchVerifyState(scan: Scan): BatchVerifyState {
  if (!scan.batchVerify) {
    scan.batchVerify = {
      status: 'idle',
      results: {},
    }
  }
  return scan.batchVerify
}

/**
 * Parses Gemini response text into structured part verdicts.
 * Handles JSON blocks, arrays, and structured regex fallback.
 */
export function parseBatchVerifierResponse(
  rawText: string,
  plannedParts: BatchVerifyPart[],
): BatchVerifyPart[] {
  const partsMap = new Map<number, BatchVerifyPart>()
  for (const p of plannedParts) {
    partsMap.set(p.partIndex, { ...p, verdict: 'REJECTED', rescanRequired: true, reason: 'Pending verification' })
  }

  // 1. Try extracting JSON block
  try {
    const jsonMatch =
      rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ||
      rawText.match(/(\{[\s\S]*"verdicts"[\s\S]*\})/) ||
      rawText.match(/(\[\s*\{[\s\S]*\}\s*\])/)
    let jsonString = jsonMatch ? jsonMatch[1] : rawText.trim()
    // Sanitize trailing commas before closing braces/brackets
    jsonString = jsonString.replace(/,\s*([\]}])/g, '$1')
    const parsed = JSON.parse(jsonString)
    const list = Array.isArray(parsed)
      ? parsed
      : parsed.verdicts || parsed.parts || parsed.results || parsed.data || []

    if (Array.isArray(list) && list.length > 0) {
      for (const item of list) {
        const idx = Number(item.partIndex || item.part || item.index)
        if (partsMap.has(idx)) {
          const rawVerdict = String(item.verdict || '').toUpperCase().trim()
          const confidence = typeof item.confidence === 'number' ? item.confidence : 0.9
          // Strict confidence threshold: must be explicitly confirmed, no rejection/mismatch indicators, confidence >= 0.85
          const isConfirmed =
            (rawVerdict === 'CONFIRMED' || rawVerdict === 'SAME' || rawVerdict === 'MATCH' || rawVerdict === 'CONFIRM') &&
            !rawVerdict.includes('REJECT') &&
            !rawVerdict.includes('MISMATCH') &&
            !rawVerdict.includes('NOT') &&
            !rawVerdict.includes('DIFFERENT') &&
            !rawVerdict.includes('DIFF') &&
            confidence >= 0.85

          const cropDetail = item.cropPosition ? ` [Crop: ${String(item.cropPosition).trim()}]` : ''
          const anchorProof = item.visualAnchorProof ? ` [Anchor: ${String(item.visualAnchorProof).trim()}]` : ''
          const mismatchStr = item.mismatchDetail && !String(item.mismatchDetail).toLowerCase().includes('none')
            ? ` [Fark: ${String(item.mismatchDetail).trim()}]`
            : ''
          const baseReason = item.reason
            ? String(item.reason).trim()
            : isConfirmed
              ? 'Forensic scene analysis confirmed same take and action'
              : 'Scene or action mismatch detected'

          const existing = partsMap.get(idx)!
          partsMap.set(idx, {
            ...existing,
            verdict: isConfirmed ? 'CONFIRMED' : 'REJECTED',
            confidence,
            visualAnchorProof: item.visualAnchorProof ? String(item.visualAnchorProof).trim() : undefined,
            reason: `${baseReason}${mismatchStr}${cropDetail}${anchorProof}`,
            rescanRequired: !isConfirmed,
          })
        }
      }
      return Array.from(partsMap.values()).sort((a, b) => a.partIndex - b.partIndex)
    }
  } catch {
    // Fall back to line-by-line regex parsing
  }

  // 2. Regex fallback for line-by-line formats
  for (const p of plannedParts) {
    const pRegex = new RegExp(`PART\\s*${p.partIndex}[^\\n]*?(CONFIRMED|REJECTED|SAME|DIFFERENT|MATCH|MISMATCH)[^\\n]*`, 'gi')
    const match = pRegex.exec(rawText)
    if (match) {
      const vText = match[1].toUpperCase()
      const isConfirmed = (vText === 'CONFIRMED' || vText === 'SAME' || vText === 'MATCH') && vText !== 'MISMATCH' && !vText.includes('DIFF')
      const existing = partsMap.get(p.partIndex)!
      partsMap.set(p.partIndex, {
        ...existing,
        verdict: isConfirmed ? 'CONFIRMED' : 'REJECTED',
        confidence: isConfirmed ? 0.9 : 0.1,
        reason: `Verdict: ${vText}`,
        rescanRequired: !isConfirmed,
      })
    }
  }

  return Array.from(partsMap.values()).sort((a, b) => a.partIndex - b.partIndex)
}

/**
 * Gathers candidate lanes across all available API keys for the 3 allowed models.
 */
async function getBatchCandidateLanes(scan: Scan): Promise<CandidateLane[]> {
  const userKeys = scan.ownerUsername ? await getAllUserApiKeys(scan.ownerUsername) : []
  const systemKeys = getAllApiKeys()
  const envKey = process.env.GEMINI_API_KEY
  const allKeys = Array.from(new Set([...userKeys, ...systemKeys, ...(envKey ? [envKey] : [])])).filter(Boolean)

  if (allKeys.length === 0) {
    throw new Error('No Gemini API keys configured. Please add an API key in Settings.')
  }

  const lanes: CandidateLane[] = []
  allKeys.forEach((apiKey, keyIdx) => {
    for (const modelId of BATCH_VERIFY_MODELS) {
      if (!globalGeminiCoordinator.isModelExhausted(apiKey, modelId, 20)) {
        lanes.push({
          apiKey,
          keyIdx: keyIdx + 1,
          modelId,
          rpd: 20,
        })
      }
    }
  })

  return lanes
}

/**
 * Execute batch verification for a single 1-minute window.
 */
export async function verifySingleMinute(
  scanId: string,
  minuteIndex: number,
  token?: CancelToken,
): Promise<BatchMinuteResult> {
  const scan = getScan(scanId)
  if (!scan) throw new Error(`Scan ${scanId} not found`)

  const state = getOrCreateBatchVerifyState(scan)
  const minStart = minuteIndex * 60
  const minEnd = (minuteIndex + 1) * 60

  const plan = planMinuteSegments(scan, minuteIndex)
  if (plan.parts.length === 0) {
    const emptyResult: BatchMinuteResult = {
      minuteIndex,
      shortStart: minStart,
      shortEnd: minEnd,
      status: 'done',
      totalScenes: 0,
      confirmedCount: 0,
      rejectedCount: 0,
      parts: [],
      updatedAt: Date.now(),
    }
    state.results[minuteIndex] = emptyResult
    saveScan(scan)
    return emptyResult
  }

  const minuteResult: BatchMinuteResult = {
    minuteIndex,
    shortStart: minStart,
    shortEnd: minEnd,
    status: 'preparing',
    totalScenes: plan.parts.length,
    confirmedCount: 0,
    rejectedCount: 0,
    parts: plan.parts,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
  state.results[minuteIndex] = minuteResult
  saveScan(scan)

  logScan(scanId, 'info', `[Batch Verifier] Min ${minuteIndex + 1} (${fmtMs(minStart)}–${fmtMs(minEnd)}): Stitched ${plan.parts.length} matched scenes at 24 FPS...`)

  let shortClipPath: string | null = null
  let movieClipPath: string | null = null

  try {
    // 1. Stitch videos at 24 FPS (excluding missing gaps from both)
    const stitched = await stitchMinuteVerificationClips(scanId, minuteIndex, plan.parts, token)
    shortClipPath = stitched.shortClipPath
    movieClipPath = stitched.movieClipPath

    minuteResult.status = 'verifying'
    minuteResult.updatedAt = Date.now()
    const scanBeforeVerify = getScan(scanId)
    if (scanBeforeVerify) {
      const stateBeforeVerify = getOrCreateBatchVerifyState(scanBeforeVerify)
      stateBeforeVerify.results[minuteIndex] = minuteResult
      saveScan(scanBeforeVerify)
    }

    // 2. Acquire available lane from Gemini 3.6, 3.7, or 3.8
    const candidateLanes = await getBatchCandidateLanes(scan)
    logScan(
      scanId,
      'info',
      `[Batch Verifier] Min ${minuteIndex + 1}: Waiting for first available lane (${BATCH_VERIFY_MODELS.join(', ')})...`,
    )

    let attempts = 0
    const maxAttempts = 4
    let verifiedParts: BatchVerifyPart[] = []
    let chosenModel = ''

    while (attempts < maxAttempts) {
      if (token?.isCancelled()) throw new Error('Verification cancelled')
      attempts++

      let releaseLane: ((dur?: number) => void) | null = null
      let uploadedShort: { uri: string; name: string } | null = null
      let uploadedMovie: { uri: string; name: string } | null = null
      let aiClient: GoogleGenAI | null = null
      let chosenLane: CandidateLane | null = null

      try {
        const { selected: lane, release } = await globalGeminiCoordinator.acquireFirstAvailableLane({
          candidates: candidateLanes,
          scanId,
          scanTitle: scan.shortName || scanId,
          operation: `Batch Verify Min ${minuteIndex + 1}`,
          videoSeconds: Math.ceil(stitched.totalDurationSec),
          isStopping: () => token?.isCancelled() || false,
          onWait: (msg) => logScan(scanId, 'info', msg),
        })

        chosenLane = lane
        releaseLane = release
        chosenModel = lane.modelId
        minuteResult.model = chosenModel
        aiClient = getClient(lane.apiKey)

        logScan(
          scanId,
          'info',
          `[Batch Verifier] Min ${minuteIndex + 1}: Acquired lane Key ${lane.keyIdx} (${chosenModel}). Uploading paired clips...`,
        )

        // Upload both 24 FPS clips
        uploadedShort = await uploadVideo(aiClient, shortClipPath)
        uploadedMovie = await uploadVideo(aiClient, movieClipPath)

        const prompt = buildBatchVerifierPrompt(plan.parts)

        logScan(
          scanId,
          'info',
          `[Batch Verifier] Min ${minuteIndex + 1}: Analyzing ${plan.parts.length} scenes frame-by-frame on ${chosenModel}...`,
        )

        const response = await aiClient.models.generateContent({
          model: chosenModel,
          contents: [
            { fileData: { fileUri: uploadedShort.uri, mimeType: 'video/mp4' } },
            { fileData: { fileUri: uploadedMovie.uri, mimeType: 'video/mp4' } },
            { text: prompt },
          ],
          config: {
            maxOutputTokens: 65536,
          },
        })

        const rawText = extractResponseText(response)
        verifiedParts = parseBatchVerifierResponse(rawText, plan.parts)
        incrementModelUsage(chosenModel, lane.apiKey)
        globalGeminiCoordinator.recordSuccess(lane.apiKey, chosenModel, 0)
        break // Success!
      } catch (err) {
        const geminiErr = classifyError(err)
        logScan(
          scanId,
          'warn',
          `[Batch Verifier] Min ${minuteIndex + 1} attempt ${attempts} failed on ${chosenModel || 'model'}: ${geminiErr.message}`,
        )

        if ((geminiErr.kind === 'rpd' || geminiErr.kind === 'rate') && chosenLane) {
          const outcome = globalGeminiCoordinator.handleQuotaOrRateError(
            chosenLane.apiKey,
            chosenLane.modelId,
            0,
            chosenLane.rpd || 20,
            geminiErr.kind === 'rpd',
          )
          logScan(
            scanId,
            'warn',
            `[Batch Verifier] Key ${chosenLane.keyIdx} (${chosenModel}): ${outcome.reason}`,
          )
          if (releaseLane) {
            releaseLane(Math.ceil(stitched.totalDurationSec), CHUNK_COOLDOWN_MS)
            releaseLane = null
          }
          continue
        }

        // Prohibited content error: DO NOT RETRY - Stop immediately
        if (geminiErr.kind === 'policy_blocked') {
          logScan(
            scanId,
            'error',
            `[Batch Verifier] Prohibited content detected on Minute ${minuteIndex + 1}. Stopping immediately without retry.`,
          )
          throw err
        }

        if (attempts >= maxAttempts) {
          throw err
        }
        await new Promise((r) => setTimeout(r, 2500 * attempts))
      } finally {
        if (releaseLane) releaseLane(Math.ceil(stitched.totalDurationSec))
        if (aiClient && uploadedShort?.name) void deleteFileQuiet(aiClient, uploadedShort.name)
        if (aiClient && uploadedMovie?.name) void deleteFileQuiet(aiClient, uploadedMovie.name)
      }
    }

    // 3. Update Scan Matches and Candidate Groups on FRESH scan
    const freshScan = getScan(scanId) || scan
    const freshState = getOrCreateBatchVerifyState(freshScan)

    const confirmedCount = verifiedParts.filter((p) => p.verdict === 'CONFIRMED').length
    const rejectedCount = verifiedParts.length - confirmedCount

    minuteResult.status = 'done'
    minuteResult.confirmedCount = confirmedCount
    minuteResult.rejectedCount = rejectedCount
    minuteResult.parts = verifiedParts
    minuteResult.model = chosenModel
    minuteResult.finishedAt = Date.now()
    minuteResult.updatedAt = Date.now()
    freshState.results[minuteIndex] = minuteResult

    // Apply verdicts to freshScan.matches with resilient, coordinate-based matching
    for (const p of verifiedParts) {
      const isConfirmed = p.verdict === 'CONFIRMED'
      let match: ChunkMatch | null = null

      // 1. Precise lookup by unique matchId
      if (p.matchId) {
        match = freshScan.matches.find((m) => m.id === p.matchId) || null
      }

      // 2. Precise lookup by shortStart & movieStart coordinates (ground truth of stitched scene)
      if (!match) {
        match = freshScan.matches.find(
          (m) =>
            Math.abs(m.shortStart - p.shortStart) < 0.25 &&
            Math.abs(m.movieStart - p.movieStart) < 0.5,
        ) || null
      }

      // 3. Lookup by chunkIndex and shortStart
      if (!match && p.chunkIndex !== undefined) {
        match = freshScan.matches.find(
          (m) =>
            m.chunkIndex === p.chunkIndex &&
            Math.abs(m.shortStart - p.shortStart) < 0.35,
        ) || null
      }

      // 4. Fallback to short window overlap minimizing movieStart distance
      if (!match) {
        const candidates = freshScan.matches.filter(
          (m) =>
            (Math.abs(m.shortStart - p.shortStart) < 0.35 && Math.abs(m.shortEnd - p.shortEnd) < 0.35) ||
            Math.max(0, Math.min(m.shortEnd, p.shortEnd) - Math.max(m.shortStart, p.shortStart)) > 0.1,
        )
        if (candidates.length > 0) {
          candidates.sort(
            (a, b) =>
              Math.abs(a.movieStart - p.movieStart) - Math.abs(b.movieStart - p.movieStart),
          )
          match = candidates[0]
        }
      }

      // 5. Array index fallback ONLY if coordinates actually match
      if (!match && p.matchIndex !== undefined && freshScan.matches[p.matchIndex]) {
        const candidate = freshScan.matches[p.matchIndex]
        if (Math.abs(candidate.shortStart - p.shortStart) < 0.35) {
          match = candidate
        }
      }

      if (match) {
        // If user explicitly picked or rescanned this scene, preserve their choice!
        const preserveUserChoice = Boolean(match.userPick || match.viaRescan)
        const effectiveConfirmed = isConfirmed || preserveUserChoice

        match.batchVerified = effectiveConfirmed ? 'confirmed' : 'rejected'
        match.batchVerdict = effectiveConfirmed ? 'CONFIRMED' : p.verdict
        match.batchReason =
          preserveUserChoice && !isConfirmed
            ? `User verified selection preserved (${match.reason || 'User review'})`
            : p.reason
        match.batchModel = chosenModel
        match.batchTimestamp = Date.now()
        match.rescanRequired = !effectiveConfirmed
        if (effectiveConfirmed) {
          match.verified = true
          match.rejected = false

          // Remove any duplicate / competing candidates for this same short segment
          // from scan.matches so they never pollute side-by-side or corrupt merge preview
          freshScan.matches = freshScan.matches.filter((m) => {
            if (m === match) return true
            if (m.userPick) return true // User pick is preserved

            const overlap = Math.min(m.shortEnd, match!.shortEnd) - Math.max(m.shortStart, match!.shortStart)
            const shorter = Math.min(m.shortEnd - m.shortStart, match!.shortEnd - match!.shortStart)
            const isConflict =
              Math.abs(m.shortStart - match!.shortStart) < 0.35 ||
              overlap > 0.25 ||
              (shorter > 0 && overlap / shorter >= 0.25)

            if (!isConflict) return true

            // If m is not confirmed, drop it
            if (m.batchVerified !== 'confirmed' && !m.verified) return false

            // If BOTH are confirmed, the one with longer duration or higher confidence stays
            const mDur = m.shortEnd - m.shortStart
            const matchDur = match!.shortEnd - match!.shortStart
            if (matchDur >= mDur) {
              return false
            }
            return true
          })
        } else {
          match.verified = false
          match.rejected = true
        }
      }

      // Also update CandidateGroups if present
      if (freshScan.candidateGroups) {
        const group = freshScan.candidateGroups.find(
          (g) =>
            sameShortSegment(g.shortStart, g.shortEnd, p.shortStart, p.shortEnd) ||
            Math.max(0, Math.min(g.shortEnd, p.shortEnd) - Math.max(g.shortStart, p.shortStart)) > 0.1,
        )
        if (group) {
          const candIdx = group.candidates.findIndex(
            (c) => Math.abs(c.movieStart - p.movieStart) < 0.5,
          )
          if (isConfirmed) {
            group.status = 'confirmed'
            if (candIdx >= 0) {
              group.confirmedIndex = candIdx
              group.candidates[candIdx].verdict = 'same'
              group.candidates[candIdx].verifierReason = p.reason
              group.candidates[candIdx].verifierModel = chosenModel
            }
          } else {
            group.status = 'rejected'
            if (candIdx >= 0) {
              group.candidates[candIdx].verdict = 'different'
              group.candidates[candIdx].verifierReason = p.reason
              group.candidates[candIdx].verifierModel = chosenModel
            }
          }
        }
      }
    }

    // Deduplicate freshScan.matches to guarantee NO overlapping matches ever exist on the timeline
    const deduplicatedMatches: ChunkMatch[] = []
    const sortedMatches = [...freshScan.matches].sort((a, b) => {
      if (Math.abs(a.shortStart - b.shortStart) > 0.2) {
        return a.shortStart - b.shortStart
      }
      const aPick = a.userPick ? 1 : 0
      const bPick = b.userPick ? 1 : 0
      if (aPick !== bPick) return bPick - aPick

      const aConf = (a.verified || a.batchVerified === 'confirmed') ? 1 : 0
      const bConf = (b.verified || b.batchVerified === 'confirmed') ? 1 : 0
      if (aConf !== bConf) return bConf - aConf

      const aDur = a.shortEnd - a.shortStart
      const bDur = b.shortEnd - b.shortStart
      if (Math.abs(aDur - bDur) > 0.1) return bDur - aDur

      return (b.confidence || 0) - (a.confidence || 0)
    })

    for (const m of sortedMatches) {
      const conflictIndex = deduplicatedMatches.findIndex((existing) =>
        sameShortSegment(existing.shortStart, existing.shortEnd, m.shortStart, m.shortEnd),
      )

      if (conflictIndex === -1) {
        deduplicatedMatches.push(m)
      } else {
        const existing = deduplicatedMatches[conflictIndex]
        const existingPriority =
          (existing.userPick ? 10000 : 0) +
          ((existing.verified || existing.batchVerified === 'confirmed') ? 1000 : 0) +
          (existing.shortEnd - existing.shortStart) * 10 +
          (existing.confidence || 0)

        const mPriority =
          (m.userPick ? 10000 : 0) +
          ((m.verified || m.batchVerified === 'confirmed') ? 1000 : 0) +
          (m.shortEnd - m.shortStart) * 10 +
          (m.confidence || 0)

        const winner = mPriority > existingPriority ? m : existing
        const loser = mPriority > existingPriority ? existing : m

        if (mPriority > existingPriority) {
          deduplicatedMatches[conflictIndex] = m
        }

        // Store the alternative match into CandidateGroups so it appears as a selectable candidate
        // in side-by-side compare and candidate chooser instead of colliding on the timeline
        if (!Array.isArray(freshScan.candidateGroups)) freshScan.candidateGroups = []
        let g = freshScan.candidateGroups.find((x) =>
          sameShortSegment(x.shortStart, x.shortEnd, winner.shortStart, winner.shortEnd),
        )
        if (!g) {
          g = {
            id: `g${freshScan.candidateGroups.length}-${Math.random().toString(36).slice(2, 8)}`,
            shortStart: winner.shortStart,
            shortEnd: winner.shortEnd,
            status: winner.verified ? 'confirmed' : 'pending',
            candidates: [],
            confirmedIndex: winner.verified ? 0 : null,
            confirmedViaRescan: false,
            attempts: 0,
            origin: winner.origin ?? 'chunk',
            originWindow: winner.originWindow,
          }
          freshScan.candidateGroups.push(g)
        }

        const hasWinner = g.candidates.some(
          (c) => c.chunkIndex === winner.chunkIndex && Math.abs(c.movieStart - winner.movieStart) < 0.5,
        )
        if (!hasWinner) {
          g.candidates.unshift({
            shortStart: winner.shortStart,
            shortEnd: winner.shortEnd,
            movieStart: winner.movieStart,
            movieEnd: winner.movieEnd,
            chunkIndex: winner.chunkIndex,
            model: winner.model,
            confidence: winner.confidence,
            verdict: winner.verified ? 'same' : winner.rejected ? 'different' : 'pending',
            rescan: 'none',
          })
        }

        const hasLoser = g.candidates.some(
          (c) => c.chunkIndex === loser.chunkIndex && Math.abs(c.movieStart - loser.movieStart) < 0.5,
        )
        if (!hasLoser) {
          g.candidates.push({
            shortStart: loser.shortStart,
            shortEnd: loser.shortEnd,
            movieStart: loser.movieStart,
            movieEnd: loser.movieEnd,
            chunkIndex: loser.chunkIndex,
            model: loser.model,
            confidence: loser.confidence,
            verdict: loser.verified ? 'same' : loser.rejected ? 'different' : 'pending',
            rescan: 'none',
          })
        }
      }
    }

    deduplicatedMatches.sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)
    freshScan.matches = deduplicatedMatches
    if (freshScan.report) {
      freshScan.report.matches = [...freshScan.matches]
    }

    saveScan(freshScan)
    logScan(
      scanId,
      'success',
      `[Batch Verifier] Min ${minuteIndex + 1} complete on ${chosenModel}! ✅ ${confirmedCount} Confirmed · ❌ ${rejectedCount} Rejected (Rescan Required)`,
    )

    return minuteResult
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    minuteResult.status = 'error'
    minuteResult.error = msg
    minuteResult.updatedAt = Date.now()
    const errorScan = getScan(scanId)
    if (errorScan) {
      const errorState = getOrCreateBatchVerifyState(errorScan)
      errorState.results[minuteIndex] = minuteResult
      saveScan(errorScan)
    }
    logScan(scanId, 'error', `[Batch Verifier] Min ${minuteIndex + 1} failed: ${msg}`)
    throw err
  } finally {
    // Cleanup local temp clips
    if (shortClipPath && fs.existsSync(/*turbopackIgnore: true*/ shortClipPath)) {
      try {
        fs.unlinkSync(shortClipPath)
      } catch {}
    }
    if (movieClipPath && fs.existsSync(/*turbopackIgnore: true*/ movieClipPath)) {
      try {
        fs.unlinkSync(movieClipPath)
      } catch {}
    }
  }
}

/**
 * Execute batch verification for ALL minutes of the short video concurrently.
 */
export async function startBatchVerificationAll(scanId: string): Promise<void> {
  const existingToken = activeCancelTokens.get(scanId)
  if (existingToken && !existingToken.isCancelled()) {
    logScan(scanId, 'info', `[Batch Verifier] Verification is already running for this scan.`)
    return
  }

  const scan = getScan(scanId)
  if (!scan) throw new Error(`Scan ${scanId} not found`)

  const totalDuration = scan.shortDuration || 60
  const minuteCount = Math.max(1, Math.ceil(totalDuration / 60))

  const token = new CancelToken()
  activeCancelTokens.set(scanId, token)

  const state = getOrCreateBatchVerifyState(scan)
  state.status = 'running'
  state.startedAt = Date.now()
  state.finishedAt = null
  state.progress = `Starting verification across ${minuteCount} minute(s)...`
  saveScan(scan)

  logScan(scanId, 'info', `[Batch Verifier] Starting parallel 24 FPS verification for ${minuteCount} minute(s) across available API keys & models...`)

  // Process minutes with bounded concurrency across coordinator lanes
  void (async () => {
    try {
      const pendingMinutes = Array.from({ length: minuteCount }, (_, minIdx) => minIdx)
      // Process minutes with bounded concurrency (max 2 per scan to leave headroom for other parallel scans)
      const CONCURRENCY = Math.min(2, minuteCount)
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (pendingMinutes.length > 0) {
          if (token.isCancelled()) break
          const minIdx = pendingMinutes.shift()
          if (minIdx === undefined) break
          try {
            await verifySingleMinute(scanId, minIdx, token)
          } catch (err) {
            console.warn(`[Batch Verifier] Error in minute ${minIdx + 1}:`, err)
            const ge = classifyError(err)
            if (ge.kind === 'policy_blocked') {
              logScan(
                scanId,
                'error',
                `[Batch Verifier] Prohibited content detected on Minute ${minIdx + 1}.`,
              )
            }
          }
        }
      })

      await Promise.all(workers)
    } finally {
      activeCancelTokens.delete(scanId)
      const latestScan = getScan(scanId)
      if (latestScan && latestScan.batchVerify) {
        latestScan.batchVerify.status = token.isCancelled() ? 'stopped' : 'done'
        latestScan.batchVerify.finishedAt = Date.now()
        saveScan(latestScan)
        logScan(scanId, 'success', `[Batch Verifier] All ${minuteCount} minute(s) verification completed.`)
      }
    }
  })()
}

/**
 * Cancel active batch verification for a scan.
 */
export function stopBatchVerification(scanId: string): void {
  const token = activeCancelTokens.get(scanId)
  if (token) {
    token.cancel()
    activeCancelTokens.delete(scanId)
  }
  const scan = getScan(scanId)
  if (scan && scan.batchVerify) {
    scan.batchVerify.status = 'stopped'
    saveScan(scan)
    logScan(scanId, 'warn', `[Batch Verifier] Verification stopped by user.`)
  }
}
