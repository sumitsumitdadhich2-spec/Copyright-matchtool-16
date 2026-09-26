'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSWRConfig } from 'swr'
import type { Scan, CandidateGroup, BatchVerifyPart } from '@/lib/types'
import { fmtTime } from '@/lib/format'
import { displayModelName } from '@/lib/models'
import {
  ShieldCheck,
  CheckCircle2,
  Zap,
  Clock,
  Loader2,
  RotateCcw,
  Square,
  Eye,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Sparkles,
} from 'lucide-react'

export interface VerifierItem {
  id: string
  itemNumber: number
  shortStart: number
  shortEnd: number
  movieStart: number
  movieEnd: number
  duration: number
  status: 'pending' | 'verifying' | 'rescanning' | 'confirmed' | 'rejected' | 'unverified'
  model?: string
  verifierModel?: string
  reason?: string
  confidence?: number
  chunkIndex?: number
  matchIndex?: number
  partIndex?: number
  group?: CandidateGroup
  part?: BatchVerifyPart
}

const VERIFIER_STATUS_CLASS: Record<string, string> = {
  pending: 'bg-muted border border-border/50',
  verifying: 'bg-primary animate-pulse ring-1 ring-primary',
  rescanning: 'bg-purple-500 animate-pulse ring-1 ring-purple-400',
  confirmed: 'bg-emerald-500 ring-1 ring-emerald-400 shadow-xs',
  rejected: 'bg-rose-500/80 hover:bg-rose-500 shadow-xs',
  unverified: 'bg-amber-500/70',
}

