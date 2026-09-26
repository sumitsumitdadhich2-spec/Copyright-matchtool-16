import fs from 'node:fs'
import path from 'node:path'
import { IN_FLAGS, PART_AUDIO, PART_EXT, joinParts, probeDuration, probeHasAudio, scalePadFilter, verifyExportSync } from './ffmpeg'
import { CancelToken, FfmpegCancelled, engineCount, parallelMap, runFfmpeg, sliceProgress } from './ffmpeg-pool'
import { estimateBitrateBytes, placeWork, removeStageWork } from './work-dir'
import { getScan, saveScan, scanMediaDir, addLog } from './store'
import { RENDER_FPS_OPTIONS, isRenderFps, type RenderJob, type RenderResolution, type RenderSettings, type Scan } from './types'
import { buildRenderSegments, snapSegments, totalSnappedSeconds, type SnappedSegment } from './render-segments'
import { COVERAGE_MIN_GAP_SEC, coverageFromRanges, coverageLine, fmtShortTs, shortTotalOf } from './short-coverage'
import { originLabel } from './candidate-pick'

export { buildRenderSegments } from './render-segments'

// ---------------------------------------------------------------------------
// RENDER / EXPORT — precise, parallel, no stream copy.
//
//   Phase 1  every matched scene is cut from the ORIGINAL movie as its own
//            part file: `-ss <abs>` before `-i` (frame-accurate) + exact `-t`,
//            scaled/padded to the target geometry, CRF 18 intermediate
//            (near-lossless). All parts run CONCURRENTLY on the ffmpeg engine
//            pool (one single-threaded process per core).
//   Phase 2  parts are joined with the concat demuxer and RE-ENCODED once at
//            the user's bitrate/fps — identical geometry/fps/audio on every
//            part means the join is seamless, no A/V drift.
//   verify   ffprobe duration ≈ sum of scenes (±1 frame) — logged.
//
// Cancel kills every in-flight child through the CancelToken and drops queued
// parts immediately.
// ---------------------------------------------------------------------------

// ---------- Settings validation ----------

export const RESOLUTION_MAP: Record<RenderResolution, { w: number; h: number }> = {
  '480p': { w: 854, h: 480 },
  '720p': { w: 1280, h: 720 },
  '1080p': { w: 1920, h: 1080 },
  '2k': { w: 2560, h: 1440 },
  '4k': { w: 3840, h: 2160 },
}

export function validateRenderSettings(input: unknown): { ok: true; settings: RenderSettings } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Missing render settings' }
  const s = input as Partial<RenderSettings>
  if (!s.resolution || !(s.resolution in RESOLUTION_MAP)) {
    return { ok: false, error: 'Invalid resolution (480p, 720p, 1080p, 2k, 4k)' }
  }
  const fps = Number(s.fps)
  if (!isRenderFps(fps)) {
    return { ok: false, error: `Invalid FPS. Choose one of: ${RENDER_FPS_OPTIONS.join(', ')}` }
  }
  const vb = Number(s.videoBitrateKbps)
  if (!Number.isFinite(vb) || vb < 250 || vb > 100000) {
    return { ok: false, error: 'Video bitrate must be between 250 and 100000 kbps' }
  }
  const ab = Number(s.audioBitrateKbps)
  if (!Number.isFinite(ab) || ab < 32 || ab > 320) {
    return { ok: false, error: 'Audio bitrate must be between 32 and 320 kbps' }
  }
  const headPad = Number(s.headPaddingSec)
  const headPaddingSec = Number.isFinite(headPad) && headPad > 0 ? Math.min(60, Math.round(headPad)) : 0
  const tailPad = Number(s.tailPaddingSec)
  const tailPaddingSec = Number.isFinite(tailPad) && tailPad > 0 ? Math.min(60, Math.round(tailPad)) : 0

  return {
    ok: true,
    settings: {
      resolution: s.resolution,
      fps,
      videoBitrateKbps: Math.round(vb),
      audioBitrateKbps: Math.round(ab),
      headPaddingSec,
      tailPaddingSec,
    },
  }
}

// ---------- Render job manager (one render at a time per scan) ----------

// Survives route-module reloads in dev.
const g = globalThis as unknown as { __cmtActiveRenders?: Map<string, CancelToken> }
const activeRenders: Map<string, CancelToken> = g.__cmtActiveRenders ?? new Map()
g.__cmtActiveRenders = activeRenders

