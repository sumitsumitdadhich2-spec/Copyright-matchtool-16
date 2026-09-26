'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Layers, Loader2, Check, AlertTriangle, Filter, Zap, RotateCcw, Play } from 'lucide-react'
import type { Scan, TwelveLabsState, PrefilterInfo, MergePipelineState, MergePipelineStatus } from '@/lib/types'
import { fetcher } from '@/lib/format'
import { MinuteApproval } from './minute-approval'

interface PipelineResponse {
  hasKey: boolean
  ready: boolean
  running: boolean
  pipeline: MergePipelineState
  twelveLabs: TwelveLabsState
  prefilter: PrefilterInfo | null
}

/** Ordered pipeline steps for the timeline UI. */
const STEPS: { key: MergePipelineStatus; label: string }[] = [
  { key: 'checking', label: 'Compat check' },
  { key: 'merging', label: 'Merge' },
  { key: 'uploading', label: 'Upload' },
  { key: 'indexing', label: 'Index' },
  { key: 'splitting', label: 'Split' },
  { key: 'segmenting', label: 'Segmentation' },
  { key: 'suggesting', label: 'Minute list' },
]

const ACTIVE_STATUSES: MergePipelineStatus[] = [
  'checking',
  'merging',
  'uploading',
  'indexing',
  'splitting',
  'segmenting',
  'suggesting',
]

function stepIndex(status: MergePipelineStatus): number {
  const i = STEPS.findIndex((s) => s.key === status)
  if (i >= 0) return i
  if (status === 'awaiting_approval' || status === 'approved') return STEPS.length
  return -1
}

