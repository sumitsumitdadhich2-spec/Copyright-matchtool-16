import { CHUNK_SECONDS } from './models'
import type { Scan, ShortSegmentState } from './types'

/** Client-safe helpers for the PER-MINUTE movie search range feature.
 *  Shared by the scheduler (server), the segments API route and the
 *  minute-select UI so all three agree on which chunks a minute covers. */

/** ABSOLUTE original-movie window of a chunk: chunks cover ONLY the confirmed
 *  trim range, so every chunk's absolute start = trimStart + index * 60. */
export function chunkAbsWindow(
  scan: Pick<Scan, 'movieTrimStart' | 'movieTrimEnd' | 'movieDuration'>,
  chunkIndex: number,
): { start: number; end: number } {
  const trimStart = scan.movieTrimStart ?? 0
  const rangeEnd = scan.movieTrimEnd ?? scan.movieDuration ?? Number.POSITIVE_INFINITY
  const start = trimStart + chunkIndex * CHUNK_SECONDS
  return { start, end: Math.min(start + CHUNK_SECONDS, rangeEnd) }
}

/** Effective movie search range for one short minute: its own per-minute range
 *  (clamped inside the trim window), or the whole trim window when unset. */
export function segMovieRange(
  scan: Pick<Scan, 'movieTrimStart' | 'movieTrimEnd' | 'movieDuration'>,
  seg: Pick<ShortSegmentState, 'movieRangeStart' | 'movieRangeEnd'>,
): { start: number; end: number; custom: boolean } {
  const trimStart = scan.movieTrimStart ?? 0
  const trimEnd = scan.movieTrimEnd ?? scan.movieDuration ?? Number.POSITIVE_INFINITY
  const hasCustom =
    typeof seg.movieRangeStart === 'number' && typeof seg.movieRangeEnd === 'number' && seg.movieRangeEnd > seg.movieRangeStart
  if (!hasCustom) return { start: trimStart, end: trimEnd, custom: false }
  const start = Math.max(trimStart, seg.movieRangeStart!)
  const end = Math.min(trimEnd, seg.movieRangeEnd!)
  if (end <= start) return { start: trimStart, end: trimEnd, custom: false }
  return { start, end, custom: true }
}

/** True when the minute has an exact movie-minute allow-list (Minute Finder). */
export function segHasMinuteList(seg: Pick<ShortSegmentState, 'movieMinutes'>): boolean {
  return Array.isArray(seg.movieMinutes) && seg.movieMinutes.length > 0
}

/** Compact "7-13, 21-24, 66" rendering of a sorted minute list for logs/UI. */
export function formatMinuteList(minutes: number[]): string {
  const sorted = [...new Set(minutes)].sort((a, b) => a - b)
  const parts: string[] = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`)
    i = j + 1
  }
  return parts.join(', ')
}

/** True when a movie chunk overlaps the minute's chosen movie search range —
 *  chunks outside the range are skipped for that minute (quota saver).
 *  EXACT MINUTE LIST (Minute Finder) takes priority over the continuous
 *  movieRangeStart/End range: only chunks touching a listed absolute movie
 *  minute count as "in range"; gaps between listed minutes are skipped. */
export function chunkOverlapsSegRange(
  scan: Pick<Scan, 'movieTrimStart' | 'movieTrimEnd' | 'movieDuration'>,
  seg: Pick<ShortSegmentState, 'movieRangeStart' | 'movieRangeEnd' | 'movieMinutes'>,
  chunkIndex: number,
): boolean {
  const w = chunkAbsWindow(scan, chunkIndex)
  if (segHasMinuteList(seg)) {
    // A chunk's absolute start = trimStart + index*60, so with a non-zero
    // trimStart one chunk can touch TWO movie minutes — check every minute
    // the chunk window covers.
    const firstMin = Math.floor(w.start / 60)
    const lastMin = Math.floor(Math.max(w.start, w.end - 0.001) / 60)
    for (let m = firstMin; m <= lastMin; m++) if (seg.movieMinutes!.includes(m)) return true
    return false
  }
  const r = segMovieRange(scan, seg)
  return w.start < r.end && w.end > r.start
}
