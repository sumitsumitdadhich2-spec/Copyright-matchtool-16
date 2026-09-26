'use client'

import { useRef, useState } from 'react'
import {
  Target,
  Play,
  ShieldCheck,
  ShieldX,
  ShieldQuestion,
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronUp,
  Search,
} from 'lucide-react'
import type { Scan, CandidateGroup, CandidateEntry } from '@/lib/types'
import { fmtTime } from '@/lib/format'
import { displayModelName } from '@/lib/models'
import { originLabel } from '@/lib/candidate-pick'

const GROUP_BADGE: Record<CandidateGroup['status'], { label: string; cls: string }> = {
  pending: { label: 'Pending verify', cls: 'bg-muted text-muted-foreground' },
  verifying: { label: 'Verifying 24fps', cls: 'bg-primary/15 text-primary' },
  rescanning: { label: 'Rescanning', cls: 'bg-warning/15 text-warning' },
  confirmed: { label: 'Confirmed', cls: 'bg-success/15 text-success' },
  rejected: { label: 'Rejected (final)', cls: 'bg-destructive/15 text-destructive' },
  unverified: { label: 'Unverified', cls: 'bg-warning/15 text-warning' },
}

export function CandidatesPanel({ scan }: { scan: Scan }) {
  const groups = scan.candidateGroups ?? []
  const totalCandidates = groups.reduce((n, g) => n + (g.candidates ? g.candidates.length : 0), 0)
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  if (groups.length === 0) return null

  const filteredGroups = groups.filter((g) => {
    if (!searchQuery.trim()) return true
    const q = searchQuery.toLowerCase().trim()
    const str = `${fmtTime(g.shortStart)} ${fmtTime(g.shortEnd)} ${g.status} ${g.origin || ''} ${g.candidates?.map((c) => `${c.chunkIndex} ${fmtTime(c.movieStart)}`).join(' ') || ''}`.toLowerCase()
    return str.includes(q)
  })

  return (
    <section aria-label="Match candidates" className="panel border-border/80 bg-card/70">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Target className="size-4 text-destructive" aria-hidden />
          <h2 className="text-sm font-semibold">Match Candidates Explorer</h2>
          <span className="rounded-full bg-muted px-2.5 py-0.5 font-mono text-xs text-muted-foreground">
            {groups.length} group{groups.length === 1 ? '' : 's'} · {totalCandidates} candidate{totalCandidates === 1 ? '' : 's'}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-1.5 rounded-lg border border-input bg-secondary px-3 py-1.5 text-xs font-semibold text-foreground hover:border-primary/40 hover:bg-secondary/80 transition"
        >
          <span>{isOpen ? 'Collapse Candidate List' : 'Expand Full Candidate List'}</span>
          {isOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
      </div>

      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Candidate details & live verification status are also integrated right into the <strong>Match Report Table</strong> above.
      </p>

      {isOpen && (
        <div className="mt-3 space-y-3">
          {/* Quick search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search candidate groups by timestamp or chunk..."
              className="w-full rounded-lg border border-input bg-background py-1.5 pl-8 pr-3 text-xs placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
          </div>

          <div className="grid gap-3">
            {[...filteredGroups]
              .sort((a, b) => a.shortStart - b.shortStart)
              .map((g) => (
                <GroupCard key={g.id} scan={scan} g={g} />
              ))}
          </div>
        </div>
      )}
    </section>
  )
}

function GroupCard({ scan, g }: { scan: Scan; g: CandidateGroup }) {
  const badge = GROUP_BADGE[g.status] || { label: g.status || 'Pending', cls: 'bg-muted text-muted-foreground' }
  const busy = g.status === 'verifying' || g.status === 'rescanning'
  const candidates = g.candidates || []
  return (
    <div className="rounded-lg border border-border bg-background p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-bold text-foreground">
          Short {fmtTime(g.shortStart)} – {fmtTime(g.shortEnd)}
        </span>
        <span className={`ml-auto flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] ${badge.cls}`}>
          {busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
          {badge.label}
        </span>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          {originLabel(g.origin, g.originWindow)}
        </span>
      </div>
      <div className="mt-2.5 grid gap-2">
        {candidates.map((c, i) => (
          <CandidateRow key={i} scan={scan} g={g} c={c} index={i} />
        ))}
      </div>
    </div>
  )
}

function verdictBadge(c: CandidateEntry, g: CandidateGroup, index: number) {
  const isWinner = g.status === 'confirmed' && g.confirmedIndex === index
  if (isWinner) {
    return (
      <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 font-mono text-[11px] text-success font-semibold">
        <ShieldCheck className="size-3" aria-hidden />
        {g.confirmedViaRescan ? 'SAME (via rescan)' : 'SAME'}
      </span>
    )
  }
  if (c.verdict === 'verifying' || c.rescanVerdict === 'verifying' || c.rescan === 'rescanning') {
    return (
      <span className="flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[11px] text-primary">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        checking
      </span>
    )
  }
  if (c.verdict === 'different') {
    return (
      <span className="flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 font-mono text-[11px] text-destructive font-semibold">
        <ShieldX className="size-3" aria-hidden />
        DIFFERENT
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
      <ShieldQuestion className="size-3" aria-hidden />
      pending
    </span>
  )
}

function CandidateRow({ scan, g, c, index }: { scan: Scan; g: CandidateGroup; c: CandidateEntry; index: number }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [showVideo, setShowVideo] = useState(false)
  const previewStart = g.confirmedViaRescan && g.confirmedIndex === index && c.rescanMovieStart != null ? c.rescanMovieStart : c.movieStart

  function openPreview() {
    setShowVideo(true)
    requestAnimationFrame(() => {
      const v = videoRef.current
      if (!v) return
      const seek = () => {
        v.currentTime = previewStart
        void v.play().catch(() => {})
      }
      if (v.readyState >= 1) seek()
      else v.addEventListener('loadedmetadata', seek, { once: true })
    })
  }

  return (
    <div className="rounded-md border border-border/60 bg-muted/20 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-bold">
          #{index + 1} Movie {fmtTime(c.movieStart)} – {fmtTime(c.movieEnd)}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">chunk {c.chunkIndex}</span>
        <span className="ml-auto flex items-center gap-1">
          {g.status === 'rejected' && !g.superseded && index === 0 && (
            <span className="rounded-full bg-destructive/15 px-2 py-0.5 font-mono text-[11px] text-destructive font-semibold">
              rejected kept
            </span>
          )}
          {verdictBadge(c, g, index)}
        </span>
      </div>
      <div className="mt-1.5 grid gap-0.5 text-xs text-muted-foreground">
        <span>
          Found by <span className="font-mono font-medium text-foreground">{displayModelName(c.model)}</span>
          {c.verifierModel && (
            <>
              {' · verified by '}
              <span className="font-mono font-medium text-foreground">{displayModelName(c.verifierModel)}</span>
            </>
          )}
        </span>
        {c.verifierReason && <p className="mt-0.5 italic text-foreground/90">&ldquo;{c.verifierReason}&rdquo;</p>}
        {c.rescan !== 'none' && c.rescan !== 'pending' && (
          <div className="mt-1 flex items-center gap-1 text-purple-400">
            <RefreshCw className="size-3 shrink-0" aria-hidden />
            {c.rescan === 'rescanning' && `Rescanning full chunk ${c.chunkIndex}...`}
            {c.rescan === 'not_found' && 'Rescan: segment NOT found in full chunk'}
            {c.rescan === 'found' && c.rescanMovieStart != null && (
              <>
                Rescan found {fmtTime(c.rescanMovieStart)} – {fmtTime(c.rescanMovieEnd ?? c.rescanMovieStart)}
                {c.rescanVerdict === 'same' && ' — verifier: SAME'}
                {c.rescanVerdict === 'different' && ' — verifier: DIFFERENT (final)'}
              </>
            )}
          </div>
        )}
        {c.rescanReason && <p className="italic text-purple-300">&ldquo;{c.rescanReason}&rdquo;</p>}
      </div>
      {showVideo ? (
        <video
          ref={videoRef}
          src={`/api/scans/${scan.id}/media?kind=movie`}
          controls
          playsInline
          preload="metadata"
          className="mt-2 w-full rounded-md bg-black max-h-60"
          aria-label={`Movie preview at ${fmtTime(previewStart)}`}
        />
      ) : (
        <button
          type="button"
          onClick={openPreview}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-input bg-card py-1.5 text-xs font-semibold text-foreground hover:bg-secondary transition"
        >
          <Play className="size-3 text-primary" aria-hidden /> Preview at {fmtTime(previewStart)}
        </button>
      )}
    </div>
  )
}
