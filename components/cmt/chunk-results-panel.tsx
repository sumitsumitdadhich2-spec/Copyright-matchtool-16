'use client'

import { useEffect, useState } from 'react'
import { useSWRConfig } from 'swr'
import { ChevronDown, ChevronRight, Clock3, FileText, RotateCcw } from 'lucide-react'
import type { Scan, ChunkState } from '@/lib/types'
import { fmtTime } from '@/lib/format'
import { displayModelName } from '@/lib/models'

const CHUNK_SECONDS = 60

/** Chunks to display for a selected short minute: the active minute is mirrored
 *  into scan.chunks (live states); other minutes come from shortSegments[i].chunks. */
function chunksForSegment(scan: Scan, segIdx: number): ChunkState[] {
  const segs = scan.shortSegments
  if (!segs || segs.length === 0) return scan.chunks || []
  if (segIdx === (scan.currentShortSegment ?? 0)) return scan.chunks || segs[segIdx]?.chunks || []
  return segs[segIdx]?.chunks ?? []
}

export function ChunkResultsPanel({ scan }: { scan: Scan }) {
  const segs = scan.shortSegments || []
  const multi = segs.length > 1
  const [selected, setSelected] = useState<number | null>(null)
  const activeSeg = scan.currentShortSegment ?? 0
  const segIdx = selected ?? activeSeg

  useEffect(() => {
    setSelected(null)
  }, [scan.id, segs.length])

  const chunks = chunksForSegment(scan, segIdx) || []
  const visible = chunks.filter(
    (c) => c && (c.status !== 'pending' || (c.matches?.length ?? 0) > 0 || (c.rawOutputs?.length ?? 0) > 0),
  )
  if (visible.length === 0 && !multi) return null

  return (
    <section aria-label="Chunk timeline results" className="panel">
      <div className="flex flex-wrap items-center gap-2">
        <Clock3 className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Chunk Timeline — Matches Per Minute</h2>
        {multi && (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[10px] text-primary">
            short minute {segIdx + 1}/{segs.length}
          </span>
        )}
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {visible.length}/{scan.chunkCount} chunk(s)
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Har movie minute ke liye ek hi AI call: short video + wo chunk. HISSA 2 ki matched lines yahan dikhti
        hain (movie time global hai), aur full raw output arrow se dekh sakte ho.
      </p>

      {multi && (
        <div className="mt-2 flex flex-wrap gap-1.5" role="tablist" aria-label="Short video minutes">
          {segs.map((seg) => {
            const isSel = seg.index === segIdx
            return (
              <button
                key={seg.index}
                type="button"
                role="tab"
                aria-selected={isSel}
                onClick={() => setSelected(seg.index === activeSeg ? null : seg.index)}
                title={`Short ${fmtTime(seg.start)}–${fmtTime(seg.end)} — ${seg.status}`}
                className={`flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-mono text-[10px] transition-colors ${
                  isSel
                    ? 'border-primary bg-primary/15 text-primary'
                    : 'border-input text-muted-foreground hover:bg-secondary'
                }`}
              >
                Min {seg.index + 1}
                {seg.status === 'done' && <span className="text-success" aria-hidden>✓</span>}
                {(seg.status === 'scanning' || seg.status === 'verifying') && (
                  <span className="inline-block size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
                )}
              </button>
            )
          })}
        </div>
      )}

      {visible.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">Is minute ke liye abhi koi chunk result nahi hai.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-1.5">
          {visible.map((c) => (
            <ChunkRow key={c.index} scan={scan} chunk={c} segIdx={multi ? segIdx : undefined} />
          ))}
        </div>
      )}
    </section>
  )
}

