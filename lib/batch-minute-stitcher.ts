import fs from 'node:fs'
import path from 'node:path'
import { MEDIA_DIR, WORK_DIR } from './paths'
import { runFfmpeg, CancelToken } from './ffmpeg-pool'
import { probeHasAudio } from './ffmpeg'
import { resolveMainMatches } from './candidate-pick'
import type { Scan, BatchVerifyPart, ChunkMatch } from './types'

export interface MinuteSegmentPlan {
  minuteIndex: number
  minStart: number
  minEnd: number
  parts: BatchVerifyPart[]
}

/**
 * Plan matched scene segments for a specific 1-minute window of the short video.
 * Uses only MAIN matches (candidates excluded). Gaps (unmatched seconds) are omitted.
 */
export function getMainMatches(matches: ChunkMatch[]): ChunkMatch[] {
  return resolveMainMatches(matches)
}

export function planMinuteSegments(scan: Scan, minuteIndex: number): MinuteSegmentPlan {
  const minStart = minuteIndex * 60
  const minEnd = (minuteIndex + 1) * 60

  // Ensure all matches have stable IDs for resilient lookup
  for (let i = 0; i < (scan.matches || []).length; i++) {
    const m = scan.matches[i]
    if (!m.id) {
      m.id = `m_${i}_${m.shortStart.toFixed(3)}_${m.movieStart.toFixed(3)}_${m.chunkIndex}`
    }
  }

  // Get only MAIN matches — candidate alternatives are completely excluded
  const mainMatches = getMainMatches(scan.matches || [])

  // All main matches that overlap this minute
  const minuteMatches = mainMatches.filter(
    (m) => m.shortStart < minEnd && m.shortEnd > minStart && m.shortEnd - m.shortStart >= 0.15,
  )

  const parts: BatchVerifyPart[] = []
  let runningLocalClock = 0
  let lastEnd = minStart

  for (const m of minuteMatches) {
    const sStart = Math.max(minStart, m.shortStart)
    const sEnd = Math.min(minEnd, m.shortEnd)

    // Skip tiny slices < 0.15s or inverted ranges
    if (sEnd - sStart < 0.15) continue

    // Adjust for any small edge overlap with previous scene
    const adjustedStart = Math.max(sStart, lastEnd)
    if (sEnd - adjustedStart < 0.15) continue

    const dur = sEnd - adjustedStart
    const offsetInMatch = adjustedStart - m.shortStart
    const mStart = Math.max(0, m.movieStart + offsetInMatch)
    const mEnd = mStart + dur

    const partIndex = parts.length + 1
    const localStart = runningLocalClock
    const localEnd = runningLocalClock + dur
    runningLocalClock += dur
    lastEnd = sEnd

    parts.push({
      partIndex,
      matchId: m.id,
      chunkIndex: m.chunkIndex,
      matchIndex: scan.matches.indexOf(m),
      shortStart: adjustedStart,
      shortEnd: sEnd,
      movieStart: mStart,
      movieEnd: mEnd,
      localStart,
      localEnd,
      duration: dur,
    })
  }

  return {
    minuteIndex,
    minStart,
    minEnd,
    parts,
  }
}

/**
 * Stitch matched short and movie segments into 24 FPS paired verification videos.
 * Missing short segments are excluded from BOTH videos so they remain in 1:1 sync.
 */
export async function stitchMinuteVerificationClips(
  scanId: string,
  minuteIndex: number,
  parts: BatchVerifyPart[],
  token?: CancelToken,
): Promise<{
  shortClipPath: string
  movieClipPath: string
  totalDurationSec: number
  parts: BatchVerifyPart[]
}> {
  if (parts.length === 0) {
    throw new Error(`No matched scenes found for minute ${minuteIndex + 1}`)
  }

  const shortSource = path.join(MEDIA_DIR, scanId, 'short.mp4')
  const movieSource = path.join(MEDIA_DIR, scanId, 'movie.mp4')

  if (!fs.existsSync(shortSource)) throw new Error(`Short video not found at ${shortSource}`)
  if (!fs.existsSync(movieSource)) throw new Error(`Movie video not found at ${movieSource}`)

  const outDir = path.join(WORK_DIR, scanId, 'batch-verify', `min-${minuteIndex}`)
  fs.mkdirSync(outDir, { recursive: true })

  const shortClipPath = path.join(outDir, `short-min-${minuteIndex}-24fps.mp4`)
  const movieClipPath = path.join(outDir, `movie-min-${minuteIndex}-24fps.mp4`)

  const hasShortAudio = await probeHasAudio(shortSource).catch(() => false)
  const hasMovieAudio = await probeHasAudio(movieSource).catch(() => false)

  // 1. Build Short Stitched Video
  await stitchSourceParts(shortSource, parts.map((p) => ({ start: p.shortStart, dur: p.duration })), shortClipPath, hasShortAudio, `Short Min ${minuteIndex + 1}`, token)

  // 2. Build Movie Stitched Video
  await stitchSourceParts(movieSource, parts.map((p) => ({ start: p.movieStart, dur: p.duration })), movieClipPath, hasMovieAudio, `Movie Min ${minuteIndex + 1}`, token)

  const totalDurationSec = parts.reduce((acc, p) => acc + p.duration, 0)

  return {
    shortClipPath,
    movieClipPath,
    totalDurationSec,
    parts,
  }
}

