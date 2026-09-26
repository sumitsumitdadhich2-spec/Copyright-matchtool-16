import type { CandidateEntry, CandidateGroup, ChunkMatch, MatchOrigin, Scan } from './types'

// ---------------------------------------------------------------------------
// CANDIDATE PICK — user choice of the main clip for one short window.
//
// Pure helpers shared by the scheduler (server), the pick API route (server)
// and the preview/compare panels (client). No fs / no side effects.
// ---------------------------------------------------------------------------

/** Two short-video ranges represent the same scene/segment (even with lesser or greater duration)
 *  when they overlap, start/end near each other, or one is contained in the other. */
export function sameShortSegment(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart)
  const aLen = Math.max(0.01, aEnd - aStart)
  const bLen = Math.max(0.01, bEnd - bStart)
  const shorter = Math.min(aLen, bLen)

  // One is contained within the other (even with different duration)
  if ((aStart >= bStart - 0.35 && aEnd <= bEnd + 0.35) || (bStart >= aStart - 0.35 && bEnd <= aEnd + 0.35)) {
    return true
  }

  // Significant overlap (at least 20% of shorter, or at least 0.2s)
  if (overlap > 0 && shorter > 0) {
    if (overlap >= 0.2 || overlap / shorter >= 0.2) return true
  }

  // Starts or ends close to each other with any positive overlap
  if (overlap > 0 && (Math.abs(aStart - bStart) < 0.45 || Math.abs(aEnd - bEnd) < 0.45)) {
    return true
  }

  return false
}

/** Resolves a list of matches to a single, non-overlapping sequence of main matches.
 *  Priority rules:
 *  1. User pick (`userPick === true`) ALWAYS wins (highest priority).
 *  2. Confirmed/Verified (`verified === true || batchVerified === 'confirmed'`) wins over unverified.
 *  3. Non-rejected wins over rejected (`rejected === true || batchVerified === 'rejected'`).
 *  4. Longer short duration and higher confidence break ties.
 *  5. Earlier shortStart breaks remaining ties.
 */
export function resolveMainMatches(matches: ChunkMatch[]): ChunkMatch[] {
  if (!matches || matches.length === 0) return []

  const valid = matches.filter((m) => m && m.movieEnd - m.movieStart > 0.05)

  // 1. Sort by deterministic priority descending, so the chosen or best match is evaluated first:
  const sorted = [...valid].sort((a, b) => {
    const aPick = a.userPick ? 1 : 0
    const bPick = b.userPick ? 1 : 0
    if (aPick !== bPick) return bPick - aPick

    const aConf = (a.verified || a.batchVerified === 'confirmed') ? 1 : 0
    const bConf = (b.verified || b.batchVerified === 'confirmed') ? 1 : 0
    if (aConf !== bConf) return bConf - aConf

    const aRej = (a.rejected || a.batchVerified === 'rejected') ? 1 : 0
    const bRej = (b.rejected || b.batchVerified === 'rejected') ? 1 : 0
    if (aRej !== bRej) return aRej - bRej

    const aDur = a.shortEnd - a.shortStart
    const bDur = b.shortEnd - b.shortStart
    if (Math.abs(aDur - bDur) > 0.1) return bDur - aDur

    return (b.confidence || 0) - (a.confidence || 0) || a.shortStart - b.shortStart
  })

  // 2. Greedily accept matches. Since higher-priority matches come first,
  // any conflicting candidate or duplicate for the same short segment is rejected.
  const accepted: ChunkMatch[] = []
  for (const m of sorted) {
    const conflicts = accepted.some((existing) => {
      if (sameShortSegment(existing.shortStart, existing.shortEnd, m.shortStart, m.shortEnd)) return true
      const overlap = Math.min(existing.shortEnd, m.shortEnd) - Math.max(existing.shortStart, m.shortStart)
      const shorter = Math.min(existing.shortEnd - existing.shortStart, m.shortEnd - m.shortStart)
      if (overlap > 0 && shorter > 0) {
        // If both are user picks, only near-identical segment (>= 75% overlap) conflicts.
        if (existing.userPick && m.userPick) {
          if (overlap / shorter >= 0.75) return true
          return false
        }
        // For general candidates, only a true majority overlap (>= 50%) is a scene conflict.
        // Seams/boundary overlaps (e.g. 0.1s - 0.4s) between consecutive scenes are NOT conflicts;
        // buildRenderSegments trims boundary overlaps cleanly so both scenes are preserved.
        if (overlap / shorter >= 0.5) return true
      }
      return false
    })

    if (!conflicts) {
      accepted.push(m)
    }
  }

  // 3. Sort chronologically by shortStart
  accepted.sort((a, b) => a.shortStart - b.shortStart)
  return accepted
}