function ChunkRow({ scan, chunk, segIdx }: { scan: Scan; chunk: ChunkState; segIdx?: number }) {
  const [open, setOpen] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  const { mutate } = useSWRConfig()
  // TRIM OFFSET: chunks cover ONLY the confirmed trim range, so absolute
  // original-movie time = trimStart + index * 60 (capped at trimEnd).
  const trimStart = scan.movieTrimStart ?? 0
  const rangeEnd = scan.movieTrimEnd ?? scan.movieDuration ?? Number.POSITIVE_INFINITY
  const base = trimStart + chunk.index * CHUNK_SECONDS
  const end = Math.min(base + CHUNK_SECONDS, rangeEnd)
  const matches = chunk.matches || []
  const raws = chunk.rawOutputs || []
  const scanning = chunk.status === 'scanning'
  // RESCAN LOCK (UI): retry stays disabled while ANY candidate group is still
  // pending/verifying/rescanning — verification queue must fully drain first.
  const pendingVerify = (scan.candidateGroups || []).filter(
    (g) => g.status === 'pending' || g.status === 'verifying' || g.status === 'rescanning',
  ).length
  const isFailed = chunk.status === 'failed' || chunk.status === 'policy_blocked'
  const isPolicyBlocked = chunk.status === 'policy_blocked'
  const canRetry = !scanning && chunk.status !== 'pending' && (isFailed || pendingVerify === 0)
  const retryTitle = isPolicyBlocked
    ? 'Google Policy Blocked chunk — manual retry if needed'
    : isFailed
      ? 'Is failed chunk ko dobara queue me daal kar rescan karo'
      : pendingVerify > 0
        ? `Verification in progress — ${pendingVerify} candidate group(s) pending. Rescan tabhi milega jab saare candidates verify ho jayen.`
        : 'Is chunk ko dobara chunk models se map karwao'

  async function retry() {
    if (retrying) return
    setRetrying(true)
    setRetryError(null)
    try {
      const segParam = segIdx !== undefined ? `?segment=${segIdx}` : ''
      const res = await fetch(`/api/scans/${scan.id}/chunks/${chunk.index}/retry${segParam}`, { method: 'POST' })
      const j = (await res.json()) as { ok: boolean; error?: string }
      if (!j.ok) setRetryError(j.error || 'Retry failed')
      void mutate(`/api/scans/${scan.id}`)
    } catch {
      setRetryError('Retry failed — network error')
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="rounded-md border border-border bg-background">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="font-mono text-xs font-semibold text-foreground">
          {fmtTime(base)} – {fmtTime(end)}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">chunk {chunk.index}</span>
        {scanning && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">scanning…</span>}
        {chunk.status === 'no_match' && matches.length === 0 && (
          <span className="text-[11px] text-muted-foreground">no matches in this minute</span>
        )}
        {chunk.status === 'failed' && <span className="text-[11px] text-destructive">failed</span>}
        {chunk.status === 'policy_blocked' && (
          <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-500">
            Flagged by Google Policy (PROHIBITED_CONTENT)
          </span>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {matches.map((f, i) => (
            <span
              key={`${f.shortStart}-${f.movieStart}-${i}`}
              title={`Short ${fmtTime(f.shortStart)}–${fmtTime(f.shortEnd)} → Movie ${fmtTime(f.movieStart)}–${fmtTime(f.movieEnd)} · ${displayModelName(f.model)}`}
              className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/15 px-2 py-0.5 font-mono text-[10px] text-primary"
            >
              {fmtTime(f.shortStart)}–{fmtTime(f.shortEnd)}
              <span aria-hidden>→</span>
              <span className="font-semibold">
                {fmtTime(f.movieStart)}–{fmtTime(f.movieEnd)}
              </span>
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void retry()}
          disabled={!canRetry || retrying}
          title={retryTitle}
          className="ml-auto flex items-center gap-1 rounded-md border border-input px-2 py-1 text-[11px] font-medium hover:bg-secondary disabled:opacity-30"
        >
          <RotateCcw className={`size-3.5 ${retrying ? 'animate-spin' : ''}`} aria-hidden />
          {retrying ? 'Retrying…' : isFailed ? 'Retry failed' : pendingVerify > 0 ? `Verify pending (${pendingVerify})` : 'Retry'}
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={raws.length === 0}
          aria-expanded={open}
          className="flex items-center gap-1 rounded-md border border-input px-2 py-1 text-[11px] font-medium hover:bg-secondary disabled:opacity-30"
        >
          {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
          AI output {raws.length > 0 ? `(${raws.length})` : ''}
        </button>
      </div>
      {retryError && (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-destructive" role="alert">
          {retryError}
        </p>
      )}
      {open && raws.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
          {raws.map((r, i) => (
            <div key={`${r.t}-${i}`} className="rounded-md border border-border bg-card">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1">
                <FileText className="size-3.5 text-muted-foreground" aria-hidden />
                <span className="font-mono text-[10px] text-muted-foreground">{displayModelName(r.model)}</span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {new Date(r.t).toLocaleTimeString()}
                </span>
              </div>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-[10px] leading-relaxed text-foreground">
                {r.text}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
