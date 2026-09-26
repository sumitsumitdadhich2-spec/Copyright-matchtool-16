'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Play, Square, RotateCcw, Loader2, LogOut, ScanSearch, Settings, Users, ShieldCheck, ShieldX, Zap, ZapOff } from 'lucide-react'
import type { Scan, MinuteFinderMode } from '@/lib/types'
import { fetcher } from '@/lib/format'
import { useAuth } from '@/components/auth/auth-gate'
import { UsersDialog } from '@/components/auth/users-dialog'
import { TokenBadge, TokensExhaustedBanner, useTokens } from './token-badge'
import { SettingsDialog } from './settings-dialog'
import { UploadPanel } from './upload-panel'
import { TwelveLabsPanel } from './twelvelabs-panel'
import { MinuteFinderPanel } from './minute-finder-panel'
import { TrimPanel } from './trim-panel'
import { MinuteSelectPanel } from './minute-select-panel'
import { ScanTimeline } from './scan-timeline'
import { VerifierTimeline } from './verifier-timeline'
import { ModelBoard } from './model-board'
import { ChunkResultsPanel } from './chunk-results-panel'
import { CandidatesPanel } from './candidates-panel'
import { LogsPanel } from './logs-panel'
import { ReportPanel } from './report-panel'
import { ComparePanel } from './compare-panel'
import { RenderPanel } from './render-panel'
import { HistoryPanel } from './history-panel'
import { GapBackupPanel } from './gap-backup-panel'
import { LiveActivityBar } from './live-activity-bar'
import { TopMilestoneBanner } from './top-milestone-banner'
import { ErrorBoundary } from './error-boundary'

interface ScanResponse {
  scan: Scan
  running: boolean
  usage: Record<string, number> | null
}

