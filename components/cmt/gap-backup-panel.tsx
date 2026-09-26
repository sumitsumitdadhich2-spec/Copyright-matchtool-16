'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Circle, Loader2, Pause, Play, Plus, RotateCcw, Search, Square, Trash2, X } from 'lucide-react'
import type { GapBackupCandidate, GapBackupRequest, GapBackupState, Scan, ShortCoverage, ShortRange } from '@/lib/types'
import { fetcher, fmtDuration, fmtTime } from '@/lib/format'
import { displayModelName, GAP_FINDER_AVAILABLE_MODELS } from '@/lib/models'

interface GapResponse {
  coverage: ShortCoverage
  gaps: ShortRange[]
  state: GapBackupState
  running: boolean
}

const PHASES = [
  { key: 'cutting', label: 'Prepare clips' },
  { key: 'uploading', label: 'Upload' },
  { key: 'searching', label: 'Chunk batches' },
  { key: 'awaiting_review', label: 'Review' },
  { key: 'done', label: 'Done' },
] as const

function requestTone(status: GapBackupRequest['status']) {
  if (status === 'done') return 'bg-success/15 text-success'
  if (status === 'failed') return 'bg-destructive/15 text-destructive'
  if (status === 'running' || status === 'uploading') return 'bg-primary/15 text-primary'
  return 'bg-muted text-muted-foreground'
}

