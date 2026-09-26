'use client'

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useSWRConfig } from 'swr'
import { CheckSquare, Copy, ListChecks, Loader2, Play } from 'lucide-react'
import type { Scan } from '@/lib/types'
import { fmtTime } from '@/lib/format'
import { chunkOverlapsSegRange, segMovieRange } from '@/lib/segment-range'

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

function toHms(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`
}

interface RangeText {
  start: string
  end: string
}

/** Mini dual-thumb slider (same style as the movie trim bar) so each minute's
 *  movie search range can be DRAGGED instead of typed. Slider ↔ text inputs
 *  stay in sync both ways. */
function MiniRangeSlider({
  min,
  max,
  start,
  end,
  disabled,
  label,
  onChange,
}: {
  min: number
  max: number
  start: number
  end: number
  disabled?: boolean
  label: string
  onChange: (start: number, end: number) => void
}) {
  const barRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<'start' | 'end' | null>(null)
  const span = Math.max(1, max - min)

  function posToSeconds(clientX: number): number {
    const bar = barRef.current
    if (!bar) return min
    const rect = bar.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return min + frac * span
  }

  function applyDrag(sec: number, which: 'start' | 'end') {
    if (which === 'start') {
      onChange(Math.min(Math.max(min, sec), end - 1), end)
    } else {
      onChange(start, Math.max(Math.min(max, sec), start + 1))
    }
  }

  function onPointerDown(e: ReactPointerEvent) {
    if (disabled) return
    const sec = posToSeconds(e.clientX)
    const which: 'start' | 'end' = Math.abs(sec - start) <= Math.abs(sec - end) ? 'start' : 'end'
    dragRef.current = which
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    applyDrag(sec, which)
  }

  function onPointerMove(e: ReactPointerEvent) {
    if (!dragRef.current || disabled) return
    applyDrag(posToSeconds(e.clientX), dragRef.current)
  }

  function onPointerUp() {
    dragRef.current = null
  }

  const startPct = ((Math.min(Math.max(start, min), max) - min) / span) * 100
  const endPct = ((Math.min(Math.max(end, min), max) - min) / span) * 100

  return (
    <div
      ref={barRef}
      role="group"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={`relative h-5 touch-none select-none rounded bg-muted ${
        disabled ? 'opacity-50' : 'cursor-ew-resize'
      }`}
    >
      <div
        className="absolute inset-y-0 rounded-sm bg-primary/30 ring-1 ring-primary/60"
        style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
        aria-hidden
      />
      <div
        role="slider"
        aria-label={`${label} — from`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={start}
        aria-valuetext={toHms(start)}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (disabled) return
          if (e.key === 'ArrowLeft') applyDrag(start - 5, 'start')
          if (e.key === 'ArrowRight') applyDrag(start + 5, 'start')
        }}
        className="absolute top-1/2 z-10 h-6 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow focus:outline-none focus:ring-2 focus:ring-ring"
        style={{ left: `${startPct}%` }}
      />
      <div
        role="slider"
        aria-label={`${label} — to`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={end}
        aria-valuetext={toHms(end)}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (disabled) return
          if (e.key === 'ArrowLeft') applyDrag(end - 5, 'end')
          if (e.key === 'ArrowRight') applyDrag(end + 5, 'end')
        }}
        className="absolute top-1/2 z-10 h-6 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow focus:outline-none focus:ring-2 focus:ring-ring"
        style={{ left: `${endPct}%` }}
      />
    </div>
  )
}

/** Short-video minute selection: pick exactly which minutes of the SHORT get
 *  scanned (any combination) — unselected minutes are skipped and save API
 *  quota. PLUS: each minute can get its OWN movie search range (from–to), so
 *  only movie chunks inside that range are scanned for that minute — big
 *  quota saver. "Same for all" copies one range to every minute. */
export function MinuteSelectPanel({ scan, running, refresh }: { scan: Scan; running: boolean; refresh: () => void }) {
  const segs = scan.shortSegments || []
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [ranges, setRanges] = useState<Record<number, RangeText>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { mutate } = useSWRConfig()

  const trimStart = scan.movieTrimStart ?? 0
  const trimEnd = scan.movieTrimEnd ?? scan.movieDuration ?? 0

  /** Server-side range text for one segment ('' = full window). */
  function serverRangeText(segIndex: number): RangeText {
    const seg = segs.find((s) => s.index === segIndex)
    if (!seg) return { start: '', end: '' }
    const r = segMovieRange(scan, seg)
    return r.custom ? { start: toHms(r.start), end: toHms(r.end) } : { start: '', end: '' }
  }

  const selectionSignature = segs.map((s) => (s.selected === false ? '0' : '1')).join('')
  const rangeSignature = segs.map((s) => `${s.movieRangeStart ?? ''}-${s.movieRangeEnd ?? ''}`).join('|')

  // Sync local selection + ranges from the server state whenever the scan changes.
  useEffect(() => {
    setPicked(new Set(segs.filter((s) => s.selected !== false).map((s) => s.index)))
    const next: Record<number, RangeText> = {}
    for (const s of segs) next[s.index] = serverRangeText(s.index)
    setRanges(next)
    // serverRangeText derives only from these stable scan/segment signatures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan.id, segs.length, selectionSignature, rangeSignature])

  if (segs.length <= 1) return null

  const serverSelected = new Set(segs.filter((s) => s.selected !== false).map((s) => s.index))
  const rangesDirty = segs.some((s) => {
    const srv = serverRangeText(s.index)
    const loc = ranges[s.index] || { start: '', end: '' }
    return srv.start !== loc.start || srv.end !== loc.end
  })
  const dirty = picked.size !== serverSelected.size || [...picked].some((i) => !serverSelected.has(i)) || rangesDirty
  const doneCount = segs.filter((s) => s.status === 'done').length
  const remaining = segs.filter(
    (s) =>
      s.status !== 'done' ||
      (s.chunks || []).some(
        (c) => c.status === 'pending' || (c.status === 'cancelled' && chunkOverlapsSegRange(scan, s, c.index)),
      ),
  )
  const unselectedRemaining = remaining.filter((s) => s.selected === false)

  function toggle(i: number) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  function setRange(i: number, field: keyof RangeText, value: string) {
    setRanges((prev) => ({ ...prev, [i]: { ...(prev[i] || { start: '', end: '' }), [field]: value } }))
  }

  /** Current numeric range for a minute's slider — falls back to the full
   *  scanned movie window when a text box is empty or invalid. */
  function numericRange(i: number): { start: number; end: number } {
    const r = ranges[i] || { start: '', end: '' }
    const s = r.start.trim() !== '' ? parseTimeInput(r.start) : null
    const e = r.end.trim() !== '' ? parseTimeInput(r.end) : null
    let start = s !== null && Number.isFinite(s) ? s : trimStart
    let end = e !== null && Number.isFinite(e) ? e : trimEnd
    start = Math.min(Math.max(trimStart, start), trimEnd)
    end = Math.min(Math.max(trimStart, end), trimEnd)
    if (end <= start) {
      start = trimStart
      end = trimEnd
    }
    return { start, end }
  }

  /** Slider drag → write both text boxes (rounded to whole seconds). Dragging
   *  to the full window clears the boxes back to "poori movie" mode. */
  function setRangeFromSlider(i: number, start: number, end: number) {
    const s = Math.round(start)
    const e = Math.round(end)
    const isFull = s <= Math.round(trimStart) && e >= Math.round(trimEnd)
    setRanges((prev) => ({
      ...prev,
      [i]: isFull ? { start: '', end: '' } : { start: toHms(s), end: toHms(e) },
    }))
  }

  /** Copy the first picked minute's range to ALL minutes ("same for all"). */
  function copyToAll() {
    const source = [...picked].sort((a, b) => a - b)[0] ?? segs[0].index
    const src = ranges[source] || { start: '', end: '' }
    setRanges((prev) => {
      const next: Record<number, RangeText> = { ...prev }
      for (const s of segs) next[s.index] = { ...src }
      return next
    })
  }

  /** Parse + validate all range inputs → API payload. Returns null on error. */
  function buildRangesPayload(): { index: number; start: number | null; end: number | null }[] | null {
    const out: { index: number; start: number | null; end: number | null }[] = []
    for (const s of segs) {
      const r = ranges[s.index] || { start: '', end: '' }
      const hasStart = r.start.trim() !== ''
      const hasEnd = r.end.trim() !== ''
      if (!hasStart && !hasEnd) {
        out.push({ index: s.index, start: null, end: null })
        continue
      }
      const start = hasStart ? parseTimeInput(r.start) : trimStart
      const end = hasEnd ? parseTimeInput(r.end) : trimEnd
      if (start === null || end === null) {
        setError(`Minute ${s.index + 1}: movie range time samajh nahi aaya — HH:MM:SS ya MM:SS format use karo`)
        return null
      }
      if (end <= start) {
        setError(`Minute ${s.index + 1}: movie range "To" time "From" ke baad hona chahiye`)
        return null
      }
      if (end <= trimStart || start >= trimEnd) {
        setError(`Minute ${s.index + 1}: movie range scanned window (${toHms(trimStart)}–${toHms(trimEnd)}) ke bahar hai`)
        return null
      }
      out.push({ index: s.index, start, end })
    }
    return out
  }

  async function apply(indexes: number[], thenResume = false) {
    setError(null)
    const rangesPayload = buildRangesPayload()
    if (!rangesPayload) return
    setBusy(true)
    try {
      const res = await fetch(`/api/scans/${scan.id}/segments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected: indexes, ranges: rangesPayload }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError(j.error || 'Failed to update minute selection')
        return
      }
      if (thenResume) {
        const r2 = await fetch(`/api/scans/${scan.id}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resume: true }),
        })
        if (!r2.ok) {
          const j = await r2.json().catch(() => ({}))
          setError(j.error || 'Selection saved, but the scan could not start')
        }
      }
      void mutate(`/api/scans/${scan.id}`)
      refresh()
    } catch {
      setError('Network error — try again')
    } finally {
      setBusy(false)
    }
  }

  /** Scan remaining: select ALL minutes that still have work (keeping finished
   *  ones as-is) and resume — results merge into this same scan. */
  function scanRemaining() {
    const indexes = new Set<number>([...segs.filter((s) => s.status === 'done').map((s) => s.index), ...remaining.map((s) => s.index)])
    void apply([...indexes], true)
  }

  return (
    <section aria-label="Short minute selection" className="panel">
      <div className="flex flex-wrap items-center gap-2">
        <ListChecks className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Short Minutes — Kaunse Minute Scan Karne Hain?</h2>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px]">
          {picked.size}/{segs.length} selected
        </span>
        {doneCount > 0 && (
          <span className="rounded-full bg-success/15 px-2 py-0.5 font-mono text-[10px] text-success">{doneCount} done</span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Sirf selected minutes ke chunks par scan chalega — baaki skip ho kar API quota bachega. Har minute ke neeche
        slider kheench kar movie ka search range (From–To) select karo — bilkul waise hi jaise movie upload ke baad trim
        hota hai. Chaaho to exact time type bhi kar sakte ho. Poora slider = poori movie window. &quot;Same for
        all&quot; se ek range sab minutes par lag jayegi.
      </p>

      <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2 md:grid-cols-3" role="group" aria-label="Minute selection with movie ranges">
        {segs.map((seg) => {
          const checked = picked.has(seg.index)
          const isDone = seg.status === 'done'
          const r = ranges[seg.index] || { start: '', end: '' }
          const hasRange = r.start.trim() !== '' || r.end.trim() !== ''
          return (
            <div
              key={seg.index}
              className={`rounded-md border px-2.5 py-2 text-xs transition-colors ${
                checked ? 'border-primary bg-primary/10' : 'border-input'
              } ${running ? 'opacity-60' : ''}`}
            >
              <label className={`flex items-center gap-2 ${running ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={running || busy}
                  onChange={() => toggle(seg.index)}
                  className="size-3.5 accent-primary"
                />
                <span className="flex flex-col">
                  <span className="font-medium">Minute {seg.index + 1}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {fmtTime(seg.start)}–{fmtTime(seg.end)}
                  </span>
                </span>
                {isDone && (
                  <span className="ml-auto text-[10px] text-success" title="Scanned + verified">
                    ✓
                  </span>
                )}
                {(seg.status === 'scanning' || seg.status === 'verifying') && (
                  <span className="ml-auto inline-block size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
                )}
              </label>

              <div className="mt-2 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className={`text-[10px] ${hasRange ? 'text-primary' : 'text-muted-foreground'}`}>
                    Movie range {hasRange ? '' : '(poori movie)'}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {toHms(numericRange(seg.index).start)}–{toHms(numericRange(seg.index).end)}
                  </span>
                </div>
                <MiniRangeSlider
                  min={trimStart}
                  max={trimEnd}
                  start={numericRange(seg.index).start}
                  end={numericRange(seg.index).end}
                  disabled={running || busy}
                  label={`Minute ${seg.index + 1} movie search range`}
                  onChange={(s, e) => setRangeFromSlider(seg.index, s, e)}
                />
              </div>

              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  type="text"
                  inputMode="numeric"
                  value={r.start}
                  disabled={running || busy}
                  onChange={(e) => setRange(seg.index, 'start', e.target.value)}
                  placeholder={toHms(trimStart)}
                  aria-label={`Minute ${seg.index + 1}: movie search from (HH:MM:SS)`}
                  className="w-full min-w-0 rounded border border-input bg-background px-1.5 py-1 font-mono text-[10px] focus:border-primary focus:outline-none disabled:opacity-50"
                />
                <span className="text-[10px] text-muted-foreground">–</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={r.end}
                  disabled={running || busy}
                  onChange={(e) => setRange(seg.index, 'end', e.target.value)}
                  placeholder={toHms(trimEnd)}
                  aria-label={`Minute ${seg.index + 1}: movie search to (HH:MM:SS)`}
                  className="w-full min-w-0 rounded border border-input bg-background px-1.5 py-1 font-mono text-[10px] focus:border-primary focus:outline-none disabled:opacity-50"
                />
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setPicked(new Set(segs.map((s) => s.index)))}
          disabled={running || busy}
          className="flex items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-40"
        >
          <CheckSquare className="size-3.5" aria-hidden /> Select All
        </button>
        <button
          type="button"
          onClick={() => setPicked(new Set())}
          disabled={running || busy}
          className="rounded-md border border-input px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-40"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={copyToAll}
          disabled={running || busy}
          title="Pehle selected minute ki movie range sab minutes par copy karo"
          className="flex items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-40"
        >
          <Copy className="size-3.5" aria-hidden /> Same for all
        </button>
        <button
          type="button"
          onClick={() => void apply([...picked])}
          disabled={running || busy || picked.size === 0 || !dirty}
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          Apply selection
        </button>
        {unselectedRemaining.length > 0 && !running && (
          <button
            type="button"
            onClick={scanRemaining}
            disabled={busy}
            title={`Bache hue ${unselectedRemaining.length} minute(s) ko isi scan me scan karo — results merge honge`}
            className="ml-auto flex items-center gap-1.5 rounded-md border border-primary/50 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-40"
          >
            <Play className="size-3.5" aria-hidden /> Scan remaining ({unselectedRemaining.length})
          </button>
        )}
      </div>

      {dirty && !running && !busy && (
        <p role="alert" className="mt-2 rounded-md border border-warning/50 bg-warning/10 px-2.5 py-1.5 text-xs font-medium text-warning">
          Changes abhi SAVE nahi hue — scan start karne se pehle &quot;Apply selection&quot; zaroor dabao, warna scan
          purani setting (ya poori movie) par chalega.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
