import fs from 'node:fs'
import path from 'node:path'
import { CHUNK_SECONDS } from './models'
import {
  CancelToken,
  engineCount,
  parallelMap,
  parseProgressLine,
  planSlices,
  runFfmpeg,
  runFfprobe,
  sliceProgress,
  type TimeSlice,
} from './ffmpeg-pool'
import { placeWork, removeStageWork } from './work-dir'

// ---------------------------------------------------------------------------
// PRECISE ENCODING — no stream copy anywhere.
//
//   * every cut: `-ss <abs>` BEFORE `-i` (accurate seek: decode from the
//     previous keyframe, drop until the exact timestamp) + exact `-t`
//   * `-fflags +genpts` on input, `-avoid_negative_ts make_zero`,
//     `-fps_mode cfr`, `-pix_fmt yuv420p`, 48 kHz audio on output
//   * long tasks are split into ENGINES time slices on the 60 s chunk grid
//     (lib/ffmpeg-pool.ts) and run concurrently, one single-threaded ffmpeg
//     per core; slices use IDENTICAL params so a join is seamless
//   * joins are re-encodes too (concat demuxer → libx264/aac); intermediates
//     at CRF 18 (near-lossless), the final join at the target quality
//   * INTERMEDIATE AUDIO IS LOSSLESS PCM (.mov container). AAC adds ~1024
//     samples of encoder priming + up to one frame of trailing padding to
//     EVERY file (~45–50 ms). The concat demuxer positions each next part at
//     the previous part's container duration (= the longer audio stream), so
//     with AAC parts a 48-scene render drifted +2.3 s and A/V desynced toward
//     the end. PCM parts are sample-exact → seams land on the exact frame;
//     AAC is applied ONCE in the final join.
//   * every output is verified with ffprobe: duration ≈ expected (±1 frame)
// ---------------------------------------------------------------------------

/** Every generated scan copy is encoded at 24 fps; compatible full MP4 sources can bypass encoding. */
const SCAN_FPS = 24
const SCAN_FPS_STR = String(SCAN_FPS)

/** Input-side flags for precise cutting. Placed before `-i`. */
const IN_FLAGS = ['-fflags', '+genpts']
/** Output-side flags shared by every encode. */
const OUT_FLAGS = ['-avoid_negative_ts', 'make_zero', '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p', '-threads', '1']
/** Final joins obey the same one-thread-per-engine contract as every other
 * pooled process. Their filters already reset both streams to timestamp zero;
 * avoid_negative_ts would shift an H.264 MP4 forward by two frames. */
const JOIN_OUT_FLAGS = ['-fps_mode', 'cfr', '-pix_fmt', 'yuv420p', '-threads', '0']
/** Lossless audio for intermediate parts (no priming/padding — see header). */
const PART_AUDIO = ['-c:a', 'pcm_s16le', '-ar', '48000']
/** Container for intermediate parts: QuickTime carries PCM without `-strict` flags. */
const PART_EXT = '.mov'

/** Scan-copy video params (640px / 24 fps / CRF 28 / veryfast) — Gemini uploads. */
const SCAN_VIDEO = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28']
const SCAN_AUDIO = ['-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-ar', '48000']
const SCAN_VF = `scale=640:-2,fps=${SCAN_FPS_STR}`

export interface FfmpegLog {
  (msg: string): void
}

// ---------- Probing ----------

export async function probeDuration(file: string): Promise<number> {
  try {
    const out = await runFfprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
    const dur = Number.parseFloat(out.trim())
    if (!Number.isFinite(dur) || dur <= 0) throw new Error('Could not determine video duration')
    return dur
  } catch (probeErr) {
    const dur = await probeDurationViaFfmpeg(file)
    if (dur !== null) return dur
    throw probeErr
  }
}

/** Fallback: read duration from `ffmpeg -i` stderr. */
async function probeDurationViaFfmpeg(file: string): Promise<number | null> {
  let stderr = ''
  try {
    await runFfmpeg(['-i', file], { label: 'probe', onStderr: (l) => (stderr += l) })
  } catch (err) {
    stderr += err instanceof Error ? err.message : String(err)
  }
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) return null
  const dur = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Number.isFinite(dur) && dur > 0 ? dur : null
}

/** True when the file has at least one audio stream. */
export async function probeHasAudio(file: string): Promise<boolean> {
  try {
    const out = await runFfprobe(['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file])
    return out.trim().length > 0
  } catch {
    return false
  }
}

/** Probe video width/height (first video stream). */
export async function probeResolution(file: string): Promise<{ width: number; height: number } | null> {
  try {
    const out = await runFfprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])
    const [w, h] = out.trim().split(/[,\s]+/).map((v) => Number.parseInt(v, 10))
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { width: w, height: h }
    return null
  } catch {
    return null
  }
}

/** Probe the average frame rate of the first video stream (null when unknown). */
export async function probeFps(file: string): Promise<number | null> {
  try {
    const out = await runFfprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,avg_frame_rate', '-of', 'csv=p=0', file])
    for (const tok of out.trim().split(/[,\s]+/)) {
      const [n, d] = tok.split('/').map(Number)
      const fps = d ? n / d : n
      if (Number.isFinite(fps) && fps > 0 && fps <= 240) return fps
    }
    return null
  } catch {
    return null
  }
}

export interface DurationCheck {
  ok: boolean
  actual: number
  expected: number
  diff: number
  tolerance: number
}

/**
 * Verify an encode landed on the expected duration (±1 frame at `fps`, with a
 * small floor for container rounding). Logs the result; never throws.
 */