function ReviewCandidate({ scanId, candidate, onReview }: { scanId: string; candidate: GapBackupCandidate; onReview: (id: string, action: 'accept' | 'reject') => void }) {
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const shortRef = useRef<HTMLVideoElement>(null)
  const movieRef = useRef<HTMLVideoElement>(null)
  const shortSrc = `/api/scans/${scanId}/media?kind=short`
  const movieSrc = `/api/scans/${scanId}/media?kind=movie`
  const shortDuration = candidate.shortEnd - candidate.shortStart

  function pauseBoth(reset = false) {
    const shortVideo = shortRef.current
    const movieVideo = movieRef.current
    shortVideo?.pause()
    movieVideo?.pause()
    if (reset) {
      if (shortVideo) {
        try { shortVideo.currentTime = candidate.shortStart } catch {}
      }
      if (movieVideo) {
        try { movieVideo.currentTime = candidate.movieStart } catch {}
      }
    }
    setPlaying(false)
  }

  useEffect(() => {
    pauseBoth(true)
  }, [candidate.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function relativeTime(video: HTMLVideoElement, start: number) {
    return Math.max(0, video.currentTime - start)
  }

  function seekToSharedPosition() {
    const shortVideo = shortRef.current
    const movieVideo = movieRef.current
    if (!shortVideo || !movieVideo) return
    const shortPosition = relativeTime(shortVideo, candidate.shortStart)
    const moviePosition = relativeTime(movieVideo, candidate.movieStart)
    const shortInRange = shortVideo.currentTime >= candidate.shortStart - 0.05 && shortVideo.currentTime < candidate.shortEnd - 0.05
    const movieInRange = movieVideo.currentTime >= candidate.movieStart - 0.05 && movieVideo.currentTime < candidate.movieEnd - 0.05
    const sharedPosition = shortInRange && movieInRange ? Math.min(shortPosition, moviePosition, shortDuration) : 0
    try {
      shortVideo.currentTime = candidate.shortStart + sharedPosition
      movieVideo.currentTime = candidate.movieStart + sharedPosition
    } catch {}
  }

  async function togglePlay() {
    const shortVideo = shortRef.current
    const movieVideo = movieRef.current
    if (!shortVideo || !movieVideo) return
    if (playing) {
      pauseBoth()
      return
    }
    seekToSharedPosition()
    try {
      await Promise.all([shortVideo.play(), movieVideo.play()])
      setPlaying(true)
    } catch {
      pauseBoth()
    }
  }

  function synchronizeFromShort() {
    const shortVideo = shortRef.current
    const movieVideo = movieRef.current
    if (!shortVideo || !movieVideo || movieVideo.seeking) return
    const position = relativeTime(shortVideo, candidate.shortStart)
    if (shortVideo.currentTime >= candidate.shortEnd - 0.02 || position >= shortDuration - 0.02) {
      pauseBoth(true)
      return
    }
    const movieTarget = candidate.movieStart + position
    if (Math.abs(movieVideo.currentTime - movieTarget) > 0.15) {
      try {
        movieVideo.currentTime = movieTarget
      } catch {}
    }
  }

  function handleNativePause() {
    if (!playing) return
    const shortVideo = shortRef.current
    const movieVideo = movieRef.current
    if (shortVideo && !shortVideo.paused) shortVideo.pause()
    if (movieVideo && !movieVideo.paused) movieVideo.pause()
    setPlaying(false)
  }

  async function review(action: 'accept' | 'reject') {
    pauseBoth()
    setBusy(true)
    await onReview(candidate.id, action)
    setBusy(false)
  }

  return (
    <article className="rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">Needs your review</span>
        <span className="font-mono text-[10px] text-muted-foreground">chunk {candidate.chunkIndex + 1} · {displayModelName(candidate.model)}</span>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 flex items-center justify-between gap-2 text-xs font-medium"><span>Short missing range</span><span className="font-mono text-muted-foreground">{fmtTime(candidate.shortStart)}–{fmtTime(candidate.shortEnd)}</span></div>
          <video ref={shortRef} preload="metadata" src={shortSrc} muted playsInline onLoadedMetadata={() => { if (shortRef.current) shortRef.current.currentTime = candidate.shortStart }} onTimeUpdate={synchronizeFromShort} onPause={handleNativePause} className="aspect-video w-full rounded-md bg-foreground/10 object-contain" aria-label="Short video missing range preview" />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between gap-2 text-xs font-medium"><span>Gemini movie candidate</span><span className="font-mono text-muted-foreground">{fmtTime(candidate.movieStart)}–{fmtTime(candidate.movieEnd)}</span></div>
          <video ref={movieRef} preload="metadata" src={movieSrc} muted playsInline onLoadedMetadata={() => { if (movieRef.current) movieRef.current.currentTime = candidate.movieStart }} onTimeUpdate={() => { if (movieRef.current && movieRef.current.currentTime >= candidate.movieEnd - 0.02) pauseBoth(true) }} onPause={handleNativePause} className="aspect-video w-full rounded-md bg-foreground/10 object-contain" aria-label="Movie candidate preview" />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void togglePlay()} className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground">
          {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          {playing ? 'Pause both' : 'Play both'}
        </button>
        <button type="button" onClick={() => pauseBoth(true)} className="flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-xs font-medium hover:bg-secondary"><RotateCcw className="size-3.5" aria-hidden /> Restart</button>
        <span className="text-xs text-muted-foreground">Synchronized from each range start</span>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground"><span className="font-semibold text-foreground">Gemini evidence:</span> {candidate.reason}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void review('accept')} disabled={busy} className="flex items-center gap-1.5 rounded-md bg-success px-3 py-2 text-xs font-medium text-success-foreground disabled:opacity-50"><Check className="size-3.5" aria-hidden /> Accept match</button>
        <button type="button" onClick={() => void review('reject')} disabled={busy} className="flex items-center gap-1.5 rounded-md border border-destructive/40 px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"><X className="size-3.5" aria-hidden /> Reject</button>
      </div>
    </article>
  )
}

function RequestRow({ request }: { request: GapBackupRequest }) {
  const shouldAutoOpen = request.status === 'uploading' || request.status === 'running' || request.status === 'failed'
  const [open, setOpen] = useState(shouldAutoOpen)
  useEffect(() => {
    if (shouldAutoOpen) setOpen(true)
    else if (request.status === 'done') setOpen(false)
  }, [request.status, shouldAutoOpen])
  const elapsed = request.finishedAt && request.startedAt ? fmtDuration(request.finishedAt - request.startedAt) : null
  return (
    <div className="rounded-md border border-border bg-background/60">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 p-2 text-left" aria-expanded={open}>
        {open ? <ChevronDown className="size-3.5 shrink-0" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0" aria-hidden />}
        <span className="font-mono text-xs">Batch {request.batch} · chunk {request.chunkIndex + 1}</span>
        <span className="hidden text-[10px] text-muted-foreground sm:inline">{fmtTime(request.chunkStart)}–{fmtTime(request.chunkEnd)}</span>
        <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium ${requestTone(request.status)}`}>{request.status}</span>
      </button>
      {open && (
        <div className="border-t border-border p-3">
          <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
            <span className="rounded bg-muted px-2 py-1">{request.lane.replace(request.model, displayModelName(request.model))}</span>
            {typeof request.tokens === 'number' && <span className="rounded bg-muted px-2 py-1">{request.tokens.toLocaleString()} tokens</span>}
            {typeof request.matches === 'number' && <span className="rounded bg-muted px-2 py-1">{request.matches} strict match(es)</span>}
            {elapsed && <span className="rounded bg-muted px-2 py-1">{elapsed}</span>}
          </div>
          {request.error && <p role="alert" className="mt-2 text-xs text-destructive">{request.error}</p>}
          <div className="mt-3">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Raw Gemini reply</p>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-foreground p-3 font-mono text-[11px] leading-relaxed text-background">{request.raw || (request.status === 'running' ? 'Gemini response ka wait ho raha hai…' : 'Abhi raw reply available nahi hai.')}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

function parseTimestampToSec(val: string): number | null {
  const clean = val.trim()
  if (!clean) return null
  if (/^\d+(\.\d+)?$/.test(clean)) return parseFloat(clean)
  const parts = clean.split(':').map((p) => parseFloat(p))
  if (parts.some((p) => isNaN(p))) return null
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return null
}

export function GapBackupPanel({ scan }: { scan: Scan }) {
  const { data, mutate } = useSWR<GapResponse>(`/api/scans/${scan.id}/gap-backup`, fetcher, { refreshInterval: 1200 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [selectedModels, setSelectedModels] = useState<string[]>(() => [
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    'gemini-3.6-flash',
  ])

  const [selectedGapKeys, setSelectedGapKeys] = useState<string[]>([])
  const [customGaps, setCustomGaps] = useState<ShortRange[]>([])
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [customError, setCustomError] = useState<string | null>(null)
  const [showCustomInput, setShowCustomInput] = useState(false)

  const preview = data ?? { coverage: scan.report?.coverage, gaps: [], state: scan.gapBackup, running: false }
  const coverage = preview.coverage
  const fallbackState: GapBackupState = { status: 'idle', parts: [], minutes: [], requests: [], candidates: [], addedMatches: [] }
  const rawState = preview.state ?? fallbackState
  const state = Array.isArray(rawState.minutes) && Array.isArray(rawState.requests) ? rawState : fallbackState
  const running = Boolean(data?.running || ['cutting', 'uploading', 'searching'].includes(state.status))
  const currentPhase = PHASES.findIndex((phase) => phase.key === state.status)
  const pending = state.candidates.filter((candidate) => candidate.review === 'pending')
  const groupedRequests = state.minutes.map((minute) => ({ minute, requests: state.requests.filter((request) => request.minuteIndex === minute.index) }))

  const allAvailableGaps = useMemo(
    () => [
      ...(coverage?.gaps || []).map((g, i) => ({
        ...g,
        key: `gap-${g.start.toFixed(2)}-${g.end.toFixed(2)}`,
        label: `Gap #${i + 1}`,
        isCustom: false,
      })),
      ...customGaps.map((g, i) => ({
        ...g,
        key: `custom-${g.start.toFixed(2)}-${g.end.toFixed(2)}`,
        label: `Custom #${i + 1}`,
        isCustom: true,
      })),
    ],
    [coverage?.gaps, customGaps],
  )

  // Initialize selected gap keys when gaps become available
  useEffect(() => {
    if (allAvailableGaps.length > 0) {
      setSelectedGapKeys((prev) => {
        const availableKeys = allAvailableGaps.map((g) => g.key)
        if (prev.length === 0) return availableKeys
        const stillValid = prev.filter((k) => availableKeys.includes(k))
        return stillValid.length > 0 ? stillValid : availableKeys
      })
    }
  }, [allAvailableGaps])

  if (!coverage || (coverage.gaps.length === 0 && state.status === 'idle')) return null

  const toggleGap = (key: string) => {
    setSelectedGapKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    )
  }

  const selectAllGaps = () => {
    setSelectedGapKeys(allAvailableGaps.map((g) => g.key))
  }

  const clearAllGaps = () => {
    setSelectedGapKeys([])
  }

  const handleAddCustomGap = () => {
    setCustomError(null)
    const s = parseTimestampToSec(customStart)
    const e = parseTimestampToSec(customEnd)
    if (s === null || e === null) {
      setCustomError('Timestamp format sahi nahi hai (e.g. 0:30 ya 1:15.5)')
      return
    }
    if (s < 0) {
      setCustomError('Start time negative nahi ho sakta')
      return
    }
    if (e <= s) {
      setCustomError('End time start time se bada hona chahiye')
      return
    }
    if (e - s < 0.2) {
      setCustomError('Scene duration kam se kam 0.2s honi chahiye')
      return
    }
    const newGap: ShortRange = {
      start: Number(s.toFixed(3)),
      end: Number(e.toFixed(3)),
    }
    const newKey = `custom-${newGap.start.toFixed(2)}-${newGap.end.toFixed(2)}`
    if (allAvailableGaps.some((g) => Math.abs(g.start - newGap.start) < 0.1 && Math.abs(g.end - newGap.end) < 0.1)) {
      setCustomError('Yeh scene range pehle se list me maujood hai')
      return
    }
    setCustomGaps((prev) => [...prev, newGap])
    setSelectedGapKeys((prev) => [...prev, newKey])
    setCustomStart('')
    setCustomEnd('')
  }

  const handleRemoveCustomGap = (key: string) => {
    setCustomGaps((prev) => prev.filter((g) => `custom-${g.start.toFixed(2)}-${g.end.toFixed(2)}` !== key))
    setSelectedGapKeys((prev) => prev.filter((k) => k !== key))
  }

  const toggleModel = (id: string) => {
    setSelectedModels((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    )
  }

  const selectAllModels = () => {
    setSelectedModels(GAP_FINDER_AVAILABLE_MODELS.map((m) => m.id))
  }

  const resetDefaultModels = () => {
    setSelectedModels(['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.6-flash'])
  }

  const chosenGaps = allAvailableGaps.filter((g) => selectedGapKeys.includes(g.key))

  async function action(actionName: 'start' | 'stop' | 'accept' | 'reject', candidateId?: string) {
    if (actionName === 'start' && chosenGaps.length === 0) {
      setError('Kripya search karne ke liye kam se kam 1 missing scene choose karein')
      return
    }
    if (actionName === 'start' && selectedModels.length === 0) {
      setError('Kam se kam 1 model choose karein')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/scans/${scan.id}/gap-backup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          actionName === 'start'
            ? {
                action: 'start',
                models: selectedModels,
                selectedGaps: chosenGaps.map((g) => ({ start: g.start, end: g.end })),
              }
            : { action: actionName, candidateId }
        ),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) setError(body.error || 'Request complete nahi hui')
      await mutate()
    } catch {
      setError('Network request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Manual missing-scene finder" className="panel border-warning/40">
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="size-4 text-warning" aria-hidden />
        <div>
          <h2 className="text-sm font-semibold">Manual missing-scene finder</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Initial minute finder se alag, transparent 24 fps search</p>
        </div>
        <span className="rounded-full bg-warning/15 px-2 py-0.5 font-mono text-xs text-warning">{coverage.pct}% covered</span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{coverage.missingSec.toFixed(1)}s missing</span>
      </div>

      {/* MISSING SCENE SELECTOR */}
      <div className="mt-4 rounded-lg border border-warning/30 bg-background/70 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground">
              Select Missing Scene(s) to search ({chosenGaps.length} of {allAvailableGaps.length} selected):
            </span>
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <button
              type="button"
              onClick={selectAllGaps}
              disabled={running}
              className="text-primary hover:underline disabled:opacity-50"
            >
              Select All ({allAvailableGaps.length})
            </button>
            <span className="text-muted-foreground">·</span>
            <button
              type="button"
              onClick={clearAllGaps}
              disabled={running}
              className="text-muted-foreground hover:underline disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {allAvailableGaps.map((gap) => {
            const isSelected = selectedGapKeys.includes(gap.key)
            const duration = (gap.end - gap.start).toFixed(1)
            return (
              <div
                key={gap.key}
                onClick={() => !running && toggleGap(gap.key)}
                className={`flex cursor-pointer items-center justify-between gap-2 rounded-md border p-2.5 text-xs transition-colors ${
                  isSelected
                    ? 'border-warning/60 bg-warning/10 text-foreground shadow-xs'
                    : 'border-border/60 bg-muted/20 text-muted-foreground hover:border-border'
                } ${running ? 'cursor-not-allowed opacity-80' : ''}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={running}
                    onChange={() => toggleGap(gap.key)}
                    onClick={(e) => e.stopPropagation()}
                    className="size-3.5 rounded border-warning/80 text-warning focus:ring-warning"
                  />
                  <div className="min-w-0">
                    <div className="font-mono font-semibold text-foreground">
                      {fmtTime(gap.start)} – {fmtTime(gap.end)}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      Duration: {duration}s · {gap.label}
                    </div>
                  </div>
                </div>
                {gap.isCustom && !running && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRemoveCustomGap(gap.key)
                    }}
                    title="Remove custom scene"
                    className="p-1 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {/* CUSTOM SCENE TIMESTAMP ADDER */}
        {!running && (
          <div className="mt-3 border-t border-border/60 pt-2.5">
            {!showCustomInput ? (
              <button
                type="button"
                onClick={() => setShowCustomInput(true)}
                className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
              >
                <Plus className="size-3" />
                Or Add Custom Missing Scene Timestamp
              </button>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-foreground">Add Custom Missing Scene:</span>
                  <button
                    type="button"
                    onClick={() => {
                      setShowCustomInput(false)
                      setCustomError(null)
                    }}
                    className="text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    placeholder="Start (e.g. 0:30)"
                    value={customStart}
                    onChange={(e) => setCustomStart(e.target.value)}
                    className="h-7 w-28 rounded border border-border bg-background px-2 font-mono text-xs"
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <input
                    type="text"
                    placeholder="End (e.g. 0:40)"
                    value={customEnd}
                    onChange={(e) => setCustomEnd(e.target.value)}
                    className="h-7 w-28 rounded border border-border bg-background px-2 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={handleAddCustomGap}
                    className="flex h-7 items-center gap-1 rounded bg-secondary px-2.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
                  >
                    <Plus className="size-3" />
                    Add Scene
                  </button>
                </div>
                {customError && <p className="text-[11px] text-destructive">{customError}</p>}
              </div>
            )}
          </div>
        )}
      </div>

      {/* MODEL SELECTION CONTROLS */}
      {!running && (
        <div className="mt-4 rounded-lg border border-border/80 bg-background/70 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-foreground">
                Targeted AI Models ({selectedModels.length} selected):
              </span>
              <button
                type="button"
                onClick={() => setShowModelPicker((prev) => !prev)}
                className="text-[11px] font-medium text-primary hover:underline"
              >
                {showModelPicker ? 'Hide Options ▲' : 'Customize Models ▼'}
              </button>
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              <button
                type="button"
                onClick={selectAllModels}
                className="text-primary hover:underline"
              >
                Select All
              </button>
              <span className="text-muted-foreground">·</span>
              <button
                type="button"
                onClick={resetDefaultModels}
                className="text-muted-foreground hover:underline"
              >
                Reset Default (3.7, 3.8, 3.6)
              </button>
            </div>
          </div>

          <div className={`mt-2.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 ${showModelPicker ? 'block' : 'hidden sm:grid'}`}>
            {GAP_FINDER_AVAILABLE_MODELS.map((model) => {
              const isChecked = selectedModels.includes(model.id)
              return (
                <label
                  key={model.id}
                  className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs transition-colors ${
                    isChecked
                      ? 'border-primary/50 bg-primary/10 text-foreground'
                      : 'border-border/60 bg-muted/30 text-muted-foreground hover:border-border'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggleModel(model.id)}
                    className="mt-0.5 size-3.5 rounded-sm border-primary text-primary focus:ring-primary"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-foreground">{model.name}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {model.rpm} RPM · {model.rpd} RPD
                      </span>
                    </div>
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/90 truncate">
                      {model.id}
                    </p>
                  </div>
                </label>
              )
            })}
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!running ? (
          <button
            type="button"
            onClick={() => void action('start')}
            disabled={busy || pending.length > 0 || selectedModels.length === 0 || chosenGaps.length === 0}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : state.status === 'idle' ? <Search className="size-3.5" aria-hidden /> : <RotateCcw className="size-3.5" aria-hidden />}
            {state.status === 'idle'
              ? `Find missing scenes (${chosenGaps.length} scene${chosenGaps.length === 1 ? '' : 's'}, ${selectedModels.length} models)`
              : `Retry missing scenes (${chosenGaps.length} scene${chosenGaps.length === 1 ? '' : 's'}, ${selectedModels.length} models)`}
          </button>
        ) : (
          <button type="button" onClick={() => void action('stop')} disabled={busy} className="flex items-center gap-1.5 rounded-md border border-destructive/40 px-3 py-2 text-xs font-medium text-destructive"><Square className="size-3.5 fill-current" aria-hidden /> Stop finder</button>
        )}
        <span className="text-xs text-muted-foreground">Manual only · suggested movie chunks only · maximum 4 parallel</span>
      </div>
      {pending.length > 0 && <p className="mt-2 text-xs text-warning">Pehle {pending.length} pending candidate(s) Accept/Reject karein; uske baad unresolved ranges Retry kar sakte hain.</p>}
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}

      {state.status !== 'idle' && (
        <div className="mt-5 rounded-lg border border-border bg-secondary/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            {PHASES.map((phase, index) => {
              const activePhase = phase.key === state.status || (state.status === 'stopped' && phase.key === 'searching') || (state.status === 'error' && index === Math.max(0, currentPhase))
              const passed = currentPhase >= 0 && index < currentPhase
              return <div key={phase.key} className="flex items-center gap-1.5"><span className={`flex size-5 items-center justify-center rounded-full ${passed ? 'bg-success text-success-foreground' : activePhase ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>{passed ? <Check className="size-3" aria-hidden /> : activePhase && running ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Circle className="size-2.5" aria-hidden />}</span><span className={`text-[10px] ${activePhase ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{phase.label}</span>{index < PHASES.length - 1 && <span className="mx-1 h-px w-4 bg-border" />}</div>
            })}
          </div>
          <p className="mt-3 text-xs text-foreground">{state.progress || state.status}</p>
          <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] text-muted-foreground">
            <span>{state.requests.filter((request) => request.status === 'queued').length} queued</span><span>·</span>
            <span>{state.requests.filter((request) => request.status === 'uploading' || request.status === 'running').length} active</span><span>·</span>
            <span>{state.requests.filter((request) => request.status === 'done').length} completed</span><span>·</span>
            <span>{state.requests.filter((request) => request.status === 'failed').length} failed</span><span>·</span>
            <span>{state.requestCount || 0} Gemini attempts</span><span>·</span><span>{(state.tokenCount || 0).toLocaleString()} tokens</span><span>·</span><span>{pending.length} review pending</span>
          </div>
          {state.error && <p role="alert" className="mt-2 text-xs text-destructive">{state.error}</p>}
        </div>
      )}

      {pending.length > 0 && <div className="mt-5"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Side-by-side candidate review</h3><div className="mt-2 flex flex-col gap-3">{pending.map((candidate) => <ReviewCandidate key={candidate.id} scanId={scan.id} candidate={candidate} onReview={(id, decision) => action(decision, id)} />)}</div></div>}

      {groupedRequests.length > 0 && (
        <div className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Live Gemini activity and replies</h3>
          <div className="mt-2 flex flex-col gap-3">
            {groupedRequests.map(({ minute, requests }) => (
              <article key={minute.index} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-2"><Play className="size-3.5 text-primary" aria-hidden /><h4 className="text-xs font-semibold">Short minute {minute.index + 1}</h4><span className="font-mono text-[10px] text-muted-foreground">{fmtTime(minute.start)}–{fmtTime(minute.end)}</span><span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] ${minute.status === 'failed' ? 'bg-destructive/15 text-destructive' : minute.status === 'awaiting_review' ? 'bg-warning/15 text-warning' : 'bg-primary/15 text-primary'}`}>{minute.status.replace('_', ' ')}</span></div>
                <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] text-muted-foreground">
                  <span>{minute.partIds.length} gap part(s)</span><span>·</span>
                  <span>{requests.filter((request) => request.status === 'queued').length} queued</span><span>·</span>
                  <span>{requests.filter((request) => request.status === 'uploading' || request.status === 'running').length} active</span><span>·</span>
                  <span>{minute.completedChunks.length}/{minute.candidateChunks.length} chunks checked</span>
                  {minute.clip && <><span>·</span><span>{minute.clip.durationSec.toFixed(2)}s clip · {(minute.clip.sizeBytes / 1024 / 1024).toFixed(1)} MB · 24 fps</span></>}
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">Search order: {minute.candidateChunks.length ? minute.candidateChunks.map((chunk) => `chunk ${chunk + 1}`).join(' → ') : 'No minute-finder suggestion'}{minute.currentBatch?.length ? ` · Current batch: ${minute.currentBatch.map((chunk) => chunk + 1).join(', ')}` : ''}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">{minute.partIds.map((partId) => { const part = state.parts.find((item) => item.index === partId); return <span key={partId} className="rounded bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">P{partId} · {part?.result || 'pending'}</span> })}</div>
                {minute.error && <p role="alert" className="mt-2 text-xs text-destructive">{minute.error}</p>}
                <div className="mt-2 flex flex-col gap-2">{requests.length ? requests.map((request) => <RequestRow key={request.id} request={request} />) : <p className="rounded-md border border-dashed border-border p-3 text-xs leading-relaxed text-muted-foreground">{minute.status === 'failed' ? 'Is minute ke liye Gemini request nahi bheji gayi. Upar failure reason diya hai.' : minute.status === 'uploading' ? '24 fps clip Gemini Files par upload ho rahi hai. Upload complete hote hi request cards yahan aayenge.' : 'Clip aur request queue prepare ho rahi hai. Lane, model, timing aur raw reply request start hote hi yahan dikhenge.'}</p>}</div>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
