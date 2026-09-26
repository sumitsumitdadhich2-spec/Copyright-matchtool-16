import fs from 'node:fs'
import path from 'node:path'
import { encodeParts, joinParts, probeDuration, probeFps, probeHasAudio, verifyDuration, type FfmpegLog } from './ffmpeg'
import { engineCount, runFfprobe, type CancelToken } from './ffmpeg-pool'
import { estimateBitrateBytes, removeStageWork } from './work-dir'

// ---------------------------------------------------------------------------
// AUTO MERGE (short + movie → merged.mp4) — PRECISE RE-ENCODE, no stream copy.
//
//   1. probe both files; TARGET = movie's resolution + fps, 48 kHz stereo
//   2. normalize SHORT and MOVIE to the target (scale + pad, fps, audio —
//      silence synthesized when a file has none) as CRF 18 parts, every
//      slice on its own engine (all cores busy)
//   3. join short parts + movie parts with ONE final re-encode
//   4. verify: merged duration ≈ short + movie (±1 frame), logged
//
// There is NO "same format required" rule anymore — any short + any movie
// merge. Originals are NEVER touched; merged.mp4 is a separate new file.
// ---------------------------------------------------------------------------

export interface StreamInfo {
  video: {
    codec: string
    width: number
    height: number
    pixFmt: string
    fps: number | null
  } | null
  audio: {
    codec: string
    sampleRate: number
    channels: number
  } | null
}