/** Provenance of a match produced from group `g`. A rescan-found window is
 *  'rescan' — unless the group itself came from the gap-backup pass, whose
 *  origin is the more useful thing to know downstream. */
export function groupMatchOrigin(g: CandidateGroup, viaRescan: boolean): MatchOrigin {
  const base = g.origin ?? 'chunk'
  if (viaRescan && base !== 'gap-backup') return 'rescan'
  return base
}

/** Human label for logs: "[origin: chunk scan #12]" / "[origin: rescan]" /
 *  "[origin: gap backup window #7]" / "[origin: user pick]". */
export function originTag(origin: MatchOrigin | undefined, chunkIndex?: number, originWindow?: number): string {
  switch (origin) {
    case 'rescan':
      return '[origin: rescan]'
    case 'gap-backup':
      return `[origin: gap backup${originWindow !== undefined ? ` window #${originWindow}` : ''}]`
    case 'user':
      return '[origin: user pick]'
    default:
      return `[origin: chunk scan${chunkIndex !== undefined ? ` #${chunkIndex}` : ''}]`
  }
}

/** REJECTED — KEPT: the best candidate window of a rejected group. Prefer the
 *  most recent rescan-found window (the rescan had the whole chunk to look at),
 *  otherwise the first (highest-ranked) original candidate. */
export function bestRejectedCandidate(g: CandidateGroup): { c: CandidateEntry; index: number; viaRescan: boolean } | null {
  if (!g.candidates || g.candidates.length === 0) return null
  for (let i = g.candidates.length - 1; i >= 0; i--) {
    const c = g.candidates[i]
    if (c.rescan === 'found' && c.rescanMovieStart != null && c.rescanMovieEnd != null && c.rescanMovieEnd > c.rescanMovieStart) {
      return { c, index: i, viaRescan: true }
    }
  }
  return { c: g.candidates[0], index: 0, viaRescan: false }
}

/** Rewrite scan.matches for ONE candidate group.
 *
 *  USER PICK wins: one verified match built from the picked candidate window
 *  (rescan window when viaRescan) — even if the AI rejected / never verified it.
 *  Otherwise the AI verdict:
 *   confirmed  → ONE verified match (rescan window when confirmedViaRescan)
 *   rejected   → best candidate KEPT, flagged rejected=true, verified=false
 *                ("almost right" beats a hole in the merge). Superseded groups
 *                (a confirmed group already owns the window) push nothing.
 *   unverified → original candidate windows kept, flagged verified=false
 *   pending / verifying / rescanning → group not decided yet: matches untouched
 *     (the raw chunk matches stay in place until the verifier finishes). */