export function Dashboard() {
  const [scanId, setScanId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usersOpen, setUsersOpen] = useState(false)
  const { user, logout } = useAuth()
  const { tokens, exhausted, refreshTokens } = useTokens()

  const { data, mutate } = useSWR<ScanResponse>(scanId ? `/api/scans/${scanId}` : null, fetcher, {
    refreshInterval: (latest) => {
      const st = latest?.scan?.status
      const rendering = latest?.scan?.renderJob?.status === 'rendering'
      const segmenting =
        latest?.scan?.shortSegmentingProgress !== undefined && latest.scan.shortSegmentingProgress < 100
      return st === 'scanning' || st === 'chunking' || latest?.running || latest?.scan?.background?.state === 'queued' || latest?.scan?.background?.state === 'running' || rendering || segmenting ? 1500 : 5000
    },
  })

  // Minute finder toggle (per-user setting): gemini (default) | twelvelabs | off.
  const { data: settings, mutate: mutateSettings } = useSWR<{
    minuteFinder?: MinuteFinderMode
    autoMode?: boolean
    verifierEnabled?: boolean
  }>('/api/settings', fetcher)
  const minuteFinderMode: MinuteFinderMode = settings?.minuteFinder ?? 'gemini'

  const scan = data?.scan || null
  const queued = scan?.background?.state === 'queued'
  const running = data?.running || scan?.background?.state === 'running'
  const status = scan?.status

  // Scan is BLOCKED when a normal user's tokens are exhausted (admin is unlimited).
  const scanBlocked = user.role !== 'admin' && exhausted
  const canStart = Boolean(scan && !running && !queued && status === 'ready' && scan.chunkCount > 0 && !scanBlocked)
  // Segments-aware: any incomplete minute (or any resumable chunk inside one) allows Resume.
  const hasResumableWork = Boolean(
    scan &&
      (scan.shortSegments?.length
        ? scan.shortSegments.some(
            (seg) =>
              seg.status !== 'done' ||
              (seg.chunks || []).some((c) => c.status === 'pending' || c.status === 'scanning' || c.status === 'cancelled'),
          )
        : (scan.chunks || []).some((c) => c.status === 'pending' || c.status === 'scanning' || c.status === 'cancelled')),
  )
  const canResume = Boolean(
    scan && !running && !queued && (status === 'stopped' || ((status === 'error' || status === 'scanning') && hasResumableWork)),
  )
  // Stop dab chuka hai lekin in-flight requests background me settle ho rahi hain —
  // partial results/export TURANT available hain, dobara Stop ki zaroorat nahi.
  const stoppingInBackground = Boolean(running && status === 'stopped')
  const canStop = running && !stoppingInBackground

  const verifierOn = scan ? scan.verifierEnabled !== false : settings?.verifierEnabled !== false
  const autoModeOn = scan ? scan.autoMode !== false : settings?.autoMode !== false

  async function toggleVerifier() {
    const nextState = !verifierOn
    if (scan && data) {
      void mutate({ ...data, scan: { ...scan, verifierEnabled: nextState } } as ScanResponse, false)
    }
    void mutateSettings((prev) => ({ ...(prev || {}), verifierEnabled: nextState }), false)
    try {
      const calls: Promise<unknown>[] = [
        fetch('/api/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ verifierEnabled: nextState }),
        }),
      ]
      if (scan) {
        calls.push(
          fetch(`/api/scans/${scan.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ verifierEnabled: nextState }),
          }),
        )
      }
      await Promise.all(calls)
    } catch {
      /* ignore and refresh below */
    } finally {
      void mutate()
      void mutateSettings()
    }
  }

  async function toggleAutoMode() {
    const nextState = !autoModeOn
    if (scan && data) {
      void mutate({ ...data, scan: { ...scan, autoMode: nextState } } as ScanResponse, false)
    }
    void mutateSettings((prev) => ({ ...(prev || {}), autoMode: nextState }), false)
    try {
      const calls: Promise<unknown>[] = [
        fetch('/api/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autoMode: nextState }),
        }),
      ]
      if (scan) {
        calls.push(
          fetch(`/api/scans/${scan.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ autoMode: nextState }),
          }),
        )
      }
      await Promise.all(calls)
    } catch {
      /* ignore and refresh below */
    } finally {
      void mutate()
      void mutateSettings()
    }
  }

  async function action(path: string, body?: object) {
    if (!scanId) return
    setBusy(true)
    setActionError(null)
    const res = await fetch(`/api/scans/${scanId}/${path}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    setBusy(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setActionError(j.error || 'Action failed')
    }
    void mutate()
    refreshTokens()
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-4 p-4 md:p-6">
      <TopMilestoneBanner scan={scan} onSelectScan={setScanId} />
      <header className="alert-in sticky top-3 z-20 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card/80 p-3 shadow-lg backdrop-blur-md md:px-4">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-md shadow-primary/30">
            <ScanSearch className="size-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-base font-semibold leading-tight tracking-tight md:text-lg">
              Shiva <span className="text-primary">MatchTool</span>
            </h1>
            <p className="hidden font-mono text-[11px] uppercase tracking-wider text-muted-foreground sm:block">
              AI scanner · 1 prompt/min · 24 fps
            </p>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <TokenBadge tokens={tokens} />
          {queued && (
            <span className="flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Queued{scan?.background?.position ? ` · position ${scan.background.position}` : ''}
            </span>
          )}
          {(status === 'scanning' || status === 'verifying') && (
            <>
              <span className="pill-live flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/15 px-3 py-1 text-xs font-medium text-primary">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {(() => {
                  const segCount = scan?.shortSegments?.length ?? 0
                  const minute =
                    segCount > 1 ? ` minute ${(scan?.currentShortSegment ?? 0) + 1}/${segCount}` : ''
                  return status === 'verifying' ? `Verifying${minute} at 24 fps...` : `Scanning${minute}...`
                })()}
              </span>
              {/* Verify pipeline runs IN PARALLEL with chunk scanning — show its own status. */}
              {status === 'scanning' &&
                (() => {
                  const active = (scan?.candidateGroups || []).filter(
                    (g) => g.status === 'pending' || g.status === 'verifying' || g.status === 'rescanning',
                  ).length
                  return active > 0 ? (
                    <span className="flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/15 px-3 py-1 text-xs font-medium text-warning">
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      Verify pipeline: {active} group(s)
                    </span>
                  ) : null
                })()}
            </>
          )}
          {stoppingInBackground && (
            <span className="flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/15 px-3 py-1 text-xs font-medium text-warning">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Stopping — partial results ready (export niche available)
            </span>
          )}
          <button
            type="button"
            onClick={toggleAutoMode}
            disabled={busy}
            className={`btn-press flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-semibold transition-all shadow-sm ${
              autoModeOn
                ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 shadow-cyan-950/25'
                : 'border-zinc-700 bg-zinc-800/90 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
            title={
              autoModeOn
                ? 'Auto Scan is ON: Full movie & short auto-accepted, scans start automatically upon upload without manual steps. Click to turn OFF.'
                : 'Auto Scan is OFF: Manual movie trimming and minute selection enabled. Click to turn ON.'
            }
            aria-label={`Auto Scan is currently ${autoModeOn ? 'ON' : 'OFF'}. Click to toggle.`}
          >
            {autoModeOn ? (
              <Zap className="size-4 text-cyan-400" aria-hidden />
            ) : (
              <ZapOff className="size-4 text-zinc-400" aria-hidden />
            )}
            <span className="font-medium">Auto:</span>
            <span
              className={`rounded px-1.5 py-0.5 text-xs font-black uppercase tracking-wider ${
                autoModeOn ? 'bg-cyan-500 text-cyan-950' : 'bg-zinc-700 text-zinc-200'
              }`}
            >
              {autoModeOn ? 'ON' : 'OFF'}
            </span>
          </button>

          <button
            type="button"
            onClick={toggleVerifier}
            disabled={busy}
            className={`btn-press flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-semibold transition-all shadow-sm ${
              verifierOn
                ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 shadow-emerald-950/25'
                : 'border-zinc-700 bg-zinc-800/90 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
            title={
              verifierOn
                ? 'Verifier is ON (automatic 24fps AI check after chunks). Click to turn OFF.'
                : 'Verifier is OFF (no AI verify after chunks — instant raw matches). Click to turn ON.'
            }
            aria-label={`Verifier is currently ${verifierOn ? 'ON' : 'OFF'}. Click to toggle.`}
          >
            {verifierOn ? (
              <ShieldCheck className="size-4 text-emerald-400" aria-hidden />
            ) : (
              <ShieldX className="size-4 text-zinc-400" aria-hidden />
            )}
            <span className="font-medium">Verifier:</span>
            <span
              className={`rounded px-1.5 py-0.5 text-xs font-black uppercase tracking-wider ${
                verifierOn ? 'bg-emerald-500 text-emerald-950' : 'bg-zinc-700 text-zinc-200'
              }`}
            >
              {verifierOn ? 'ON' : 'OFF'}
            </span>
          </button>
          <button
            type="button"
            onClick={() => action('start')}
            disabled={!canStart || busy}
            className="btn-press flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/25 hover:shadow-lg hover:shadow-primary/30 disabled:opacity-40 disabled:shadow-none"
          >
            <Play className="size-4" aria-hidden /> Start scan
          </button>
          <button
            type="button"
            onClick={() => action('start', { resume: true })}
            disabled={!canResume || busy}
            className="btn-press flex items-center gap-1.5 rounded-lg border border-input bg-card px-4 py-2 text-sm font-medium hover:border-primary/40 hover:bg-secondary disabled:opacity-40"
          >
            <RotateCcw className="size-4" aria-hidden /> Resume
          </button>
          <button
            type="button"
            onClick={() => action('stop')}
            disabled={!canStop || busy}
            className="btn-press flex items-center gap-1.5 rounded-lg border border-destructive/50 bg-card px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-40"
          >
            <Square className="size-4" aria-hidden /> Stop
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
            title="Settings — API keys"
            className="btn-press flex items-center gap-1.5 rounded-lg border border-input bg-card px-3 py-2 text-sm font-medium hover:border-primary/40 hover:bg-secondary"
          >
            <Settings className="size-4" aria-hidden />
            <span className="hidden sm:inline">Settings</span>
          </button>
          {user.role === 'admin' && (
            <button
              type="button"
              onClick={() => setUsersOpen(true)}
              aria-label="Manage users"
              title="Manage users — create and control IDs"
              className="btn-press flex items-center gap-1.5 rounded-lg border border-input bg-card px-3 py-2 text-sm font-medium hover:border-primary/40 hover:bg-secondary"
            >
              <Users className="size-4" aria-hidden />
              <span className="hidden sm:inline">Users</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => logout()}
            aria-label={`Log out ${user.username}`}
            title={`Logged in as ${user.username} — log out`}
            className="btn-press flex items-center gap-1.5 rounded-lg border border-input bg-card px-3 py-2 text-sm font-medium hover:border-destructive/40 hover:bg-secondary"
          >
            <LogOut className="size-4" aria-hidden />
            <span className="hidden sm:inline">{user.username}</span>
          </button>
        </div>
      </header>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {user.role === 'admin' && <UsersDialog open={usersOpen} onClose={() => setUsersOpen(false)} />}

      {scanBlocked && <TokensExhaustedBanner tokens={tokens} />}

      {actionError && (
        <p role="alert" className="alert-in rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </p>
      )}
      {scan?.error && (
        <p role="alert" className="alert-in rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Scan error: {scan.error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <ErrorBoundary fallbackTitle="Scan view error">
            {scan && <LiveActivityBar scan={scan} />}
            {scan && (
              <MinuteFinderPanel
                scan={scan}
                mode={minuteFinderMode}
                onModeChanged={(m) => void mutateSettings((prev) => ({ ...(prev || {}), minuteFinder: m }), { revalidate: true })}
              />
            )}
            {/* Old TwelveLabs auto pipeline — only behind the toggle (zero changes inside). */}
            {scan && minuteFinderMode === 'twelvelabs' && <TwelveLabsPanel scan={scan} />}
            <UploadPanel scan={scan} selectedScanId={scanId} onScanCreated={(id) => setScanId(id)} refresh={() => void mutate()} />
            {scan && scan.awaitingTrim && !autoModeOn && scan.movieDuration && scan.status !== 'chunking' && (
              <TrimPanel scan={scan} refresh={() => void mutate()} />
            )}
            {scan && (scan.shortSegments?.length ?? 0) > 1 && !scan.awaitingTrim && !autoModeOn && (
              <MinuteSelectPanel scan={scan} running={running} refresh={() => void mutate()} />
            )}
            <ScanTimeline scan={scan || emptyScan()} />
            <VerifierTimeline scan={scan || emptyScan()} />
            <ModelBoard scan={scan} usage={data?.usage || null} />
            {scan && <CandidatesPanel scan={scan} />}
            {scan && scan.report && <ReportPanel scan={scan} />}
            {scan && (scan.status === 'done' || scan.status === 'stopped') && <GapBackupPanel scan={scan} />}
            {scan && (scan.matches?.length ?? 0) > 0 && <ComparePanel scan={scan} />}
            {scan && (scan.status === 'done' || scan.status === 'stopped') && (scan.matches?.length ?? 0) > 0 && (
              <RenderPanel scan={scan} />
            )}
            {scan && <ChunkResultsPanel scan={scan} />}
            {scan && <LogsPanel scan={scan} />}
          </ErrorBoundary>
        </div>
        <div className="flex flex-col gap-4">
          <ErrorBoundary fallbackTitle="History error">
            <HistoryPanel
              activeId={scanId}
              onSelect={(id) => setScanId(id)}
              onNew={() => {
                setScanId(null)
                setActionError(null)
              }}
            />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  )
}

function emptyScan(): Scan {
  return {
    id: '',
    createdAt: 0,
    status: 'created',
    shortName: null,
    movieName: null,
    shortSize: null,
    movieSize: null,
    shortDuration: null,
    movieDuration: null,
    chunkCount: 0,
    chunkingProgress: 0,
    chunks: [],
    matches: [],
    candidateGroups: [],
    logs: [],
    startedAt: null,
    finishedAt: null,
    error: null,
    report: null,
    modelStates: {},
  }
}
