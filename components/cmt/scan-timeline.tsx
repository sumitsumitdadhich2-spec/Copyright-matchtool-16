'use client'

import { useEffect, useState } from 'react'
import type { Scan, ChunkState, ShortSegmentStatus, ShortSegmentState } from '@/lib/types'
import { fmtTime } from '@/lib/format'
import { displayModelName } from '@/lib/models'
import { Clock, Zap, CheckCircle2, Layers, ListFilter } from 'lucide-react'

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-muted border border-border/50',
  scanning: 'bg-primary animate-pulse ring-1 ring-primary',
  no_match: 'bg-success/70 hover:bg-success',
  match: 'bg-destructive ring-1 ring-destructive',
  failed: 'bg-destructive/80',
  policy_blocked: 'bg-amber-500',
  cancelled: 'bg-muted/40 opacity-40',
}

const SEG_STATUS_LABEL: Record<ShortSegmentStatus, string> = {
  pending: 'pending',
  scanning: 'scanning',
  verifying: 'verifying',
  done: 'done',
}

/** Pick the chunks to display for a given selected minute. The active minute is
 *  mirrored into scan.chunks (live states); other minutes come straight from
 *  shortSegments[i].chunks. */
function chunksForSegment(scan: Scan, segIdx: number): ChunkState[] {
  const segs = scan.shortSegments
  if (!segs || segs.length === 0) return scan.chunks || []
  if (segIdx === (scan.currentShortSegment ?? 0)) return scan.chunks || []
  const seg = segs[segIdx]
  if (!seg) return scan.chunks || []
  if (seg.chunks && seg.chunks.length > 0) return seg.chunks
  // Segment not started yet — synthesize pending placeholders so the grid stays stable.
  return Array.from({ length: scan.chunkCount || 0 }, (_, i) => ({ index: i, status: 'pending' as const, attempts: 0 }))
}

function getSegmentMetrics(scan: Scan, segIdx: number) {
  const segs = scan.shortSegments || []
  const seg = segs[segIdx]
  const chunks = chunksForSegment(scan, segIdx) || []

  let filterLabel: string | null = null
  if (seg?.movieMinutes && seg.movieMinutes.length > 0) {
    filterLabel = `${seg.movieMinutes.length} specific movie minute(s)`
  } else if (seg?.prefilterChunks && seg.prefilterChunks.length > 0) {
    filterLabel = `${seg.prefilterChunks.length} TwelveLabs chunks`
  } else if (seg?.movieRangeStart !== undefined && seg?.movieRangeEnd !== undefined) {
    filterLabel = `Range ${fmtTime(seg.movieRangeStart)}–${fmtTime(seg.movieRangeEnd)}`
  }

  const doneChunks = chunks.filter((c) => c && (c.status === 'match' || c.status === 'no_match'))
  const matchChunks = chunks.filter((c) => c && c.status === 'match')
  const noMatchChunks = chunks.filter((c) => c && c.status === 'no_match')
  const scanningChunks = chunks.filter((c) => c && c.status === 'scanning')
  const pendingChunks = chunks.filter((c) => c && c.status === 'pending')
  const failedChunks = chunks.filter((c) => c && (c.status === 'failed' || c.status === 'policy_blocked'))
  const cancelledChunks = chunks.filter((c) => c && c.status === 'cancelled')

  // Total planned chunks for this minute
  let totalPlanned = chunks.length
  if (seg?.movieMinutes && seg.movieMinutes.length > 0) {
    totalPlanned = seg.movieMinutes.length
  } else if (seg?.prefilterChunks && seg.prefilterChunks.length > 0) {
    totalPlanned = seg.prefilterChunks.length
  } else if (cancelledChunks.length > 0) {
    totalPlanned = Math.max(0, chunks.length - cancelledChunks.length)
  }

  const directActive = doneChunks.length + scanningChunks.length + pendingChunks.length + failedChunks.length
  if (directActive > 0 && totalPlanned < directActive) {
    totalPlanned = directActive
  }
  if (totalPlanned === 0 && chunks.length > 0) {
    totalPlanned = chunks.length
  }

  const remaining = Math.max(0, totalPlanned - doneChunks.length)
  const progressPct = totalPlanned > 0 ? Math.min(100, Math.round((doneChunks.length / totalPlanned) * 100)) : 0

  return {
    seg,
    chunks,
    filterLabel,
    totalPlanned,
    doneCount: doneChunks.length,
    matchCount: matchChunks.length,
    noMatchCount: noMatchChunks.length,
    scanningChunks,
    scanningCount: scanningChunks.length,
    pendingChunks,
    pendingCount: pendingChunks.length,
    failedCount: failedChunks.length,
    cancelledCount: cancelledChunks.length,
    remaining,
    progressPct,
  }
}