export function applyGroupMatches(scan: Scan, g: CandidateGroup): void {
  const pick = g.userPick
  const picked = pick ? g.candidates[pick.index] : undefined

  const pStart = picked?.shortStart ?? g.shortStart
  const pEnd = picked?.shortEnd ?? g.shortEnd

  // Remove any match that belongs to this group or overlaps this exact short scene.
  // CRITICAL: A non-user-pick group must NEVER overwrite a match that the user manually picked (userPick === true)!
  scan.matches = (scan.matches || []).filter((m) => {
    const isSameSegment =
      sameShortSegment(g.shortStart, g.shortEnd, m.shortStart, m.shortEnd) ||
      sameShortSegment(pStart, pEnd, m.shortStart, m.shortEnd)

    if (isSameSegment) {
      // If the existing match was picked by the user, and this group is NOT a user pick, preserve the user pick!
      if (m.userPick && !g.userPick) return true
      return false
    }

    const overlap = Math.min(m.shortEnd, pEnd) - Math.max(m.shortStart, pStart)
    const shorter = Math.min(m.shortEnd - m.shortStart, pEnd - pStart)
    if (overlap > 0 && shorter > 0 && overlap / shorter >= 0.5) {
      if (m.userPick && !g.userPick) return true
      return false
    }
    return true
  })

  if (picked && pick) {
    const useRescan = pick.viaRescan && picked.rescanMovieStart != null && picked.rescanMovieEnd != null
    scan.matches.push({
      shortStart: picked.shortStart ?? g.shortStart,
      shortEnd: picked.shortEnd ?? g.shortEnd,
      movieStart: useRescan ? picked.rescanMovieStart! : picked.movieStart,
      movieEnd: useRescan ? picked.rescanMovieEnd! : picked.movieEnd,
      chunkIndex: picked.chunkIndex,
      model: picked.model,
      confidence: picked.confidence ?? 0.95,
      verified: true,
      viaRescan: useRescan || undefined,
      userPick: true,
      origin: 'user',
      originWindow: g.originWindow,
    })
  } else if (g.status === 'confirmed' && g.confirmedIndex !== null) {
    const c = g.candidates[g.confirmedIndex]
    if (c) {
      scan.matches.push({
        shortStart: c.shortStart ?? g.shortStart,
        shortEnd: c.shortEnd ?? g.shortEnd,
        movieStart: g.confirmedViaRescan ? c.rescanMovieStart! : c.movieStart,
        movieEnd: g.confirmedViaRescan ? c.rescanMovieEnd! : c.movieEnd,
        chunkIndex: c.chunkIndex,
        model: c.model,
        confidence: c.confidence,
        verified: true,
        viaRescan: g.confirmedViaRescan || undefined,
        origin: groupMatchOrigin(g, g.confirmedViaRescan),
        originWindow: g.originWindow,
      })
    }
  } else if (g.status === 'rejected' && !g.superseded) {
    const best = bestRejectedCandidate(g)
    if (best) {
      scan.matches.push({
        shortStart: best.c.shortStart ?? g.shortStart,
        shortEnd: best.c.shortEnd ?? g.shortEnd,
        movieStart: best.viaRescan ? best.c.rescanMovieStart! : best.c.movieStart,
        movieEnd: best.viaRescan ? best.c.rescanMovieEnd! : best.c.movieEnd,
        chunkIndex: best.c.chunkIndex,
        model: best.c.model,
        confidence: best.c.confidence,
        verified: false,
        rejected: true,
        viaRescan: best.viaRescan || undefined,
        origin: groupMatchOrigin(g, best.viaRescan),
        originWindow: g.originWindow,
      })
    }
  } else {
    // Unverified or undecided (pending/verifying/rescanning): keep ONLY the single
    // best candidate (longest duration / highest confidence) in scan.matches so multiple
    // chunk candidates NEVER duplicate, slice, or clutter the stitched preview, compare panel, or timeline!
    const best = [...(g.candidates || [])].sort((a, b) => {
      const aDur = (a.shortEnd ?? g.shortEnd) - (a.shortStart ?? g.shortStart)
      const bDur = (b.shortEnd ?? g.shortEnd) - (b.shortStart ?? g.shortStart)
      if (Math.abs(aDur - bDur) > 0.15) return bDur - aDur
      return (b.confidence || 0) - (a.confidence || 0)
    })[0] || (g.candidates ? g.candidates[0] : undefined)

    if (best) {
      scan.matches.push({
        shortStart: best.shortStart ?? g.shortStart,
        shortEnd: best.shortEnd ?? g.shortEnd,
        movieStart: best.movieStart,
        movieEnd: best.movieEnd,
        chunkIndex: best.chunkIndex,
        model: best.model,
        confidence: best.confidence,
        verified: false,
        origin: groupMatchOrigin(g, false),
        originWindow: g.originWindow,
      })
    }
  }
  scan.matches.sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)
}

// ---------- Client-side option list for the preview / compare panels ----------

