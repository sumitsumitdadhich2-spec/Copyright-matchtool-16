'use client'

import { useState } from 'react'
import { useSWRConfig } from 'swr'
import { Check, ChevronLeft, ChevronRight, Loader2, Star, Undo2 } from 'lucide-react'
import type { Scan } from '@/lib/types'
import type { CandidateOption } from '@/lib/candidate-pick'
import { fmtTime } from '@/lib/format'
import { displayModelName } from '@/lib/models'

const STATE_BADGE: Record<CandidateOption['state'], { label: string; cls: string }> = {
  main: { label: 'MAIN clip', cls: 'bg-success/15 text-success' },
  confirmed: { label: 'AI: SAME', cls: 'bg-success/15 text-success' },
  rejected: { label: 'AI: rejected', cls: 'bg-destructive/15 text-destructive' },
  unverified: { label: 'unverified', cls: 'bg-warning/15 text-warning' },
  pending: { label: 'not checked yet', cls: 'bg-muted text-muted-foreground' },
  checking: { label: 'checking', cls: 'bg-primary/15 text-primary' },
}

/** Candidate browser shown under a clip that has alternative movie windows.
 *
 *  `viewIdx === null` = the clip's current MAIN window is showing; a number =
 *  options[viewIdx] is being previewed. The parent player seeks to whatever
 *  window this component reports through onView. "Make main" POSTs the user
 *  pick; scan.matches is rewritten server-side so preview, side-by-side and
 *  export all follow the same choice. */
