import 'server-only'

import fs from 'node:fs'
import { getScan, saveScan, addLog, scanMediaDir } from './store'
import { ensureLocalMedia, localMediaPath } from './media'
import { probeDuration } from './ffmpeg'
import { planMergeTarget, mergeVideos, mergedFilePath } from './merge'
import { ensureIndex, fetchVideoEmbeddings, loadEmbeddings, saveEmbeddings, type TLSegment } from './twelvelabs'
import {
  createAsset,
  pollAssetReady,
  indexAsset,
  buildSegmentDefinitions,
  createSegmentationTask,
  pollSegmentationTask,
  buildMinuteSuggestions,
  PEGASUS_MAX_DURATION_SEC,
} from './pegasus'
import type { Scan, MergePipelineState } from './types'

// ---------------------------------------------------------------------------
// AUTO PIPELINE ORCHESTRATOR (fire-and-forget, same pattern as the old
// manual indexing route):
//
//   [1] checking   — ffprobe both files, target = movie resolution/fps
//   [2] merging    — precise re-encode (short + FULL movie normalized to the
//                    target, parallel parts on every core, one final join) +
//                    duration check
//   [3] uploading  — merged.mp4 → TwelveLabs asset
//   [4] indexing   — Marengo index via indexed-assets → embeddings download
//   [5] splitting  — time-split embeddings at short-end (short / movie sets)
//   [6] segmenting — Pegasus 1.5 segmentation (> 2h => SKIP + error)
//   [7] suggesting — segment_4 → minute list → awaiting_approval
//
// Retry resumes from the failed step: every step checks its cached output
// (merged.mp4 / assetId / saved embeddings / stored segments) and skips work
// that is already done. Any error stops the pipeline with a clear Hinglish
// message; the manual "Full scan" fallback (minute-select) always keeps
// working because it never depends on this pipeline.
// ---------------------------------------------------------------------------

// Per-process lock so a double-trigger never starts two pipelines.
const running = new Set<string>()

export function isPipelineRunning(id: string): boolean {
  return running.has(id)
}

function setState(id: string, patch: Partial<MergePipelineState>): Scan | null {
  const s = getScan(id)
  if (!s) return null
  s.mergePipeline = { ...(s.mergePipeline || { status: 'idle' }), ...patch }
  saveScan(s)
  return s
}

function log(id: string, level: 'info' | 'warn' | 'error' | 'success', msg: string) {
  const s = getScan(id)
  if (!s) return
  addLog(s, level, msg)
  saveScan(s)
}