export type CandidateOptionState = 'main' | 'confirmed' | 'rejected' | 'unverified' | 'pending' | 'checking'

/** One selectable movie window for a short clip (a candidate, or its rescan window). */
export interface CandidateOption {
  groupId: string
  groupStatus: CandidateGroup['status']
  /** index into group.candidates[] */
  index: number
  viaRescan: boolean
  /** short window of the OWNING group (ABSOLUTE short seconds) */
  shortStart: number
  shortEnd: number
  /** ABSOLUTE movie seconds */
  movieStart: number
  movieEnd: number
  chunkIndex: number
  model: string
  /** what the AI decided about this exact window */
  state: CandidateOptionState
  /** this window is the current main clip (AI confirmed or user pick) */
  isMain: boolean
  /** this window is the user's explicit pick */
  isUserPick: boolean
  /** main clip of a REJECTED group kept in the merge (no user pick) — red badge */
  rejectedKept: boolean
  /** provenance of this window */
  origin: MatchOrigin
  originWindow?: number
}

function windowState(c: CandidateEntry, g: CandidateGroup, index: number, viaRescan: boolean): CandidateOptionState {
  if (g.status === 'confirmed' && g.confirmedIndex === index && g.confirmedViaRescan === viaRescan) return 'confirmed'
  const verdict = viaRescan ? c.rescanVerdict : c.verdict
  if (verdict === 'same') return 'confirmed'
  if (verdict === 'different') return 'rejected'
  if (verdict === 'verifying' || (!viaRescan && c.rescan === 'rescanning')) return 'checking'
  if (g.status === 'rejected') return 'rejected'
  if (g.status === 'unverified' || verdict === 'error') return 'unverified'
  return 'pending'
}

function nearlySame(a: number, b: number) {
  return Math.abs(a - b) <= 0.5
}

/** All candidate windows whose group covers the given short window (the clip
 *  currently shown in the preview / compare). Rescan-found windows count as
 *  their own option. Every group state is included — confirmed, unverified,
 *  rejected and not-yet-checked — the choice belongs to the user. */