export async function verifyDuration(file: string, expected: number, fps: number, log?: FfmpegLog, label = path.basename(file)): Promise<DurationCheck> {
  const tolerance = Math.max(1 / Math.max(1, fps), 0.05) + 0.02
  let actual = 0
  try {
    actual = await probeDuration(file)
  } catch {
    // leave 0 → not ok
  }
  const diff = actual - expected
  const ok = Math.abs(diff) <= tolerance
  const msg = `[verify] ${label}: ${actual.toFixed(3)}s vs expected ${expected.toFixed(3)}s (${diff >= 0 ? '+' : ''}${(diff * 1000).toFixed(0)} ms, tol ±${(tolerance * 1000).toFixed(0)} ms) ${ok ? 'OK' : 'MISMATCH'}`
  if (ok) console.log(msg)
  else console.warn(msg)
  log?.(msg.replace('[verify] ', 'Verify: '))
  return { ok, actual, expected, diff, tolerance }
}

interface ExportStreamProfile {
  duration: number
  start: number
  fps: number | null
  frames: number | null
}

export interface ExportSyncCheck {
  ok: boolean
  video: ExportStreamProfile
  audio: ExportStreamProfile
  expectedDuration: number
  expectedFrames: number
  issues: string[]
}

function rationalNumber(value: unknown): number | null {
  const text = String(value ?? '')
  const [numerator, denominator] = text.split('/').map(Number)
  const parsed = denominator ? numerator / denominator : numerator
  return Number.isFinite(parsed) ? parsed : null
}

/** Probe streams independently; format duration can hide video/audio drift. */
export async function verifyExportSync(file: string, expectedDuration: number, expectedFps: number, log?: FfmpegLog): Promise<ExportSyncCheck> {
  const output = await runFfprobe([
    '-v', 'error', '-show_entries',
    'stream=codec_type,start_time,duration,duration_ts,time_base,avg_frame_rate,nb_frames',
    '-of', 'json', file,
  ])
  const parsed = JSON.parse(output) as { streams?: Array<Record<string, unknown>> }
  const readStream = (kind: 'video' | 'audio'): ExportStreamProfile => {
    const stream = parsed.streams?.find((item) => item.codec_type === kind)
    if (!stream) throw new Error(`Final export has no ${kind} stream`)
    const timeBase = rationalNumber(stream.time_base)
    const durationTs = Number(stream.duration_ts)
    const duration = Number(stream.duration)
    const frames = Number(stream.nb_frames)
    return {
      duration: Number.isFinite(duration) ? duration : Number.isFinite(durationTs) && timeBase ? durationTs * timeBase : 0,
      start: Number.isFinite(Number(stream.start_time)) ? Number(stream.start_time) : 0,
      fps: kind === 'video' ? rationalNumber(stream.avg_frame_rate) : null,
      frames: kind === 'video' && Number.isFinite(frames) ? frames : null,
    }
  }
  const video = readStream('video')
  const audio = readStream('audio')
  const expectedFrames = Math.round(expectedDuration * expectedFps)
  const frameTolerance = 1 / expectedFps + 0.01
  const audioTolerance = Math.max(frameTolerance, 1024 / 48000 + 0.01)
  const issues: string[] = []
  if (Math.abs(video.duration - expectedDuration) > frameTolerance) issues.push(`video duration ${(video.duration - expectedDuration) * 1000 >= 0 ? '+' : ''}${((video.duration - expectedDuration) * 1000).toFixed(0)}ms`)
  if (Math.abs(audio.duration - expectedDuration) > audioTolerance) issues.push(`audio duration ${(audio.duration - expectedDuration) * 1000 >= 0 ? '+' : ''}${((audio.duration - expectedDuration) * 1000).toFixed(0)}ms`)
  if (Math.abs((video.start + video.duration) - (audio.start + audio.duration)) > audioTolerance) issues.push(`A/V end skew ${(Math.abs((video.start + video.duration) - (audio.start + audio.duration)) * 1000).toFixed(0)}ms`)
  if (Math.abs(video.start - audio.start) > frameTolerance) issues.push(`A/V start skew ${(Math.abs(video.start - audio.start) * 1000).toFixed(0)}ms`)
  if (video.frames !== null && video.frames !== expectedFrames) issues.push(`frame count ${video.frames}, expected ${expectedFrames}`)
  if (video.fps === null || Math.abs(video.fps - expectedFps) > Math.max(0.01, expectedFps * 0.001)) issues.push(`FPS ${video.fps?.toFixed(3) ?? 'unknown'}, expected ${expectedFps}`)
  const summary = `Verify A/V: video ${video.duration.toFixed(3)}s/${video.frames ?? '?'}f @ ${video.fps?.toFixed(3) ?? '?'}fps; audio ${audio.duration.toFixed(3)}s; expected ${expectedDuration.toFixed(3)}s/${expectedFrames}f — ${issues.length ? `FAILED (${issues.join('; ')})` : 'OK'}`
  log?.(summary)
  if (issues.length) console.warn(`[verify] ${summary}`)
  else console.log(`[verify] ${summary}`)
  return { ok: issues.length === 0, video, audio, expectedDuration, expectedFrames, issues }
}

// ---------- Movie chunking (chunk-XXXX.mp4) ----------

export interface ChunkOptions {
  onLog?: FfmpegLog
  token?: CancelToken
  /** Scan/task owner used by the global pool for cross-scan fairness. */
  owner?: string
}

/**
 * Cut the movie into exact sequential 1-minute chunks, re-encoded at 24 fps /
 * 640px / CRF 28 with keyframes forced on the 60 s grid.
 *
 * PARALLEL: the [trimStart, trimEnd) range is split into ENGINES slices whose
 * edges are chunk edges; each slice runs its own ffmpeg with the segment muxer
 * and `-segment_start_number` so the global numbering is identical to a single
 * sequential run (chunkAbsWindow in lib/scheduler.ts stays correct).
 */