function getWaitingExplanation({
  scan,
  segIdx,
  activeSeg,
  seg,
  pendingCount,
  scanningCount,
  scanningChunks,
}: {
  scan: Scan
  segIdx: number
  activeSeg: number
  seg?: ShortSegmentState
  pendingCount: number
  scanningCount: number
  scanningChunks: ChunkState[]
}): { title: string; reason: string; badge: string } {
  if (pendingCount === 0) {
    return {
      title: 'Queue Completed',
      reason: 'Is minute ke saare planned chunks scan ho chuke hain.',
      badge: 'Completed',
    }
  }

  const isScanning = scan.status === 'running' || scan.status === 'scanning' || scan.status === 'verifying'

  if (seg?.selected === false) {
    return {
      title: 'Minute Unselected',
      reason: 'Ye minute settings me unselected hai, isliye iske chunks skip kiye gaye hain.',
      badge: 'Unselected',
    }
  }

  if (!isScanning) {
    if (scan.status === 'chunking') {
      return {
        title: 'Movie Chunking Chal Rahi Hai',
        reason: 'Movie video 60-second chunks me slice ho rahi hai. Ready hote hi scanning shuru hogi.',
        badge: 'Preparing Chunks',
      }
    }
    if (scan.status === 'done') {
      return {
        title: 'Scan Finished',
        reason: 'Overall scan complete ho chuka hai.',
        badge: 'Completed',
      }
    }
    if (scan.status === 'stopped') {
      return {
        title: 'Scan Paused / Stopped',
        reason: 'Scan pause par hai. Agle chunks scan karne ke liye "Resume Scan" par click karein.',
        badge: 'Paused',
      }
    }
    return {
      title: 'Scan Idle',
      reason: 'Start Scan button click karne par chunks ki queue scan hona shuru hogi.',
      badge: 'Ready to Scan',
    }
  }

  if (segIdx > activeSeg) {
    return {
      title: `Minute ${activeSeg + 1} Ka Scan Chal Raha Hai`,
      reason: `Abhi live scan Minute ${activeSeg + 1} par active hai. Rate-limit safety aur sequential timeline mapping ke mutabik Min ${activeSeg + 1} complete hote hi Min ${segIdx + 1} automatic shuru ho jayega.`,
      badge: `In Queue (After Min ${activeSeg + 1})`,
    }
  }

  if (segIdx < activeSeg) {
    return {
      title: 'Previous Minute',
      reason: `Live scanner abhi Minute ${activeSeg + 1} par aage badh chuka hai.`,
      badge: 'Previous Minute',
    }
  }

  // Active minute (segIdx === activeSeg)
  const activeModelCount = Object.values(scan.modelStates || {}).filter((s) => s.state === 'active').length
  const coolingList = Object.entries(scan.modelStates || {})
    .filter(([, s]) => s.state === 'cooling' && s.cooldownUntil && s.cooldownUntil > Date.now())
    .map(([m, s]) => `${displayModelName(m)} (${Math.max(1, Math.round((s.cooldownUntil! - Date.now()) / 1000))}s cooldown)`)

  const exhaustedList = Object.entries(scan.modelStates || {})
    .filter(([, s]) => s.state === 'exhausted')
    .map(([m]) => displayModelName(m))

  if (scanningCount > 0 || activeModelCount > 0) {
    const chunkNames = scanningChunks.map((c) => `#${c.index + 1}`).join(', ')
    return {
      title: `${scanningCount || activeModelCount} Worker Lane(s) Busy Hain`,
      reason: `Filhal ${chunkNames ? `Chunk ${chunkNames}` : 'active chunks'} scan ho rahe hain. Concurrency cap aur TPM rate-limit safety ke mutabik jaise hi inme se koi chunk complete hoga, queue se agla waiting chunk turant pick ho jayega.`,
      badge: 'Workers Busy',
    }
  }

  if (coolingList.length > 0) {
    return {
      title: 'Model Cooldown Buffer',
      reason: `Rate-limit safety pause: ${coolingList.join(', ')}. Cooldown expire hote hi queue se agla chunk dispatch ho jayega.`,
      badge: 'Cooldown Buffer',
    }
  }

  if (exhaustedList.length > 0) {
    return {
      title: 'Model Quota Allocation',
      reason: `${exhaustedList.join(', ')} quota cap par hain. Baaki available models par agla chunk allocate kiya ja raha hai.`,
      badge: 'Allocating Lane',
    }
  }

  return {
    title: 'Pacing & Lane Dispatch',
    reason: 'Safety coordinator TPM collision prevent karne ke liye key lane allocate kar raha hai. Next chunk dispatch ho raha hai...',
    badge: 'Pacing Queue',
  }
}