export function CandidateChooser({
  scan,
  options,
  viewIdx,
  onView,
  compact = false,
}: {
  scan: Scan
  options: CandidateOption[]
  viewIdx: number | null
  onView: (idx: number | null) => void
  compact?: boolean
}) {
  const { mutate } = useSWRConfig()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const renderRunning = scan.renderJob?.status === 'rendering'
  const choiceLocked = renderRunning
  const choiceLockedReason = renderRunning
    ? 'Render chal raha hai — finish ya cancel hone ke baad main clip badlo'
    : null
  const total = options.length
  // Index of the main clip in options (if present).
  const mainIdx = options.findIndex((o) => o.isMain)
  const mainOpt = mainIdx >= 0 ? options[mainIdx] : undefined
  const viewing = viewIdx === null ? null : options[Math.min(viewIdx, Math.max(0, total - 1))]
  // Position of the currently shown window inside the list.
  const pos = viewing ? options.indexOf(viewing) : mainIdx >= 0 ? mainIdx : 0

  function step(dir: 1 | -1) {
    if (total === 0) return
    if (total === 1) {
      // Toggle between main and the candidate option
      if (viewIdx === null && !options[0]?.isMain) {
        onView(0)
      } else {
        onView(null)
      }
      return
    }
    // Cycle smoothly through all candidate options & main
    const next = (pos + dir + total) % total
    const o = options[next]
    onView(o && o.isMain ? null : next)
  }

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/scans/${scan.id}/candidates/pick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError(j.error || 'Choice save nahi hui')
        return
      }
      onView(null)
      await mutate(`/api/scans/${scan.id}`)
    } catch {
      setError('Network error — dobara try karo')
    } finally {
      setBusy(false)
    }
  }

  function makeMain() {
    if (!viewing || viewing.isMain) return
    void post({
      groupId: viewing.groupId,
      candidateIndex: viewing.index,
      viaRescan: viewing.viaRescan,
      shortStart: viewing.shortStart,
      shortEnd: viewing.shortEnd,
      movieStart: viewing.movieStart,
      movieEnd: viewing.movieEnd,
      chunkIndex: viewing.chunkIndex,
      model: viewing.model,
    })
  }

  function resetToAi() {
    const picked = options.find((o) => o.isUserPick)
    if (!picked) return
    void post({ groupId: picked.groupId, candidateIndex: null })
  }

  const hasMultiple = total > 1 || (total === 1 && !options[0]?.isMain)
  const canPrev = hasMultiple
  const canNext = hasMultiple
  const userPicked = options.some((o) => o.isUserPick)
  const badge = viewing
    ? STATE_BADGE[viewing.state] || { label: viewing.state || 'candidate', cls: 'bg-muted text-muted-foreground' }
    : mainOpt
    ? STATE_BADGE.main
    : null

  return (
    <div
      className={`rounded-md border border-dashed border-primary/40 bg-primary/5 ${compact ? 'p-2' : 'p-2.5'}`}
      role="group"
      aria-label="Candidate windows for this clip"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-xs font-semibold">
          <Star className="size-3.5 text-primary" aria-hidden />
          {total} candidate{total === 1 ? '' : 's'} for this clip
        </span>
        {viewing && (viewing.viaRescan || viewing.origin === 'rescan') ? (
          <span className="rounded-full bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 px-2 py-0.5 font-mono text-[10px] font-medium">
            🔄 Rescanned (User Review)
          </span>
        ) : !viewing && mainOpt && (mainOpt.viaRescan || mainOpt.origin === 'rescan') ? (
          <span className="rounded-full bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 px-2 py-0.5 font-mono text-[10px] font-medium">
            🔄 Rescanned Main
          </span>
        ) : badge ? (
          <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${badge.cls}`}>{badge.label}</span>
        ) : null}
        {viewing && (
          <span className="font-mono text-[10px] text-muted-foreground">
            short {fmtTime(viewing.shortStart)}–{fmtTime(viewing.shortEnd)} ({(viewing.shortEnd - viewing.shortStart).toFixed(1)}s) · movie {fmtTime(viewing.movieStart)}–{fmtTime(viewing.movieEnd)} · chunk {viewing.chunkIndex} · {displayModelName(viewing.model)}
            {viewing.viaRescan || viewing.origin === 'rescan' ? ' · 🔄 rescan' : ''}
          </span>
        )}
        {!viewing && mainOpt && (
          <span className="font-mono text-[10px] text-muted-foreground">
            showing MAIN — short {fmtTime(mainOpt.shortStart)}–{fmtTime(mainOpt.shortEnd)} ({(mainOpt.shortEnd - mainOpt.shortStart).toFixed(1)}s) · movie {fmtTime(mainOpt.movieStart)}–{fmtTime(mainOpt.movieEnd)}
            {mainOpt.viaRescan || mainOpt.origin === 'rescan' ? ' · 🔄 rescan' : mainOpt.isUserPick ? ' · your choice' : ''}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {viewing ? `Candidate ${pos + 1} of ${total}` : `Main (${pos + 1}/${total})`}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={!canPrev || busy}
          className="flex items-center gap-1 rounded-md border border-input px-2.5 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-40"
          aria-label="Previous candidate"
        >
          <ChevronLeft className="size-3.5" aria-hidden /> Prev candidate
        </button>
        <button
          type="button"
          onClick={() => step(1)}
          disabled={!canNext || busy}
          className="flex items-center gap-1 rounded-md border border-input px-2.5 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-40"
          aria-label="Next candidate"
        >
          Next candidate <ChevronRight className="size-3.5" aria-hidden />
        </button>
        {viewing && !viewing.isMain && (
          <button
            type="button"
            onClick={() => onView(null)}
            disabled={busy}
            className="rounded-md border border-input px-2.5 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-40"
          >
            Back to main
          </button>
        )}
        <button
          type="button"
          onClick={makeMain}
          disabled={!viewing || viewing.isMain || busy || choiceLocked}
          title={choiceLockedReason ?? 'Is candidate ko main clip banao (preview + export me)'}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
          Make this the main clip
        </button>
        {userPicked && (
          <button
            type="button"
            onClick={resetToAi}
            disabled={busy || choiceLocked}
            className="flex items-center gap-1 rounded-md border border-input px-2.5 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-40"
            title={choiceLockedReason ?? 'User choice hatao — AI verdict wapas'}
          >
            <Undo2 className="size-3.5" aria-hidden /> Reset to AI
          </button>
        )}
      </div>
      {choiceLockedReason && (
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          Candidate dekh sakte ho; {choiceLockedReason}.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