/**
 * Internal helper to stitch multiple time segments from a source file into a single 24 FPS MP4.
 * Guarantees zero frame drift and sample-locked audio sync.
 */
async function stitchSourceParts(
  sourceFile: string,
  segments: Array<{ start: number; dur: number }>,
  outFile: string,
  hasAudio: boolean,
  label: string,
  token?: CancelToken,
): Promise<void> {
  const inArgs: string[] = ['-y']
  const vFilters: string[] = []
  const aFilters: string[] = []
  const vLabels: string[] = []

  let totalFrames = 0

  segments.forEach((seg, i) => {
    const frames = Math.max(1, Math.round(seg.dur * 24))
    totalFrames += frames
    const samples = frames * 2000 // 48000 Hz / 24 fps = exactly 2000 samples per frame
    const readDur = seg.dur + 0.25 // slight read buffer to ensure trim=end_frame always has enough input

    inArgs.push('-accurate_seek', '-ss', seg.start.toFixed(3), '-t', readDur.toFixed(3), '-i', sourceFile)
    vFilters.push(`[${i}:v]scale=640:-2,fps=24,trim=end_frame=${frames},setpts=PTS-STARTPTS,setsar=1[v${i}]`)
    vLabels.push(`[v${i}]`)

    if (hasAudio) {
      aFilters.push(
        `[${i}:a]asetpts=PTS-STARTPTS,aresample=48000:async=0:first_pts=0,aformat=channel_layouts=mono,apad=whole_len=${samples},atrim=end_sample=${samples},asetpts=N/SR/TB[a${i}]`,
      )
    }
  })

  // FFmpeg concat filter with v=1:a=1 requires interleaved stream inputs: [v0][a0][v1][a1]...
  const interleavedLabels: string[] = []
  segments.forEach((_, i) => {
    interleavedLabels.push(`[v${i}]`)
    if (hasAudio) {
      interleavedLabels.push(`[a${i}]`)
    }
  })

  let filterComplex = ''
  if (segments.length === 1) {
    if (hasAudio) {
      filterComplex = `${vFilters[0]};${aFilters[0]}`
    } else {
      filterComplex = vFilters[0]
    }
  } else {
    if (hasAudio) {
      filterComplex = `${vFilters.join(';')};${aFilters.join(';')};${interleavedLabels.join('')}concat=n=${segments.length}:v=1:a=1[v][a]`
    } else {
      filterComplex = `${vFilters.join(';')};${vLabels.join('')}concat=n=${segments.length}:v=1:a=0[v]`
    }
  }

  const outArgs: string[] = [
    ...inArgs,
    '-filter_complex',
    filterComplex,
    '-map',
    segments.length === 1 ? '[v0]' : '[v]',
  ]

  if (hasAudio) {
    outArgs.push('-map', segments.length === 1 ? '[a0]' : '[a]', '-c:a', 'aac', '-b:a', '96k', '-ar', '48000')
  } else {
    outArgs.push('-an')
  }

  outArgs.push(
    '-frames:v',
    String(totalFrames),
    '-r',
    '24',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '26',
    '-bf',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-fps_mode',
    'cfr',
    '-threads',
    '1',
    '-movflags',
    '+faststart',
    outFile,
  )

  await runFfmpeg(outArgs, { label: `stitch ${label} (${segments.length} segments, ${totalFrames} frames)`, token })
}