export function isRenderActive(scanId: string): boolean {
  return activeRenders.has(scanId)
}

export function renderOutputPath(scanId: string): string {
  return path.join(scanMediaDir(scanId), 'render.mp4')
}

/** Remove an export that was built from an older match list.
 *  The caller must reject active/persisted renders before invoking this. */
export function invalidateRenderedOutput(scan: Scan): boolean {
  if (isRenderActive(scan.id) || scan.renderJob?.status === 'rendering') return false

  const output = renderOutputPath(scan.id)
  const hadFile = fs.existsSync(output)
  const hadCompletedJob = scan.renderJob?.status === 'done'
  if (!hadFile && !hadCompletedJob) return false

  fs.rmSync(output, { force: true })
  if (scan.renderJob) {
    const settings = scan.renderJob.settings
    scan.renderJob = {
      status: 'idle',
      settings,
      pct: 0,
      etaSeconds: null,
      totalOutputSeconds: 0,
      segmentCount: 0,
      error: null,
      startedAt: null,
      finishedAt: null,
      fileSize: null,
    }
  }
  return true
}

const RENDER_STAGE = 'render-parts'

/** HH:MM:SS.mmm on the ORIGINAL movie clock (scene logs). */
function movieClock(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s - h * 3600 - m * 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${r.toFixed(3).padStart(6, '0')}`
}

function freshJob(settings: RenderSettings, totalOutputSeconds: number, segmentCount: number): RenderJob {
  return {
    status: 'rendering',
    settings,
    pct: 0,
    etaSeconds: null,
    totalOutputSeconds,
    segmentCount,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    fileSize: null,
  }
}

/**
 * Start a background render. Returns an error string if it cannot start.
 * Progress is persisted into scan.renderJob (throttled), so the existing
 * GET /api/scans/[id] polling picks it up with no extra wiring.
 */
export async function startRender(scanId: string, settings: RenderSettings): Promise<string | null> {
  if (activeRenders.has(scanId)) return 'A render is already in progress for this scan'

  const scan = getScan(scanId)
  if (!scan) return 'Scan not found'
  // PARTIAL EXPORT: stopped scans can render too — whatever matched so far
  // (verified + unverified) gets exported; Resume still continues the scan.
  if (scan.status !== 'done' && scan.status !== 'stopped') {
    return 'Scan must be complete or stopped before rendering'
  }
  if (scan.renderJob?.status === 'rendering') {
    // stale flag from a crashed process — recover instead of blocking forever
    scan.renderJob.status = 'error'
    scan.renderJob.error = 'Previous render was interrupted'
    saveScan(scan, { immediate: true })
  }

  const rawSegments = buildRenderSegments(scan)
  const headPad = Math.max(0, settings.headPaddingSec || 0)
  const tailPad = Math.max(0, settings.tailPaddingSec || 0)
  const maxMovieDur = scan.movieDuration && scan.movieDuration > 0 ? scan.movieDuration : Infinity

  const effectiveSegments = rawSegments.map((seg) => {
    const paddedMovieStart = Math.max(0, seg.movieStart - headPad)
    const paddedMovieEnd = Math.min(maxMovieDur, Math.max(paddedMovieStart + 0.05, seg.movieEnd + tailPad))
    return {
      ...seg,
      movieStart: paddedMovieStart,
      movieEnd: paddedMovieEnd,
    }
  })

  // FRAME GRID: scenes are snapped to the output fps before anything is
  // encoded, so the expected total is an exact frame count (see render-segments).
  const segments = snapSegments(effectiveSegments, settings.fps)
  if (segments.length === 0) return 'No matched scenes to render'

  const mediaDir = scanMediaDir(scanId)
  const movieFile = path.join(mediaDir, 'movie.mp4')
  if (!fs.existsSync(movieFile)) return 'Original movie file not found'

  // Claim the scan before the first await. Without this lock, a candidate pick
  // could change scan.matches while audio probing was still using old segments.
  const token = new CancelToken()
  activeRenders.set(scanId, token)

  // Silent movie: audio stream refs would make ffmpeg fail — synthesize silence instead.
  let hasAudio: boolean
  try {
    hasAudio = await probeHasAudio(movieFile)
  } catch (error) {
    activeRenders.delete(scanId)
    return `Could not inspect movie audio: ${error instanceof Error ? error.message : String(error)}`
  }

  // Audio probing succeeded, so this attempt can now replace any older export.
  fs.rmSync(renderOutputPath(scanId), { force: true })

  const totalOut = totalSnappedSeconds(segments, settings.fps)
  scan.renderJob = freshJob(settings, totalOut, segments.length)
  const engines = engineCount()
  addLog(
    scan,
    'info',
    `Render started: ${segments.length} scenes, ${totalOut.toFixed(3)}s output (${segments.reduce((n, s) => n + s.frames, 0)} frames @ ${settings.fps}fps), ${settings.resolution}, ${settings.videoBitrateKbps}kbps video / ${settings.audioBitrateKbps}kbps audio${headPad > 0 || tailPad > 0 ? ` [Padding: head +${headPad}s, tail +${tailPad}s per clip]` : ''} — ${Math.min(engines, segments.length)} part(s) at a time on ${engines} engines, precise re-encode (no stream copy)${scan.status === 'stopped' ? ' — PARTIAL export (scan stopped; ab tak ke matches)' : ''}`,
  )
  // COVERAGE of what is ACTUALLY being rendered (not just what the scan matched):
  // overlap trimming and duplicate skipping happen in buildRenderSegments, so
  // this is the honest "kitna short output me ja raha hai" number.
  const shortTotal = shortTotalOf(scan)
  if (shortTotal > 0) {
    const cov = coverageFromRanges(
      segments.map((s) => ({ start: s.shortStart, end: s.shortEnd })),
      shortTotal,
    )
    const line = coverageLine(cov, '(render input)')
    addLog(scan, line.level, line.msg)
    if (cov.missingSec >= COVERAGE_MIN_GAP_SEC) {
      addLog(
        scan,
        'warn',
        `Expected output = ${totalOut.toFixed(3)} s (short is ${shortTotal.toFixed(3)} s, ${cov.missingSec.toFixed(1)} s NOT rendered) — missing: ${cov.gaps
          .slice(0, 20)
          .map((gp) => `${fmtShortTs(gp.start)}–${fmtShortTs(gp.end)}`)
          .join(', ')}${cov.gaps.length > 20 ? ` … +${cov.gaps.length - 20} more` : ''}`,
      )
    }
    scan.renderJob.coverage = cov
    scan.renderJob.shortSeconds = shortTotal
  }
  saveScan(scan)

  // Fire and forget — progress lands in scan.renderJob.
  void runRenderPipeline(scanId, settings, segments, movieFile, hasAudio, totalOut, token)

  return null
}

/** Part encode: frame-accurate cut + CRF 18 intermediate at the final geometry/fps.
 *
 *  EXACT LENGTH: the scene's snapped frame count is forced with `-frames:v` and
 *  the audio is trimmed to the matching `frames / fps` seconds. Without this the
 *  `fps=` filter rounded a 28.008-frame scene UP to 29 frames (+41 ms), which
 *  stacked into +1.78 s of drift across a 77-scene render. A little extra input
 *  is read (`-t` + one frame) so the last frame is always available to encode. */
function partArgs(movieFile: string, hasAudio: boolean, seg: SnappedSegment, w: number, h: number, fps: number, partFile: string): string[] {
  const snapDur = seg.snapDur
  const readDur = snapDur + 2 / fps
  const args: string[] = ['-y', ...IN_FLAGS]
  if (seg.movieStart > 0.0005) args.push('-ss', seg.movieStart.toFixed(6))
  args.push('-t', readDur.toFixed(6), '-i', movieFile)
  if (!hasAudio) args.push('-f', 'lavfi', '-t', readDur.toFixed(6), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
  args.push(
    '-filter_complex',
    `[0:v]${scalePadFilter(w, h, fps)},trim=end_frame=${seg.frames},setpts=PTS-STARTPTS[v];${hasAudio ? '[0:a]' : '[1:a]'}aresample=48000:async=0:first_pts=0,aformat=channel_layouts=stereo,apad=whole_len=${Math.round(snapDur * 48000)},atrim=end_sample=${Math.round(snapDur * 48000)},asetpts=N/SR/TB[a]`,
    '-map', '[v]', '-map', '[a]',
    '-frames:v', String(seg.frames), '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-bf', '0',
    // Lossless PCM audio in parts: AAC priming/padding per part stacked up to
    // +2.3 s over 48 scenes (audio ran long, seams shifted, A/V drifted).
    ...PART_AUDIO, '-ac', '2',
    // Do not shift timestamps on intermediates. With B-frames,
    // `avoid_negative_ts=make_zero` added two frames to every MOV duration.
    '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p', '-threads', '1',
    partFile,
  )
  return args
}

async function runRenderPipeline(
  scanId: string,
  settings: RenderSettings,
  segments: SnappedSegment[],
  movieFile: string,
  hasAudio: boolean,
  totalOut: number,
  token: CancelToken,
) {
  const { w, h } = RESOLUTION_MAP[settings.resolution]
  const outFile = renderOutputPath(scanId)

  let lastSave = 0
  const persist = (mutate: (s: Scan) => void, force = false) => {
    const now = Date.now()
    if (!force && now - lastSave < 800) return
    lastSave = now
    const fresh = getScan(scanId)
    if (!fresh) return
    mutate(fresh)
    saveScan(fresh)
  }
  const log = (level: 'info' | 'warn' | 'error' | 'success', msg: string) =>
    persist((s) => addLog(s, level, msg), true)

  const setProgress = (pct: number, eta: number | null) =>
    persist((s) => {
      if (!s.renderJob || s.renderJob.status !== 'rendering') return
      s.renderJob.pct = pct
      s.renderJob.etaSeconds = eta
    })

  // Intermediates at CRF 18 are roughly 2.5× the target bitrate — estimate for
  // RAM/disk placement (spills to DATA_DIR/work when the tmpfs budget is tight).
  const estimate = estimateBitrateBytes(totalOut, Math.max(settings.videoBitrateKbps * 2.5, 6000), 192)
  const placement = placeWork(scanId, RENDER_STAGE, estimate)
  const partsDir = placement.dir
  const cleanupParts = () => removeStageWork(scanId, RENDER_STAGE)

  try {
    log('info', `Render parts → ${placement.inRam ? 'RAM' : 'disk'} work dir (est ${(estimate / 1048576).toFixed(0)} MB)`)

    // ---- Phase 1: every scene as its own part, all engines busy (0..70 %). ----
    const partFiles = segments.map((_, i) => path.join(partsDir, `part-${String(i).padStart(4, '0')}${PART_EXT}`))
    const startedAt = Date.now()
    const progress = sliceProgress((doneSec, speed) => {
      const pct = Math.min(70, Math.round((doneSec / Math.max(0.1, totalOut)) * 70))
      // ETA: remaining parts at aggregate speed + join (≈ 1× realtime at medium preset, spread over cores)
      const remainingParts = Math.max(0, totalOut - doneSec)
      const eta = speed && speed > 0 ? Math.round(remainingParts / speed + totalOut * 0.6) : null
      setProgress(pct, eta)
    })

    await parallelMap(segments, async (seg, i) => {
      const dur = seg.snapDur
      const t0 = Date.now()
      await runFfmpeg(partArgs(movieFile, hasAudio, seg, w, h, settings.fps, partFiles[i]), {
        label: `render ${scanId.slice(0, 6)} part ${i + 1}/${segments.length}`,
        owner: scanId,
        token,
        onStderr: progress.forSlice(i, dur),
      })
      progress.complete(i, dur)
      const secs = (Date.now() - t0) / 1000
      const check = await verifyExportSync(partFiles[i], dur, settings.fps)
      const flags = `${seg.rejected ? ' rejected-kept' : ''}${seg.unverified ? ' unverified' : ''}`
      // FORCED persist: the 800 ms throttle used to silently drop most of these
      // (only 10 of 77 scene lines survived a real render).
      log(
        check.ok ? 'info' : 'error',
        `Scene ${i + 1}/${segments.length}: movie ${movieClock(seg.movieStart)} → ${movieClock(seg.movieEnd)} (${dur.toFixed(3)}s, ${seg.frames}f) [short ${fmtShortTs(seg.shortStart)}] origin=${originLabel(seg.origin, seg.originWindow)}${flags} encoded in ${secs.toFixed(1)}s (${(dur / Math.max(0.1, secs)).toFixed(1)}x) — video ${check.video.duration.toFixed(3)}s/${check.video.frames ?? '?'}f, audio ${check.audio.duration.toFixed(3)}s${check.ok ? '' : ` — INVALID: ${check.issues.join('; ')}`}`,
      )
      if (!check.ok) throw new Error(`Scene ${i + 1} failed timeline verification: ${check.issues.join('; ')}`)
    })
    if (token.cancelled) throw new FfmpegCancelled()
    const partsWall = (Date.now() - startedAt) / 1000
    log('info', `All ${segments.length} scene part(s) done in ${partsWall.toFixed(1)}s — joining with precise re-encode at ${settings.videoBitrateKbps}kbps...`)

    // ---- Phase 2: concat + final re-encode at the user's quality (70..99 %). ----
    const joinStarted = Date.now()
    await joinParts(
      partFiles,
      {
        scanId,
        width: w,
        height: h,
        fps: settings.fps,
        channels: 2,
        preset: 'fast',
        final: { videoKbps: settings.videoBitrateKbps, audioKbps: settings.audioBitrateKbps },
        token,
        label: `render ${scanId.slice(0, 6)}`,
        onProgress: (pct) => {
          const done = ((pct - 70) / 29) * totalOut
          const elapsed = (Date.now() - joinStarted) / 1000
          const rate = done > 0 && elapsed > 0 ? done / elapsed : null
          setProgress(Math.min(99, pct), rate ? Math.max(0, Math.round((totalOut - done) / rate)) : null)
        },
        onLog: (msg) => persist((s) => addLog(s, msg.includes('MISMATCH') ? 'warn' : 'info', msg), true),
      },
      outFile,
      totalOut,
      undefined,
      { partDurations: segments.map((segment) => segment.snapDur), strict: true },
    )

    activeRenders.delete(scanId)
    cleanupParts()

    let size: number | null = null
    try {
      size = fs.statSync(outFile).size
    } catch {
      // ignore
    }
    let probedDur: number | null = null
    try {
      probedDur = await probeDuration(outFile)
    } catch {
      // ignore — file exists, size known
    }
    const wall = (Date.now() - startedAt) / 1000
    persist((s) => {
      if (!s.renderJob) return
      s.renderJob.status = 'done'
      s.renderJob.pct = 100
      s.renderJob.etaSeconds = 0
      s.renderJob.finishedAt = Date.now()
      s.renderJob.fileSize = size
      addLog(
        s,
        'success',
        `Render complete in ${wall.toFixed(1)}s: ${probedDur ? `${probedDur.toFixed(2)}s, ` : ''}${size ? `${(size / (1024 * 1024)).toFixed(1)} MB` : 'file ready'} — download available`,
      )
    }, true)
  } catch (err) {
    activeRenders.delete(scanId)
    cleanupParts()
    if (err instanceof FfmpegCancelled || token.cancelled) {
      try {
        if (fs.existsSync(outFile)) fs.unlinkSync(outFile)
      } catch {
        // ignore
      }
      persist((s) => {
        if (!s.renderJob) return
        s.renderJob.status = 'idle'
        s.renderJob.pct = 0
        s.renderJob.etaSeconds = null
        s.renderJob.error = null
        s.renderJob.finishedAt = null
        addLog(s, 'warn', 'Render cancelled')
      }, true)
      return
    }
    const msg = err instanceof Error ? err.message : String(err)
    persist((s) => {
      if (!s.renderJob) return
      s.renderJob.status = 'error'
      s.renderJob.error = msg.slice(0, 600)
      s.renderJob.finishedAt = Date.now()
      addLog(s, 'error', `Render failed: ${msg.slice(0, 200)}`)
    }, true)
  }
}

/** Cancel an in-flight render. Returns false when nothing is rendering. */
export function cancelRender(scanId: string): boolean {
  const token = activeRenders.get(scanId)
  if (token) {
    // Kills every running part/join child and drops queued parts.
    token.cancel()
    return true
  }
  // No live process (e.g. server restarted mid-render) — reset the persisted state.
  const scan = getScan(scanId)
  if (scan?.renderJob?.status === 'rendering') {
    scan.renderJob.status = 'idle'
    scan.renderJob.pct = 0
    scan.renderJob.etaSeconds = null
    scan.renderJob.error = null
    scan.renderJob.finishedAt = null
    addLog(scan, 'warn', 'Render cancelled (no live process)')
    saveScan(scan)
    return true
  }
  return false
}
