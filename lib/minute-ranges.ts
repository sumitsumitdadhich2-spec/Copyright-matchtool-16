import type { MinuteSuggestion, Scan } from './types'
import { formatMinuteList } from './segment-range'

/**
 * SHARED: map approved MOVIE minutes back onto each SHORT minute via the
 * suggestions' short windows, and set the per-short-minute movie search range
 * (existing `movieRangeStart/End` system — the chunk scan then only touches
 * chunks overlapping that range).
 *
 * Extracted VERBATIM from the Pegasus approve route so both the TwelveLabs
 * approval flow and the Gemini Minute Finder auto-start behave identically.
 * Mutates `scan.shortSegments` in place; the caller saves the scan.
 */
export function applyApprovedMinutes(
  scan: Scan,
  approved: number[],
  suggestions: MinuteSuggestion[],
): { ok: true; rangeNotes: string[] } | { ok: false; error: string } {
  const segs = scan.shortSegments
  if (!segs || segs.length === 0) return { ok: false, error: 'Short video segments missing' }
  if (approved.length === 0) return { ok: false, error: 'Kam se kam ek suggested minute approve karo.' }
  const approvedSet = new Set(approved)

  const trimStart = scan.movieTrimStart ?? 0
  const trimEnd = scan.movieTrimEnd ?? scan.movieDuration ?? 0
  const rangeNotes: string[] = []
  for (const seg of segs) {
    const relevantMinutes: number[] = []
    for (const sug of suggestions) {
      if (!approvedSet.has(sug.minute)) continue
      const overlaps = sug.shortWindows.some((w) => w.start < seg.end && w.end > seg.start)
      if (overlaps) relevantMinutes.push(sug.minute)
    }
    if (relevantMinutes.length === 0) {
      seg.selected = false
      delete seg.movieRangeStart
      delete seg.movieRangeEnd
      delete seg.movieMinutes
      continue
    }
    seg.selected = true
    // EXACT MINUTE LIST: chunk selection uses this allow-list (gaps between
    // minutes are skipped). ±1 buffer is already included by the finder.
    const minuteList = [...new Set(relevantMinutes)].sort((a, b) => a - b)
    seg.movieMinutes = minuteList
    // Range = min..max kept ONLY for UI / backward-compat display; the chunk
    // scheduler prefers `movieMinutes` when it is set.
    const rawStart = Math.min(...minuteList) * 60
    const rawEnd = (Math.max(...minuteList) + 1) * 60
    const start = Math.max(trimStart, rawStart)
    const end = Math.min(trimEnd, rawEnd)
    if (end > start && !(start <= trimStart && end >= trimEnd)) {
      seg.movieRangeStart = start
      seg.movieRangeEnd = end
    } else {
      delete seg.movieRangeStart
      delete seg.movieRangeEnd
    }
    rangeNotes.push(`minute ${seg.index + 1} → movie minutes [${formatMinuteList(minuteList)}] (${minuteList.length} chunks)`)
  }

  if (!segs.some((s) => s.selected !== false)) {
    return { ok: false, error: 'Approved minutes kisi short minute se map nahi hue — Retry ya manual Full scan use karo.' }
  }
  return { ok: true, rangeNotes }
}