/** Probe first video + audio stream of a file (codec/resolution/pix_fmt/fps/audio). */
export async function probeStreamInfo(file: string): Promise<StreamInfo> {
  const info: StreamInfo = { video: null, audio: null }
  try {
    const out = await runFfprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'csv=p=0', file])
    const parts = out.trim().split(',')
    if (parts.length >= 4) {
      const [codec, w, h, pixFmt] = parts
      const width = Number.parseInt(w, 10)
      const height = Number.parseInt(h, 10)
      if (codec && Number.isFinite(width) && Number.isFinite(height)) {
        info.video = { codec, width, height, pixFmt: pixFmt || 'unknown', fps: await probeFps(file) }
      }
    }
  } catch {
    // no/unreadable video stream
  }
  try {
    const out = await runFfprobe(['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'csv=p=0', file])
    const parts = out.trim().split(',')
    if (parts.length >= 3 && parts[0]) {
      info.audio = { codec: parts[0], sampleRate: Number.parseInt(parts[1], 10) || 0, channels: Number.parseInt(parts[2], 10) || 0 }
    }
  } catch {
    // no audio stream
  }
  return info
}

export interface MergeTarget {
  width: number
  height: number
  fps: number
  short: StreamInfo
  movie: StreamInfo
  /** Human summary for the logs panel. */
  summary: string
}

function even(n: number): number {
  return n % 2 === 0 ? n : n + 1
}

function describe(v: StreamInfo['video']): string {
  if (!v) return 'no video'
  return `${v.width}x${v.height}${v.fps ? ` @ ${v.fps.toFixed(2).replace(/\.?0+$/, '')}fps` : ''} ${v.codec}`
}

/**
 * Decide the shared output format: the MOVIE's resolution and fps (the
 * movie is the reference the scan timestamps refer to). Fails only when a
 * file has no readable video stream at all.
 */
export async function planMergeTarget(shortFile: string, movieFile: string): Promise<{ ok: true; target: MergeTarget } | { ok: false; reason: string }> {
  const [short, movie] = await Promise.all([probeStreamInfo(shortFile), probeStreamInfo(movieFile)])
  if (!short.video || !movie.video) {
    return { ok: false, reason: `Video stream read nahi ho paya (ffprobe fail) — ${!short.video ? 'short' : 'movie'} file valid video hai kya?` }
  }
  const fps = Math.min(120, Math.max(1, Math.round(movie.video.fps ?? short.video.fps ?? 24)))
  const width = even(movie.video.width)
  const height = even(movie.video.height)
  const same =
    short.video.width === movie.video.width && short.video.height === movie.video.height && Math.abs((short.video.fps ?? fps) - fps) < 0.01
  const summary = same
    ? `short ${describe(short.video)} + movie ${describe(movie.video)} — same geometry, target ${width}x${height} @ ${fps}fps`
    : `short ${describe(short.video)} → scaled/padded to movie ${width}x${height} @ ${fps}fps`
  return { ok: true, target: { width, height, fps, short, movie, summary } }
}

/** Escape a path for the ffmpeg concat demuxer list file (single quotes). */
export function concatEscape(p: string): string {
  return p.replace(/'/g, "'\\''")
}

export interface MergeOptions {
  scanId: string
  onLog?: FfmpegLog
  onProgress?: (pct: number, note: string) => void
  token?: CancelToken
  /** Final join quality (CRF). Default 20 — visually lossless for TwelveLabs indexing. */
  crf?: number
}

/**
 * PART A (short) first, PART B (movie) after — normalized to the movie's
 * geometry/fps and joined with a single precise re-encode. Exact duration
 * sum (verified), originals untouched.
 */
export async function mergeVideos(shortFile: string, movieFile: string, outFile: string, opts: MergeOptions): Promise<{ target: MergeTarget; duration: number }> {
  const plan = await planMergeTarget(shortFile, movieFile)
  if (!plan.ok) throw new Error(plan.reason)
  const { target } = plan
  const [shortDur, movieDur] = await Promise.all([probeDuration(shortFile), probeDuration(movieFile)])
  const expected = shortDur + movieDur
  const [shortAudio, movieAudio] = await Promise.all([probeHasAudio(shortFile), probeHasAudio(movieFile)])
  const stage = 'merge-parts'
  const common = { scanId: opts.scanId, width: target.width, height: target.height, fps: target.fps, channels: 2 as const, preset: 'medium' as const, onLog: opts.onLog, token: opts.token }

  opts.onLog?.(`ffmpeg: merge target — ${target.summary}; audio: short ${shortAudio ? 'yes' : 'no (silence)'}, movie ${movieAudio ? 'yes' : 'no (silence)'}; ${engineCount()} engines`)
  removeStageWork(opts.scanId, stage)
  try {
    // Parts: short 0..20 %, movie 20..70 %, join 70..99 %.
    const shortParts = await encodeParts({
      ...common,
      source: shortFile,
      rangeStart: 0,
      rangeEnd: shortDur,
      scanId: opts.scanId,
      stage,
      partPrefix: 'a',
      estimatedBytes: estimateBitrateBytes(expected, 12000, 192),
      progressRange: [0, 20],
      onProgress: opts.onProgress,
      label: 'Merge PART A (short)',
    })
    const movieParts = await encodeParts({
      ...common,
      source: movieFile,
      rangeStart: 0,
      rangeEnd: movieDur,
      scanId: opts.scanId,
      stage,
      partPrefix: 'b',
      estimatedBytes: 0,
      progressRange: [20, 70],
      onProgress: opts.onProgress,
      label: 'Merge PART B (movie)',
    })

    await joinParts(
      [...shortParts.parts, ...movieParts.parts],
      { ...common, final: { crf: opts.crf ?? 20, audioKbps: 160 }, onProgress: opts.onProgress, label: 'Merge' },
      outFile,
      expected,
    )
  } finally {
    removeStageWork(opts.scanId, stage)
  }

  if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
    throw new Error('Merge output file empty/missing — ffmpeg join fail hua')
  }
  const duration = await probeDuration(outFile)
  await verifyDuration(outFile, expected, target.fps, opts.onLog, path.basename(outFile))
  return { target, duration }
}

export function mergedFilePath(mediaDir: string): string {
  return path.join(mediaDir, 'merged.mp4')
}