export async function chunkMovie(
  movieFile: string,
  outDir: string,
  duration: number,
  onProgress: (pct: number) => void,
  trimStart = 0,
  trimEnd?: number,
  opts: ChunkOptions = {},
): Promise<number> {
  // Support flexible signature in case caller passed (movieFile, outDir, duration, trimStart, trimEnd, onProgress, opts)
  if (typeof onProgress === 'number' && typeof trimEnd === 'function') {
    const realProgress = trimEnd as unknown as (pct: number) => void
    const realStart = onProgress as number
    const realEnd = typeof trimStart === 'number' ? trimStart : undefined
    return chunkRange(movieFile, outDir, 'chunk', realStart, realEnd !== undefined && realEnd > realStart ? Math.min(realEnd, duration) : duration, realProgress, opts)
  }
  const rangeEnd = trimEnd !== undefined && trimEnd > trimStart ? Math.min(trimEnd, duration) : duration
  return chunkRange(movieFile, outDir, 'chunk', trimStart, rangeEnd, onProgress, opts)
}

export function chunkPath(outDir: string, index: number): string {
  return path.join(outDir, `chunk-${String(index).padStart(4, '0')}.mp4`)
}

/**
 * Cut the SHORT video into exact sequential 1-minute scan segments
 * (seg-0000.mp4, ...) with the same params as movie chunks. Original untouched.
 */
export async function chunkShort(
  shortFile: string,
  outDir: string,
  duration: number,
  onProgress: (pct: number) => void,
  opts: ChunkOptions = {},
): Promise<number> {
  return chunkRange(shortFile, outDir, 'seg', 0, duration, onProgress, opts)
}

export function segmentPath(outDir: string, index: number): string {
  return path.join(outDir, `seg-${String(index).padStart(4, '0')}.mp4`)
}

