import type { ChunkMatch, Scan, ShortCoverage, ShortRange } from './types'

// ---------------------------------------------------------------------------
// SHORT COVERAGE — how much of the short video the match set actually covers.
//
// Pure helpers (no fs / no side effects) shared by the scheduler (COVERAGE
// log at scan end + partial report), the gap-backup pass (which gaps to search),
// the render pipeline (what is NOT going into the output) and the UI.
//
// mergeRanges / gapsOf / missingRanges are the generalised versions of the
// helpers that used to live only inside lib/gemini-minute-finder.ts — the
// minute finder's backup pass imports them from here now.
// ---------------------------------------------------------------------------

/** Missing intervals strictly shorter than 0.500 seconds are ignored. */
export const COVERAGE_MIN_GAP_SEC = 0.5

/** Union of ranges: sorted, overlapping/touching (≤ `touch` s apart) ranges merged. */
export function mergeRanges(rs: ShortRange[], touch = 0.01): ShortRange[] {
  const s = [...rs].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start)
  const out: ShortRange[] = []
  for (const r of s) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + touch) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

/** [0, total) minus `covered` (which MUST already be merged/sorted). */
export function gapsOf(covered: ShortRange[], total: number): ShortRange[] {
  const gaps: ShortRange[] = []
  let cursor = 0
  for (const c of covered) {
    if (c.start > cursor) gaps.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < total) gaps.push({ start: cursor, end: total })
  return gaps
}

/**
 * Gaps = short minus coverage, each padded ±`padSec` (clamped to the short),
 * merged, and anything shorter than `minGapSec` dropped.
 * The minute finder's backup pass uses pad 2 / min 4; manual gap recovery uses
 * the shared 0.500-second coverage threshold and verifies its movie side at 24 fps.
 */
export function missingRanges(
  covered: ShortRange[],
  shortDuration: number,
  opts: { padSec?: number; minGapSec?: number; mergeWithinSec?: number } = {},
): ShortRange[] {
  const pad = opts.padSec ?? 2
  const minGap = opts.minGapSec ?? 4
  const merged = mergeRanges(covered)
  let gaps = gapsOf(merged, shortDuration)
  if (opts.mergeWithinSec) gaps = mergeRanges(gaps, opts.mergeWithinSec)
  const padded = gaps.map((g) => ({ start: Math.max(0, g.start - pad), end: Math.min(shortDuration, g.end + pad) }))
  return mergeRanges(padded).filter((g) => g.end - g.start >= minGap)
}

/** Coverage of `total` seconds by the given short ranges (any order, overlaps allowed). */
export function coverageFromRanges(ranges: ShortRange[], total: number): ShortCoverage {
  const covered = mergeRanges(
    ranges.map((r) => ({ start: Math.max(0, r.start), end: Math.min(total, r.end) })),
  )
  const gaps = gapsOf(covered, total).filter((g) => g.end - g.start >= COVERAGE_MIN_GAP_SEC)
  const missingSec = gaps.reduce((n, g) => n + (g.end - g.start), 0)
  const coveredSec = Math.max(0, total - missingSec)
  const pct = total > 0 ? Math.round((coveredSec / total) * 1000) / 10 : 0
  return { coveredSec, totalSec: total, pct, gaps, missingSec, at: Date.now() }
}

/** Short duration to measure against: stored duration, else the last match end. */
export function shortTotalOf(scan: Pick<Scan, 'shortDuration' | 'matches'>): number {
  if (scan.shortDuration && scan.shortDuration > 0) return scan.shortDuration
  return (scan.matches || []).reduce((n, m) => Math.max(n, m.shortEnd), 0)
}

/**
 * Coverage of the short by ALL matches — verified, unverified AND rejected-kept
 * all count (they are all in the merge). Gaps are the short ranges with NO
 * match at all: exactly what the gap-backup pass searches for.
 */
export function computeShortCoverage(scan: Pick<Scan, 'shortDuration' | 'matches'>): ShortCoverage {
  const total = shortTotalOf(scan)
  return coverageFromRanges((scan.matches || []).map(matchRange), total)
}

function matchRange(m: ChunkMatch): ShortRange {
  return { start: m.shortStart, end: m.shortEnd }
}

/** mm:ss.mmm for coverage logs (short clock). */
export function fmtShortTs(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return `${String(m).padStart(2, '0')}:${r.toFixed(3).padStart(6, '0')}`
}

/** "m:ss" / "m:ss.s" for the headline part of coverage logs. */
export function fmtShortClock(sec: number): string {
  const m = Math.floor(sec / 60)
  const r = sec - m * 60
  const frac = Math.abs(r - Math.round(r)) < 0.05 ? String(Math.round(r)).padStart(2, '0') : r.toFixed(1).padStart(4, '0')
  return `${m}:${frac}`
}

/** "[00:04.250–00:05.542, 00:13.625–00:15.375, ...]" */
export function fmtGapList(gaps: ShortRange[], max = 40): string {
  const items = gaps.slice(0, max).map((g) => `${fmtShortTs(g.start)}–${fmtShortTs(g.end)}`)
  if (gaps.length > max) items.push(`… +${gaps.length - max} more`)
  return `[${items.join(', ')}]`
}

/**
 * The ONE log line for coverage — same wording everywhere (scan end, partial
 * report, render start, after the gap-backup pass).
 *   COVERAGE: short 2:19 → 1:59.4 covered (86%) — 19.6 s MISSING in 12 gap(s): [...]
 */
export function coverageLine(c: ShortCoverage, extra?: string): { level: 'warn' | 'success'; msg: string } {
  const head = `COVERAGE: short ${fmtShortClock(c.totalSec)} → ${fmtShortClock(c.coveredSec)} covered (${c.pct}%)`
  if (c.gaps.length === 0 || c.missingSec < COVERAGE_MIN_GAP_SEC) {
    return { level: 'success', msg: `${head} — nothing missing${extra ? ` ${extra}` : ''}` }
  }
  return {
    level: 'warn',
    msg: `${head} — ${c.missingSec.toFixed(1)} s MISSING in ${c.gaps.length} gap(s): ${fmtGapList(c.gaps)}${extra ? ` ${extra}` : ''}`,
  }
}