function fmtDur(sec: number): string {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m ${String(ss).padStart(2, '0')}s` : `${m}m ${ss}s`
}

/** AUTO PIPELINE panel: merge → TwelveLabs upload → Marengo index →
 *  Pegasus segmentation → minute list → user approval → Gemini scan.
 *  Replaces the old manual "Index Movie on Twelve Labs" flow. Without a
 *  TwelveLabs key the section hides and the app runs 100% as before. */
export function TwelveLabsPanel({ scan }: { scan: Scan }) {
  const [acting, setActing] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const { data, mutate } = useSWR<PipelineResponse>(
    scan.id ? `/api/scans/${scan.id}/merge-pipeline` : null,
    fetcher,
    {
      refreshInterval: (latest) =>
        latest && (ACTIVE_STATUSES.includes(latest.pipeline?.status) || latest.running) ? 3000 : 15000,
    },
  )

  // Key na ho to section bilkul na dikhe — app 100% normal chalta hai.
  if (!data || !data.hasKey) return null

  const pipeline = data.pipeline ?? { status: 'idle' as const }
  const status = pipeline.status
  const prefilter = data.prefilter ?? scan.prefilter ?? null
  const isActive = ACTIVE_STATUSES.includes(status) || data.running
  const currentStep = stepIndex(status)
  const isError = status === 'error'
  const isDone = status === 'awaiting_approval' || status === 'approved'

  async function post(action: 'start' | 'retry') {
    setActing(true)
    setActionError(null)
    const res = await fetch(`/api/scans/${scan.id}/merge-pipeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    setActing(false)
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      setActionError(j.error || 'Pipeline start failed')
    }
    void mutate()
  }

  // PER-MINUTE PLAN (Twelve Labs pre-filter): har short minute me kitne chunks
  // scan/verify honge + live progress (unchanged from the old panel).
  const minuteRows = (scan.shortSegments || [])
    .filter((s) => s.selected !== false && Array.isArray(s.prefilterChunks) && s.prefilterChunks.length > 0)
    .map((s) => {
      const planned = s.prefilterChunks!.length
      const scanned = s.chunks.filter((c) => c.status === 'match' || c.status === 'no_match').length
      const matched = s.chunks.filter((c) => c.status === 'match').length
      return {
        index: s.index,
        planned,
        scanned,
        matched,
        windows: s.tlWindows?.length ?? 0,
        saved: s.earlyStopSavedChunks ?? 0,
        status: s.status,
      }
    })

  return (
    <section aria-label="Auto merge pipeline" className="panel">
      <div className="flex flex-wrap items-center gap-2">
        <Layers className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">
          Auto Pipeline <span className="font-normal text-muted-foreground">(Merge → Index → Segmentation)</span>
        </h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {isActive ? (
            <span className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/15 px-2.5 py-0.5 text-xs text-primary">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              Running...
            </span>
          ) : status === 'awaiting_approval' ? (
            <span className="rounded-full border border-warning/40 bg-warning/15 px-2.5 py-0.5 text-xs text-warning">
              Approval ka wait
            </span>
          ) : status === 'approved' ? (
            <span className="flex items-center gap-1 rounded-full bg-success/15 px-2.5 py-0.5 text-xs text-success">
              <Check className="size-3" aria-hidden />
              Approved — Gemini chal raha hai
            </span>
          ) : isError ? (
            <span className="rounded-full bg-destructive/15 px-2.5 py-0.5 text-xs text-destructive">Error</span>
          ) : (
            <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground">
              {data.ready ? 'ready to start' : 'short + movie + trim ka wait'}
            </span>
          )}
          {status === 'idle' && data.ready && !isActive && (
            <button
              type="button"
              onClick={() => post('start')}
              disabled={acting}
              className="btn-press flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm disabled:opacity-40"
            >
              <Play className="size-3" aria-hidden />
              {acting ? 'Starting...' : 'Start Auto Pipeline'}
            </button>
          )}
          {isError && !isActive && (
            <button
              type="button"
              onClick={() => post('retry')}
              disabled={acting}
              className="btn-press flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm disabled:opacity-40"
            >
              <RotateCcw className="size-3" aria-hidden />
              {acting ? 'Retrying...' : 'Retry'}
            </button>
          )}
        </div>
      </div>

      {/* STEP TIMELINE */}
      {(isActive || isDone || isError) && (
        <ol className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-2" aria-label="Pipeline steps">
          {STEPS.map((step, i) => {
            const done = currentStep > i || (isDone && i < STEPS.length)
            const active = isActive && currentStep === i
            const failed = isError && currentStep === i
            return (
              <li key={step.key} className="flex items-center gap-1">
                <span
                  className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
                    done
                      ? 'bg-success/15 text-success'
                      : active
                        ? 'border border-primary/30 bg-primary/15 text-primary'
                        : failed
                          ? 'bg-destructive/15 text-destructive'
                          : 'bg-secondary text-muted-foreground'
                  }`}
                >
                  {done ? (
                    <Check className="size-3" aria-hidden />
                  ) : active ? (
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                  ) : failed ? (
                    <AlertTriangle className="size-3" aria-hidden />
                  ) : null}
                  {step.label}
                </span>
                {i < STEPS.length - 1 && <span className="text-muted-foreground/50" aria-hidden>{'→'}</span>}
              </li>
            )
          })}
        </ol>
      )}

      {/* LIVE PROGRESS NOTE */}
      {isActive && pipeline.progress && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin text-primary" aria-hidden />
          {pipeline.progress}
        </p>
      )}

      {/* MERGE INFO */}
      {pipeline.mergedDuration ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Merged: PART A (short {pipeline.shortEnd ? fmtDur(pipeline.shortEnd) : '--'}) + PART B (movie) = total{' '}
          {fmtDur(pipeline.mergedDuration)} — ek hi upload, ek hi index.
        </p>
      ) : null}

      {/* ERROR + FALLBACK HINT */}
      {isError && pipeline.error && (
        <div className="mt-2 space-y-1">
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span>{pipeline.error}</span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            Fallback: neeche minute-select panel se manual {'"Full scan"'} hamesha chala sakte ho — wo is pipeline par
            depend nahi karta.
          </p>
        </div>
      )}

      {actionError && <p className="mt-2 text-xs text-destructive">{actionError}</p>}

      {/* APPROVAL STEP: Pegasus segment_4 minute list */}
      {status === 'awaiting_approval' && pipeline.minuteSuggestions && pipeline.minuteSuggestions.length > 0 && (
        <MinuteApproval scanId={scan.id} suggestions={pipeline.minuteSuggestions} onApproved={() => void mutate()} />
      )}

      {/* APPROVED SUMMARY */}
      {status === 'approved' && pipeline.approvedMinutes && pipeline.approvedMinutes.length > 0 && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-success">
          <Check className="size-3" aria-hidden />
          Approved minutes: {pipeline.approvedMinutes.map((m) => m + 1).join(', ')} — Gemini sirf inhi par compare kar
          raha hai.
        </p>
      )}

      {/* PRE-FILTER RESULT (existing lower section, unchanged) */}
      {prefilter && (
        <p className="mt-2 flex items-center gap-1.5 text-xs">
          <Filter className="size-3 text-primary" aria-hidden />
          {prefilter.mode === 'prefiltered' ? (
            <span className="text-success">
              Pre-filter: {prefilter.selectedChunks} of {prefilter.totalChunks} chunks selected (Twelve Labs)
            </span>
          ) : (
            <span className="text-muted-foreground">
              Full scan: all {prefilter.totalChunks} chunks{prefilter.reason ? ` — ${prefilter.reason}` : ''}
            </span>
          )}
        </p>
      )}

      {/* PER-MINUTE PLAN: har minute me kitne chunks scan/verify honge + live progress */}
      {prefilter?.mode === 'prefiltered' && minuteRows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-xs">
            <caption className="sr-only">Twelve Labs per-minute chunk plan</caption>
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th scope="col" className="py-1.5 pr-2 font-medium">Minute</th>
                <th scope="col" className="py-1.5 pr-2 font-medium">Chunks to scan</th>
                <th scope="col" className="py-1.5 pr-2 font-medium">Scanned</th>
                <th scope="col" className="py-1.5 pr-2 font-medium">Chunks w/ match</th>
                <th scope="col" className="py-1.5 pr-2 font-medium">Expected windows</th>
                <th scope="col" className="py-1.5 font-medium">Early-stop saved</th>
              </tr>
            </thead>
            <tbody>
              {minuteRows.map((r) => (
                <tr key={r.index} className="border-b border-border/50 last:border-0">
                  <td className="py-1.5 pr-2 font-medium">
                    {r.index + 1}
                    {r.status === 'done' && <Check className="ml-1 inline size-3 text-success" aria-label="done" />}
                    {(r.status === 'scanning' || r.status === 'verifying') && (
                      <Loader2 className="ml-1 inline size-3 animate-spin text-primary" aria-label={r.status} />
                    )}
                  </td>
                  <td className="py-1.5 pr-2 tabular-nums">{r.planned}</td>
                  <td className="py-1.5 pr-2 tabular-nums text-muted-foreground">
                    {r.scanned}/{r.planned}
                  </td>
                  <td className="py-1.5 pr-2 tabular-nums">{r.matched}</td>
                  <td className="py-1.5 pr-2 tabular-nums">{r.windows}</td>
                  <td className="py-1.5 tabular-nums">
                    {r.saved > 0 ? (
                      <span className="flex items-center gap-1 text-success">
                        <Zap className="size-3" aria-hidden />
                        {r.saved} chunk(s)
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Auto flow: short + movie upload aur trim confirm hote hi dono ek video me merge hote hain (no re-encode), merged
        video TwelveLabs par EK baar upload + Marengo index hota hai (embeddings short/movie me time-split), phir Pegasus
        1.5 segmentation se segment_4 matching nikalti hai. Uski minute list yahan aati hai — approve karte hi Gemini
        sirf unhi minutes par compare karta hai.
      </p>
    </section>
  )
}
