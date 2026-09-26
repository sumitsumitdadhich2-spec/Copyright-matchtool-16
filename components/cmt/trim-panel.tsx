'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useSWRConfig } from 'swr'
import { Loader2, Scissors, SkipForward } from 'lucide-react'
import type { Scan } from '@/lib/types'
import { fmtTime } from '@/lib/format'

const CHUNK_SECONDS = 60

/** Parse "HH:MM:SS", "MM:SS" or plain seconds into seconds. Returns null when invalid. */
function parseTimeInput(v: string): number | null {
  const t = v.trim()
  if (!t) return null
  const parts = t.split(':').map((p) => p.trim())
  if (parts.some((p) => p === '' || !/^\d+(\.\d+)?$/.test(p))) return null
  if (parts.length === 1) return Number(parts[0])
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1])
  if (parts.length === 3) return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2])
  return null
}

/** Format seconds as HH:MM:SS for the inputs. */
function toHms(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/** Movie trim bar: shown right after the movie upload, BEFORE chunking.
 *  Select just the range that holds your scene — FFmpeg cuts ONLY that range
 *  into chunks (stream copy, zero quality loss) and the scan spends API quota
 *  ONLY on it. Skipping the trim scans the full movie as before. */
export function TrimPanel({ scan, refresh }: { scan: Scan; refresh: () => void }) {
  const dur = scan.movieDuration || 0
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(dur)
  const [startText, setStartText] = useState(toHms(0))
  const [endText, setEndText] = useState(toHms(dur))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<'start' | 'end' | null>(null)
  const { mutate } = useSWRConfig()

  // Re-init when a different movie arrives.
  useEffect(() => {
    setStart(0)
    setEnd(dur)
    setStartText(toHms(0))
    setEndText(toHms(dur))
  }, [scan.id, dur])

  const rangeDur = Math.max(0, end - start)
  const isFull = start <= 0.5 && end >= dur - 0.5
  const chunkEstimate = Math.max(1, Math.ceil(rangeDur / CHUNK_SECONDS))

  // ---- Slider (dual-thumb) sync: slider drag → numbers, numbers → slider ----
  const setStartSynced = useCallback(
    (v: number, maxEnd: number) => {
      const clamped = Math.min(Math.max(0, v), maxEnd - 1)
      setStart(clamped)
      setStartText(toHms(clamped))
    },
    [],
  )
  const setEndSynced = useCallback(
    (v: number, minStart: number) => {
      const clamped = Math.max(Math.min(dur, v), minStart + 1)
      setEnd(clamped)
      setEndText(toHms(clamped))
    },
    [dur],
  )

  function posToSeconds(clientX: number): number {
    const bar = barRef.current
    if (!bar || dur <= 0) return 0
    const rect = bar.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return frac * dur
  }

  function onBarPointerDown(e: ReactPointerEvent) {
    if (dur <= 0) return
    const sec = posToSeconds(e.clientX)
    // Grab whichever thumb is closer.
    const which: 'start' | 'end' = Math.abs(sec - start) <= Math.abs(sec - end) ? 'start' : 'end'
    dragRef.current = which
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    applyDrag(sec, which)
  }

  function applyDrag(sec: number, which: 'start' | 'end') {
    if (which === 'start') {
      setStartSynced(sec, end)
      seekPreview(Math.min(sec, end - 1))
    } else {
      setEndSynced(sec, start)
      seekPreview(Math.max(sec, start + 1))
    }
  }

  function onBarPointerMove(e: ReactPointerEvent) {
    if (!dragRef.current) return
    applyDrag(posToSeconds(e.clientX), dragRef.current)
  }

  function onBarPointerUp() {
    dragRef.current = null
  }

  function seekPreview(sec: number) {
    const v = videoRef.current
    if (v && Number.isFinite(sec)) v.currentTime = Math.min(Math.max(0, sec), dur)
  }

  // ---- Time inputs: type exact HH:MM:SS, always kept in sync with the slider ----
  function commitStartText(v: string) {
    const sec = parseTimeInput(v)
    if (sec === null || sec < 0 || sec >= end) {
      setStartText(toHms(start)) // revert invalid input
      return
    }
    setStartSynced(sec, end)
    seekPreview(sec)
  }

  function commitEndText(v: string) {
    const sec = parseTimeInput(v)
    if (sec === null || sec <= start || sec > dur + 0.5) {
      setEndText(toHms(end))
      return
    }
    setEndSynced(Math.min(sec, dur), start)
    seekPreview(Math.min(sec, dur))
  }

  async function confirm(full: boolean) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/scans/${scan.id}/trim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(full ? {} : { start, end }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError(j.error || 'Failed to confirm trim')
      } else {
        void mutate(`/api/scans/${scan.id}`)
        refresh()
      }
    } catch {
      setError('Failed to confirm trim — network error')
    } finally {
      setBusy(false)
    }
  }

  const startPct = dur > 0 ? (start / dur) * 100 : 0
  const endPct = dur > 0 ? (end / dur) * 100 : 100

  const markers = useMemo(() => {
    if (dur <= 0) return []
    const stepCount = 6
    return Array.from({ length: stepCount + 1 }, (_, i) => (dur * i) / stepCount)
  }, [dur])

  return (
    <section aria-label="Movie trim" className="panel border-primary/40">
      <div className="flex flex-wrap items-center gap-2">
        <Scissors className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Trim Movie — Sirf Apna Scene Wala Hissa Scan Karo</h2>
        <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[10px] text-primary">
          API quota saver
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Slider kheencho ya exact time type karo (HH:MM:SS) — FFmpeg sirf selected range ko stream-copy se chunks me
        kaatega (zero quality loss). Matches ke movie timestamps hamesha ORIGINAL movie ke time me hi report honge.
        Trim optional hai — skip karke poori movie bhi scan kar sakte ho.
      </p>

      <video
        ref={videoRef}
        src={`/api/scans/${scan.id}/media?kind=movie`}
        controls
        preload="metadata"
        playsInline
        className="mt-3 aspect-video w-full rounded-md border border-border bg-black object-contain"
      />

      {/* ---- Dual-thumb trim bar ---- */}
      <div className="mt-3">
        <div
          ref={barRef}
          role="group"
          aria-label="Trim range slider"
          onPointerDown={onBarPointerDown}
          onPointerMove={onBarPointerMove}
          onPointerUp={onBarPointerUp}
          onPointerCancel={onBarPointerUp}
          className="relative h-8 cursor-ew-resize touch-none select-none rounded-md bg-muted"
        >
          {/* selected range fill */}
          <div
            className="absolute inset-y-0 rounded-sm bg-primary/30 ring-1 ring-primary/60"
            style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
            aria-hidden
          />
          {/* start thumb */}
          <div
            role="slider"
            aria-label="Trim start"
            aria-valuemin={0}
            aria-valuemax={dur}
            aria-valuenow={start}
            aria-valuetext={toHms(start)}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') setStartSynced(start - 1, end)
              if (e.key === 'ArrowRight') setStartSynced(start + 1, end)
            }}
            className="absolute top-1/2 z-10 h-9 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow focus:outline-none focus:ring-2 focus:ring-ring"
            style={{ left: `${startPct}%` }}
          />
          {/* end thumb */}
          <div
            role="slider"
            aria-label="Trim end"
            aria-valuemin={0}
            aria-valuemax={dur}
            aria-valuenow={end}
            aria-valuetext={toHms(end)}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') setEndSynced(end - 1, start)
              if (e.key === 'ArrowRight') setEndSynced(end + 1, start)
            }}
            className="absolute top-1/2 z-10 h-9 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow focus:outline-none focus:ring-2 focus:ring-ring"
            style={{ left: `${endPct}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground" aria-hidden>
          {markers.map((m, i) => (
            <span key={i}>{fmtTime(m)}</span>
          ))}
        </div>
      </div>

      {/* ---- Exact time inputs + live stats ---- */}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Start time (HH:MM:SS)</span>
          <input
            type="text"
            inputMode="numeric"
            value={startText}
            onChange={(e) => setStartText(e.target.value)}
            onBlur={(e) => commitStartText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !(e.nativeEvent.isComposing || e.keyCode === 229)) commitStartText(startText)
            }}
            className="w-28 rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">End time (HH:MM:SS)</span>
          <input
            type="text"
            inputMode="numeric"
            value={endText}
            onChange={(e) => setEndText(e.target.value)}
            onBlur={(e) => commitEndText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !(e.nativeEvent.isComposing || e.keyCode === 229)) commitEndText(endText)
            }}
            className="w-28 rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs"
          />
        </label>
        <div className="flex flex-col gap-0.5 text-xs">
          <span className="text-muted-foreground">Selected range</span>
          <span className="font-mono font-semibold">
            {fmtTime(rangeDur)} · ~{chunkEstimate} chunk(s)
            {isFull ? ' (full movie)' : ''}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void confirm(false)}
            disabled={busy || rangeDur < 1}
            className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground disabled:opacity-40"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Scissors className="size-3.5" aria-hidden />}
            Confirm Trim ({chunkEstimate} chunk{chunkEstimate > 1 ? 's' : ''})
          </button>
          <button
            type="button"
            onClick={() => void confirm(true)}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-xs font-medium hover:bg-secondary disabled:opacity-40"
          >
            <SkipForward className="size-3.5" aria-hidden />
            Skip — Full Movie ({Math.max(1, Math.ceil(dur / CHUNK_SECONDS))} chunks)
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
