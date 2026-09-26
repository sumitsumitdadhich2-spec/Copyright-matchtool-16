'use client'

import { useState } from 'react'
import useSWR from 'swr'
import {
  Search,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Play,
  Square,
  Sparkles,
  Plus,
  Trash2,
  Check,
  Eye,
} from 'lucide-react'
import type { MissingSceneScanState, MissingSceneTarget, Scan } from '@/lib/types'
import { fetcher, fmtTime } from '@/lib/format'
import { CandidateSideBySide } from './candidate-side-by-side'

interface MissingSceneApiResponse {
  ok: boolean
  running: boolean
  state: MissingSceneScanState | null
  detectedGaps: MissingSceneTarget[]
}

export function MissingScenePanel({ scan }: { scan: Scan }) {
  const [selectedSceneIds, setSelectedSceneIds] = useState<string[]>([])
  const [customScenes, setCustomScenes] = useState<MissingSceneTarget[]>([])
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [customError, setCustomError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [reviewingId, setReviewingId] = useState<string | null>(null)
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)

  const { data, mutate } = useSWR<MissingSceneApiResponse>(
    scan.id ? `/api/scans/${scan.id}/missing-scene-scan` : null,
    fetcher,
    {
      refreshInterval: (latest) => (latest?.running ? 1500 : 8000),
    },
  )

  const state = data?.state || scan.missingSceneScan
  const isRunning = Boolean(data?.running || (state && ['preparing', 'scanning_windows', 'scanning_chunks', 'verifying'].includes(state.status)))

  const handleReviewCandidate = async (candidateId: string, action: 'accept' | 'reject') => {
    setReviewingId(candidateId)
    try {
      const res = await fetch(`/api/scans/${scan.id}/missing-scene-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, candidateId }),
      })
      const result = await res.json()
      if (!res.ok) {
        setActionError(result.error || 'Review candidate failed')
      } else {
        await mutate()
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setReviewingId(null)
    }
  }

  // Available scenes: server detected gaps + user added custom scenes
  const detectedGaps = data?.detectedGaps || []
  const allAvailableScenes: MissingSceneTarget[] = [...detectedGaps, ...customScenes]

  const toggleScene = (id: string) => {
    setSelectedSceneIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const selectAll = () => {
    setSelectedSceneIds(allAvailableScenes.map((s) => s.id))
  }

  const clearSelection = () => {
    setSelectedSceneIds([])
  }

  const parseInputTime = (val: string): number | null => {
    const trimmed = val.trim()
    if (/^\d+(\.\d+)?$/.test(trimmed)) return parseFloat(trimmed)
    const m = trimmed.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/)
    if (m) {
      return parseInt(m[1], 10) * 60 + parseFloat(m[2])
    }
    return null
  }

  const addCustomScene = () => {
    setCustomError(null)
    const s = parseInputTime(customStart)
    const e = parseInputTime(customEnd)
    if (s === null || e === null) {
      setCustomError('Valid format enter karein (e.g. 0:30 ya 30.5)')
      return
    }
    if (e <= s) {
      setCustomError('End time start time se bada hona chahiye')
      return
    }
    const duration = Number((e - s).toFixed(3))
    const id = `custom-${Date.now()}-${Math.round(s)}-${Math.round(e)}`
    const newScene: MissingSceneTarget = {
      id,
      shortStart: s,
      shortEnd: e,
      duration,
    }
    setCustomScenes((prev) => [...prev, newScene])
    setSelectedSceneIds((prev) => [...prev, id])
    setCustomStart('')
    setCustomEnd('')
  }

  const removeCustomScene = (id: string) => {
    setCustomScenes((prev) => prev.filter((s) => s.id !== id))
    setSelectedSceneIds((prev) => prev.filter((x) => x !== id))
  }

  const selectedScenesToSearch = allAvailableScenes.filter((s) => selectedSceneIds.includes(s.id))

  const handleStartScan = async () => {
    if (selectedScenesToSearch.length === 0) {
      setActionError('Kripya search karne ke liye kam se kam 1 scene select karein.')
      return
    }
    setActionLoading(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/scans/${scan.id}/missing-scene-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenes: selectedScenesToSearch.map((s) => ({
            id: s.id,
            start: s.shortStart,
            end: s.shortEnd,
          })),
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to start missing scene scan')
      await mutate()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionLoading(false)
    }
  }

  const handleStopScan = async () => {
    setActionLoading(true)
    try {
      await fetch(`/api/scans/${scan.id}/missing-scene-scan`, { method: 'DELETE' })
      await mutate()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-primary/20 bg-card/60 p-4 shadow-sm backdrop-blur-sm" aria-labelledby="missing-scene-finder-title">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Search className="size-4" aria-hidden />
          </div>
          <div>
            <h2 id="missing-scene-finder-title" className="text-sm font-semibold text-foreground">
              Targeted Missing Scene Window Scanner
            </h2>
            <p className="text-[11px] text-muted-foreground">
              Jo scene short me nahi mile, unhe 20-min movie windows me dhoondein aur 24 fps par verify karein
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isRunning ? (
            <span className="flex items-center gap-1.5 rounded-full bg-primary/15 px-3 py-1 text-xs font-medium text-primary">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Scanning in progress
            </span>
          ) : state?.status === 'done' ? (
            <span className="flex items-center gap-1.5 rounded-full bg-success/15 px-3 py-1 text-xs font-medium text-success">
              <CheckCircle2 className="size-3.5" aria-hidden />
              Done
            </span>
          ) : null}
        </div>
      </div>

      {/* DETECTED SCENES SELECTION */}
      <div className="mt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="text-xs font-medium text-foreground">
            Select Missing Scene(s) to search ({selectedScenesToSearch.length} selected):
          </label>
          {allAvailableScenes.length > 0 && (
            <div className="flex items-center gap-2 text-[11px]">
              <button
                type="button"
                onClick={selectAll}
                className="text-primary hover:underline"
              >
                Select All ({allAvailableScenes.length})
              </button>
              <span className="text-muted-foreground">·</span>
              <button
                type="button"
                onClick={clearSelection}
                className="text-muted-foreground hover:underline"
              >
                Clear
              </button>
            </div>
          )}
        </div>

        {allAvailableScenes.length === 0 ? (
          <div className="mt-2 rounded-lg border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
            Filhal koi missing gap detect nahi hua ya scan abhi poora nahi hua. Neeche se custom time range add karein.
          </div>
        ) : (
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {allAvailableScenes.map((scene, idx) => {
              const isSelected = selectedSceneIds.includes(scene.id)
              const isCustom = scene.id.startsWith('custom-')
              return (
                <div
                  key={scene.id}
                  onClick={() => toggleScene(scene.id)}
                  className={`flex cursor-pointer items-center justify-between rounded-lg border p-2.5 text-xs transition-all ${
                    isSelected
                      ? 'border-primary bg-primary/10 shadow-xs'
                      : 'border-border bg-background hover:border-primary/40'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {}}
                      className="size-4 rounded-sm border-primary text-primary focus:ring-primary"
                    />
                    <div>
                      <div className="font-mono font-medium">
                        {fmtTime(scene.shortStart)} – {fmtTime(scene.shortEnd)}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        Duration: <span className="font-medium text-foreground">{scene.duration.toFixed(1)}s</span>
                        {isCustom ? ' (Custom)' : ` · Gap #${idx + 1}`}
                      </div>
                    </div>
                  </div>
                  {isCustom && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeCustomScene(scene.id)
                      }}
                      className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      title="Remove scene"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* CUSTOM RANGE ADDER */}
      <div className="mt-3 rounded-lg border border-border/60 bg-background/50 p-2.5">
        <span className="text-[11px] font-medium text-muted-foreground">Or Add Custom Missing Scene Timestamp:</span>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="Start (e.g. 0:30)"
            value={customStart}
            onChange={(e) => setCustomStart(e.target.value)}
            className="w-28 rounded-md border border-input bg-background px-2.5 py-1 text-xs"
          />
          <span className="text-muted-foreground text-xs">to</span>
          <input
            type="text"
            placeholder="End (e.g. 0:40)"
            value={customEnd}
            onChange={(e) => setCustomEnd(e.target.value)}
            className="w-28 rounded-md border border-input bg-background px-2.5 py-1 text-xs"
          />
          <button
            type="button"
            onClick={addCustomScene}
            className="btn-press flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-secondary"
          >
            <Plus className="size-3" aria-hidden />
            Add Scene
          </button>
        </div>
        {customError && <p className="mt-1 text-[11px] text-destructive">{customError}</p>}
      </div>

      {/* ACTIONS */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!isRunning ? (
          <button
            type="button"
            onClick={handleStartScan}
            disabled={actionLoading || selectedScenesToSearch.length === 0}
            className="btn-press flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground shadow-sm disabled:opacity-40"
          >
            <Play className="size-3.5" aria-hidden />
            {actionLoading
              ? 'Starting...'
              : selectedScenesToSearch.length <= 1
              ? 'Scan Windows for 1 Selected Scene'
              : `Merge ${selectedScenesToSearch.length} Scenes & Scan Windows`}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleStopScan}
            disabled={actionLoading}
            className="btn-press flex items-center gap-1.5 rounded-lg border border-destructive/50 bg-card px-3.5 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-40"
          >
            <Square className="size-3.5" aria-hidden />
            Stop Scanner
          </button>
        )}

        {selectedScenesToSearch.length > 1 && (
          <span className="text-[11px] text-muted-foreground">
            (Selected {selectedScenesToSearch.length} scenes will be joined with 1s gap and searched with clear part breakdown)
          </span>
        )}
      </div>

      {actionError && (
        <p className="mt-2 flex items-center gap-1 text-xs text-destructive">
          <AlertCircle className="size-3.5 shrink-0" aria-hidden />
          {actionError}
        </p>
      )}

      {/* ACTIVE STATUS & PROGRESS */}
      {state && state.status !== 'idle' && (
        <div className="mt-4 rounded-xl border border-primary/20 bg-background/80 p-3.5 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-foreground">Scanner Status:</span>
              <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wide text-primary">
                {isRunning && <Loader2 className="size-3 animate-spin" aria-hidden />}
                {state.status.replace(/_/g, ' ')}
              </span>
            </div>

            {/* Parallel worker indicators */}
            {isRunning && (
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                {(state.activeWindows || 0) > 0 && (
                  <span className="rounded-full bg-blue-500/10 px-2 py-0.5 font-mono font-medium text-blue-600 dark:text-blue-400">
                    ⚡ {state.activeWindows} Windows Active
                  </span>
                )}
                {(state.activeChunks || 0) > 0 && (
                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-mono font-medium text-amber-600 dark:text-amber-400">
                    🚀 {state.activeChunks} Chunks Active
                  </span>
                )}
              </div>
            )}
          </div>

          {state.progress && (
            <p className="mt-2 text-xs font-medium text-muted-foreground">
              {state.progress}
            </p>
          )}

          {/* DUAL PARALLEL PROGRESS METERS */}
          {isRunning && (state.totalWindows || (state.totalChunks && state.totalChunks > 0)) && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {state.totalWindows ? (
                <div className="rounded-lg border border-border/70 bg-card/50 p-2.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-medium text-foreground">20-Min Movie Windows</span>
                    <span className="font-mono text-muted-foreground">
                      {state.completedWindows || 0} / {state.totalWindows} (
                      {Math.round(((state.completedWindows || 0) / state.totalWindows) * 100)}%)
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-blue-500 transition-all duration-300"
                      style={{
                        width: `${Math.min(100, Math.round(((state.completedWindows || 0) / state.totalWindows) * 100))}%`,
                      }}
                    />
                  </div>
                </div>
              ) : null}

              {(state.totalChunks && state.totalChunks > 0) ? (
                <div className="rounded-lg border border-border/70 bg-card/50 p-2.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-medium text-foreground">1-Min Pipelined Chunks</span>
                    <span className="font-mono text-muted-foreground">
                      {state.completedChunks || 0} / {state.totalChunks} (
                      {Math.round(((state.completedChunks || 0) / state.totalChunks) * 100)}%)
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-amber-500 transition-all duration-300"
                      style={{
                        width: `${Math.min(100, Math.round(((state.completedChunks || 0) / state.totalChunks) * 100))}%`,
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {/* WINDOW HITS */}
          {state.windowHits && state.windowHits.length > 0 && (
            <div className="mt-3 border-t border-border/60 pt-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-success">
                  <Sparkles className="mr-1 inline size-3.5" aria-hidden />
                  Instant Window Hits ({state.windowHits.length}):
                </span>
                <span className="text-[10px] text-muted-foreground">
                  (Pipelined chunks scan automatically in background)
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {state.windowHits.map((hit, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1.5 rounded-md border border-success/30 bg-success/10 px-2 py-1 font-mono text-[11px] text-success"
                  >
                    <span>Movie Min {hit.movieMinute}</span>
                    <span className="text-muted-foreground/80">({fmtTime(hit.shortStart)}–{fmtTime(hit.shortEnd)})</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* CANDIDATE SCENE MATCHES FOR USER MANUAL REVIEW WITH SIDE-BY-SIDE VIDEO PREVIEW */}
          {state.candidates && state.candidates.length > 0 && (
            <div className="mt-3 border-t border-border/60 pt-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground">
                  <Sparkles className="mr-1 inline size-3.5 text-primary" aria-hidden />
                  Candidate Scene Matches ({state.candidates.length}) — Side-by-Side Review:
                </span>
                <span className="text-[11px] text-muted-foreground">
                  (Watch synchronized video preview below, then click Accept or Reject)
                </span>
              </div>

              {/* SIDE-BY-SIDE DUAL VIDEO PLAYER */}
              <CandidateSideBySide
                scan={scan}
                candidates={state.candidates}
                selectedCandidateId={selectedCandidateId || state.candidates[0]?.id || null}
                onSelectCandidate={(id) => setSelectedCandidateId(id)}
                onAccept={(id) => handleReviewCandidate(id, 'accept')}
                onReject={(id) => handleReviewCandidate(id, 'reject')}
                reviewingId={reviewingId}
              />

              {/* CANDIDATE LIST */}
              <div className="mt-3 space-y-2">
                <div className="text-[11px] font-medium text-muted-foreground">
                  All Candidates List (Click any candidate to preview in player above):
                </div>
                {state.candidates.map((cand, idx) => {
                  const isAccepted = cand.status === 'confirmed'
                  const isRejected = cand.status === 'rejected'
                  const isBusy = reviewingId === cand.id
                  const isSelected = (selectedCandidateId || state.candidates?.[0]?.id) === cand.id

                  return (
                    <div
                      key={cand.id}
                      onClick={() => setSelectedCandidateId(cand.id)}
                      className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2.5 text-xs transition-all cursor-pointer ${
                        isSelected
                          ? 'border-primary ring-1 ring-primary bg-primary/10 shadow-xs'
                          : isAccepted
                          ? 'border-success/40 bg-success/10'
                          : isRejected
                          ? 'border-muted bg-muted/20 opacity-60'
                          : 'border-primary/30 bg-primary/5 hover:border-primary/60'
                      }`}
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-primary">#{idx + 1}</span>
                          <span className="font-mono font-medium text-foreground">
                            Short {fmtTime(cand.shortStart)}–{fmtTime(cand.shortEnd)}
                          </span>
                          <span className="text-muted-foreground">➔</span>
                          <span className="font-mono font-medium text-foreground">
                            Movie {fmtTime(cand.movieStart)}–{fmtTime(cand.movieEnd)}
                          </span>
                          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            Chunk {cand.chunkIndex + 1}
                          </span>
                          {isSelected && (
                            <span className="flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                              <Eye className="size-3" /> PREVIEWING
                            </span>
                          )}
                        </div>
                        {cand.model && (
                          <p className="text-[11px] text-muted-foreground">
                            Model: <span className="font-mono">{cand.model}</span>
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                        {isAccepted ? (
                          <span className="flex items-center gap-1 rounded-md bg-success/20 px-2 py-1 text-xs font-medium text-success">
                            <Check className="size-3.5" aria-hidden />
                            Accepted
                          </span>
                        ) : isRejected ? (
                          <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                            Rejected
                          </span>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => handleReviewCandidate(cand.id, 'accept')}
                              disabled={isBusy || actionLoading}
                              className="btn-press flex items-center gap-1 rounded-md bg-success px-2.5 py-1 text-xs font-semibold text-success-foreground hover:bg-success/90 disabled:opacity-40 cursor-pointer"
                            >
                              {isBusy ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Check className="size-3" aria-hidden />}
                              Accept Match
                            </button>
                            <button
                              type="button"
                              onClick={() => handleReviewCandidate(cand.id, 'reject')}
                              disabled={isBusy || actionLoading}
                              className="btn-press rounded-md border border-input bg-card px-2 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40 cursor-pointer"
                            >
                              Reject
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* CONFIRMED MATCHES SUMMARY */}
          {state.addedMatches && state.addedMatches.length > 0 && (
            <div className="mt-2.5 border-t border-border/60 pt-2">
              <span className="text-[11px] font-medium text-success">
                <Check className="mr-1 inline size-3" aria-hidden />
                Confirmed Matches Added to Scan ({state.addedMatches.length}):
              </span>
              <div className="mt-1 space-y-1">
                {state.addedMatches.map((m, i) => (
                  <div
                    key={i}
                    className="flex flex-wrap items-center justify-between rounded-md border border-success/30 bg-success/5 px-2.5 py-1 text-xs text-foreground"
                  >
                    <span className="font-mono">
                      Short {fmtTime(m.shortStart)}–{fmtTime(m.shortEnd)} ➔ Movie {fmtTime(m.movieStart)}–{fmtTime(m.movieEnd)}
                    </span>
                    <span className="rounded-full bg-success/20 px-2 py-0.5 text-[10px] font-semibold text-success">
                      CONFIRMED
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