function fmtDur(sec: number): string {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m ${String(ss).padStart(2, '0')}s` : `${m}m ${ss}s`
}

/** Can the pipeline run for this scan? (both videos in, trim confirmed) */
export function pipelineReady(scan: Scan): boolean {
  return Boolean(scan.shortDuration && scan.movieDuration && scan.awaitingTrim === false)
}

/**
 * Kick off (or retry) the auto merge → index → segmentation pipeline.
 * Fire-and-forget: returns immediately; the UI polls GET /merge-pipeline.
 */
export function startMergePipeline(scanId: string, tlKey: string): { ok: boolean; error?: string } {
  const scan = getScan(scanId)
  if (!scan) return { ok: false, error: 'Scan not found' }
  if (!pipelineReady(scan)) {
    return { ok: false, error: 'Short + movie dono upload + trim confirm hone ke baad hi pipeline chalti hai.' }
  }
  if (running.has(scanId)) return { ok: false, error: 'Pipeline already running' }
  const st = scan.mergePipeline?.status
  if (st === 'awaiting_approval' || st === 'approved') {
    return { ok: false, error: 'Pipeline already complete — minute list ready hai.' }
  }

  running.add(scanId)
  setState(scanId, { status: 'checking', error: null, startedAt: Date.now(), finishedAt: null, progress: 'Checking codec/resolution...' })
  log(scanId, 'info', 'Auto pipeline start: merge → TwelveLabs upload → Marengo index → Pegasus segmentation → minute list')

  void runPipeline(scanId, tlKey)
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      setState(scanId, { status: 'error', error: msg, finishedAt: Date.now() })
      log(scanId, 'error', `Pipeline error: ${msg}`)
    })
    .finally(() => {
      running.delete(scanId)
    })

  return { ok: true }
}

async function runPipeline(id: string, tlKey: string): Promise<void> {
  const scan0 = getScan(id)
  if (!scan0 || !scan0.shortDuration || !scan0.movieDuration) throw new Error('Scan/media state missing')
  const shortDuration = scan0.shortDuration
  const movieDuration = scan0.movieDuration
  const mediaDir = scanMediaDir(id)
  const mergedFile = mergedFilePath(mediaDir)

  // Ensure originals exist locally (cold start => re-download from Blob).
  setState(id, { status: 'checking', progress: 'Checking video files...' })
  const shortFile = (await ensureLocalMedia(id, 'short')) || localMediaPath(id, 'short')
  const movieFile = (await ensureLocalMedia(id, 'movie')) || localMediaPath(id, 'movie')
  if (!fs.existsSync(shortFile) || !fs.existsSync(movieFile)) {
    throw new Error('Short/movie file server par nahi mili — dobara upload karke retry karo.')
  }

  // ---- [1] + [2] Compat check + merge (skip when merged.mp4 already valid) ----
  let mergedDuration: number
  const expectedDuration = shortDuration + movieDuration
  const cachedMergeOk = fs.existsSync(mergedFile) && fs.statSync(mergedFile).size > 0
  if (cachedMergeOk) {
    setState(id, { status: 'merging', progress: 'Merged file cached — validating...' })
    mergedDuration = await probeDuration(mergedFile)
    log(id, 'info', `Merge cached: merged.mp4 already exists (${fmtDur(mergedDuration)}) — skip re-merge`)
  } else {
    setState(id, { status: 'checking', progress: 'Probing codec/resolution...' })
    log(id, 'info', 'Probing codec/resolution... (target = movie ki resolution/fps; short usme scale/pad hoga — koi format restriction nahi)')
    const plan = await planMergeTarget(shortFile, movieFile)
    if (!plan.ok) {
      log(id, 'error', plan.reason)
      throw new Error(plan.reason)
    }
    log(id, 'success', `Merge target: ${plan.target.summary}`)

    setState(id, { status: 'merging', progress: 'Merging PART A + PART B (precise re-encode)...' })
    log(id, 'info', `Merging PART A (short ${fmtDur(shortDuration)}) + PART B (movie ${fmtDur(movieDuration)})... (precise re-encode, all cores, frame-accurate join)`)
    const merged = await mergeVideos(shortFile, movieFile, mergedFile, {
      scanId: id,
      onLog: (msg) => log(id, msg.includes('MISMATCH') ? 'warn' : 'info', msg),
      onProgress: (pct, note) => setState(id, { status: 'merging', progress: `Merging ${pct}% — ${note}` }),
    })
    mergedDuration = merged.duration
    log(id, 'success', `Merge complete — total ${fmtDur(mergedDuration)} (${merged.target.width}x${merged.target.height} @ ${merged.target.fps}fps)`)
  }

  // Duration validation: merged ≈ short + movie (>1.5s difference => WARN only).
  if (Math.abs(mergedDuration - expectedDuration) > 1.5) {
    log(
      id,
      'warn',
      `Duration mismatch: merged ${fmtDur(mergedDuration)} vs expected ${fmtDur(expectedDuration)} (short+movie) — audio sync check karo`,
    )
  }
  setState(id, { shortEnd: shortDuration, mergedDuration })

  // ---- [3] + [4] Upload asset + Marengo index (skip when embeddings cached) ----
  let assetId = getScan(id)?.mergePipeline?.assetId || null
  const cachedMovieEmb = await loadEmbeddings(id, 'movie')
  const cachedShortEmb = await loadEmbeddings(id, 'short')
  const embeddingsCached = Boolean(cachedMovieEmb && cachedShortEmb)

  if (!embeddingsCached) {
    if (!assetId) {
      setState(id, { status: 'uploading', progress: 'Uploading merged video to TwelveLabs...' })
      log(id, 'info', 'Uploading merged video to TwelveLabs (ek hi upload — asset)...')
      assetId = await createAsset(tlKey, mergedFile)
      setState(id, { assetId })
      await pollAssetReady(tlKey, assetId, {
        onTick: (st) => setState(id, { status: 'uploading', progress: `Asset upload: ${st}...` }),
      })
      log(id, 'success', `Asset ready on TwelveLabs (${assetId})`)
    } else {
      // Asset cached from a previous attempt — make sure it is ready.
      setState(id, { status: 'uploading', progress: 'Asset cached — verifying...' })
      try {
        await pollAssetReady(tlKey, assetId, { timeoutMs: 60_000, onTick: () => {} })
        log(id, 'info', `Asset cached (${assetId}) — upload skip`)
      } catch {
        log(id, 'warn', 'Cached asset invalid — re-uploading merged video')
        setState(id, { status: 'uploading', progress: 'Re-uploading merged video...' })
        assetId = await createAsset(tlKey, mergedFile)
        setState(id, { assetId })
        await pollAssetReady(tlKey, assetId, {
          onTick: (st) => setState(id, { status: 'uploading', progress: `Asset upload: ${st}...` }),
        })
      }
    }

    setState(id, { status: 'indexing', progress: 'Marengo indexing (indexed-assets)...' })
    log(id, 'info', 'Marengo index start (merged video — ek hi index, embeddings baad me time-split honge)')
    const tlStartedAt = Date.now()
    {
      const s = getScan(id)
      if (s) {
        s.twelveLabs = { status: 'indexing', progress: 'Indexing merged video...', error: null, startedAt: tlStartedAt }
        saveScan(s)
      }
    }
    const indexId = await ensureIndex(tlKey)
    const videoId = await indexAsset(tlKey, indexId, assetId, {
      onTick: (st) => {
        setState(id, { status: 'indexing', progress: `Indexing: ${st}...` })
        const s = getScan(id)
        if (s) {
          s.twelveLabs = { ...(s.twelveLabs || { status: 'indexing' }), status: 'indexing', indexId, progress: `Indexing: ${st}...` }
          saveScan(s)
        }
      },
    })
    setState(id, { status: 'indexing', progress: 'Downloading embeddings...' })
    log(id, 'info', 'Index ready — downloading segment embeddings...')
    const segments = await fetchVideoEmbeddings(tlKey, indexId, videoId)
    log(id, 'success', `Indexed — ${segments.length} segments (6s embeddings, merged video)`)

    // ---- [5] Time-split embeddings at the PART A boundary ----
    setState(id, { status: 'splitting', progress: 'Splitting embeddings at short-end...' })
    const shortSegs: TLSegment[] = []
    const movieSegs: TLSegment[] = []
    for (const seg of segments) {
      // Boundary-straddling segment goes where its MIDPOINT lies — never both.
      const mid = (seg.start + seg.end) / 2
      if (mid < shortDuration) {
        // PART A — times already 0-based short seconds.
        shortSegs.push(seg)
      } else {
        // PART B — shift to ORIGINAL-movie seconds (movieTime = mergedTime − shortDuration).
        movieSegs.push({
          ...seg,
          start: Math.max(0, seg.start - shortDuration),
          end: Math.max(0, seg.end - shortDuration),
        })
      }
    }
    await saveEmbeddings(id, 'short', { indexId, videoId, savedAt: Date.now(), segments: shortSegs })
    await saveEmbeddings(id, 'movie', { indexId, videoId, savedAt: Date.now(), segments: movieSegs })
    log(
      id,
      'success',
      `Embeddings time-split: ${shortSegs.length} short (PART A) + ${movieSegs.length} movie (PART B, offset -${Math.round(shortDuration)}s) — 1 upload, 1 index, dono kaam`,
    )
    {
      const s = getScan(id)
      if (s) {
        const totalMs = Date.now() - tlStartedAt
        s.twelveLabs = {
          status: 'ready',
          indexId,
          videoId,
          segmentCount: movieSegs.length,
          indexedAt: Date.now(),
          startedAt: tlStartedAt,
          totalMs,
          error: null,
        }
        saveScan(s)
      }
    }
  } else {
    log(id, 'info', 'Embeddings already cached (short + movie) — upload/index/split skip')
    const s = getScan(id)
    if (s && s.twelveLabs?.status !== 'ready') {
      s.twelveLabs = { ...(s.twelveLabs || { status: 'ready' }), status: 'ready', segmentCount: cachedMovieEmb!.segments.length, error: null }
      saveScan(s)
    }
  }

  // ---- Duration gate: Pegasus segmentation max 2 hours ----
  if (mergedDuration > PEGASUS_MAX_DURATION_SEC) {
    const msg = `Merged video 2 ghante se zyada hai (${fmtDur(mergedDuration)}) — Pegasus segmentation limit exceed. Chhoti movie/trim use karo. (Index + embeddings ready hain — manual Full scan fallback chalega)`
    setState(id, { segmentationSkipped: true, status: 'error', error: msg, finishedAt: Date.now() })
    log(id, 'error', msg)
    return
  }

  // ---- [6] Pegasus segmentation (cached segments => skip) ----
  let segResult = getScan(id)?.mergePipeline?.segments || null
  if (!segResult || !Array.isArray(segResult.segment_4)) {
    if (!assetId) {
      // embeddings were cached but no asset — segmentation needs the asset.
      setState(id, { status: 'uploading', progress: 'Uploading merged video (segmentation asset)...' })
      log(id, 'info', 'Segmentation ke liye asset chahiye — uploading merged video...')
      assetId = await createAsset(tlKey, mergedFile)
      setState(id, { assetId })
      await pollAssetReady(tlKey, assetId, {
        onTick: (st) => setState(id, { status: 'uploading', progress: `Asset upload: ${st}...` }),
      })
    }
    setState(id, { status: 'segmenting', progress: 'Pegasus 1.5 segmentation start...' })
    const defs = buildSegmentDefinitions(shortDuration, mergedDuration)
    log(
      id,
      'info',
      `Pegasus 1.5 segmentation start (4 segment definitions, timings auto-filled: PART A 00:00–${fmtDur(shortDuration)}, max_tokens 96000)`,
    )
    const segTaskId = await createSegmentationTask(tlKey, assetId, defs)
    setState(id, { segTaskId })
    segResult = await pollSegmentationTask(tlKey, segTaskId, {
      onTick: (st) => setState(id, { status: 'segmenting', progress: `Segmentation: ${st}...` }),
    })
    setState(id, { segments: segResult })
    const counts = Object.entries(segResult)
      .map(([k, v]) => `${k}: ${v.length}`)
      .join(', ')
    log(id, 'success', `Pegasus segmentation complete — ${counts || 'no segments'}`)
  } else {
    log(id, 'info', 'Segmentation result cached — Pegasus skip')
  }

  // ---- [7] segment_4 → minute suggestions ----
  setState(id, { status: 'suggesting', progress: 'Building minute list from segment_4...' })
  const segment4 = segResult.segment_4 || []
  if (segment4.length === 0) {
    const msg = 'Pegasus segment_4 empty — koi match segments nahi mile. Retry karo ya manual Full scan fallback use karo.'
    log(id, 'error', msg)
    throw new Error(msg)
  }
  const { suggestions, skipped } = buildMinuteSuggestions(segment4, shortDuration)
  if (skipped > 0) {
    log(id, 'warn', `segment_4: ${skipped} entry(ies) skip hui (missing/PART-A-side part_b_timestamp)`)
  }
  if (suggestions.length === 0) {
    const msg = 'segment_4 se koi valid movie minute nahi bana — Retry karo ya manual Full scan fallback use karo.'
    log(id, 'error', msg)
    throw new Error(msg)
  }
  const listNote = suggestions.map((s) => `minute ${s.minute + 1} (${s.sceneCount} scene${s.sceneCount > 1 ? 's' : ''})`).join(', ')
  setState(id, {
    status: 'awaiting_approval',
    progress: 'Minute list ready — approval ka wait',
    minuteSuggestions: suggestions,
    finishedAt: Date.now(),
    error: null,
  })
  log(id, 'success', `Check karne hain: ${listNote} — UI me review karke approve karo, phir Gemini start hoga`)
}