export function VerifierTimeline({ scan }: { scan: Scan }) {
  const { mutate } = useSWRConfig()

  const totalDuration = scan.shortDuration || 60
  const minuteCount = Math.max(1, Math.ceil(totalDuration / 60))
  const activeSeg = Math.min(minuteCount - 1, Math.max(0, scan.currentShortSegment ?? 0))

  const [selected, setSelected] = useState<number | null>(null)
  const [selectedItem, setSelectedItem] = useState<VerifierItem | null>(null)
  const [isDetailsOpen, setIsDetailsOpen] = useState(false)

  // Actions state
  const [triggeringMinute, setTriggeringMinute] = useState<number | null>(null)
  const [triggeringAll, setTriggeringAll] = useState(false)
  const [rescanningPart, setRescanningPart] = useState<string | null>(null)
  const [modelPickerPart, setModelPickerPart] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  const segIdx = selected !== null ? selected : activeSeg
  const multi = minuteCount > 1

  useEffect(() => {
    setSelected(null)
    setSelectedItem(null)
  }, [scan.id, minuteCount])

  const jumpToCompare = (shortStart: number, shortEnd: number) => {
    window.dispatchEvent(
      new CustomEvent('jump-to-compare-scene', {
        detail: { shortStart, shortEnd },
      }),
    )
    const el = document.getElementById('compare-panel')
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // --- Derive Items for all minutes and current minute ---
  const allMinutesData = useMemo(() => {
    const data: Record<number, VerifierItem[]> = {}
    const candidateGroups = scan.candidateGroups || []
    const batchResults = scan.batchVerify?.results || {}
    const matches = scan.matches || []

    for (let m = 0; m < minuteCount; m++) {
      const minStart = m * 60
      const minEnd = (m + 1) * 60
      const items: VerifierItem[] = []

      // 1. Check Batch Verify Results for this minute
      const bRes = batchResults[m]
      if (bRes && bRes.parts && bRes.parts.length > 0) {
        bRes.parts.forEach((p, idx) => {
          let st: VerifierItem['status'] = 'pending'
          if (p.verdict === 'CONFIRMED') st = 'confirmed'
          else if (p.verdict === 'REJECTED') st = 'rejected'
          else if (p.verdict === 'UNVERIFIED') st = 'unverified'
          else if (bRes.status === 'verifying' || bRes.status === 'preparing') st = 'verifying'

          items.push({
            id: `batch-${m}-${p.partIndex ?? idx}`,
            itemNumber: idx + 1,
            shortStart: p.shortStart,
            shortEnd: p.shortEnd,
            movieStart: p.movieStart,
            movieEnd: p.movieEnd,
            duration: p.duration || Math.max(0.1, p.shortEnd - p.shortStart),
            status: st,
            model: bRes.model,
            verifierModel: bRes.model,
            reason: p.reason,
            partIndex: p.partIndex,
            matchIndex: p.matchIndex,
            part: p,
          })
        })
      } else if (candidateGroups.length > 0) {
        // 2. Derive from CandidateGroups
        const minGroups = candidateGroups.filter((g) => g.shortStart < minEnd && g.shortEnd > minStart)
        minGroups.forEach((g, idx) => {
          const winCand = g.candidates?.[g.winnerCandidateIndex ?? g.confirmedCandidateIndex ?? 0] || g.candidates?.[0]
          let st: VerifierItem['status'] = 'pending'
          if (g.status === 'confirmed') st = 'confirmed'
          else if (g.status === 'rejected') st = 'rejected'
          else if (g.status === 'verifying') st = 'verifying'
          else if (g.status === 'rescanning') st = 'rescanning'
          else if (g.status === 'unverified') st = 'unverified'

          items.push({
            id: g.id || `group-${m}-${idx}`,
            itemNumber: idx + 1,
            shortStart: g.shortStart,
            shortEnd: g.shortEnd,
            movieStart: winCand?.movieStart ?? 0,
            movieEnd: winCand?.movieEnd ?? 0,
            duration: Math.max(0.1, g.shortEnd - g.shortStart),
            status: st,
            model: winCand?.model,
            verifierModel: winCand?.verifierModel,
            reason: winCand?.verifierReason,
            confidence: winCand?.confidence,
            chunkIndex: winCand?.chunkIndex,
            group: g,
          })
        })
      } else if (matches.length > 0) {
        // 3. Fallback to Matches
        const minMatches = matches.filter(
          (match) => match.shortStart < minEnd && match.shortEnd > minStart && match.shortEnd - match.shortStart >= 0.15,
        )
        minMatches.forEach((match, idx) => {
          let st: VerifierItem['status'] = 'pending'
          if (match.verified) st = 'confirmed'
          else if (match.rejected) st = 'rejected'
          else if (scan.status === 'verifying') st = 'verifying'

          items.push({
            id: `match-${m}-${idx}`,
            itemNumber: idx + 1,
            shortStart: match.shortStart,
            shortEnd: match.shortEnd,
            movieStart: match.movieStart,
            movieEnd: match.movieEnd,
            duration: Math.max(0.1, match.shortEnd - match.shortStart),
            status: st,
            model: match.model,
            chunkIndex: match.chunkIndex,
            matchIndex: idx,
          })
        })
      }

      data[m] = items
    }
    return data
  }, [scan.candidateGroups, scan.batchVerify, scan.matches, scan.status, minuteCount])

  const items = allMinutesData[segIdx] || []

  // Metrics for active minute
  const confirmedCount = items.filter((i) => i.status === 'confirmed').length
  const rejectedCount = items.filter((i) => i.status === 'rejected').length
  const inFlightItems = items.filter((i) => i.status === 'verifying' || i.status === 'rescanning')
  const inFlightCount = inFlightItems.length
  const unverifiedCount = items.filter((i) => i.status === 'unverified').length
  const rescanningCount = items.filter((i) => i.status === 'rescanning').length
  const pendingCount = items.filter((i) => i.status === 'pending').length
  const doneCount = confirmedCount + rejectedCount + unverifiedCount
  const totalPlanned = items.length
  const remaining = Math.max(0, totalPlanned - doneCount)
  const progressPct = totalPlanned > 0 ? Math.min(100, Math.round((doneCount / totalPlanned) * 100)) : 0

  // Overall totals across all minutes
  let overallTotal = 0
  let overallDone = 0
  let overallConfirmed = 0
  let overallRejected = 0
  for (let m = 0; m < minuteCount; m++) {
    const list = allMinutesData[m] || []
    overallTotal += list.length
    overallConfirmed += list.filter((i) => i.status === 'confirmed').length
    overallRejected += list.filter((i) => i.status === 'rejected').length
    overallDone += list.filter((i) => i.status === 'confirmed' || i.status === 'rejected' || i.status === 'unverified').length
  }

  const isBatchRunning = scan.batchVerify?.status === 'running'
  const isMinVerifying =
    scan.batchVerify?.results?.[segIdx]?.status === 'verifying' ||
    scan.batchVerify?.results?.[segIdx]?.status === 'preparing' ||
    inFlightCount > 0

  // Handlers
  async function handleVerifyAll() {
    if (triggeringAll || isBatchRunning) return
    setTriggeringAll(true)
    setFeedback(null)
    try {
      const res = await fetch(`/api/scans/${scan.id}/batch-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start_all' }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setFeedback({ ok: true, msg: 'Started 24 FPS batch verification across all minute blocks.' })
        await mutate(`/api/scans/${scan.id}`)
      } else {
        setFeedback({ ok: false, msg: data.error || 'Failed to start batch verification' })
      }
    } catch {
      setFeedback({ ok: false, msg: 'Network error starting batch verification' })
    } finally {
      setTriggeringAll(false)
    }
  }

  async function handleStop() {
    try {
      await fetch(`/api/scans/${scan.id}/batch-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      })
      await mutate(`/api/scans/${scan.id}`)
      setFeedback({ ok: true, msg: 'Batch verification stopped.' })
    } catch {}
  }

  async function handleVerifyMinute(minuteIndex: number) {
    if (triggeringMinute !== null) return
    setTriggeringMinute(minuteIndex)
    setFeedback(null)
    try {
      const res = await fetch(`/api/scans/${scan.id}/batch-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify_minute', minuteIndex }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setFeedback({ ok: true, msg: `Started 24 FPS verification for Minute ${minuteIndex + 1}` })
        await mutate(`/api/scans/${scan.id}`)
      } else {
        setFeedback({ ok: false, msg: data.error || `Failed to verify minute ${minuteIndex + 1}` })
      }
    } catch {
      setFeedback({ ok: false, msg: 'Network error triggering minute verification' })
    } finally {
      setTriggeringMinute(null)
    }
  }

  async function handleRescanScene(item: VerifierItem, chosenModel?: string) {
    if (rescanningPart !== null) return
    setModelPickerPart(null)
    setRescanningPart(item.id)
    setFeedback(null)
    try {
      const chunkIndex = item.chunkIndex ?? Math.max(0, Math.floor(item.movieStart / 60))
      const res = await fetch(`/api/scans/${scan.id}/rescan-scene`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shortStart: item.shortStart,
          shortEnd: item.shortEnd,
          chunkIndex,
          movieStart: item.movieStart,
          movieEnd: item.movieEnd,
          model: chosenModel || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) {
        setFeedback({
          ok: true,
          msg: `Rescan Successful! Found movie ${fmtTime(data.movieStart)}–${fmtTime(data.movieEnd)} on ${displayModelName(data.model)}. Set as MAIN clip.`,
        })
        await mutate(`/api/scans/${scan.id}`)
      } else {
        setFeedback({
          ok: false,
          msg: data.error || 'Rescan could not find a matching scene in this chunk.',
        })
      }
    } catch {
      setFeedback({ ok: false, msg: 'Network error while rescanning scene.' })
    } finally {
      setRescanningPart(null)
    }
  }

  if (scan.chunkCount === 0 && (!scan.matches || scan.matches.length === 0)) {
    return (
      <section aria-label="Verifier timeline" className="panel">
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="size-4 text-emerald-400" aria-hidden />
          <h2 className="text-sm font-semibold">Verifier Timeline</h2>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Upload a movie to see live 24 FPS verification data.</p>
      </section>
    )
  }

  return (
    <section aria-label="Verifier timeline" className="panel border-emerald-500/20 bg-card/70">
      {/* ---------- Header ---------- */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="size-4 text-emerald-400" aria-hidden />
            <h2 className="text-sm font-semibold">Verifier Timeline</h2>
            <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-mono font-medium text-emerald-300">
              24 FPS LIVE VERIFIER
            </span>
          </div>
          {multi && (
            <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 font-mono text-[11px] font-medium text-emerald-400">
              Short Minute {segIdx + 1}/{minuteCount}
              {` (${fmtTime(segIdx * 60)}–${fmtTime(Math.min((segIdx + 1) * 60, totalDuration))})`}
            </span>
          )}
          {totalPlanned > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">
              <Sparkles className="size-3 text-emerald-400" aria-hidden />
              {totalPlanned} candidate scene(s) in this minute
            </span>
          )}
        </div>

        {/* Global Action Buttons */}
        <div className="flex items-center gap-2">
          {isBatchRunning ? (
            <button
              onClick={handleStop}
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/20 transition-colors"
            >
              <Square className="h-3 w-3 fill-current" />
              Stop Verifier
            </button>
          ) : (
            <button
              onClick={handleVerifyAll}
              type="button"
              disabled={triggeringAll || overallTotal === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-r from-emerald-600 to-teal-600 px-3 py-1 text-xs font-semibold text-white shadow-sm hover:from-emerald-500 hover:to-teal-500 disabled:opacity-50 transition-all cursor-pointer"
            >
              {triggeringAll ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <Zap className="h-3 w-3" />
                  Verify All Minutes
                </>
              )}
            </button>
          )}

          <div className="flex flex-col items-end">
            <span className="font-mono text-xs font-semibold text-foreground">
              {doneCount}/{totalPlanned} verified in Min {segIdx + 1} ({progressPct}%)
            </span>
            {multi && (
              <span className="font-mono text-[10px] text-muted-foreground">
                Overall: {overallDone}/{overallTotal} scenes ({overallConfirmed} confirmed · {overallRejected} rejected)
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div
          className={`mt-2.5 rounded-md border p-2 text-xs ${
            feedback.ok
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
          }`}
        >
          {feedback.msg}
        </div>
      )}

      {/* ---------- Minute Selection Tabs (with per-minute progress) ---------- */}
      {multi && (
        <div className="mt-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Verifier short minutes">
          {Array.from({ length: minuteCount }, (_, idx) => {
            const isSel = idx === segIdx
            const isActive = idx === activeSeg
            const minItems = allMinutesData[idx] || []
            const mDone = minItems.filter((i) => i.status === 'confirmed' || i.status === 'rejected' || i.status === 'unverified').length
            const mTotal = minItems.length
            const mInFlight = minItems.some((i) => i.status === 'verifying' || i.status === 'rescanning')

            return (
              <button
                key={idx}
                type="button"
                role="tab"
                aria-selected={isSel}
                onClick={() => {
                  setSelected(idx === activeSeg ? null : idx)
                  setSelectedItem(null)
                }}
                title={`Short Minute ${idx + 1} (${fmtTime(idx * 60)}–${fmtTime(Math.min((idx + 1) * 60, totalDuration))}) — ${mDone}/${mTotal} verified`}
                className={`btn-press flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-xs ${
                  isSel
                    ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300 font-semibold shadow-xs'
                    : 'border-input text-muted-foreground hover:border-emerald-500/40 hover:bg-secondary'
                }`}
              >
                <span>Min {idx + 1}</span>
                <span className="text-[10px] opacity-80">({mDone}/{mTotal})</span>
                {mTotal > 0 && mDone >= mTotal && <span className="text-emerald-400 font-bold" aria-hidden>✓</span>}
                {mInFlight && (
                  <span className="inline-block size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
                )}
                {isActive && mDone < mTotal && <span className="sr-only">(current)</span>}
              </button>
            )
          })}
        </div>
      )}

      {/* ---------- Live Verifier Status Breakdown Cards (Same 4 Cards!) ---------- */}
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
        {/* Card 1: Min Target */}
        <div className="rounded-lg border border-border bg-card/60 p-2.5">
          <div className="text-[11px] text-muted-foreground">Min {segIdx + 1} Target</div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="font-mono text-lg font-bold text-foreground">{totalPlanned}</span>
            <span className="text-[11px] text-muted-foreground">scenes</span>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground truncate">
            {overallTotal} total candidates in short
          </div>
        </div>

        {/* Card 2: Completed */}
        <div className="rounded-lg border border-border bg-card/60 p-2.5">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <CheckCircle2 className="size-3 text-emerald-400" aria-hidden />
            <span>Completed</span>
          </div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="font-mono text-lg font-bold text-emerald-400">{doneCount}</span>
            <span className="text-[11px] text-muted-foreground">done</span>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground truncate">
            {confirmedCount > 0 || rejectedCount > 0
              ? `${confirmedCount} confirmed · ${rejectedCount} rejected`
              : `${doneCount} verified`}
          </div>
        </div>

        {/* Card 3: Kaam Chal Raha Hai */}
        <div
          className={`rounded-lg border p-2.5 ${
            inFlightCount > 0 ? 'border-primary/50 bg-primary/10' : 'border-border bg-card/60'
          }`}
        >
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Zap
              className={`size-3 ${inFlightCount > 0 ? 'text-primary animate-pulse' : 'text-muted-foreground'}`}
              aria-hidden
            />
            <span>Kaam Chal Raha Hai</span>
          </div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className={`font-mono text-lg font-bold ${inFlightCount > 0 ? 'text-primary' : 'text-foreground'}`}>
              {inFlightCount}
            </span>
            <span className="text-[11px] text-muted-foreground">in flight</span>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground truncate">
            {inFlightCount > 0 ? '24fps AI Verifier active' : 'Idle / waiting'}
          </div>
        </div>

        {/* Card 4: Waiting / Baki */}
        <div className="rounded-lg border border-border bg-card/60 p-2.5">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clock className="size-3 text-amber-500" aria-hidden />
            <span>Waiting / Baki</span>
          </div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="font-mono text-lg font-bold text-foreground">{pendingCount}</span>
            <span className="text-[11px] text-muted-foreground">queued</span>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground truncate">
            {remaining} scenes baki verify hone ko
          </div>
        </div>
      </div>

      {/* ---------- Active Work Details (Kaam chal raha hai) ---------- */}
      {inFlightCount > 0 && (
        <div className="mt-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
            <span className="text-xs font-semibold text-foreground">
              Abhi In {inFlightCount} Scene(s) Par 24 FPS Verification Chal Raha Hai:
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {inFlightItems.map((item) => (
              <div
                key={item.id}
                className="inline-flex items-center gap-2 rounded-md border border-primary/30 bg-background/90 px-2.5 py-1.5 text-xs shadow-xs"
              >
                <span className="font-mono font-bold text-primary">Scene #{item.itemNumber}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  Short [{fmtTime(item.shortStart)}–{fmtTime(item.shortEnd)}]
                </span>
                <span className="text-foreground/40 font-mono">⟷</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  Movie [{fmtTime(item.movieStart)}–{fmtTime(item.movieEnd)}]
                </span>
                {item.verifierModel && (
                  <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    {displayModelName(item.verifierModel)}
                  </span>
                )}
                {item.status === 'rescanning' && (
                  <span className="rounded-sm bg-purple-500/20 px-1.5 py-0.5 text-[10px] font-medium text-purple-300">
                    Rescan
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------- Visual Scene Square Grid (Squre Dabbe) ---------- */}
      {totalPlanned > 0 ? (
        <div className="mt-3.5">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-xs text-muted-foreground">
              Click any box to inspect scene details or view comparison:
            </span>
            <button
              type="button"
              onClick={() => void handleVerifyMinute(segIdx)}
              disabled={isMinVerifying || triggeringMinute === segIdx}
              className="inline-flex items-center gap-1 rounded border border-border/80 bg-background/80 px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted/40 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {triggeringMinute === segIdx || isMinVerifying ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RotateCcw className="h-3 w-3" />
              )}
              {doneCount >= totalPlanned ? `Re-verify Min ${segIdx + 1}` : `Verify Min ${segIdx + 1}`}
            </button>
          </div>

          <div className="flex flex-wrap gap-1" role="list" aria-label="Verifier scene blocks">
            {items.map((item) => {
              const tooltip = `Scene #${item.itemNumber}: Short [${fmtTime(item.shortStart)}–${fmtTime(
                item.shortEnd,
              )}] ⟷ Movie [${fmtTime(item.movieStart)}–${fmtTime(item.movieEnd)}] (${item.duration.toFixed(
                1,
              )}s) — ${item.status.toUpperCase()}${
                item.verifierModel ? ` · ${displayModelName(item.verifierModel)}` : ''
              }${item.reason ? ` · ${item.reason}` : ''}`

              const isSelected = selectedItem?.id === item.id

              return (
                <div
                  key={item.id}
                  role="listitem"
                  title={tooltip}
                  onClick={() => setSelectedItem(isSelected ? null : item)}
                  className={`h-5 w-5 rounded-sm cursor-pointer ${
                    VERIFIER_STATUS_CLASS[item.status] || 'bg-muted'
                  } transition-all duration-200 hover:scale-125 hover:ring-2 hover:ring-primary/50 ${
                    isSelected ? 'ring-2 ring-white scale-125 z-10 shadow-md' : ''
                  }`}
                />
              )
            })}
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-border/70 p-4 text-center text-xs text-muted-foreground">
          Is minute me abhi koi matched candidate scenes nahi mile hain (chunk scan chal raha hai).
        </div>
      )}

      {/* ---------- Selected Scene Quick Inspector (When user clicks a square box) ---------- */}
      {selectedItem && (
        <div className="mt-3 rounded-lg border border-primary/40 bg-card p-3 text-xs shadow-sm transition-all">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2">
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold text-foreground text-xs">
                SCENE #{selectedItem.itemNumber}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                Short [{fmtTime(selectedItem.shortStart)} – {fmtTime(selectedItem.shortEnd)}] <span className="text-foreground/40">⟷</span> Movie [{fmtTime(selectedItem.movieStart)} – {fmtTime(selectedItem.movieEnd)}]
              </span>
              <span className="text-[10px] text-muted-foreground">({selectedItem.duration.toFixed(2)}s)</span>
            </div>

            <div className="flex items-center gap-1.5">
              {selectedItem.status === 'confirmed' && (
                <span className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-400 border border-emerald-500/30">
                  <CheckCircle2 className="h-3 w-3" />
                  CONFIRMED
                </span>
              )}
              {selectedItem.status === 'rejected' && (
                <span className="inline-flex items-center gap-1 rounded bg-rose-500/20 px-2 py-0.5 text-[10px] font-medium text-rose-400 border border-rose-500/30">
                  <AlertCircle className="h-3 w-3" />
                  REJECTED
                </span>
              )}
              {selectedItem.status === 'verifying' && (
                <span className="inline-flex items-center gap-1 rounded bg-primary/20 px-2 py-0.5 text-[10px] font-medium text-primary border border-primary/30">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  VERIFYING 24FPS
                </span>
              )}
              {selectedItem.status === 'pending' && (
                <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  QUEUED
                </span>
              )}

              {/* View button to jump directly to Side-by-Side Comparison */}
              <button
                type="button"
                onClick={() => jumpToCompare(selectedItem.shortStart, selectedItem.shortEnd)}
                className="inline-flex items-center gap-1 rounded bg-secondary hover:bg-secondary/80 border border-border/80 px-2 py-0.5 text-[10px] font-medium text-foreground transition-colors cursor-pointer shadow-xs hover:border-primary/50"
                title={`View Short [${fmtTime(selectedItem.shortStart)}–${fmtTime(selectedItem.shortEnd)}] in Side-by-Side Comparison`}
              >
                <Eye className="h-3 w-3 text-primary" />
                View Compare
              </button>

              {/* Rescan button if rejected */}
              {selectedItem.status === 'rejected' && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      if (rescanningPart === selectedItem.id) return
                      setModelPickerPart((prev) => (prev === selectedItem.id ? null : selectedItem.id))
                    }}
                    disabled={rescanningPart === selectedItem.id}
                    className="inline-flex items-center gap-1 rounded bg-indigo-600/80 hover:bg-indigo-600 px-2 py-0.5 text-[10px] font-medium text-white shadow-xs disabled:opacity-50 transition-colors cursor-pointer"
                    title="Choose Gemini Model (3.6, 3.7, 3.8) to rescan this scene"
                  >
                    {rescanningPart === selectedItem.id ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Rescanning...
                      </>
                    ) : (
                      <>
                        <RotateCcw className="h-3 w-3" />
                        Rescan Scene
                        <ChevronDown className="h-2.5 w-2.5 opacity-80" />
                      </>
                    )}
                  </button>

                  {modelPickerPart === selectedItem.id && (
                    <div className="absolute right-0 top-full mt-1 z-30 w-44 rounded-md border border-border/80 bg-popover p-1 shadow-lg backdrop-blur-md">
                      <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                        Choose Model:
                      </div>
                      {[
                        { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
                        { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
                        { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
                      ].map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => void handleRescanScene(selectedItem, m.id)}
                          className="w-full text-left rounded px-2 py-1 text-[11px] font-medium hover:bg-primary/20 hover:text-primary transition-colors cursor-pointer"
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={() => setSelectedItem(null)}
                className="text-muted-foreground hover:text-foreground text-xs px-1"
              >
                ✕
              </button>
            </div>
          </div>

          {selectedItem.reason && (
            <div className="mt-2 text-[11px] text-muted-foreground bg-muted/20 p-2 rounded border border-border/40">
              <strong className="text-foreground">Verifier Reason: </strong>
              {selectedItem.reason}
            </div>
          )}
        </div>
      )}

      {/* ---------- Legend with Live Counts (Same as Scan Timeline) ---------- */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <LegendDot cls="bg-muted border border-border/60" label="pending" count={pendingCount} />
        <LegendDot cls="bg-primary animate-pulse" label="verifying" count={inFlightCount} />
        <LegendDot cls="bg-emerald-500" label="confirmed" count={confirmedCount} />
        <LegendDot cls="bg-rose-500/80" label="rejected" count={rejectedCount} />
        {unverifiedCount > 0 && <LegendDot cls="bg-amber-500/70" label="unverified" count={unverifiedCount} />}
        {rescanningCount > 0 && <LegendDot cls="bg-purple-500 animate-pulse" label="rescanning" count={rescanningCount} />}
      </div>

      {/* ---------- Expandable Full Details Accordion (Optional detailed breakdown) ---------- */}
      {items.length > 0 && (
        <div className="mt-3 border-t border-border/50 pt-2">
          <button
            type="button"
            onClick={() => setIsDetailsOpen(!isDetailsOpen)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground font-medium transition cursor-pointer"
          >
            {isDetailsOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            <span>{isDetailsOpen ? 'Hide Scene Details Table' : `Show Scene Details & Rescan Table (${items.length})`}</span>
          </button>

          {isDetailsOpen && (
            <div className="mt-2.5 flex flex-col gap-2 max-h-80 overflow-y-auto pr-1">
              {items.map((p) => {
                const isConfirmed = p.status === 'confirmed'
                const isRejected = p.status === 'rejected'

                return (
                  <div
                    key={p.id}
                    className={`flex flex-col gap-1.5 rounded-md border p-2 text-xs transition-colors ${
                      isConfirmed
                        ? 'border-emerald-500/30 bg-emerald-500/5'
                        : isRejected
                        ? 'border-rose-500/30 bg-rose-500/5'
                        : 'border-border/60 bg-background/50'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold text-foreground text-[11px]">
                          SCENE #{p.itemNumber}
                        </span>
                        <span className="font-mono text-muted-foreground text-[11px]">
                          Short [{fmtTime(p.shortStart)} – {fmtTime(p.shortEnd)}] <span className="text-foreground/60">⟷</span> Movie [{fmtTime(p.movieStart)} – {fmtTime(p.movieEnd)}]
                        </span>
                        <span className="text-[10px] text-muted-foreground">({p.duration.toFixed(2)}s)</span>
                      </div>

                      <div className="flex items-center gap-2">
                        {isConfirmed && (
                          <span className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-400 border border-emerald-500/30">
                            <CheckCircle2 className="h-3 w-3" />
                            CONFIRMED
                          </span>
                        )}
                        {isRejected && (
                          <span className="inline-flex items-center gap-1 rounded bg-rose-500/20 px-2 py-0.5 text-[10px] font-medium text-rose-400 border border-rose-500/30">
                            <AlertCircle className="h-3 w-3" />
                            REJECTED
                          </span>
                        )}
                        {p.status === 'verifying' && (
                          <span className="inline-flex items-center gap-1 rounded bg-primary/20 px-2 py-0.5 text-[10px] font-medium text-primary">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            VERIFYING
                          </span>
                        )}

                        <button
                          type="button"
                          onClick={() => jumpToCompare(p.shortStart, p.shortEnd)}
                          className="inline-flex items-center gap-1 rounded bg-secondary hover:bg-secondary/80 border border-border/80 px-2 py-0.5 text-[10px] font-medium text-foreground transition-colors cursor-pointer shadow-xs"
                        >
                          <Eye className="h-3 w-3 text-primary" />
                          View
                        </button>

                        {isRejected && (
                          <button
                            type="button"
                            onClick={() => void handleRescanScene(p)}
                            disabled={rescanningPart === p.id}
                            className="inline-flex items-center gap-1 rounded bg-indigo-600/80 hover:bg-indigo-600 px-2 py-0.5 text-[10px] font-medium text-white shadow-xs disabled:opacity-50 transition-colors cursor-pointer"
                          >
                            {rescanningPart === p.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RotateCcw className="h-3 w-3" />
                            )}
                            Rescan
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function LegendDot({ cls, label, count }: { cls: string; label: string; count?: number }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${cls}`} aria-hidden />
      <span>{label}</span>
      {count !== undefined && (
        <span className="font-mono text-[10px] text-muted-foreground/80">({count})</span>
      )}
    </span>
  )
}
