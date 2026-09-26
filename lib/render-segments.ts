import type { MatchOrigin, Scan } from './types'
import { resolveMainMatches } from './candidate-pick'

export { resolveMainMatches } from './candidate-pick'

export interface RenderSegment {
  movieStart: number
  movieEnd: number
  shortStart: number
  shortEnd: number
  /** provenance of the match this scene came from (first match of a merged run) */
  origin?: MatchOrigin
  originWindow?: number
  /** REJECTED — KEPT: the verifier said DIFFERENT but the clip stays in the merge */
  rejected?: boolean
  /** the AI never managed to verify this window */
  unverified?: boolean
  /** user explicitly picked this clip */
  userPick?: boolean
}

/** Single source of truth for both instant preview and exported scene order.
 *
 *  Ordering rules:
 *  1. Scenes ALWAYS follow the short video's timeline (shortStart ascending).
 *  2. When two matches overlap on the short timeline, USER PICKS ALWAYS WIN,
 *     followed by verified matches over unverified ones.
 *  3. Overlapping tails are TRIMMED (1:1 time mapping) instead of dropping the
 *     whole match, so no short-video coverage is silently lost.
 *  4. Back-to-back matches that are continuous in BOTH clocks (e.g. a scene
 *     crossing the 60s minute boundary of a 2-min short) are MERGED into one
 *     scene, so the render has no artificial cut at the boundary. */
export function buildRenderSegments(scan: Pick<Scan, 'matches'>): RenderSegment[] {
  // Step 1: Deterministically resolve the single main match for each scene.
  // USER PICKS ALWAYS WIN (highest priority 10,000).
  const matches = resolveMainMatches(scan.matches || [])

  const segments: RenderSegment[] = []
  for (const match of matches) {
    let { shortStart, movieStart } = match
    const { shortEnd, movieEnd } = match
    const previous = segments.at(-1)

    if (previous) {
      const overlap = previous.shortEnd - shortStart
      if (overlap > 0.05) {
        // If current is user pick and previous is not, protect user pick by trimming previous!
        if (match.userPick && !previous.userPick) {
          const trimAmount = overlap
          previous.shortEnd = shortStart
          previous.movieEnd = Math.max(previous.movieStart + 0.05, previous.movieEnd - trimAmount)
        } else {
          // Normal boundary trim: trim start of current to meet previous end
          movieStart += overlap
          shortStart = previous.shortEnd
        }
        if (shortEnd - shortStart <= 0.05 || movieEnd - movieStart <= 0.05) continue
      }

      // CONTINUITY MERGE: continuous in both the short AND the movie clock
      // (typical at the 60s minute boundary of a multi-minute short).
      if (
        Math.abs(shortStart - previous.shortEnd) <= 0.25 &&
        Math.abs(movieStart - previous.movieEnd) <= 0.25 &&
        movieEnd > previous.movieEnd &&
        Boolean(match.userPick) === Boolean(previous.userPick)
      ) {
        previous.shortEnd = shortEnd
        previous.movieEnd = movieEnd
        continue
      }
    }

    const isConfirmed = match.verified === true || match.batchVerified === 'confirmed'
    segments.push({
      movieStart,
      movieEnd,
      shortStart,
      shortEnd,
      origin: match.origin ?? 'chunk',
      originWindow: match.originWindow,
      rejected: match.rejected === true && match.userPick !== true ? true : undefined,
      unverified: !isConfirmed && match.rejected !== true ? true : undefined,
      userPick: match.userPick ? true : undefined,
    })
  }
  return segments
}

export function totalStitchedSeconds(segments: RenderSegment[]): number {
  return segments.reduce((total, segment) => total + Math.max(0, segment.movieEnd - segment.movieStart), 0)
}

// ---------------------------------------------------------------------------
// FRAME GRID SNAPPING
//
// Gemini reports millisecond timestamps, so a scene duration like 1.167 s is
// 28.008 frames at 24 fps — ffmpeg's `fps=` filter emits the 29th frame and the
// part runs +41 ms long. Over 77 scenes that stacked up to +1.78 s of drift on
// a 2-minute render. Every scene is therefore snapped to the output frame grid
// BEFORE encoding: an integer frame count is what gets encoded (`-frames:v`)
// and what the expected total is computed from, so expected == actual.
// ---------------------------------------------------------------------------

export interface SnappedSegment extends RenderSegment {
  /** exact number of output frames this scene contributes */
  frames: number
  /** frames / fps — the encoded duration, to the sample */
  snapDur: number
}

/** Snap one duration to the frame grid (at least one frame). */
export function snapFrames(dur: number, fps: number): { frames: number; snapDur: number } {
  const frames = Math.max(1, Math.round(Math.max(0, dur) * fps))
  return { frames, snapDur: frames / fps }
}

/** Snap every scene's START and DURATION to the output frame grid so seams
 *  cannot shift and the total is an exact frame count. */
export function snapSegments(segments: RenderSegment[], fps: number): SnappedSegment[] {
  return segments.map((seg) => {
    const movieStart = Math.max(0, Math.round(seg.movieStart * fps) / fps)
    const { frames, snapDur } = snapFrames(seg.movieEnd - seg.movieStart, fps)
    return { ...seg, movieStart, movieEnd: movieStart + snapDur, frames, snapDur }
  })
}

/** Exact output length of a snapped scene list (sum of frame counts / fps). */
export function totalSnappedSeconds(segments: SnappedSegment[], fps: number): number {
  return segments.reduce((total, seg) => total + seg.frames, 0) / fps
}