export function candidateOptionsFor(scan: Pick<Scan, 'matches' | 'candidateGroups'>, shortStart: number, shortEnd: number): CandidateOption[] {
  const groups = (scan.candidateGroups || []).filter((g) => {
    return (
      sameShortSegment(g.shortStart, g.shortEnd, shortStart, shortEnd) ||
      Math.min(g.shortEnd, shortEnd) - Math.max(g.shortStart, shortStart) > 0.05
    )
  })
  const resolved = resolveMainMatches(scan.matches || [])
  const mains = resolved.filter(
    (m) =>
      sameShortSegment(m.shortStart, m.shortEnd, shortStart, shortEnd) ||
      Math.min(m.shortEnd, shortEnd) - Math.max(m.shortStart, shortStart) > 0.05,
  )
  const main = mains[0]
  const out: CandidateOption[] = []

  for (const g of groups) {
    ;(g.candidates || []).forEach((c, index) => {
      const push = (viaRescan: boolean, ms: number, me: number) => {
        const isUserPick =
          (!!g.userPick && g.userPick.index === index && g.userPick.viaRescan === viaRescan) ||
          (!!main?.userPick && Math.abs(main.movieStart - ms) < 0.5 && Math.abs(main.movieEnd - me) < 0.5)
        out.push({
          groupId: g.id,
          groupStatus: g.status,
          index,
          viaRescan,
          shortStart: c.shortStart ?? g.shortStart,
          shortEnd: c.shortEnd ?? g.shortEnd,
          movieStart: ms,
          movieEnd: me,
          chunkIndex: c.chunkIndex,
          model: c.model,
          state: windowState(c, g, index, viaRescan),
          isMain: false,
          isUserPick,
          rejectedKept: false,
          origin: groupMatchOrigin(g, viaRescan),
          originWindow: g.originWindow,
        })
      }
      push(false, c.movieStart, c.movieEnd)
      if (c.rescan === 'found' && c.rescanMovieStart != null && c.rescanMovieEnd != null) {
        push(true, c.rescanMovieStart, c.rescanMovieEnd)
      }
    })
  }

  // Include any other chunk matches that claimed this same short segment
  for (const m of mains) {
    const already = out.some(
      (o) =>
        Math.abs(o.movieStart - m.movieStart) < 0.5 &&
        Math.abs(o.movieEnd - m.movieEnd) < 0.5 &&
        Math.abs(o.shortStart - m.shortStart) < 0.5,
    )
    if (!already) {
      out.push({
        groupId: groups[0]?.id ?? `g-match-${m.chunkIndex}`,
        groupStatus: m.verified ? 'confirmed' : 'pending',
        index: -1,
        viaRescan: false,
        shortStart: m.shortStart,
        shortEnd: m.shortEnd,
        movieStart: m.movieStart,
        movieEnd: m.movieEnd,
        chunkIndex: m.chunkIndex,
        model: m.model,
        state: m.verified ? 'confirmed' : m.rejected ? 'rejected' : 'pending',
        isMain: false,
        isUserPick: !!m.userPick,
        rejectedKept: isRejectedKept(m),
        origin: m.origin ?? 'chunk',
        originWindow: m.originWindow,
      })
    }
  }

  // De-duplicate identical windows (adjacent chunks often report the same window).
  const seen = new Set<string>()
  const deduped = out.filter((o) => {
    const k = `${o.shortStart.toFixed(1)}-${o.shortEnd.toFixed(1)}-${o.movieStart.toFixed(1)}-${o.movieEnd.toFixed(1)}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  // Identify or inject the SINGLE active main option
  let mainOpt: CandidateOption | undefined
  if (main) {
    mainOpt = deduped.find((o) => nearlySame(o.movieStart, main.movieStart) && nearlySame(o.movieEnd, main.movieEnd))
    if (!mainOpt) {
      mainOpt = deduped.find((o) => Math.abs(o.movieStart - main.movieStart) < 1.0)
    }
    if (!mainOpt) {
      mainOpt = {
        groupId: groups[0]?.id ?? 'main',
        groupStatus: groups[0]?.status ?? 'confirmed',
        index: -1,
        viaRescan: false,
        shortStart: main.shortStart,
        shortEnd: main.shortEnd,
        movieStart: main.movieStart,
        movieEnd: main.movieEnd,
        chunkIndex: main.chunkIndex,
        model: main.model,
        state: 'main',
        isMain: true,
        isUserPick: !!main.userPick,
        rejectedKept: isRejectedKept(main),
        origin: main.origin ?? 'chunk',
        originWindow: main.originWindow,
      }
      deduped.unshift(mainOpt)
    }
  } else if (deduped.length > 0) {
    mainOpt = deduped[0]
  }

  // Strictly enforce: ONLY mainOpt is isMain=true, everything else is isMain=false
  for (const o of deduped) {
    if (o === mainOpt) {
      o.isMain = true
      o.state = 'main'
      o.rejectedKept = isRejectedKept(main || o)
      if (main?.origin) o.origin = main.origin
      if (main?.userPick) o.isUserPick = true
    } else {
      o.isMain = false
    }
  }

  // Put the active main option first (index 0), then remaining candidates
  return deduped.sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.shortStart - b.shortStart || a.movieStart - b.movieStart)
}

/** A clip "has candidates" when at least one alternative window exists besides its current main. */
export function hasAlternatives(options: CandidateOption[]): boolean {
  return options.some((o) => !o.isMain)
}

/** Does the given match come from a user pick? (helper for badges) */
export function isUserPicked(m: ChunkMatch): boolean {
  return m.userPick === true
}

/** Is this match a REJECTED group's best candidate kept in the merge? */
export function isRejectedKept(m: ChunkMatch): boolean {
  return m.rejected === true && m.userPick !== true
}

/** Short UI label for a provenance chip. */
export function originLabel(origin: MatchOrigin | undefined, originWindow?: number): string {
  switch (origin) {
    case 'rescan':
      return 'rescan'
    case 'gap-backup':
      return originWindow !== undefined ? `gap backup #${originWindow}` : 'gap backup'
    case 'user':
      return 'your pick'
    default:
      return 'chunk scan'
  }
}