function getActiveChunkWorkerInfo(scan: Scan, c: ChunkState) {
  let modelName = c.model ? displayModelName(c.model) : null
  const keyIdxStr = c.keyIdx !== undefined ? `Key ${c.keyIdx + 1}` : null

  if (!modelName && scan.modelStates) {
    for (const [modelId, liveState] of Object.entries(scan.modelStates)) {
      if (liveState.state === 'active' && liveState.currentChunk === c.index) {
        modelName = displayModelName(modelId)
        break
      }
    }
  }

  return {
    modelName: modelName || 'Gemini Flash',
    keyIdxStr,
  }
}

export function ScanTimeline({ scan }: { scan: Scan }) {
  const segs = scan.shortSegments || []
  const multi = segs.length > 1
  const [selected, setSelected] = useState<number | null>(null)
  const activeSeg = scan.currentShortSegment ?? 0
  const segIdx = selected ?? activeSeg

  useEffect(() => {
    setSelected(null)
  }, [scan.id, segs.length])

  if (scan.chunkCount === 0) {
    return (
      <section aria-label="Scan timeline" className="panel">
        <h2 className="text-sm font-semibold">Scan Timeline</h2>
        <p className="mt-2 text-xs text-muted-foreground">Upload a movie to see the minute-by-minute timeline.</p>
      </section>
    )
  }

  const metrics = getSegmentMetrics(scan, segIdx)
  const {
    seg,
    chunks,
    filterLabel,
    totalPlanned,
    doneCount,
    matchCount,
    noMatchCount,
    scanningChunks,
    scanningCount,
    pendingCount,
    failedCount,
    cancelledCount,
    remaining,
    progressPct,
  } = metrics

  const totalDoneAllMinutes = (scan.shortSegments || []).reduce(
    (acc, s) => acc + (s.chunks || []).filter((c) => c.status === 'match' || c.status === 'no_match').length,
    0,
  ) || doneCount

  const waitingInfo = getWaitingExplanation({
    scan,
    segIdx,
    activeSeg,
    seg,
    pendingCount,
    scanningCount,
    scanningChunks,
  })

  return (
    <section aria-label="Scan timeline" className="panel">
      {/* ---------- Header ---------- */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Layers className="size-4 text-primary" aria-hidden />
            <h2 className="text-sm font-semibold">Scan Timeline</h2>
          </div>
          {multi && (
            <span className="rounded-full bg-primary/15 px-2.5 py-0.5 font-mono text-[11px] font-medium text-primary">
              Short Minute {segIdx + 1}/{segs.length}
              {seg && ` (${fmtTime(seg.start)}–${fmtTime(seg.end)})`}
            </span>
          )}
          {filterLabel && (
            <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">
              <ListFilter className="size-3 text-primary" aria-hidden />
              {filterLabel}
            </span>
          )}
        </div>

        <div className="flex flex-col items-end">
          <span className="font-mono text-xs font-semibold text-foreground">
            {doneCount}/{totalPlanned} chunks in Min {segIdx + 1} ({progressPct}%)
          </span>
          {multi && (
            <span className="font-mono text-[10px] text-muted-foreground">
              Overall: {totalDoneAllMinutes}/{scan.chunkCount} movie chunks
            </span>
          )}
        </div>
      </div>

      {/* ---------- Minute Selection Tabs (with per-minute progress) ---------- */}
      {multi && (
        <div className="mt-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Short video minutes">
          {segs.map((s) => {
            const isSel = s.index === segIdx
            const isActive = s.index === activeSeg
            const sChunks = s.chunks || []
            const sDone = sChunks.filter((c) => c.status === 'match' || c.status === 'no_match').length
            const sTotal =
              s.movieMinutes?.length ||
              s.prefilterChunks?.length ||
              (sChunks.length ? sChunks.filter((c) => c.status !== 'cancelled').length : scan.chunkCount)

            return (
              <button
                key={s.index}
                type="button"
                role="tab"
                aria-selected={isSel}
                onClick={() => setSelected(s.index === activeSeg ? null : s.index)}
                title={`Short ${fmtTime(s.start)}–${fmtTime(s.end)} — ${SEG_STATUS_LABEL[s.status]}`}
                className={`btn-press flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-xs ${
                  isSel
                    ? 'border-primary bg-primary/15 text-primary font-semibold shadow-xs'
                    : 'border-input text-muted-foreground hover:border-primary/40 hover:bg-secondary'
                }`}
              >
                <span>Min {s.index + 1}</span>
                <span className="text-[10px] opacity-80">({sDone}/{sTotal})</span>
                {s.status === 'done' && <span className="text-success font-bold" aria-hidden>✓</span>}
                {(s.status === 'scanning' || s.status === 'verifying') && (
                  <span className="inline-block size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
                )}
                {isActive && s.status !== 'done' && <span className="sr-only">(current)</span>}
              </button>
            )
          })}
        </div>
      )}

      {/* ---------- Live Chunk Status Breakdown Cards ---------- */}
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
        {/* Card 1: Total for this minute */}
        <div className="rounded-lg border border-border bg-card/60 p-2.5">
          <div className="text-[11px] text-muted-foreground">Min {segIdx + 1} Target</div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="font-mono text-lg font-bold text-foreground">{totalPlanned}</span>
            <span className="text-[11px] text-muted-foreground">chunks</span>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground truncate">
            {scan.chunkCount} total in movie
          </div>
        </div>

        {/* Card 2: Done */}
        <div className="rounded-lg border border-border bg-card/60 p-2.5">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <CheckCircle2 className="size-3 text-success" aria-hidden />
            <span>Completed</span>
          </div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="font-mono text-lg font-bold text-success">{doneCount}</span>
            <span className="text-[11px] text-muted-foreground">done</span>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground truncate">
            {matchCount > 0 ? `${matchCount} match · ${noMatchCount} clean` : `${noMatchCount} clean`}
          </div>
        </div>

        {/* Card 3: Scanning in flight */}
        <div className={`rounded-lg border p-2.5 ${scanningCount > 0 ? 'border-primary/50 bg-primary/10' : 'border-border bg-card/60'}`}>
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Zap className={`size-3 ${scanningCount > 0 ? 'text-primary animate-pulse' : 'text-muted-foreground'}`} aria-hidden />
            <span>Kaam Chal Raha Hai</span>
          </div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className={`font-mono text-lg font-bold ${scanningCount > 0 ? 'text-primary' : 'text-foreground'}`}>
              {scanningCount}
            </span>
            <span className="text-[11px] text-muted-foreground">in flight</span>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground truncate">
            {scanningCount > 0 ? 'Parallel AI lanes active' : 'Idle / waiting'}
          </div>
        </div>

        {/* Card 4: Waiting / Pending */}
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
            {remaining} chunks baki scan hone ko
          </div>
        </div>
      </div>

      {/* ---------- Active Work Details (Kaam chal raha hai) ---------- */}
      {scanningCount > 0 && (
        <div className="mt-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
            <span className="text-xs font-semibold text-foreground">
              Abhi In {scanningCount} Chunks Par Kaam Chal Raha Hai:
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {scanningChunks.map((c) => {
              const info = getActiveChunkWorkerInfo(scan, c)
              return (
                <div
                  key={c.index}
                  className="inline-flex items-center gap-2 rounded-md border border-primary/30 bg-background/90 px-2.5 py-1.5 text-xs shadow-xs"
                >
                  <span className="font-mono font-bold text-primary">Chunk #{c.index + 1}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    ({fmtTime(c.index * 60)}–{fmtTime((c.index + 1) * 60)})
                  </span>
                  <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    {info.modelName}
                  </span>
                  {info.keyIdxStr && (
                    <span className="rounded-sm bg-secondary px-1.5 py-0.5 text-[10px] font-mono text-secondary-foreground">
                      {info.keyIdxStr}
                    </span>
                  )}
                  {c.attempts > 1 && (
                    <span className="text-[10px] text-amber-500 font-medium">Try {c.attempts}</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ---------- Waiting Reason Callout (Kyo waiting me he) ---------- */}
      {pendingCount > 0 && (
        <div className="mt-2.5 rounded-lg border border-border/70 bg-card/60 p-3 text-xs">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <Clock className="size-3.5 text-amber-500" aria-hidden />
              <span>
                {pendingCount} Chunk(s) Waiting Me Hain ({remaining} baki)
              </span>
            </div>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-secondary-foreground">
              {waitingInfo.badge}
            </span>
          </div>
          <div className="text-muted-foreground leading-relaxed">
            <strong className="text-foreground font-semibold">{waitingInfo.title}: </strong>
            {waitingInfo.reason}
          </div>
        </div>
      )}

      {/* ---------- Visual Minute Chunk Grid ---------- */}
      <div className="mt-3.5 flex flex-wrap gap-1" role="list" aria-label="Movie minute blocks">
        {chunks.map((c) => {
          if (!c) return null
          const worker = c.status === 'scanning' ? getActiveChunkWorkerInfo(scan, c) : null
          const tooltip = `Minute ${c.index + 1} (${fmtTime(c.index * 60)}–${fmtTime((c.index + 1) * 60)}) — ${c.status}${
            worker ? ` · ${worker.modelName}${worker.keyIdxStr ? ` · ${worker.keyIdxStr}` : ''}` : c.model ? ` · ${displayModelName(c.model)}` : ''
          }${c.status === 'pending' ? ' (Waiting in queue)' : ''}${c.status === 'match' ? ' (Match found)' : ''}${
            c.skippedEarlyStop ? ' (Early-stop saved)' : ''
          }`

          return (
            <div
              key={c.index}
              role="listitem"
              title={tooltip}
              className={`h-5 w-5 rounded-sm ${STATUS_CLASS[c.status] || 'bg-muted'} transition-all duration-200 hover:scale-125 hover:ring-2 hover:ring-primary/50`}
            />
          )
        })}
      </div>

      {/* ---------- Legend with Live Counts ---------- */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <LegendDot cls="bg-muted border border-border/60" label="pending" count={pendingCount} />
        <LegendDot cls="bg-primary animate-pulse" label="scanning" count={scanningCount} />
        <LegendDot cls="bg-success/70" label="no match" count={noMatchCount} />
        <LegendDot cls="bg-destructive" label="match" count={matchCount} />
        {failedCount > 0 && <LegendDot cls="bg-destructive/80" label="failed" count={failedCount} />}
        {cancelledCount > 0 && <LegendDot cls="bg-muted/40" label="skipped" count={cancelledCount} />}
      </div>
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
