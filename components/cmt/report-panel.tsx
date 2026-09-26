'use client'

import { useState, useRef, useMemo, useCallback } from 'react'
import {
  FileCheck2,
  Loader2,
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Play,
  Search,
  Eye,
  Layers,
} from 'lucide-react'
import type { Scan, ChunkMatch, CandidateGroup, CandidateEntry } from '@/lib/types'
import { fmtTime, fmtDuration } from '@/lib/format'
import { displayModelName } from '@/lib/models'
import { originLabel, isRejectedKept } from '@/lib/candidate-pick'
import { ScanUsageReport } from './scan-usage-report'
import { ScanTimingReport } from './scan-timing-report'

export function ReportPanel({ scan }: { scan: Scan }) {
  const [expandedMatchKey, setExpandedMatchKey] = useState<string | null>(null)
  const [filterMode, setFilterMode] = useState<'all' | 'confirmed' | 'rejected' | 'rescan' | 'verifying'>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const report = scan.report
  const matches = useMemo(() => {
    return scan.matches && scan.matches.length > 0 ? scan.matches : report?.matches || []
  }, [scan.matches, report?.matches])

  const chunksPending = report?.chunksPending ?? 0
  const groupsPending =
    report?.groupsPending ??
    Math.max(0, (report?.groupsTotal ?? 0) - (report?.groupsConfirmed ?? 0) - (report?.groupsRejected ?? 0) - (report?.groupsUnverified ?? 0))

  const candidateGroups = useMemo(() => scan.candidateGroups || [], [scan.candidateGroups])

  // Helper to accurately match a ChunkMatch with its CandidateGroup
  const findAssociatedGroup = useCallback((m: ChunkMatch): CandidateGroup | undefined => {
    // 1. First priority: candidate match by chunkIndex and movieStart
    const byCandidate = candidateGroups.find((g) =>
      (g.candidates || []).some(
        (c) => c.chunkIndex === m.chunkIndex && Math.abs(c.movieStart - m.movieStart) <= 1.0,
      ),
    )
    if (byCandidate) return byCandidate

    // 2. Second priority: candidate match by chunkIndex and short range
    const byShortAndChunk = candidateGroups.find(
      (g) =>
        Math.abs(g.shortStart - m.shortStart) <= 0.35 &&
        (g.candidates || []).some((c) => c.chunkIndex === m.chunkIndex),
    )
    if (byShortAndChunk) return byShortAndChunk

    // 3. Fallback: match by close short timestamp
    return candidateGroups.find(
      (g) => Math.abs(g.shortStart - m.shortStart) <= 0.25 || (m.shortStart >= g.shortStart - 0.1 && m.shortEnd <= g.shortEnd + 0.1),
    )
  }, [candidateGroups])

  // Get rich live status badge
  const getMatchLiveStatus = (m: ChunkMatch, group?: CandidateGroup) => {
    const isRejected = isRejectedKept(m) || m.rejected === true || m.batchVerified === 'rejected' || (group?.status === 'rejected')

    if (isRejected) {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-destructive">
          <XCircle className="size-3.5" />
          confirm no (rejected)
        </span>
      )
    }

    if (group) {
      if (group.status === 'verifying') {
        const inFlightIdx = group.candidates.findIndex((c) => c.verdict === 'verifying')
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/30 bg-blue-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-blue-500 animate-pulse">
            <Loader2 className="size-3 animate-spin text-blue-500" />
            Verifying {inFlightIdx >= 0 ? `Cand #${inFlightIdx + 1}` : '24fps'}...
          </span>
        )
      }
      if (group.status === 'rescanning') {
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-purple-500/30 bg-purple-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-purple-500 animate-pulse">
            <RefreshCw className="size-3 animate-spin text-purple-500" />
            Rescanning Chunk...
          </span>
        )
      }
      if (group.status === 'pending') {
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-500">
            <Clock className="size-3 text-amber-500" />
            Queued for Verifier
          </span>
        )
      }
      if (group.status === 'confirmed') {
        return (
          <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-500">
            <CheckCircle2 className="size-3.5" />
            confirm yes ({group.confirmedViaRescan ? 'rescan verified' : '24fps batch'})
          </span>
        )
      }
      if (group.status === 'unverified') {
        return (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-500">
            <AlertTriangle className="size-3.5" />
            unverified (kept)
          </span>
        )
      }
    }

    if (m.verified || m.batchVerified === 'confirmed') {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-500">
          <CheckCircle2 className="size-3.5" />
          confirm yes ({m.batchVerified === 'confirmed' ? 'batch 24fps' : m.viaRescan ? 'rescan' : 'verified'})
        </span>
      )
    }

    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-500">
        <AlertTriangle className="size-3.5" />
        unverified
      </span>
    )
  }

  // Get rescan outcome column text
  const getRescanOutcome = (m: ChunkMatch, group?: CandidateGroup) => {
    if (m.viaRescan || m.origin === 'rescan') {
      return (
        <span className="inline-flex items-center gap-1 font-semibold text-emerald-500">
          <RefreshCw className="size-3 text-emerald-500" />
          Rescanned → Confirmed (Yes)
        </span>
      )
    }

    if (group) {
      if (group.confirmedViaRescan) {
        return (
          <span className="inline-flex items-center gap-1 font-semibold text-emerald-500">
            <RefreshCw className="size-3 text-emerald-500" />
            Rescanned → Confirmed (Yes)
          </span>
        )
      }
      const hasRescanning = group.candidates.some((c) => c.rescan === 'rescanning')
      if (hasRescanning || group.status === 'rescanning') {
        return (
          <span className="inline-flex items-center gap-1 font-semibold text-purple-400 animate-pulse">
            <RefreshCw className="size-3 animate-spin text-purple-400" />
            Rescanning...
          </span>
        )
      }

      const rescanCand =
        group.candidates.find((c) => c.chunkIndex === m.chunkIndex && (c.rescan === 'found' || c.rescan === 'not_found')) ||
        group.candidates.find((c) => c.rescan === 'found' || c.rescan === 'not_found')

      if (rescanCand) {
        if (rescanCand.rescan === 'found') {
          if (rescanCand.rescanVerdict === 'same') {
            return (
              <span className="inline-flex items-center gap-1 font-semibold text-emerald-500">
                <RefreshCw className="size-3 text-emerald-500" />
                Rescanned → Confirmed (Yes)
              </span>
            )
          }
          if (rescanCand.rescanVerdict === 'different') {
            return (
              <span className="inline-flex items-center gap-1 font-semibold text-destructive">
                <RefreshCw className="size-3 text-destructive" />
                Rescanned → Confirm No (Rejected)
              </span>
            )
          }
          return (
            <span className="inline-flex items-center gap-1 font-medium text-blue-400">
              <RefreshCw className="size-3 text-blue-400" />
              Rescanned → Verifying
            </span>
          )
        }
        if (rescanCand.rescan === 'not_found') {
          return (
            <span className="inline-flex items-center gap-1 font-medium text-muted-foreground">
              <RefreshCw className="size-3" />
              Rescanned → No (Not found)
            </span>
          )
        }
      }
    }

    return <span className="text-muted-foreground/60">—</span>
  }

  // Filter and search matches
  const filteredMatches = useMemo(() => {
    return matches.filter((m, i) => {
      const group = findAssociatedGroup(m)
      const isRejected = isRejectedKept(m) || m.rejected === true || m.batchVerified === 'rejected' || (group?.status === 'rejected')
      const isConfirmed = (!isRejected && (m.verified || m.batchVerified === 'confirmed' || group?.status === 'confirmed'))
      const isRescan = m.viaRescan || m.origin === 'rescan' || group?.confirmedViaRescan || group?.candidates.some((c) => c.rescan !== 'none')
      const isVerifying = group?.status === 'verifying' || group?.status === 'rescanning' || group?.status === 'pending'

      if (filterMode === 'confirmed' && !isConfirmed) return false
      if (filterMode === 'rejected' && !isRejected) return false
      if (filterMode === 'rescan' && !isRescan) return false
      if (filterMode === 'verifying' && !isVerifying) return false

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim()
        const matchStr = `${i + 1} ${fmtTime(m.shortStart)} ${fmtTime(m.movieStart)} chunk ${m.chunkIndex} ${m.model} ${m.origin || ''}`.toLowerCase()
        if (!matchStr.includes(q)) return false
      }

      return true
    })
  }, [matches, findAssociatedGroup, filterMode, searchQuery])

  if (!report) return null

  return (
    <section aria-label="Final report" className="panel border-success/30 bg-card/60 backdrop-blur-sm shadow-md">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 pb-3">
        <div className="flex size-7 items-center justify-center rounded-lg bg-success/15 text-success">
          <FileCheck2 className="size-4" aria-hidden />
        </div>
        <h2 className="text-sm font-semibold tracking-tight">{report.partial ? 'Partial Scan Report' : 'Final Match Report'}</h2>
        {report.partial && (
          <span className="rounded-full bg-warning/15 px-2.5 py-0.5 text-xs font-semibold text-warning border border-warning/30">
            INCOMPLETE — {chunksPending} chunk(s) not scanned · {groupsPending} group(s) unfinished
          </span>
        )}
        {report.prefilterMode != null && (
          <span
            className={`ml-auto rounded-full px-2.5 py-0.5 text-xs font-medium ${
              report.prefilterMode === 'twelvelabs' || report.prefilterMode === 'gemini'
                ? 'bg-primary/15 text-primary border border-primary/30'
                : 'bg-secondary text-muted-foreground'
            }`}
          >
            {report.prefilterMode === 'twelvelabs'
              ? `Twelve Labs pre-filtered — ${report.prefilterSelected ?? 0} of ${report.prefilterTotal ?? 0} chunks`
              : report.prefilterMode === 'gemini'
                ? `Chunk set: Gemini Minute Finder (${scan.geminiPrescan?.appliedMinutes?.length ?? 0} minutes)`
                : 'Full scan'}
          </span>
        )}
      </div>

      {/* Top summary stats */}
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
        <Stat label="Scan time" value={fmtDuration(report.totalScanTimeMs)} />
        <Stat label="Chunks scanned" value={String(report.chunksScanned)} />
        <Stat label="Chunks failed" value={String(report.chunksFailed)} />
        <Stat label="Chunks not scanned" value={String(chunksPending)} warn={chunksPending > 0} />
        <Stat label="Matched segments" value={String(matches.length)} />
      </div>

      {report.groupsTotal != null && report.groupsTotal > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
          <Stat label="Candidate groups" value={String(report.groupsTotal)} />
          <Stat label="Verifier confirmed" value={String(report.groupsConfirmed ?? 0)} />
          <Stat label="Verifier rejected" value={String(report.groupsRejected ?? 0)} />
          <Stat label="Unverified (Kept)" value={String(report.groupsUnverified ?? 0)} />
          <Stat label="Still verifying" value={String(groupsPending)} warn={groupsPending > 0} />
        </div>
      )}

      {report.coverage && (
        <div className="mt-2 rounded-lg border border-border/80 bg-background/80 p-3 text-xs shadow-inner">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-foreground">Short coverage: {report.coverage.pct}%</span>
            <span className="text-muted-foreground">
              {report.coverage.coveredSec.toFixed(1)}s / {report.coverage.totalSec.toFixed(1)}s
            </span>
            {report.coverage.missingSec > 0 && <span className="font-semibold text-warning">MISSING {report.coverage.missingSec.toFixed(1)}s</span>}
          </div>
          {report.coverage.gaps.length > 0 && (
            <p className="mt-1 font-mono text-xs text-warning">
              {report.coverage.gaps.map((g) => `${fmtTime(g.start)}–${fmtTime(g.end)}`).join(', ')}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2 text-muted-foreground">
            <span>Rejected kept: {report.matchesRejectedKept ?? matches.filter(isRejectedKept).length}</span>
            {Object.entries(report.originCounts || {}).map(([origin, count]) => (
              <span key={origin}>
                {originLabel(origin as never)}: {count}
              </span>
            ))}
          </div>
        </div>
      )}

      {matches.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No matches found — the short video does not appear in this movie.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {/* Header toolbar & filter buttons */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2.5">
            <div>
              <h3 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <Layers className="size-3.5 text-primary" />
                Short → Movie Time Map & Candidate Inspector
              </h3>
              <p className="text-[11px] text-muted-foreground">
                Click any row to inspect all alternative candidates, AI verdict reasons, and video previews.
              </p>
            </div>

            {/* Quick Filter Buttons */}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setFilterMode('all')}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                  filterMode === 'all'
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                All ({matches.length})
              </button>
              <button
                type="button"
                onClick={() => setFilterMode('confirmed')}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                  filterMode === 'confirmed'
                    ? 'bg-emerald-500 text-white shadow-sm'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                Confirmed Yes
              </button>
              <button
                type="button"
                onClick={() => setFilterMode('rejected')}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                  filterMode === 'rejected'
                    ? 'bg-destructive text-destructive-foreground shadow-sm'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                Rejected / Kept
              </button>
              <button
                type="button"
                onClick={() => setFilterMode('rescan')}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                  filterMode === 'rescan'
                    ? 'bg-purple-600 text-white shadow-sm'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                Rescanned
              </button>
              {groupsPending > 0 && (
                <button
                  type="button"
                  onClick={() => setFilterMode('verifying')}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                    filterMode === 'verifying'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  Verifying Live ({groupsPending})
                </button>
              )}
            </div>
          </div>

          {/* Search input */}
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by time (e.g. 0:35, 1:04), chunk number, or model..."
              className="w-full rounded-lg border border-input bg-background/90 py-1.5 pl-8 pr-3 text-xs placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Interactive Match Table */}
          <div className="overflow-x-auto rounded-lg border border-border/70 bg-card">
            <table className="w-full min-w-[620px] text-left text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-[11px] text-muted-foreground">
                  <th className="py-2 pl-3 pr-2 font-medium">#</th>
                  <th className="py-2 pr-2 font-medium">Short video</th>
                  <th className="py-2 pr-2 font-medium">Movie (global)</th>
                  <th className="py-2 pr-2 font-medium">Duration</th>
                  <th className="py-2 pr-2 font-medium">Chunk</th>
                  <th className="py-2 pr-2 font-medium">Model</th>
                  <th className="py-2 pr-2 font-medium">Origin</th>
                  <th className="py-2 pr-2 font-medium">Live Status</th>
                  <th className="py-2 pr-2 font-medium">Rescan Status</th>
                  <th className="py-2 pr-3 font-medium text-right">Candidates</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40 font-mono">
                {filteredMatches.map((m, i) => {
                  const matchKey = `${m.shortStart}-${m.movieStart}-${i}`
                  const group = findAssociatedGroup(m)
                  const isExpanded = expandedMatchKey === matchKey
                  const candCount = group?.candidates?.length || 1

                  return (
                    <MatchRowWithDetails
                      key={matchKey}
                      scan={scan}
                      match={m}
                      index={i}
                      group={group}
                      isExpanded={isExpanded}
                      onToggle={() => setExpandedMatchKey(isExpanded ? null : matchKey)}
                      liveStatus={getMatchLiveStatus(m, group)}
                      rescanOutcome={getRescanOutcome(m, group)}
                      candCount={candCount}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-col gap-4">
        <ScanTimingReport scan={scan} />
        <ScanUsageReport scan={scan} />
      </div>
    </section>
  )
}

function MatchRowWithDetails({
  scan,
  match: m,
  index: i,
  group,
  isExpanded,
  onToggle,
  liveStatus,
  rescanOutcome,
  candCount,
}: {
  scan: Scan
  match: ChunkMatch
  index: number
  group?: CandidateGroup
  isExpanded: boolean
  onToggle: () => void
  liveStatus: React.ReactNode
  rescanOutcome: React.ReactNode
  candCount: number
}) {
  const isRejected = isRejectedKept(m) || m.rejected === true || m.batchVerified === 'rejected'

  return (
    <>
      <tr
        onClick={onToggle}
        className={`group cursor-pointer transition-colors hover:bg-accent/40 ${
          isExpanded ? 'bg-accent/30 font-medium' : ''
        }`}
      >
        <td className="py-2.5 pl-3 pr-2 font-semibold text-muted-foreground group-hover:text-foreground">
          {i + 1}
        </td>
        <td className="py-2.5 pr-2 font-medium">
          {fmtTime(m.shortStart)} – {fmtTime(m.shortEnd)}
        </td>
        <td className={`py-2.5 pr-2 ${isRejected ? 'text-destructive' : 'text-emerald-500'} font-semibold`}>
          {fmtTime(m.movieStart)} – {fmtTime(m.movieEnd)}
        </td>
        <td className="py-2.5 pr-2 text-muted-foreground">{(m.movieEnd - m.movieStart).toFixed(3)}s</td>
        <td className="py-2.5 pr-2 text-muted-foreground">{m.chunkIndex}</td>
        <td className="py-2.5 pr-2 text-muted-foreground">{displayModelName(m.model)}</td>
        <td className="py-2.5 pr-2">
          <span className={isRejected ? 'text-destructive font-semibold' : 'text-muted-foreground'}>
            {isRejected ? 'rejected kept' : originLabel(m.origin, m.originWindow)}
          </span>
        </td>
        <td className="py-2.5 pr-2">{liveStatus}</td>
        <td className="py-2.5 pr-2 text-xs">{rescanOutcome}</td>
        <td className="py-2.5 pr-3 text-right">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition ${
              isExpanded
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
            }`}
          >
            <span>{candCount} {candCount === 1 ? 'cand' : 'cands'}</span>
            {isExpanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
        </td>
      </tr>

      {/* Expanded Interactive Candidate Details Drawer */}
      {isExpanded && (
        <tr>
          <td colSpan={10} className="p-0 border-b border-border bg-muted/20">
            <ExpandedCandidateDrawer scan={scan} match={m} group={group} />
          </td>
        </tr>
      )}
    </>
  )
}

function ExpandedCandidateDrawer({
  scan,
  match: m,
  group,
}: {
  scan: Scan
  match: ChunkMatch
  group?: CandidateGroup
}) {
  const shortDur = (m.shortEnd - m.shortStart).toFixed(3)

  return (
    <div className="p-3.5 sm:p-4 space-y-3">
      {/* Group Header Info */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/80 bg-card p-2.5">
        <div className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary/15 text-primary">
            <Eye className="size-3.5" />
          </span>
          <div>
            <h4 className="text-xs font-bold text-foreground">
              Short Scene Window: {fmtTime(m.shortStart)} – {fmtTime(m.shortEnd)} ({shortDur}s)
            </h4>
            <p className="text-[11px] text-muted-foreground">
              Origin: <strong className="text-foreground">{originLabel(m.origin, m.originWindow)}</strong>
              {group && (
                <> · Status: <strong className="text-foreground">{group.status}</strong></>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-mono text-muted-foreground">
            {group?.candidates?.length || 1} candidate option(s) discovered
          </span>
        </div>
      </div>

      {/* Candidate list */}
      <div className="grid gap-2.5">
        {group && group.candidates && group.candidates.length > 0 ? (
          group.candidates.map((c, idx) => (
            <CandidateDetailCard key={c.id || `${c.chunkIndex}-${idx}`} scan={scan} g={group} c={c} index={idx} />
          ))
        ) : (
          <SingleFallbackCandidateCard scan={scan} m={m} />
        )}
      </div>
    </div>
  )
}

function CandidateDetailCard({
  scan,
  g,
  c,
  index,
}: {
  scan: Scan
  g: CandidateGroup
  c: CandidateEntry
  index: number
}) {
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

  const isConfirmedCandidate = g.status === 'confirmed' && (g.confirmedIndex === index || (!g.confirmedIndex && index === 0))
  const isRejectedCandidate = c.verdict === 'different' || (g.status === 'rejected' && index === 0)

  return (
    <div
      className={`rounded-lg border p-3 text-xs transition ${
        isConfirmedCandidate
          ? 'border-emerald-500/40 bg-emerald-500/5'
          : isRejectedCandidate
            ? 'border-destructive/30 bg-destructive/5'
            : 'border-border/70 bg-card'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-2">
        <div className="flex items-center gap-2">
          <span className="font-bold text-foreground font-mono">
            Candidate #{index + 1}: Movie {fmtTime(c.movieStart)} – {fmtTime(c.movieEnd)}
          </span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            Chunk {c.chunkIndex}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {isRejectedCandidate && (
            <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold text-destructive">
              rejected kept
            </span>
          )}
          {verdictBadge(c, g, index)}
        </div>
      </div>

      {/* Model details and explanations */}
      <div className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
        <div>
          Discovered by <strong className="text-foreground font-mono">{displayModelName(c.model)}</strong>
          {c.verifierModel && (
            <>
              {' · 24fps verified by '}
              <strong className="text-foreground font-mono">{displayModelName(c.verifierModel)}</strong>
            </>
          )}
        </div>

        {c.verifierReason && (
          <p className="rounded bg-muted/40 p-2 text-foreground/90 italic border border-border/40">
            &ldquo;{c.verifierReason}&rdquo;
          </p>
        )}

        {/* Rescan information */}
        {c.rescan !== 'none' && c.rescan !== 'pending' && (
          <div className="mt-1 rounded bg-purple-500/10 p-2 border border-purple-500/20 text-purple-400">
            <div className="flex items-center gap-1 font-semibold">
              <RefreshCw className="size-3" />
              <span>Targeted Rescan Details</span>
            </div>
            {c.rescan === 'rescanning' && <p className="mt-0.5">Rescanning full chunk {c.chunkIndex} at 24 fps...</p>}
            {c.rescan === 'not_found' && <p className="mt-0.5">Rescan: segment was NOT found in full chunk.</p>}
            {c.rescan === 'found' && c.rescanMovieStart != null && (
              <p className="mt-0.5">
                Rescan detected window: <strong>{fmtTime(c.rescanMovieStart)} – {fmtTime(c.rescanMovieEnd ?? c.rescanMovieStart)}</strong>
                {c.rescanVerdict === 'same' && ' — Verifier: SAME (Confirmed)'}
                {c.rescanVerdict === 'different' && ' — Verifier: DIFFERENT (Rejected)'}
              </p>
            )}
            {c.rescanReason && <p className="mt-0.5 italic text-purple-300">&ldquo;{c.rescanReason}&rdquo;</p>}
          </div>
        )}
      </div>

      {/* Interactive Video Preview Player */}
      <div className="mt-2.5">
        {showVideo ? (
          <div className="space-y-1">
            <video
              ref={videoRef}
              src={`/api/scans/${scan.id}/media?kind=movie`}
              controls
              className="w-full rounded-md bg-black max-h-64 shadow-md"
              aria-label={`Movie preview at ${fmtTime(previewStart)}`}
            />
            <button
              type="button"
              onClick={() => setShowVideo(false)}
              className="text-[10px] text-muted-foreground hover:underline"
            >
              Hide player
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={openPreview}
            className="flex items-center justify-center gap-1.5 rounded-md border border-input bg-secondary/80 px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary hover:border-primary/40 transition"
          >
            <Play className="size-3 text-primary" aria-hidden /> Preview Movie at {fmtTime(previewStart)}
          </button>
        )}
      </div>
    </div>
  )
}

function SingleFallbackCandidateCard({ scan, match: m }: { scan: Scan; match: ChunkMatch }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [showVideo, setShowVideo] = useState(false)

  function openPreview() {
    setShowVideo(true)
    requestAnimationFrame(() => {
      const v = videoRef.current
      if (!v) return
      const seek = () => {
        v.currentTime = m.movieStart
        void v.play().catch(() => {})
      }
      if (v.readyState >= 1) seek()
      else v.addEventListener('loadedmetadata', seek, { once: true })
    })
  }

  return (
    <div className="rounded-lg border border-border/70 bg-card p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-bold text-foreground font-mono">
          Movie {fmtTime(m.movieStart)} – {fmtTime(m.movieEnd)}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          Chunk {m.chunkIndex}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Discovered by <strong className="text-foreground font-mono">{displayModelName(m.model)}</strong>
        {m.verifierModel && <> · verified by <strong className="text-foreground font-mono">{displayModelName(m.verifierModel)}</strong></>}
      </p>
      {m.reason && <p className="mt-1 italic text-foreground/80">&ldquo;{m.reason}&rdquo;</p>}
      <div className="mt-2">
        {showVideo ? (
          <video
            ref={videoRef}
            src={`/api/scans/${scan.id}/media?kind=movie`}
            controls
            className="w-full rounded-md bg-black max-h-64 shadow-md"
            aria-label={`Movie preview at ${fmtTime(m.movieStart)}`}
          />
        ) : (
          <button
            type="button"
            onClick={openPreview}
            className="flex items-center justify-center gap-1.5 rounded-md border border-input bg-secondary/80 px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary transition"
          >
            <Play className="size-3 text-primary" /> Preview Movie at {fmtTime(m.movieStart)}
          </button>
        )}
      </div>
    </div>
  )
}

function verdictBadge(c: CandidateEntry, g: CandidateGroup, index: number) {
  if (g.status === 'confirmed' && (g.confirmedIndex === index || (!g.confirmedIndex && index === 0))) {
    return (
      <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-bold text-emerald-500 border border-emerald-500/30">
        <CheckCircle2 className="size-3" aria-hidden />
        SAME (verified)
      </span>
    )
  }
  if (c.verdict === 'different') {
    return (
      <span className="flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-destructive border border-destructive/30">
        <XCircle className="size-3" aria-hidden />
        DIFFERENT (rejected)
      </span>
    )
  }
  if (c.verdict === 'verifying') {
    return (
      <span className="flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-blue-500 animate-pulse border border-blue-500/30">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        verifying 24fps
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
      <Clock className="size-3" aria-hidden />
      pending
    </span>
  )
}

function Stat({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`rounded-lg border p-2.5 shadow-sm ${warn ? 'border-warning/50 bg-warning/10' : 'border-border/80 bg-background/90'}`}>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={`font-mono text-sm font-bold ${warn ? 'text-warning' : 'text-foreground'}`}>{value}</p>
    </div>
  )
}
