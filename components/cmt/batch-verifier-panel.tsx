'use client'

import { useState } from 'react'
import { useSWRConfig } from 'swr'
import {
  CheckCircle2,
  AlertCircle,
  Eye,
  Loader2,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Square,
  ShieldCheck,
  Zap,
} from 'lucide-react'
import type { Scan, BatchVerifyPart } from '@/lib/types'
import { fmtTime } from '@/lib/format'
import { displayModelName } from '@/lib/models'

export function BatchVerifierPanel({ scan }: { scan: Scan }) {
  const { mutate } = useSWRConfig()

  const jumpToCompare = (shortStart: number, shortEnd: number) => {
    window.dispatchEvent(
      new CustomEvent('jump-to-compare-scene', {
        detail: { shortStart, shortEnd },
      }),
    )
    const el = document.getElementById('compare-panel')
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const [expandedMinutes, setExpandedMinutes] = useState<Record<number, boolean>>({ 0: true })
  const [triggeringMinute, setTriggeringMinute] = useState<number | null>(null)
  const [triggeringAll, setTriggeringAll] = useState(false)
  const [rescanningPart, setRescanningPart] = useState<number | null>(null)
  const [modelPickerPart, setModelPickerPart] = useState<number | null>(null)
  const [rescanModelName, setRescanModelName] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  const batchState = scan.batchVerify
  const isRunning = batchState?.status === 'running'
  const totalDuration = scan.shortDuration || 60
  const minuteCount = Math.max(1, Math.ceil(totalDuration / 60))

  const toggleMinute = (minIdx: number) => {
    setExpandedMinutes((prev) => ({ ...prev, [minIdx]: !prev[minIdx] }))
  }

  // Summary counts
  let totalScenesPlanned = 0
  let totalConfirmed = 0
  let totalRejected = 0

  const minuteIndices = Array.from({ length: minuteCount }, (_, i) => i)

  minuteIndices.forEach((minIdx) => {
    const res = batchState?.results?.[minIdx]
    if (res) {
      totalScenesPlanned += res.totalScenes
      totalConfirmed += res.confirmedCount
      totalRejected += res.rejectedCount
    } else {
      // Calculate from matches
      const minStart = minIdx * 60
      const minEnd = (minIdx + 1) * 60
      const inMinute = (scan.matches || []).filter(
        (m) => m.shortStart < minEnd && m.shortEnd > minStart && m.shortEnd - m.shortStart >= 0.15,
      )
      totalScenesPlanned += inMinute.length
    }
  })

  async function handleVerifyAll() {
    if (triggeringAll || isRunning) return
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

  async function handleRescanScene(part: BatchVerifyPart, partKey: number, chosenModel?: string) {
    if (rescanningPart !== null) return
    setModelPickerPart(null)
    setRescanningPart(partKey)
    setRescanModelName(chosenModel || null)
    setFeedback(null)
    try {
      // Find matching chunk index from scan matches
      const matches = scan.matches || []
      let match = (part.matchIndex !== undefined && matches[part.matchIndex])
        ? matches[part.matchIndex]
        : null
      if (!match) {
        match = matches.find(
          (m) =>
            (Math.abs(m.shortStart - part.shortStart) < 0.3 && Math.abs(m.shortEnd - part.shortEnd) < 0.3) ||
            Math.max(0, Math.min(m.shortEnd, part.shortEnd) - Math.max(m.shortStart, part.shortStart)) > 0.1,
        ) || null
      }
      const chunkIndex = match?.chunkIndex ?? Math.max(0, Math.floor(part.movieStart / 60))

      const res = await fetch(`/api/scans/${scan.id}/rescan-scene`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shortStart: part.shortStart,
          shortEnd: part.shortEnd,
          chunkIndex,
          movieStart: part.movieStart,
          movieEnd: part.movieEnd,
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

  return (
    <section className="rounded-lg border border-border/80 bg-card/60 p-4 shadow-sm backdrop-blur-sm">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-foreground text-sm sm:text-base">
                Batch Minute Verifier
              </h3>
              <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-mono font-medium text-emerald-300">
                24 FPS ALL-IN-ONE
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Merges matched scenes per 1-minute window at 24 fps and verifies via Gemini 3.6 / 3.7 / 3.8.
            </p>
          </div>
        </div>

        {/* Global Controls */}
        <div className="flex items-center gap-2">
          {isRunning ? (
            <button
              onClick={handleStop}
              className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/20 transition-colors"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
              Stop
            </button>
          ) : (
            <button
              onClick={handleVerifyAll}
              disabled={triggeringAll}
              className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-r from-emerald-600 to-teal-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:from-emerald-500 hover:to-teal-500 disabled:opacity-50 transition-all cursor-pointer"
            >
              {triggeringAll ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <Zap className="h-3.5 w-3.5" />
                  Verify All Minute Batches
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div
          className={`mt-3 rounded-md border p-2.5 text-xs ${
            feedback.ok
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
          }`}
        >
          {feedback.msg}
        </div>
      )}

      {/* Summary Bar */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 rounded-md border border-border/50 bg-background/50 p-2.5 text-xs">
        <div>
          <span className="text-muted-foreground">Total Minutes:</span>{' '}
          <span className="font-semibold text-foreground">{minuteCount}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Matched Scenes:</span>{' '}
          <span className="font-semibold text-foreground">{totalScenesPlanned}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Confirmed:</span>{' '}
          <span className="font-semibold text-emerald-400">
            {totalConfirmed} {totalConfirmed > 0 && `(✅)`}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Rejected:</span>{' '}
          <span className="font-semibold text-rose-400">
            {totalRejected} {totalRejected > 0 && `(Rescan Required)`}
          </span>
        </div>
      </div>

      {/* Minute Blocks Accordion */}
      <div className="mt-4 flex flex-col gap-2.5">
        {minuteIndices.map((minIdx) => {
          const minStart = minIdx * 60
          const minEnd = (minIdx + 1) * 60
          const result = batchState?.results?.[minIdx]
          const isExpanded = !!expandedMinutes[minIdx]

          // Calculate scene list for this minute (either from result or from scan.matches)
          const matchedScenes = (scan.matches || []).filter(
            (m) => m.shortStart < minEnd && m.shortEnd > minStart && m.shortEnd - m.shortStart >= 0.15,
          )

          const status = result?.status || 'idle'
          const isMinVerifying = status === 'preparing' || status === 'verifying'
          const isMinDone = status === 'done'

          return (
            <div
              key={minIdx}
              className="overflow-hidden rounded-md border border-border/60 bg-background/40 transition-colors"
            >
              {/* Minute Card Header */}
              <div
                onClick={() => toggleMinute(minIdx)}
                className="flex cursor-pointer items-center justify-between p-3 hover:bg-muted/20 select-none"
              >
                <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                  <span className="font-semibold text-foreground text-xs sm:text-sm">
                    Minute {minIdx + 1}
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {fmtTime(minStart)} – {fmtTime(minEnd)}
                  </span>

                  {/* Status Badge */}
                  {isMinVerifying && (
                    <span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {status === 'preparing' ? 'Stitching 24fps...' : `Verifying on ${result?.model ? displayModelName(result.model) : 'Gemini'}...`}
                    </span>
                  )}
                  {isMinDone && (
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" />
                      Verified {result?.model ? `(${displayModelName(result.model)})` : ''}
                    </span>
                  )}
                  {status === 'error' && (
                    <span className="inline-flex items-center gap-1 rounded bg-rose-500/20 px-2 py-0.5 text-[10px] font-medium text-rose-300">
                      <AlertCircle className="h-3 w-3" />
                      Error
                    </span>
                  )}
                  {status === 'idle' && (
                    <span className="rounded bg-muted/60 px-2 py-0.5 text-[10px] text-muted-foreground">
                      {matchedScenes.length} scenes available
                    </span>
                  )}

                  {/* Score breakdown if done */}
                  {isMinDone && result && (
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="text-emerald-400 font-medium">
                        {result.confirmedCount} Confirmed
                      </span>
                      <span className="text-muted-foreground">·</span>
                      <span className={result.rejectedCount > 0 ? 'text-rose-400 font-medium' : 'text-muted-foreground'}>
                        {result.rejectedCount} Rejected
                      </span>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleVerifyMinute(minIdx)
                    }}
                    disabled={isMinVerifying || triggeringMinute === minIdx}
                    className="inline-flex items-center gap-1 rounded border border-border/80 bg-background/80 px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-muted/40 disabled:opacity-50 transition-colors"
                  >
                    {triggeringMinute === minIdx || isMinVerifying ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3" />
                    )}
                    {isMinDone ? 'Re-verify' : 'Verify'}
                  </button>
                  {isExpanded ? (
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
              </div>

              {/* Minute Details / Parts List */}
              {isExpanded && (
                <div className="border-t border-border/40 p-3 bg-muted/10">
                  {result && result.parts.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      {result.parts.map((p, pIdx) => {
                        const isConfirmed = p.verdict === 'CONFIRMED'
                        const isRejected = p.verdict === 'REJECTED'
                        const partKey = minIdx * 1000 + pIdx

                        return (
                          <div
                            key={p.partIndex}
                            className={`flex flex-col gap-1.5 rounded-md border p-2.5 text-xs transition-colors ${
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
                                  PART {p.partIndex}
                                </span>
                                <span className="font-mono text-muted-foreground text-[11px]">
                                  Short [{fmtTime(p.shortStart)} – {fmtTime(p.shortEnd)}] <span className="text-foreground/60">⟷</span> Movie [{fmtTime(p.movieStart)} – {fmtTime(p.movieEnd)}]
                                </span>
                                <span className="text-[10px] text-muted-foreground">
                                  ({p.duration.toFixed(2)}s)
                                </span>
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

                                {/* View button to jump directly to Side-by-Side Comparison */}
                                <button
                                  type="button"
                                  onClick={() => jumpToCompare(p.shortStart, p.shortEnd)}
                                  className="inline-flex items-center gap-1 rounded bg-secondary hover:bg-secondary/80 border border-border/80 px-2 py-0.5 text-[10px] font-medium text-foreground transition-colors cursor-pointer shadow-xs hover:border-primary/50"
                                  title={`View Short [${fmtTime(p.shortStart)}–${fmtTime(p.shortEnd)}] in Side-by-Side Comparison`}
                                >
                                  <Eye className="h-3 w-3 text-primary" />
                                  View
                                </button>

                                {isRejected && (
                                  <div className="relative">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (rescanningPart === partKey) return
                                        setModelPickerPart((prev) => (prev === partKey ? null : partKey))
                                      }}
                                      disabled={rescanningPart === partKey}
                                      className="inline-flex items-center gap-1 rounded bg-indigo-600/80 hover:bg-indigo-600 px-2 py-0.5 text-[10px] font-medium text-white shadow-xs disabled:opacity-50 transition-colors cursor-pointer"
                                      title="Choose Gemini Model (3.6, 3.7, 3.8) to rescan this scene"
                                    >
                                      {rescanningPart === partKey ? (
                                        <>
                                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                          Rescanning {rescanModelName ? `(${displayModelName(rescanModelName)})` : ''}...
                                        </>
                                      ) : (
                                        <>
                                          <RotateCcw className="h-2.5 w-2.5" />
                                          Rescan Scene (Retry)
                                          <ChevronDown className="h-2.5 w-2.5 opacity-70" />
                                        </>
                                      )}
                                    </button>

                                    {/* Model Selection Menu */}
                                    {modelPickerPart === partKey && rescanningPart !== partKey && (
                                      <div className="absolute bottom-full right-0 mb-1 w-52 rounded-lg border border-indigo-500/30 bg-card/95 p-1.5 shadow-xl backdrop-blur-md z-50 animate-in fade-in zoom-in-95">
                                        <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground border-b border-border/50 mb-1 flex items-center justify-between">
                                          <span>Rescan Model:</span>
                                          <button
                                            type="button"
                                            onClick={() => setModelPickerPart(null)}
                                            className="text-[9px] text-muted-foreground hover:text-foreground"
                                          >
                                            ✕
                                          </button>
                                        </div>
                                        <button
                                          type="button"
                                          onClick={() => void handleRescanScene(p, partKey, 'gemini-3.7-flash')}
                                          className="w-full flex items-center justify-between rounded px-2 py-1 text-[10px] text-foreground hover:bg-indigo-500/20 hover:text-indigo-300 transition-colors text-left cursor-pointer"
                                        >
                                          <div className="flex items-center gap-1.5">
                                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                                            <span className="font-medium">Gemini 3.7 Flash</span>
                                          </div>
                                          <span className="text-[9px] text-muted-foreground">Precise</span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => void handleRescanScene(p, partKey, 'gemini-3.8-flash')}
                                          className="w-full flex items-center justify-between rounded px-2 py-1 text-[10px] text-foreground hover:bg-indigo-500/20 hover:text-indigo-300 transition-colors text-left cursor-pointer"
                                        >
                                          <div className="flex items-center gap-1.5">
                                            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400"></span>
                                            <span className="font-medium">Gemini 3.8 Flash</span>
                                          </div>
                                          <span className="text-[9px] text-muted-foreground">Latest</span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => void handleRescanScene(p, partKey, 'gemini-3.6-flash')}
                                          className="w-full flex items-center justify-between rounded px-2 py-1 text-[10px] text-foreground hover:bg-indigo-500/20 hover:text-indigo-300 transition-colors text-left cursor-pointer"
                                        >
                                          <div className="flex items-center gap-1.5">
                                            <span className="h-1.5 w-1.5 rounded-full bg-amber-400"></span>
                                            <span className="font-medium">Gemini 3.6 Flash</span>
                                          </div>
                                          <span className="text-[9px] text-muted-foreground">Fast Pool</span>
                                        </button>
                                        <div className="border-t border-border/40 my-1"></div>
                                        <button
                                          type="button"
                                          onClick={() => void handleRescanScene(p, partKey, undefined)}
                                          className="w-full flex items-center justify-between rounded px-2 py-1 text-[10px] text-foreground hover:bg-indigo-500/20 hover:text-indigo-300 transition-colors text-left cursor-pointer"
                                        >
                                          <div className="flex items-center gap-1.5">
                                            <span className="h-1.5 w-1.5 rounded-full bg-primary"></span>
                                            <span className="font-medium">Auto (First Free)</span>
                                          </div>
                                          <span className="text-[9px] text-muted-foreground">Any</span>
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Dialogue Quote & Reason */}
                            {(p.dialogueQuote || p.reason) && (
                              <div className="mt-1 flex flex-col gap-0.5 text-[11px] text-muted-foreground">
                                {p.dialogueQuote && p.dialogueQuote !== 'NONE / MUSIC' && (
                                  <div>
                                    <span className="text-foreground/70 font-medium">Dialogue: </span>
                                    <span className="italic text-foreground/90">&ldquo;{p.dialogueQuote}&rdquo;</span>
                                  </div>
                                )}
                                {p.reason && (
                                  <div>
                                    <span className="text-foreground/70 font-medium">Forensic Note: </span>
                                    <span className={isConfirmed ? 'text-emerald-300/90' : 'text-rose-300/90'}>
                                      {p.reason}
                                    </span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ) : matchedScenes.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      <p className="text-xs text-muted-foreground mb-1">
                        {matchedScenes.length} matched scenes ready for 24 FPS stitched verification:
                      </p>
                      {matchedScenes.map((m, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between rounded border border-border/40 bg-background/30 px-2.5 py-1.5 text-[11px]"
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-muted-foreground">
                              Short {fmtTime(m.shortStart)}–{fmtTime(m.shortEnd)} ⟷ Movie {fmtTime(m.movieStart)}–{fmtTime(m.movieEnd)}
                            </span>
                            <span className="text-muted-foreground">
                              ({(m.shortEnd - m.shortStart).toFixed(2)}s)
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => jumpToCompare(m.shortStart, m.shortEnd)}
                            className="inline-flex items-center gap-1 rounded bg-secondary hover:bg-secondary/80 border border-border/80 px-2 py-0.5 text-[10px] font-medium text-foreground transition-colors cursor-pointer shadow-xs hover:border-primary/50"
                            title="View in Side-by-Side Comparison"
                          >
                            <Eye className="h-3 w-3 text-primary" />
                            View
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-3 text-xs text-muted-foreground">
                      No matched scenes found in this 1-minute window yet.
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