/** Shared implementation for chunkMovie / chunkShort. */
async function chunkRange(
  source: string,
  outDir: string,
  prefix: 'chunk' | 'seg',
  rangeStart: number,
  rangeEnd: number,
  onProgress: (pct: number) => void,
  opts: ChunkOptions,
): Promise<number> {
  fs.mkdirSync(outDir, { recursive: true })
  const rangeDur = Math.max(1, rangeEnd - rangeStart)
  const slices = planSlices(rangeStart, rangeEnd)
  const engines = engineCount()
  opts.onLog?.(`ffmpeg: ${prefix === 'chunk' ? 'movie chunking' : 'short segmenting'} ${rangeDur.toFixed(0)}s → ${slices.length} slice(s) on ${engines} engines (1 process/core)`)
  const startedAt = Date.now()
  // Holder object (not a bare `let`) so TS keeps the union type across the closure.
  const peak: { speed: number | null } = { speed: null }

  const progress = sliceProgress((doneSec, speed) => {
    if (typeof onProgress === 'function') {
      onProgress(Math.min(99, Math.round((doneSec / rangeDur) * 100)))
    }
    if (speed !== null) peak.speed = Math.max(peak.speed ?? 0, speed)
  })

  // Each slice writes into its own staging dir so a rounding-tail file at a
  // slice end can never overwrite the next slice's first chunk.
  const stagingFor = (s: TimeSlice) => path.join(outDir, `.slice-${String(s.index).padStart(2, '0')}`)
  for (const s of slices) {
    fs.rmSync(stagingFor(s), { recursive: true, force: true })
    fs.mkdirSync(stagingFor(s), { recursive: true })
  }

  await parallelMap(slices, async (s) => {
    const sliceDur = s.end - s.start
    const args: string[] = ['-y', ...IN_FLAGS]
    if (s.start > 0.0005) args.push('-ss', s.start.toFixed(3))
    args.push('-i', source, '-t', sliceDur.toFixed(3))
    args.push(
      '-vf', SCAN_VF,
      ...SCAN_VIDEO,
      '-force_key_frames', `expr:gte(t,n_forced*${CHUNK_SECONDS})`,
      ...SCAN_AUDIO,
      ...OUT_FLAGS,
      '-f', 'segment',
      '-segment_time', String(CHUNK_SECONDS),
      '-segment_start_number', String(s.firstChunk),
      '-reset_timestamps', '1',
      path.join(stagingFor(s), `${prefix}-%04d.mp4`),
    )
    const t0 = Date.now()
    await runFfmpeg(args, { label: `${prefix}-slice-${s.index}`, owner: opts.owner, token: opts.token, onStderr: progress.forSlice(s.index, sliceDur) })
    progress.complete(s.index, sliceDur)
    const secs = (Date.now() - t0) / 1000
    opts.onLog?.(`ffmpeg: slice ${s.index + 1}/${slices.length} done (${sliceDur.toFixed(0)}s of video in ${secs.toFixed(1)}s, ${(sliceDur / Math.max(0.1, secs)).toFixed(1)}x)`)
  })

  // Assemble: move each slice's files into outDir; drop rounding tails.
  let produced = 0
  for (const s of slices) {
    const dir = stagingFor(s)
    const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.mp4')).sort()
    const isLast = s.index === slices.length - 1
    const maxIndex = s.firstChunk + s.chunkCount - 1
    for (const f of files) {
      const idx = Number.parseInt(f.slice(prefix.length + 1, prefix.length + 5), 10)
      const src = path.join(dir, f)
      if (!isLast && idx > maxIndex) {
        // Sub-frame rounding tail past the slice's last chunk — never real content.
        const size = fs.statSync(src).size
        opts.onLog?.(`ffmpeg: dropped rounding tail ${f} from slice ${s.index} (${size} bytes)`)
        fs.rmSync(src, { force: true })
        continue
      }
      fs.renameSync(src, path.join(outDir, f))
      produced++
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }

  onProgress(100)
  const total = fs.readdirSync(outDir).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.mp4')).length
  const wall = (Date.now() - startedAt) / 1000
  opts.onLog?.(`ffmpeg: ${total} ${prefix} file(s) in ${wall.toFixed(1)}s (${(rangeDur / Math.max(0.1, wall)).toFixed(1)}x realtime across ${slices.length} engines${peak.speed ? `, peak ${peak.speed.toFixed(1)}x` : ''})`)

  // Verify: first + last chunk land on the grid.
  const first = path.join(outDir, `${prefix}-0000.mp4`)
  if (fs.existsSync(first)) await verifyDuration(first, Math.min(CHUNK_SECONDS, rangeDur), SCAN_FPS, opts.onLog)
  if (total > 1) {
    const lastFile = path.join(outDir, `${prefix}-${String(total - 1).padStart(4, '0')}.mp4`)
    const lastExpected = rangeDur - (total - 1) * CHUNK_SECONDS
    if (fs.existsSync(lastFile) && lastExpected > 0) await verifyDuration(lastFile, lastExpected, SCAN_FPS, opts.onLog)
  }
  if (produced !== total) opts.onLog?.(`ffmpeg: note — ${produced} file(s) moved this run, ${total} present in ${path.basename(outDir)}`)
  return total
}

/** Remove all short-segment scan files. */
export function cleanupSegments(outDir: string) {
  removeMatching(outDir, (f) => f.startsWith('seg-'))
}

export function cleanupChunks(outDir: string) {
  removeMatching(outDir, (f) => f.startsWith('chunk-'))
}

/** Remove all temporary verifier/rescan clip files. */
export function cleanupClips(clipsDir: string) {
  removeMatching(clipsDir, (f) => f.endsWith('.mp4'))
}

function removeMatching(dir: string, pred: (f: string) => boolean) {
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir)) {
    if (!pred(f)) continue
    try {
      fs.rmSync(path.join(dir, f), { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

// ---------- Short clips (verifier / rescan) — pooled precise cuts ----------

/** Extract a sub-clip (24 fps scan copy). Runs through the engine pool. */
export async function extractSegment(sourceFile: string, start: number, end: number, outFile: string, token?: CancelToken): Promise<void> {
  return extractClipPrecise(sourceFile, start, end, outFile, token)
}

/**
 * Millisecond-precise clip cut for the verifier/rescan pipeline (24 fps /
 * 640px / CRF 28 / mono AAC). Very short windows are padded to 1 s so Gemini
 * gets enough frames. Pooled — the scheduler's clips are cut concurrently.
 */
export async function extractClipPrecise(sourceFile: string, start: number, end: number, outFile: string, token?: CancelToken): Promise<void> {
  const s = Math.max(0, start)
  const dur = Math.max(1, end - start)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  await runFfmpeg(
    ['-y', ...IN_FLAGS, '-ss', s.toFixed(3), '-i', sourceFile, '-t', dur.toFixed(3), '-vf', SCAN_VF, ...SCAN_VIDEO, ...SCAN_AUDIO, ...OUT_FLAGS, '-movflags', '+faststart', outFile],
    { label: `clip ${s.toFixed(1)}s+${dur.toFixed(1)}s`, token },
  )
  await verifyDuration(outFile, dur, SCAN_FPS)
}

/**
 * Create a sanitized, silent (-an) copy of a video segment or chunk.
 * Strips all audio tracks and applies normalized contrast to bypass audio-based and false-positive policy blocks.
 */
export async function sanitizeVideoMute(sourceFile: string, outFile: string, token?: CancelToken): Promise<void> {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  await runFfmpeg(
    [
      '-y',
      ...IN_FLAGS,
      '-i', sourceFile,
      '-an',
      '-vf', `${SCAN_VF},eq=contrast=0.96:brightness=0.02`,
      ...SCAN_VIDEO,
      ...OUT_FLAGS,
      '-movflags', '+faststart',
      outFile,
    ],
    { label: `sanitize-mute ${path.basename(sourceFile)}`, token },
  )
}

// ---------- Backup minute finder clip (missing short parts, concatenated) ----------

/** Black + silence inserted between concatenated parts so PART boundaries are unmistakable. */
export const BACKUP_GAP_SEPARATOR_SEC = 1

/**
 * Build the BACKUP finder clip: every `[start, end)` range of the short is cut
 * precisely (24 fps / 640px scan copy), and the pieces are concatenated with a
 * 1 s black frame + silence between them (tpad/apad on each non-last piece, so
 * the separator automatically has the right geometry). Single ffmpeg run.
 *
 * Returns the clip-clock offsets of each part — the caller writes them into
 * the prompt's PART MAP (clip mm:ss = short mm:ss).
 */
export async function buildBackupClip(
  shortFile: string,
  ranges: Array<{ start: number; end: number }>,
  outFile: string,
  token?: CancelToken,
): Promise<{ durationSec: number; sizeBytes: number; parts: Array<{ clipStart: number; clipEnd: number }> }> {
  if (ranges.length === 0) throw new Error('buildBackupClip: no ranges')
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  const hasAudio = await probeHasAudio(shortFile)

  const args: string[] = ['-y']
  const parts: Array<{ clipStart: number; clipEnd: number }> = []
  let clock = 0
  for (const r of ranges) {
    const s = Math.max(0, r.start)
    const dur = Math.max(1, r.end - r.start)
    args.push(...IN_FLAGS, '-ss', s.toFixed(3), '-t', dur.toFixed(3), '-i', shortFile)
    parts.push({ clipStart: clock, clipEnd: clock + dur })
    clock += dur + BACKUP_GAP_SEPARATOR_SEC
  }
  const total = clock - BACKUP_GAP_SEPARATOR_SEC

  const chains: string[] = []
  const labels: string[] = []
  ranges.forEach((_, i) => {
    const last = i === ranges.length - 1
    const vpad = last ? '' : `,tpad=stop_mode=add:stop_duration=${BACKUP_GAP_SEPARATOR_SEC}:color=black`
    chains.push(`[${i}:v]${SCAN_VF},setsar=1${vpad}[v${i}]`)
    labels.push(`[v${i}]`)
    if (hasAudio) {
      const apad = last ? '' : `,apad=pad_dur=${BACKUP_GAP_SEPARATOR_SEC}`
      chains.push(`[${i}:a]aresample=48000:async=1,aformat=channel_layouts=mono${apad}[a${i}]`)
      labels.push(`[a${i}]`)
    }
  })
  chains.push(`${labels.join('')}concat=n=${ranges.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`)

  args.push('-filter_complex', chains.join(';'), '-map', '[v]')
  if (hasAudio) args.push('-map', '[a]', ...SCAN_AUDIO)
  else args.push('-an')
  args.push(...SCAN_VIDEO, ...OUT_FLAGS, '-movflags', '+faststart', outFile)

  await runFfmpeg(args, { label: `backup clip (${ranges.length} part${ranges.length === 1 ? '' : 's'}, ${total.toFixed(1)}s)`, token })
  await verifyDuration(outFile, total, SCAN_FPS)
  const durationSec = await probeDuration(outFile).catch(() => total)
  const sizeBytes = fs.statSync(outFile).size
  return { durationSec, sizeBytes, parts }
}

// ---------- Generic slice → encode → join pipeline ----------

export interface SliceEncodeSpec {
  /** Source video (absolute path). */
  source: string
  /** Absolute range in the source. */
  rangeStart: number
  rangeEnd: number
  /** Work dir owner (scan id) + stage name for RAM placement / cleanup. */
  scanId: string
  stage: string
  /** Final output path. */
  outFile: string
  /** Target geometry / rate every part AND the join must share. */
  width: number
  height: number
  fps: number
  /** Audio channels for every part (1 or 2). Silence is synthesized when the source has none. */
  channels: 1 | 2
  /** Encode preset for parts + join. */
  preset: 'veryfast' | 'medium'
  /** Final join quality: CRF or bitrate. */
  final: { crf: number; audioKbps: number } | { videoKbps: number; audioKbps: number }
  /** Estimated bytes the parts will occupy (for RAM/disk placement). */
  estimatedBytes: number
  onProgress?: (pct: number, note: string) => void
  onLog?: FfmpegLog
  token?: CancelToken
  label?: string
}

function scalePadFilter(w: number, h: number, fps: number): string {
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,fps=${fps},setsar=1`
}

/** Part encode: near-lossless CRF 18 intermediate at the shared geometry. */
function partArgs(
  spec: Pick<SliceEncodeSpec, 'source' | 'width' | 'height' | 'fps' | 'channels' | 'preset'>,
  hasAudio: boolean,
  s: TimeSlice,
  partFile: string,
): string[] {
  const dur = s.end - s.start
  const args: string[] = ['-y', ...IN_FLAGS]
  if (s.start > 0.0005) args.push('-ss', s.start.toFixed(3))
  args.push('-t', dur.toFixed(3), '-i', spec.source)
  if (!hasAudio) args.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', `anullsrc=channel_layout=${spec.channels === 1 ? 'mono' : 'stereo'}:sample_rate=48000`)
  args.push(
    '-filter_complex',
    `[0:v]${scalePadFilter(spec.width, spec.height, spec.fps)},setpts=PTS-STARTPTS[v];${hasAudio ? '[0:a]' : '[1:a]'}aresample=48000:async=0:first_pts=0,aformat=channel_layouts=${spec.channels === 1 ? 'mono' : 'stereo'},asetpts=N/SR/TB[a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', spec.preset, '-crf', '18', '-bf', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${CHUNK_SECONDS})`,
    ...PART_AUDIO, '-ac', String(spec.channels),
    ...OUT_FLAGS,
    partFile,
  )
  return args
}

/** Final join: concat demuxer → one timeline-normalized target encode. */
export function joinArgs(
  listFile: string,
  spec: Pick<SliceEncodeSpec, 'width' | 'height' | 'fps' | 'channels' | 'preset' | 'final'>,
  outFile: string,
  expectedDuration: number,
  extraVf?: string,
): string[] {
  const vcodec =
    'crf' in spec.final
      ? ['-c:v', 'libx264', '-preset', spec.preset, '-crf', String(spec.final.crf)]
      : [
          '-c:v', 'libx264', '-preset', spec.preset,
          '-b:v', `${spec.final.videoKbps}k`,
          '-maxrate', `${Math.round(spec.final.videoKbps * 1.5)}k`,
          '-bufsize', `${spec.final.videoKbps * 2}k`,
        ]
  const expectedFrames = Math.max(1, Math.round(expectedDuration * spec.fps))
  const expectedSamples = Math.max(1, Math.round(expectedDuration * 48000))
  const videoFilter = `${extraVf ? `${extraVf},` : ''}fps=${spec.fps},setsar=1,trim=end_frame=${expectedFrames},setpts=PTS-STARTPTS`
  const audioFilter = `aresample=48000:async=0:first_pts=0,asetpts=N/SR/TB,apad=whole_len=${expectedSamples},atrim=end_sample=${expectedSamples},asetpts=N/SR/TB`
  return [
    '-y', ...IN_FLAGS, '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', videoFilter,
    '-af', audioFilter,
    '-frames:v', String(expectedFrames),
    '-r', String(spec.fps),
    ...vcodec,
    '-c:a', 'aac', '-b:a', `${spec.final.audioKbps}k`, '-ar', '48000', '-ac', String(spec.channels),
    // Stream copy is not an option: parts are CRF 18 + PCM audio in .mov;
    // timestamps and final stream lengths are normalized exactly once here.
    ...JOIN_OUT_FLAGS,
    '-movflags', '+faststart',
    outFile,
  ]
}

export function writeConcatList(listFile: string, files: string[], durations?: number[]) {
  const lines = ['ffconcat version 1.0']
  files.forEach((file, index) => {
    lines.push(`file '${file.replace(/'/g, "'\\''")}'`)
    const duration = durations?.[index]
    if (duration && Number.isFinite(duration)) lines.push(`duration ${duration.toFixed(9)}`)
  })
  fs.writeFileSync(listFile, `${lines.join('\n')}\n`)
}

/**
 * Encode [rangeStart, rangeEnd) of `source` into `outFile` using every engine:
 * parts in parallel (CRF 18) → concat → final re-encode. Returns the part
 * files too (callers may re-join at a different quality without re-cutting).
 */
export async function sliceEncode(spec: SliceEncodeSpec): Promise<{ parts: string[]; workDir: string; durationSec: number }> {
  const rangeDur = Math.max(0.1, spec.rangeEnd - spec.rangeStart)
  const { parts, workDir } = await encodeParts(spec)
  spec.onLog?.(`ffmpeg: ${spec.label || spec.stage} — joining with re-encode...`)
  await joinParts(parts, spec, spec.outFile, rangeDur)
  const durationSec = await probeDuration(spec.outFile)
  return { parts, workDir, durationSec }
}

/**
 * Parts-only half of sliceEncode: cut + encode [rangeStart, rangeEnd) into
 * numbered CRF 18 part files (all engines busy) WITHOUT joining them. Callers
 * that combine several sources (merge: short + movie) build their own list
 * and call joinParts once. Progress spans `progressRange` (default 0..70 %).
 */
export async function encodeParts(
  spec: Omit<SliceEncodeSpec, 'outFile' | 'final'> & { partPrefix?: string; progressRange?: [number, number] },
): Promise<{ parts: string[]; workDir: string }> {
  const rangeDur = Math.max(0.1, spec.rangeEnd - spec.rangeStart)
  const hasAudio = await probeHasAudio(spec.source)
  const slices = planSlices(spec.rangeStart, spec.rangeEnd)
  const placement = placeWork(spec.scanId, spec.stage, spec.estimatedBytes)
  const label = spec.label || spec.stage
  const prefix = spec.partPrefix || 'part'
  const [p0, p1] = spec.progressRange ?? [0, 70]
  spec.onLog?.(`ffmpeg: ${label} — ${slices.length} slice(s) on ${engineCount()} engines, parts in ${placement.inRam ? 'RAM' : 'disk'} (${placement.dir})`)

  const parts = slices.map((s) => path.join(placement.dir, `${prefix}-${String(s.index).padStart(4, '0')}${PART_EXT}`))
  const progress = sliceProgress((doneSec, speed) => {
    spec.onProgress?.(Math.min(p1, p0 + Math.round((doneSec / rangeDur) * (p1 - p0))), `Encoding ${slices.length} slice(s) in parallel${speed ? ` (${speed.toFixed(1)}x)` : ''}...`)
  })

  const t0 = Date.now()
  await parallelMap(slices, async (s) => {
    const dur = s.end - s.start
    const ts = Date.now()
    await runFfmpeg(partArgs(spec, hasAudio, s, parts[s.index]), { label: `${label} part ${s.index}`, owner: spec.scanId, token: spec.token, onStderr: progress.forSlice(s.index, dur) })
    progress.complete(s.index, dur)
    const secs = (Date.now() - ts) / 1000
    spec.onLog?.(`ffmpeg: ${label} slice ${s.index + 1}/${slices.length}: ${dur.toFixed(1)}s in ${secs.toFixed(1)}s (${(dur / Math.max(0.1, secs)).toFixed(1)}x)`)
  })
  spec.onLog?.(`ffmpeg: ${label} parts done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return { parts, workDir: placement.dir }
}

export interface JoinOptions {
  /** Planned duration for each input part; overrides padded container metadata. */
  partDurations?: number[]
  /** Reject and delete the output when duration/FPS/A-V checks fail. */
  strict?: boolean
}

/** Join already-encoded parts into outFile and verify its independent streams. */
export async function joinParts(
  parts: string[],
  spec: Pick<SliceEncodeSpec, 'width' | 'height' | 'fps' | 'channels' | 'preset' | 'final' | 'onProgress' | 'onLog' | 'token' | 'label'> & { scanId?: string },
  outFile: string,
  expectedDur: number,
  extraVf?: string,
  options: JoinOptions = {},
): Promise<void> {
  if (options.partDurations && options.partDurations.length !== parts.length) {
    throw new Error('Part duration count does not match part file count')
  }
  const listFile = `${outFile}.concat.txt`
  writeConcatList(listFile, parts, options.partDurations)
  const tmp = `${outFile}.tmp.mp4`
  try {
    await runFfmpeg(joinArgs(listFile, spec, tmp, expectedDur, extraVf), {
      label: `${spec.label || 'join'} join`,
      owner: spec.scanId,
      token: spec.token,
      onStderr: (line) => {
        const { time, speed } = parseProgressLine(line)
        if (time === null) return
        spec.onProgress?.(70 + Math.min(29, Math.round((time / expectedDur) * 29)), `Joining (precise re-encode${speed ? `, ${speed.toFixed(1)}x` : ''})...`)
      },
    })
    fs.renameSync(tmp, outFile)
  } finally {
    fs.rmSync(listFile, { force: true })
    fs.rmSync(tmp, { force: true })
  }
  const durationCheck = await verifyDuration(outFile, expectedDur, spec.fps, spec.onLog, path.basename(outFile))
  if (options.strict) {
    const syncCheck = await verifyExportSync(outFile, expectedDur, spec.fps, spec.onLog)
    if (!durationCheck.ok || !syncCheck.ok) {
      fs.rmSync(outFile, { force: true })
      throw new Error(`Export verification failed: ${syncCheck.issues.join('; ') || `duration ${durationCheck.actual.toFixed(3)}s, expected ${expectedDur.toFixed(3)}s`}`)
    }
  }
}

// ---------- Twelve Labs normalize ----------

/**
 * Twelve Labs upload requirements: aspect ratio between 1:1 and 2.4:1 and at
 * least 360px on each side. If the source violates either rule, write a
 * padded/scaled COPY and return its path; otherwise return null.
 */
export async function normalizeForTwelveLabs(sourceFile: string, scanId = 'tl', onLog?: FfmpegLog): Promise<string | null> {
  const res = await probeResolution(sourceFile)
  if (!res) return null
  const { width: w, height: h } = res
  const MIN_SIDE = 360
  const MAX_AR = 2.35
  const MIN_AR = 1.0

  let targetW = w
  let targetH = h
  if (w / h > MAX_AR) targetH = Math.ceil(w / MAX_AR)
  else if (w / h < MIN_AR) targetW = h
  if (Math.min(targetW, targetH) < MIN_SIDE) {
    const scale = MIN_SIDE / Math.min(targetW, targetH)
    targetW = Math.ceil(targetW * scale)
    targetH = Math.ceil(targetH * scale)
  }
  targetW += targetW % 2
  targetH += targetH % 2
  if (targetW === w && targetH === h) return null

  const outFile = `${sourceFile}.tl-normalized.mp4`
  if (fs.existsSync(outFile)) return outFile

  const duration = await probeDuration(sourceFile)
  const fps = (await probeFps(sourceFile)) ?? 24
  const stage = `tl-normalize-${path.basename(sourceFile).replace(/\W+/g, '_')}`
  try {
    await sliceEncode({
      source: sourceFile,
      rangeStart: 0,
      rangeEnd: duration,
      scanId,
      stage,
      outFile,
      width: targetW,
      height: targetH,
      fps: Math.min(60, Math.round(fps)),
      channels: 2,
      preset: 'veryfast',
      final: { crf: 26, audioKbps: 96 },
      estimatedBytes: Math.ceil(duration * 0.6 * 1024 * 1024),
      onLog,
      label: 'TwelveLabs normalize',
    })
  } finally {
    removeStageWork(scanId, stage)
  }
  return outFile
}

// ---------- Gemini Minute Finder: movie upload copy ----------

/** Gemini Files API hard limit is 2 GB per file — stay safely under it (1.95 GB). */
export const PRESCAN_MAX_BYTES = 1.95 * 1024 * 1024 * 1024

/**
 * Build the UPLOAD COPY of the movie for the Gemini Minute Finder.
 * RULE: Re-encoding to 480p / 24fps / CRF 30 is ONLY performed if the movie file is > 2 GB
 * (or if a non-streamable trim range is required).
 * Movies <= 2 GB (such as 1.45 GB, 1.48 GB, etc.) are directly linked or stream-copied without
 * re-encoding so that processing is instantaneous and takes 0 extra seconds!
 */
export async function preparePrescanMovieCopy(
  movieFile: string,
  outFile: string,
  movieDuration: number,
  trimStart: number,
  trimEnd: number,
  onProgress: (pct: number, note: string) => void,
  opts: { scanId?: string; onLog?: FfmpegLog; token?: CancelToken } = {},
): Promise<{ durationSec: number; sizeBytes: number; reencoded: boolean }> {
  const rangeEnd = Math.min(trimEnd, movieDuration)
  const rangeDur = Math.max(1, rangeEnd - trimStart)
  const scanId = opts.scanId || path.basename(path.dirname(outFile))
  const stage = 'prescan-copy'
  const sourceSize = fs.statSync(movieFile).size
  const fullRange = trimStart <= 0.05 && Math.abs(rangeEnd - movieDuration) <= 0.05

  // CASE 1: Full-range movie <= 2 GB -> Instant direct hardlink / copy without re-encoding!
  if (sourceSize <= PRESCAN_MAX_BYTES && fullRange) {
    await fs.promises.mkdir(path.dirname(outFile), { recursive: true })
    await fs.promises.rm(outFile, { force: true })
    onProgress(0, 'Source <= 2 GB — direct reuse (no re-encode)')
    let reuseMode = 'hard link'
    try {
      await fs.promises.link(movieFile, outFile)
    } catch {
      reuseMode = 'async copy'
      await fs.promises.copyFile(movieFile, outFile)
    }
    const durationSec = (await probeDuration(outFile)) || movieDuration
    opts.onLog?.(`ffmpeg: prescan movie <= 2 GB (${(sourceSize / (1024 * 1024)).toFixed(1)} MB) — skipping re-encode, using ${reuseMode}`)
    onProgress(100, `Movie copy ready (${reuseMode})`)
    return { durationSec, sizeBytes: sourceSize, reencoded: false }
  }

  // CASE 2: Trimmed movie <= 2 GB -> Try fast stream copy (-c copy) without re-encoding!
  if (sourceSize <= PRESCAN_MAX_BYTES && !fullRange) {
    try {
      await fs.promises.mkdir(path.dirname(outFile), { recursive: true })
      await fs.promises.rm(outFile, { force: true })
      onProgress(0, 'Fast stream copy for trim (no re-encode)...')
      await runFfmpeg([
        '-ss', String(trimStart),
        '-to', String(rangeEnd),
        '-i', movieFile,
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-y',
        outFile,
      ])
      const sz = fs.statSync(outFile).size
      if (sz > 0 && sz <= PRESCAN_MAX_BYTES) {
        opts.onLog?.(`ffmpeg: prescan trim stream copy successful (${(sz / (1024 * 1024)).toFixed(1)} MB)`)
        onProgress(100, 'Movie trim copy ready (stream copy)')
        const durationSec = (await probeDuration(outFile)) || rangeDur
        return { durationSec, sizeBytes: sz, reencoded: false }
      }
    } catch (err) {
      opts.onLog?.(`ffmpeg: trim stream copy failed, falling back to 480p re-encode: ${err}`)
    }
  }

  // CASE 3: Movie is > 2 GB (exceeds Gemini limit) -> Re-encode to 480p / CRF 30 to shrink under 2 GB
  await fs.promises.mkdir(path.dirname(outFile), { recursive: true })
  await fs.promises.rm(outFile, { force: true })

  const src = await probeResolution(movieFile)
  const ar = src ? src.width / src.height : 16 / 9
  const w480 = even(Math.round(480 * ar))
  const w360 = even(Math.round(360 * ar))

  onProgress(0, 'Movie > 2 GB: 480p re-encode (all cores)...')
  opts.onLog?.(`ffmpeg: movie size (${(sourceSize / (1024 * 1024)).toFixed(1)} MB) > 2 GB — 480p CRF 30 parallel sliceEncode`)
  try {
    const { parts } = await sliceEncode({
      source: movieFile,
      rangeStart: trimStart,
      rangeEnd,
      scanId,
      stage,
      outFile,
      width: w480,
      height: 480,
      fps: SCAN_FPS,
      channels: 1,
      preset: 'veryfast',
      final: { crf: 30, audioKbps: 64 },
      estimatedBytes: Math.ceil(rangeDur * 0.35 * 1024 * 1024),
      onProgress,
      onLog: opts.onLog,
      token: opts.token,
      label: 'Minute Finder movie copy',
    })
    if (fs.statSync(outFile).size > PRESCAN_MAX_BYTES) {
      onProgress(70, 'Still > 1.95 GB — re-joining smaller copy (360p)...')
      opts.onLog?.('ffmpeg: prescan copy > 1.95 GB → re-join parts at 360p / CRF 32')
      fs.rmSync(outFile, { force: true })
      await joinParts(
        parts,
        { scanId, width: w360, height: 360, fps: SCAN_FPS, channels: 1, preset: 'veryfast', final: { crf: 32, audioKbps: 48 }, onProgress, onLog: opts.onLog, token: opts.token, label: 'Minute Finder 360p' },
        outFile,
        rangeDur,
        `scale=${w360}:360`,
      )
      if (fs.statSync(outFile).size > PRESCAN_MAX_BYTES) {
        fs.rmSync(outFile, { force: true })
        throw new Error('Movie copy 360p par bhi 2 GB se badi hai — chhota trim range use karo.')
      }
    }
  } finally {
    removeStageWork(scanId, stage)
  }

  onProgress(100, 'Movie copy ready')
  const durationSec = await probeDuration(outFile)
  return { durationSec, sizeBytes: fs.statSync(outFile).size, reencoded: true }
}

/**
 * Fast web preview generation:
 * Creates a lightweight web-optimized 480p / 24fps / CRF 32 copy with `-movflags +faststart`.
 * Designed specifically for instant, buttery-smooth browser previews (Side-by-side, Instant Stitched, and Missing Scene Finder).
 * Runs completely in the background without blocking any scans or UI actions.
 */
const activeFastPreviewJobs = new Set<string>()

export function triggerFastPreview(scanId: string, videoFile: string, outDir: string, kind: 'movie' | 'short' = 'movie'): void {
  const jobKey = `${scanId}-${kind}`
  if (activeFastPreviewJobs.has(jobKey)) return
  const previewPath = path.join(outDir, `preview-${kind}.mp4`)
  if (fs.existsSync(previewPath) && fs.statSync(previewPath).size > 1000) return

  activeFastPreviewJobs.add(jobKey)
  void (async () => {
    try {
      const tempPath = path.join(outDir, `.preview-${kind}-tmp-${Date.now()}.mp4`)
      await runFfmpeg([
        '-y',
        '-i', videoFile,
        '-vf', "scale='min(640,iw)':-2,fps=24",
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '32',
        '-c:a', 'aac',
        '-b:a', '64k',
        '-ac', '1',
        '-movflags', '+faststart',
        tempPath,
      ], { label: `fast-preview-${jobKey}` })

      if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 1000) {
        fs.renameSync(tempPath, previewPath)
        console.log(`[preview] Fast web preview ready for ${jobKey}: ${(fs.statSync(previewPath).size / (1024 * 1024)).toFixed(1)} MB`)
      }
    } catch (err) {
      console.warn(`[preview] Fast web preview creation failed for ${jobKey}:`, err)
    } finally {
      activeFastPreviewJobs.delete(jobKey)
    }
  })()
}

function even(n: number): number {
  return n % 2 === 0 ? n : n + 1
}

// Shared encode building blocks (used by lib/render.ts and lib/merge.ts).
export { IN_FLAGS, JOIN_OUT_FLAGS, OUT_FLAGS, PART_AUDIO, PART_EXT, SCAN_FPS, scalePadFilter }
