'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Layers, Loader2, Check, AlertTriangle, RotateCcw, Play, Square, ChevronDown, ChevronRight, Sparkles } from 'lucide-react'
import type { Scan, GeminiPrescanState, GeminiPrescanStatus, GeminiPrescanWindow, GeminiBackupState, GeminiBackupPart, MinuteFinderMode } from '@/lib/types'
import { fetcher, fmtTime, fmtBytes } from '@/lib/format'
import { displayModelName } from '@/lib/models'
import { MinuteFinderToggle } from './minute-finder-toggle'
import { MissingScenePanel } from './missing-scene-panel'

interface FinderResponse {
  mode: MinuteFinderMode
  keyCount: number
  models: string[]
  maxShortSec: number
  ready: boolean
  running: boolean
  scanRunning: boolean
  prescan: GeminiPrescanState
}

const STEPS: { key: string; label: string }[] = [
  { key: 'preparing', label: 'Prepare movie copy' },
  { key: 'uploading', label: 'Upload' },
  { key: 'scanning', label: 'Scan windows' },
  { key: 'backup', label: 'Backup finder' },
  { key: 'starting_scan', label: 'Minutes found' },
  { key: 'done', label: 'Chunk scan started' },
]

const ACTIVE: GeminiPrescanStatus[] = ['preparing', 'uploading', 'scanning', 'backup', 'starting_scan']

/** Which step the finder reached — for the running AND the error state. */
function reachedStep(p?: GeminiPrescanState | null): number {
  if (!p) return 0
  if (p.status === 'done') return STEPS.length
  const i = STEPS.findIndex((s) => s.key === p.status)
  if (i >= 0) return i
  // error / idle: infer from what exists
  if (p.minuteSuggestions && p.minuteSuggestions.length > 0) return 4
  if (p.backup && p.backup.status !== 'idle') return 3
  if (p.windows && p.windows.length > 0) return 2
  if (Object.keys(p.uploads || {}).length > 0) return 1
  return 0
}

/** AUTO PIPELINE panel (header + minute-finder toggle). Gemini mode shows the
 *  Gemini Minute Finder flow; TwelveLabs mode defers to the old panel below;
 *  Off shows a one-line note. The chunk-time scan itself is untouched. */
export function MinuteFinderPanel({ scan, mode, onModeChanged }: { scan: Scan; mode: MinuteFinderMode; onModeChanged: (m: MinuteFinderMode) => void }) {
  const [acting, setActing] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [openWindow, setOpenWindow] = useState<number | null>(null)
  const [openBackupWindow, setOpenBackupWindow] = useState<number | null>(null)

  const { data, mutate } = useSWR<FinderResponse>(scan.id && mode === 'gemini' ? `/api/scans/${scan.id}/minute-finder` : null, fetcher, {
    refreshInterval: (latest) => (latest && (ACTIVE.includes(latest.prescan?.status) || latest.running) ? 2000 : 10000),
  })

  const prescan: GeminiPrescanState = data?.prescan ?? scan.geminiPrescan ?? { status: 'idle', windowLen: 1200, uploads: {}, windows: [] }
  const status = prescan.status
  const isActive = ACTIVE.includes(status) || Boolean(data?.running)
  const isError = status === 'error'
  const isDone = status === 'done'
  const step = reachedStep(prescan)
  const trimStart = scan.movieTrimStart ?? 0
  const keyCount = data?.keyCount ?? 0
  const uploadedKeys = Object.values(prescan.uploads || {}).filter((u) => u.shortUri && u.movieUri).length
  const windows = prescan.windows || []
  const doneWindows = windows.filter((w) => w.status === 'done').length
  const failedWindows = windows.filter((w) => w.status === 'failed').length
  const windowsWithHits = windows.filter((w) => (w.matches || 0) > 0).length
  const backup: GeminiBackupState | undefined = prescan.backup
  const backupWindows = backup?.windows || []
  const backupDone = backupWindows.filter((w) => w.status === 'done').length
  const backupFailed = backupWindows.filter((w) => w.status === 'failed').length
  const backupAdded = backup?.addedMinutes || []
  const backupStepLabel =
    !backup || backup.status === 'idle'
      ? 'Backup finder'
      : backup.status === 'skipped'
        ? 'Backup finder (skipped)'
        : backup.status === 'preparing'
          ? 'Backup finder (cutting clip)'
          : backup.status === 'uploading'
            ? 'Backup finder (uploading)'
            : backupWindows.length > 0
              ? `Backup finder (${backupDone}/${backupWindows.length})`
              : 'Backup finder'
  const minutes = prescan.appliedMinutes ?? prescan.minuteSuggestions?.map((s) => s.minute) ?? []
  // ACTUAL chunk-scan plan: per short minute the scheduler only touches chunks
  // whose absolute movie minute is in that minute's exact allow-list.
  const listSegs = (scan.shortSegments || []).filter((s) => s.selected !== false && Array.isArray(s.movieMinutes) && s.movieMinutes.length > 0)
  const plannedChunkCalls = listSegs.reduce((n, s) => n + s.movieMinutes!.length, 0)
  const plannedUniqueChunks = new Set(listSegs.flatMap((s) => s.movieMinutes!)).size
  const shortTooLong = Boolean(scan.shortDuration && data?.maxShortSec && scan.shortDuration > data.maxShortSec)

  async function post(action: 'start' | 'retry' | 'rerun') {
    setActing(action)
    setActionError(null)
    const res = await fetch(`/api/scans/${scan.id}/minute-finder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    setActing(null)
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      setActionError(j.error || 'Action failed')
    }
    void mutate()
  }

  async function stop() {
    setActing('stop')
    setActionError(null)
    const res = await fetch(`/api/scans/${scan.id}/minute-finder`, { method: 'DELETE' })
    setActing(null)
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      setActionError(j.error || 'Stop failed')
    }
    void mutate()
  }

  const canStart = mode === 'gemini' && Boolean(data?.ready) && !isActive && !data?.scanRunning && (status === 'idle' || isError) && !isDone
  const totalFailed = failedWindows + backupFailed
  const canRetry = mode === 'gemini' && !isActive && !data?.scanRunning && (totalFailed > 0 || (isError && windows.length > 0))
  const canRerun = mode === 'gemini' && Boolean(data?.ready) && !isActive && !data?.scanRunning && windows.length > 0

  return (
    <section aria-label="Auto pipeline — minute finder" className="panel">
      <div className="flex flex-wrap items-center gap-2">
        <Layers className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">
          Auto Pipeline{' '}
          <span className="font-normal text-muted-foreground">
            {mode === 'gemini' ? '(Gemini Minute Finder)' : mode === 'twelvelabs' ? '(Merge → Index → Segmentation)' : '(off)'}
          </span>
        </h2>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {mode === 'gemini' &&
            (isActive ? (
              <span className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/15 px-2.5 py-0.5 text-xs text-primary">
                <Loader2 className="size-3 animate-spin" aria-hidden />
                Running...
              </span>
            ) : isDone ? (
              <span className="flex items-center gap-1 rounded-full bg-success/15 px-2.5 py-0.5 text-xs text-success">
                <Check className="size-3" aria-hidden />
                Chunk scan started
              </span>
            ) : isError ? (
              <span className="rounded-full bg-destructive/15 px-2.5 py-0.5 text-xs text-destructive">Error</span>
            ) : (
              <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground">
                {data?.ready ? 'ready' : 'short + movie + trim ka wait'}
              </span>
            ))}
          <MinuteFinderToggle mode={mode} onChanged={onModeChanged} />
        </div>
      </div>

      {mode === 'off' && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Minute finder OFF hai �� upload + trim ke baad kuch auto nahi chalega. Header me <span className="font-medium text-foreground">Start scan</span>{' '}
          dabao to normal FULL scan hoga (saare chunks, 24 fps).
        </p>
      )}

      {mode === 'twelvelabs' && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          TwelveLabs mode — purana merge → Marengo → Pegasus → minute approval flow neeche wale panel me chalta hai (TwelveLabs key zaroori).
        </p>
      )}

      {mode === 'gemini' && (
        <>
          {/* ACTION BUTTONS */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {canStart && (
              <button
                type="button"
                onClick={() => post('start')}
                disabled={acting !== null || shortTooLong || keyCount === 0}
                className="btn-press flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm disabled:opacity-40"
              >
                <Play className="size-3" aria-hidden />
                {acting === 'start' ? 'Starting...' : 'Start minute finder'}
              </button>
            )}
            {canRetry && (
              <button
                type="button"
                onClick={() => post('retry')}
                disabled={acting !== null}
                className="btn-press flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm disabled:opacity-40"
              >
                <RotateCcw className="size-3" aria-hidden />
                {acting === 'retry' ? 'Retrying...' : `Retry failed windows${totalFailed ? ` (${totalFailed})` : ''}`}
              </button>
            )}
            {canRerun && (
              <button
                type="button"
                onClick={() => post('rerun')}
                disabled={acting !== null}
                className="btn-press flex items-center gap-1 rounded-lg border border-input bg-card px-3 py-1.5 text-xs font-medium hover:border-primary/40 hover:bg-secondary disabled:opacity-40"
              >
                <RotateCcw className="size-3" aria-hidden />
                {acting === 'rerun' ? 'Starting...' : 'Re-run minute finder'}
              </button>
            )}
            {isActive && (
              <button
                type="button"
                onClick={stop}
                disabled={acting !== null}
                className="btn-press flex items-center gap-1 rounded-lg border border-destructive/50 bg-card px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-40"
              >
                <Square className="size-3" aria-hidden />
                {acting === 'stop' ? 'Stopping...' : 'Stop'}
              </button>
            )}
            <span className="text-[11px] text-muted-foreground">
              {keyCount} key(s) × {data?.models?.length ?? 3} models = {keyCount * (data?.models?.length ?? 3)} lanes · 1 req/min/lane
            </span>
          </div>

          {shortTooLong && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
              Short video 3 minute se lamba hai ({fmtTime(scan.shortDuration || 0)}) — Gemini Minute Finder sirf ≤3 min short par chalta hai. Manual Full scan use karo.
            </p>
          )}
          {keyCount === 0 && data && (
            <p className="mt-2 text-xs text-warning">Gemini API key nahi — Settings me key add karo.</p>
          )}

          {/* STEP TIMELINE */}
          {(isActive || isDone || isError) && (
            <ol className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-2" aria-label="Minute finder steps">
              {STEPS.map((s, i) => {
                const done = step > i || isDone
                const active = isActive && step === i
                const failed = isError && step === i
                let label = s.label
                if (s.key === 'uploading' && keyCount > 0) label = `Upload (keys ${Math.min(uploadedKeys, keyCount)}/${keyCount})`
                if (s.key === 'scanning' && windows.length > 0) label = `Scan windows (${doneWindows}/${windows.length})`
                if (s.key === 'backup') label = backupStepLabel
                if (s.key === 'starting_scan' && minutes.length > 0) label = `Minutes found (${minutes.length})`
                return (
                  <li key={s.key} className="flex items-center gap-1">
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
                      {done ? <Check className="size-3" aria-hidden /> : active ? <Loader2 className="size-3 animate-spin" aria-hidden /> : failed ? <AlertTriangle className="size-3" aria-hidden /> : null}
                      {label}
                    </span>
                    {i < STEPS.length - 1 && <span className="text-muted-foreground/50" aria-hidden>{'→'}</span>}
                  </li>
                )
              })}
            </ol>
          )}

          {/* LIVE PROGRESS */}
          {isActive && prescan.progress && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin text-primary" aria-hidden />
              {prescan.progress}
            </p>
          )}

          {/* KEY UPLOADS PROGRESS DETAILS */}
          {prescan.uploads && Object.keys(prescan.uploads).length > 0 && (status === 'uploading' || isActive) && (
            <div className="mt-2.5 space-y-1.5 rounded-lg border border-border/70 bg-card/60 p-2.5">
              <div className="flex items-center justify-between text-[11px] font-medium text-foreground">
                <span>Gemini Files API Uploads:</span>
                <span className="text-muted-foreground">24h cache persistence</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {Object.entries(prescan.uploads).map(([keyId, up], idx) => {
                  const mProg = up.movieProgress
                  const sProg = up.shortProgress
                  return (
                    <div key={keyId} className="rounded-md border border-border/50 bg-background/50 p-2 text-xs">
                      <div className="flex items-center justify-between font-mono text-[11px] font-medium text-foreground">
                        <span>Key {idx + 1} ({keyId.slice(0, 8)})</span>
                        <span className="text-[10px] text-primary">
                          {mProg?.pct === 100 && sProg?.pct === 100 ? 'READY' : 'UPLOADING'}
                        </span>
                      </div>
                      
                      {/* Movie upload bar */}
                      <div className="mt-1.5 space-y-0.5">
                        <div className="flex justify-between text-[10px] text-muted-foreground">
                          <span>Movie Copy</span>
                          <span className="font-mono">
                            {mProg ? `${mProg.pct}% · ${mProg.speedStr}` : up.movieUri ? '100% (Ready)' : 'Waiting...'}
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                          <div
                            className="h-full bg-primary transition-all duration-300"
                            style={{ width: `${mProg ? mProg.pct : up.movieUri ? 100 : 0}%` }}
                          />
                        </div>
                      </div>

                      {/* Short upload bar */}
                      <div className="mt-1.5 space-y-0.5">
                        <div className="flex justify-between text-[10px] text-muted-foreground">
                          <span>Short Video</span>
                          <span className="font-mono">
                            {sProg ? `${sProg.pct}% · ${sProg.speedStr}` : up.shortUri ? '100% (Ready)' : 'Waiting...'}
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                          <div
                            className="h-full bg-success transition-all duration-300"
                            style={{ width: `${sProg ? sProg.pct : up.shortUri ? 100 : 0}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* MOVIE COPY INFO */}
          {prescan.movieCopy && (
            <p className="mt-2 text-xs text-muted-foreground">
              Movie upload copy: {fmtTime(prescan.movieCopy.trimStart)} → {fmtTime(prescan.movieCopy.trimEnd)} ({fmtTime(prescan.movieCopy.durationSec)}),{' '}
              {fmtBytes(prescan.movieCopy.sizeBytes)} · {prescan.movieCopy.reencoded ? 're-encoded 480p' : 'stream copy'} — sirf Gemini upload ke liye, original/chunks untouched.
            </p>
          )}

          {/* ERROR */}
          {isError && prescan.error && (
            <div className="mt-2 space-y-1">
              <p className="flex items-start gap-1.5 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                <span>{prescan.error}</span>
              </p>
              <p className="text-[11px] text-muted-foreground">
                Fallback: header ka <span className="font-medium text-foreground">Start scan</span> hamesha available hai (manual Full scan) — wo is finder par depend nahi karta.
              </p>
            </div>
          )}
          {actionError && <p className="mt-2 text-xs text-destructive">{actionError}</p>}

          {/* MINUTES FOUND */}
          {minutes.length > 0 && (
            <div className="mt-3 rounded-lg border border-success/30 bg-success/5 p-2.5">
              <p className="flex items-center gap-1.5 text-xs font-medium text-success">
                <Sparkles className="size-3" aria-hidden />
                {/* Minute numbers are 0-indexed ABSOLUTE movie minutes — same number as
                    the chunk index / log lines ("chunk 66" = 1:06:00–1:07:00). Never +1. */}
                Movie minute {minutes.join(', ')}{' '}
                <span className="font-normal text-muted-foreground">
                  ({windowsWithHits}/{windows.length} window{windows.length === 1 ? '' : 's'} me match
                  {backupAdded.length > 0 ? ` · backup pass se +${backupAdded.length}` : ''} · ±1 min buffer · chunk scan sirf inhi par)
                </span>
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {minutes.map((m) => {
                  const fromBackup = backupAdded.includes(m)
                  return (
                    <span
                      key={m}
                      title={`Movie minute ${m} = chunk ${m}${fromBackup ? ' — backup pass se mila' : ''}`}
                      className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${
                        fromBackup ? 'border-primary/40 bg-primary/10 text-primary' : 'border-success/30 bg-card text-success'
                      }`}
                    >
                      <span className="text-muted-foreground">{m}:</span> {fmtTime(m * 60)}–{fmtTime((m + 1) * 60)}
                      {fromBackup && <span className="ml-1 text-[10px] uppercase">bk</span>}
                    </span>
                  )
                })}
              </div>
              {listSegs.length > 0 && (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Chunk scan: <span className="font-medium text-foreground">{plannedChunkCalls} chunk call{plannedChunkCalls === 1 ? '' : 's'}</span>{' '}
                  (list-based · {plannedUniqueChunks} unique movie chunk{plannedUniqueChunks === 1 ? '' : 's'} across {listSegs.length} short minute{listSegs.length === 1 ? '' : 's'}) — gap chunks skipped
                </p>
              )}
            </div>
          )}

          {/* WINDOW GRID */}
          {windows.length > 0 && (
            <div className="mt-3">
              <h3 className="text-xs font-semibold text-muted-foreground">
                Windows ({doneWindows}/{windows.length} done{failedWindows ? `, ${failedWindows} failed` : ''}) — short @10fps + window @1fps
              </h3>
              <ul className="mt-1.5 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {windows.map((w) => (
                  <WindowCard key={w.index} w={w} trimStart={trimStart} open={openWindow === w.index} onToggle={() => setOpenWindow(openWindow === w.index ? null : w.index)} />
                ))}
              </ul>
            </div>
          )}

          {/* BACKUP PASS — missing short parts, high-fps clip, every window again */}
          {backup && backup.status !== 'idle' && (
            <BackupSection
              backup={backup}
              trimStart={trimStart}
              backupDone={backupDone}
              backupFailed={backupFailed}
              openWindow={openBackupWindow}
              onToggleWindow={(i) => setOpenBackupWindow(openBackupWindow === i ? null : i)}
            />
          )}

          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Auto flow: trim confirm hote hi trimmed movie ki ek upload-copy banti hai (≤1.9 GB), short + copy har API key par Files API me upload hote hain,
            phir movie 20-minute windows me {data?.models?.map(displayModelName).join(' + ') || 'gemini-3.6-flash + gemini-3.7-flash + gemini-3.8-flash'} par scan hoti hai (short 10 fps, window 1 fps).
            Short ke jo hisse (≥4 s) kisi window me nahi mile, unhe cut karke high-fps (5–24) backup clip banti hai aur har window me dobara dhundha jata hai — ek hi baar.
            Jo minutes milte hain unpar 24 fps chunk-time scan apne aap start ho jata hai — koi approval nahi.
          </p>

          <MissingScenePanel scan={scan} />
        </>
      )}
    </section>
  )
}

const PART_RESULT: Record<NonNullable<GeminiBackupPart['result']>, { label: string; cls: string }> = {
  found: { label: 'FOUND', cls: 'bg-success/15 text-success' },
  possible: { label: 'POSSIBLE', cls: 'border border-primary/30 bg-primary/15 text-primary' },
  not_in_movie: { label: 'NOT IN MOVIE', cls: 'bg-secondary text-muted-foreground' },
  non_movie: { label: 'NON-MOVIE', cls: 'bg-warning/15 text-warning' },
  pending: { label: 'pending', cls: 'bg-secondary text-muted-foreground' },
}

/** BACKUP PASS block: status line, PART MAP (missing short ranges + verdict), backup window grid. */
function BackupSection({
  backup,
  trimStart,
  backupDone,
  backupFailed,
  openWindow,
  onToggleWindow,
}: {
  backup: GeminiBackupState
  trimStart: number
  backupDone: number
  backupFailed: number
  openWindow: number | null
  onToggleWindow: (i: number) => void
}) {
  const active = backup.status === 'preparing' || backup.status === 'uploading' || backup.status === 'scanning'
  const statusChip =
    backup.status === 'skipped'
      ? { text: 'skipped', cls: 'bg-secondary text-muted-foreground' }
      : backup.status === 'done'
        ? { text: 'done', cls: 'bg-success/15 text-success' }
        : backup.status === 'error'
          ? { text: 'error', cls: 'bg-destructive/15 text-destructive' }
          : { text: backup.status, cls: 'border border-primary/30 bg-primary/15 text-primary' }

  return (
    <div className="mt-3 rounded-lg border border-border bg-card p-2.5" aria-label="Backup minute finder">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold">
          Backup finder <span className="font-normal text-muted-foreground">(missing parts · high fps · 2nd pass)</span>
        </h3>
        <span className={`ml-auto flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${statusChip.cls}`}>
          {active && <Loader2 className="size-3 animate-spin" aria-hidden />}
          {backup.status === 'done' && <Check className="size-3" aria-hidden />}
          {statusChip.text}
        </span>
      </div>

      {backup.status === 'skipped' && backup.skipReason && <p className="mt-1.5 text-[11px] text-muted-foreground">{backup.skipReason}</p>}
      {backup.error && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>{backup.error}</span>
        </p>
      )}
      {active && backup.progress && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin text-primary" aria-hidden />
          {backup.progress}
        </p>
      )}

      {backup.clip && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Clip: {fmtTime(backup.clip.durationSec)}, {fmtBytes(backup.clip.sizeBytes)} · <span className="font-mono text-foreground">{backup.clip.fps} fps</span> (900-frame budget) · movie window @1fps (same upload)
        </p>
      )}

      {backup.parts.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-medium text-muted-foreground">PART MAP — short ke missing hisse (±2 s padded)</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {backup.parts.map((p) => {
              const r = PART_RESULT[p.result || 'pending']
              return (
                <li key={p.index} className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px]">
                  <span className="font-semibold">P{p.index}</span>
                  <span className="text-muted-foreground">
                    short {fmtTime(p.shortStart)}–{fmtTime(p.shortEnd)}
                  </span>
                  <span className="text-muted-foreground/60">·</span>
                  <span className="text-muted-foreground">
                    clip {fmtTime(p.clipStart)}–{fmtTime(p.clipEnd)}
                  </span>
                  <span className={`rounded-full px-1.5 py-0.5 font-sans text-[10px] ${r.cls}`}>{r.label}</span>
                  {p.type && <span className="font-sans text-[10px] text-muted-foreground">[{p.type}]</span>}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {backup.addedMinutes && backup.addedMinutes.length > 0 && (
        <p className="mt-2 text-[11px] text-success">
          <Sparkles className="mr-1 inline size-3" aria-hidden />
          Backup se +{backup.addedMinutes.length} extra movie minute(s): {backup.addedMinutes.join(', ')}
        </p>
      )}
      {backup.status === 'done' && (!backup.addedMinutes || backup.addedMinutes.length === 0) && (
        <p className="mt-2 text-[11px] text-muted-foreground">Backup pass se koi naya minute nahi mila.</p>
      )}

      {backup.windows.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-medium text-muted-foreground">
            Backup windows ({backupDone}/{backup.windows.length} done{backupFailed ? `, ${backupFailed} failed` : ''}) — clip @{backup.clip?.fps ?? '?'}fps + window @1fps · found range first
          </p>
          <ul className="mt-1 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {backup.windows.map((w) => (
              <WindowCard key={w.index} w={w} trimStart={trimStart} open={openWindow === w.index} onToggle={() => onToggleWindow(w.index)} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function WindowCard({ w, trimStart, open, onToggle }: { w: GeminiPrescanWindow; trimStart: number; open: boolean; onToggle: () => void }) {
  const absStart = trimStart + w.startOffset
  const absEnd = trimStart + w.endOffset
  const chip =
    w.status === 'done'
      ? (w.matches || 0) > 0
        ? 'bg-success/15 text-success'
        : 'bg-secondary text-muted-foreground'
      : w.status === 'running'
        ? 'border border-primary/30 bg-primary/15 text-primary'
        : w.status === 'failed'
          ? 'bg-destructive/15 text-destructive'
          : 'bg-secondary text-muted-foreground'
  const chipText =
    w.status === 'done' ? ((w.matches || 0) > 0 ? `${w.matches} hit(s)` : 'not in window') : w.status === 'running' ? 'running' : w.status === 'failed' ? 'failed' : 'pending'
  return (
    <li className="rounded-lg border border-border bg-background">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        disabled={!w.raw && !w.error}
        className="flex w-full flex-col gap-1 p-2 text-left disabled:cursor-default"
      >
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs font-semibold">
            #{w.index} {fmtTime(absStart)}–{fmtTime(absEnd)}
          </span>
          <span className={`ml-auto flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${chip}`}>
            {w.status === 'running' && <Loader2 className="size-3 animate-spin" aria-hidden />}
            {w.status === 'done' && <Check className="size-3" aria-hidden />}
            {chipText}
          </span>
          {(w.raw || w.error) && (open ? <ChevronDown className="size-3 text-muted-foreground" aria-hidden /> : <ChevronRight className="size-3 text-muted-foreground" aria-hidden />)}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          {w.lane && <span>{w.lane.replace(/gemini-/, '')}</span>}
          {w.tokens ? <span className="font-mono">{w.tokens.toLocaleString()} tok</span> : null}
          {w.attempts && w.attempts > 1 ? <span>{w.attempts} attempts</span> : null}
          {w.policyRetried && (
            <span
              className="rounded bg-warning/15 px-1.5 py-0.2 text-[10px] font-medium text-warning"
              title="Google policy block caught — 1 sanitized retry (audio stripped + neutral prompt) executed"
            >
              Policy Retried (Muted)
            </span>
          )}
          {w.minutes && w.minutes.length > 0 && <span className="text-success">min {w.minutes.map((m) => m + 1).join(', ')}</span>}
        </div>
      </button>
      {open && (w.raw || w.error || w.policyRetried) && (
        <div className="border-t border-border p-2">
          {w.policyRetried && (
            <p className="mb-1 text-[11px] text-warning">
              ⚡ Policy Block Handled: Request was flagged by Google Content Policy (PROHIBITED_CONTENT). Automatically retried once using audio-stripped muted video copy and neutral frame alignment prompt.
            </p>
          )}
          {w.error && <p className="mb-1 text-[11px] text-destructive">{w.error}</p>}
          {w.raw && <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">{w.raw}</pre>}
        </div>
      )}
    </li>
  )
}
