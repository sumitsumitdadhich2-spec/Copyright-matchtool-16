'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import { ChevronLeft, ChevronRight, Clapperboard, Download, Loader2, Minus, Pause, Play, Plus, RotateCcw, Square, X } from 'lucide-react'
import { RENDER_FPS_OPTIONS, isRenderFps, type Scan, type RenderFps, type RenderResolution } from '@/lib/types'
import { fmtTime, fmtBytes } from '@/lib/format'
import { buildRenderSegments, type RenderSegment } from '@/lib/render-segments'
import { candidateOptionsFor, hasAlternatives } from '@/lib/candidate-pick'
import { computeShortCoverage } from '@/lib/short-coverage'
import { CandidateChooser } from './candidate-chooser'
import { ScanUsageReport } from './scan-usage-report'
import { ScanTimingReport } from './scan-timing-report'

const RESOLUTIONS: { value: RenderResolution; label: string; defaultKbps: number }[] = [
  { value: '480p', label: '480p (854×480)', defaultKbps: 2000 },
  { value: '720p', label: '720p (1280×720)', defaultKbps: 4500 },
  { value: '1080p', label: '1080p (1920×1080)', defaultKbps: 9000 },
  { value: '2k', label: '2K (2560×1440)', defaultKbps: 18000 },
  { value: '4k', label: '4K (3840×2160)', defaultKbps: 40000 },
]

const AUDIO_BITRATES = [96, 128, 192, 256, 320]

export function RenderPanel({ scan }: { scan: Scan }) {
  const segments = useMemo(() => buildRenderSegments(scan), [scan])
  const coverage = useMemo(() => computeShortCoverage(scan), [scan])

  // ---- Render settings ----
  const previousSettings = scan.renderJob?.settings
  const savedResolution = previousSettings?.resolution ?? '1080p'
  const savedFps: RenderFps = isRenderFps(previousSettings?.fps) ? previousSettings.fps : 24
  const savedVideoKbps = previousSettings?.videoBitrateKbps ?? 9000
  const savedAudioKbps = previousSettings?.audioBitrateKbps ?? 192
  const savedHeadPadding = previousSettings?.headPaddingSec ?? 0
  const savedTailPadding = previousSettings?.tailPaddingSec ?? 0
  const hasSavedSettings = Boolean(previousSettings)

  const [resolution, setResolution] = useState<RenderResolution>(savedResolution)
  const [fps, setFps] = useState<RenderFps>(savedFps)
  const [videoKbps, setVideoKbps] = useState(savedVideoKbps)
  const [audioKbps, setAudioKbps] = useState(savedAudioKbps)
  const [headPaddingSec, setHeadPaddingSec] = useState(savedHeadPadding)
  const [tailPaddingSec, setTailPaddingSec] = useState(savedTailPadding)
  const [bitrateTouched, setBitrateTouched] = useState(hasSavedSettings)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  // ---- Blob-based download state (never navigates the page) ----
  const [downloading, setDownloading] = useState(false)
  const [downloadPct, setDownloadPct] = useState<number | null>(null)
  const [downloadedBytes, setDownloadedBytes] = useState(0)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const { mutate } = useSWRConfig()

  const effectiveSegments = useMemo(() => {
    const headPad = Math.max(0, headPaddingSec)
    const tailPad = Math.max(0, tailPaddingSec)
    if (headPad === 0 && tailPad === 0) return segments
    const maxMovieDur = scan.movieDuration && scan.movieDuration > 0 ? scan.movieDuration : Infinity
    return segments.map((s) => {
      const movieStart = Math.max(0, s.movieStart - headPad)
      const movieEnd = Math.min(maxMovieDur, Math.max(movieStart + 0.05, s.movieEnd + tailPad))
      return {
        ...s,
        movieStart,
        movieEnd,
      }
    })
  }, [segments, headPaddingSec, tailPaddingSec, scan.movieDuration])

  const totalSeconds = useMemo(
    () => effectiveSegments.reduce((acc, s) => acc + Math.max(0, s.movieEnd - s.movieStart), 0),
    [effectiveSegments],
  )

  useEffect(() => {
    setResolution(savedResolution)
    setFps(savedFps)
    setVideoKbps(savedVideoKbps)
    setAudioKbps(savedAudioKbps)
    setHeadPaddingSec(savedHeadPadding)
    setTailPaddingSec(savedTailPadding)
    setBitrateTouched(hasSavedSettings)
  }, [scan.id, savedResolution, savedFps, savedVideoKbps, savedAudioKbps, savedHeadPadding, savedTailPadding, hasSavedSettings])

  function pickResolution(r: RenderResolution) {
    setResolution(r)
    if (!bitrateTouched) {
      setVideoKbps(RESOLUTIONS.find((x) => x.value === r)?.defaultKbps ?? 9000)
    }
  }

  const job = scan.renderJob
  const rendering = job?.status === 'rendering'
  const done = job?.status === 'done'
  const failed = job?.status === 'error'

  async function startRender() {
    setActionBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/scans/${scan.id}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resolution,
          fps,
          videoBitrateKbps: videoKbps,
          audioBitrateKbps: audioKbps,
          headPaddingSec,
          tailPaddingSec,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setActionError(j.error || 'Failed to start render')
      }
      void mutate(`/api/scans/${scan.id}`)
    } catch {
      setActionError('Failed to start render — network error')
    } finally {
      setActionBusy(false)
    }
  }

  async function cancelRender() {
    setActionBusy(true)
    try {
      await fetch(`/api/scans/${scan.id}/render/cancel`, { method: 'POST' })
      void mutate(`/api/scans/${scan.id}`)
    } finally {
      setActionBusy(false)
    }
  }

  /** Same-origin fetch → save to disk. NEVER uses window.open or a direct
   *  top-level navigation to the API route (that path gets blocked by preview
   *  auth with an "Unauthorized" redirect).
   *
   *  CRASH FIX: big MP4s assembled as an in-memory Blob crashed the tab right
   *  at the end of the download. When the browser supports the File System
   *  Access API (Chrome/Edge), the file now streams DIRECTLY to disk chunk by
   *  chunk — zero RAM buildup. The Blob path stays as the fallback for other
   *  browsers. */
  async function downloadRender() {
    if (downloading) return
    setDownloading(true)
    setDownloadError(null)
    setDownloadPct(0)
    setDownloadedBytes(0)
    let objectUrl: string | null = null
    try {
      const baseName = (scan.movieName || 'render').replace(/\.[^.]+$/, '')
      const fileName = `${baseName}-stitched-${job?.settings?.resolution || 'export'}.mp4`.replace(/[^\w.\- ]+/g, '_')

      // STREAM-TO-DISK path (no memory blob — big files safe).
      const picker = (window as unknown as { showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle> })
        .showSaveFilePicker
      if (typeof picker === 'function') {
        let handle: FileSystemFileHandle | null = null
        try {
          handle = await picker({
            suggestedName: fileName,
            types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
          })
        } catch (err) {
          // User cancelled the save dialog — not an error.
          if ((err as Error)?.name === 'AbortError') return
          handle = null // picker unusable (e.g. cross-origin iframe) — fall through to blob path
        }
        if (handle) {
          const res = await fetch(`/api/scans/${scan.id}/render/download?download=1`, { credentials: 'same-origin' })
          if (!res.ok) {
            setDownloadError(res.status === 404 ? 'Rendered file not found — render dobara chalao' : `Download failed (HTTP ${res.status})`)
            return
          }
          const total = Number(res.headers.get('Content-Length') || 0)
          const writable = await handle.createWritable()
          try {
            if (res.body) {
              const reader = res.body.getReader()
              let received = 0
              for (;;) {
                const { done: rdone, value } = await reader.read()
                if (rdone) break
                if (value) {
                  await writable.write(value)
                  received += value.byteLength
                  setDownloadedBytes(received)
                  if (total > 0) setDownloadPct(Math.min(100, Math.round((received / total) * 100)))
                }
              }
            }
            await writable.close()
            setDownloadPct(100)
          } catch (err) {
            try {
              await writable.abort()
            } catch {
              /* ignore */
            }
            throw err
          }
          return
        }
      }

      // FALLBACK (browsers without the File System Access API): blob assembly.
      const res = await fetch(`/api/scans/${scan.id}/render/download?download=1`, { credentials: 'same-origin' })
      if (!res.ok) {
        setDownloadError(res.status === 404 ? 'Rendered file not found — render dobara chalao' : `Download failed (HTTP ${res.status})`)
        return
      }
      const total = Number(res.headers.get('Content-Length') || 0)
      let blob: Blob
      if (res.body && total > 0) {
        // Stream with progress (file can be large).
        const reader = res.body.getReader()
        const parts: BlobPart[] = []
        let received = 0
        for (;;) {
          const { done: rdone, value } = await reader.read()
          if (rdone) break
          if (value) {
            parts.push(value)
            received += value.byteLength
            setDownloadedBytes(received)
            setDownloadPct(Math.min(100, Math.round((received / total) * 100)))
          }
        }
        blob = new Blob(parts, { type: 'video/mp4' })
      } else {
        blob = await res.blob()
        setDownloadPct(100)
        setDownloadedBytes(blob.size)
      }
      objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch {
      setDownloadError('Download failed — network error. Dobara try karo.')
    } finally {
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl as string), 10_000)
      setDownloading(false)
      setDownloadPct(null)
    }
  }

  if (segments.length === 0) return null

  const downloadBase = `/api/scans/${scan.id}/render/download`
  const elapsed = rendering && job?.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0

  return (
    <section aria-label="Render and export" className="panel">
      <div className="flex flex-wrap items-center gap-2">
        <Clapperboard className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Render — Stitched Movie Scenes</h2>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">{segments.length} scene(s)</span>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">{fmtTime(totalSeconds)} total</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Sab matched movie scenes short ke order me ek video ki tarah — neeche instant preview (bina processing),
        aur real export ORIGINAL movie quality se ffmpeg ke saath.
      </p>
      <div className="mt-2 rounded-md border border-border bg-background px-3 py-2 text-xs">
        <span className="font-semibold">Expected vs rendered:</span> {coverage.coveredSec.toFixed(1)}s of {coverage.totalSec.toFixed(1)}s short coverage is represented by {segments.length} scene(s).
        {coverage.gaps.length > 0 && <span className="text-warning"> Missing: {coverage.gaps.map((g) => `${fmtTime(g.start)}–${fmtTime(g.end)}`).join(', ')}</span>}
      </div>
      {scan.status === 'stopped' && (
        <p className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          PARTIAL RESULTS — scan stop hua hai. Ab tak jitne matches mile hain (verified + unverified dono) unka
          preview/export yahin ho sakta hai — mehnat safe hai. Resume karne par scan wahi se continue hoga.
        </p>
      )}

      <StitchedPreview scan={scan} segments={effectiveSegments} totalSeconds={totalSeconds} />

      {/* ---- Export controls ---- */}
      <div className="mt-4 rounded-md border border-border bg-background p-3">
        <h3 className="text-xs font-semibold">Export settings</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Resolution</span>
            <select
              value={resolution}
              onChange={(e) => pickResolution(e.target.value as RenderResolution)}
              disabled={rendering}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            >
              {RESOLUTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">FPS</span>
            <select
              value={fps}
              onChange={(event) => {
                const nextFps = Number(event.target.value)
                if (isRenderFps(nextFps)) setFps(nextFps)
              }}
              disabled={rendering}
              className="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs"
            >
              {RENDER_FPS_OPTIONS.map((rate) => (
                <option key={rate} value={rate}>
                  {rate} fps
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Video bitrate (kbps)</span>
            <input
              type="number"
              min={250}
              max={100000}
              step={250}
              value={videoKbps}
              onChange={(e) => {
                setBitrateTouched(true)
                setVideoKbps(Math.max(250, Math.min(100000, Math.round(Number(e.target.value) || 250))))
              }}
              disabled={rendering}
              className="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Audio bitrate</span>
            <select
              value={audioKbps}
              onChange={(e) => setAudioKbps(Number(e.target.value))}
              disabled={rendering}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            >
              {AUDIO_BITRATES.map((b) => (
                <option key={b} value={b}>
                  {b} kbps
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* ---- Clip Padding Controls (+ - Steppers) ---- */}
        <div className="mt-3 rounded-md border border-border/80 bg-muted/40 p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="text-xs font-semibold text-foreground">Clip Extra Padding (Per Scene)</span>
              <p className="text-[11px] text-muted-foreground">
                Har matched clip ke aage (Head) aur piche (Tail) extra movie footage add karein (same movie source, synced audio/video):
              </p>
            </div>
            {(headPaddingSec > 0 || tailPaddingSec > 0) && (
              <span className="rounded-full bg-primary/10 border border-primary/30 px-2 py-0.5 text-[11px] font-mono text-primary font-medium">
                Padding active: +{headPaddingSec}s head / +{tailPaddingSec}s tail
              </span>
            )}
          </div>

          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {/* Head / Start Padding (+ -) */}
            <div className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2">
              <div className="flex flex-col pr-2">
                <span className="text-xs font-medium text-foreground">Aage ki Padding (Start / Head)</span>
                <span className="text-[11px] text-muted-foreground">
                  {headPaddingSec > 0 ? `Movie start se pehle +${headPaddingSec}s extra` : 'Normal (0s extra start)'}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setHeadPaddingSec((prev) => Math.max(0, prev - 1))}
                  disabled={rendering || headPaddingSec <= 0}
                  className="flex h-7 w-7 items-center justify-center rounded border border-border bg-secondary text-foreground hover:bg-secondary/80 active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition-all cursor-pointer font-bold text-xs"
                  title="1 second aage se kam karein (-)"
                  aria-label="Decrease start padding"
                >
                  <Minus className="size-3.5" />
                </button>
                <span className="w-10 text-center font-mono text-xs font-semibold text-primary">
                  +{headPaddingSec}s
                </span>
                <button
                  type="button"
                  onClick={() => setHeadPaddingSec((prev) => Math.min(60, prev + 1))}
                  disabled={rendering || headPaddingSec >= 60}
                  className="flex h-7 w-7 items-center justify-center rounded border border-border bg-secondary text-foreground hover:bg-secondary/80 active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition-all cursor-pointer font-bold text-xs"
                  title="1 second aage add karein (+)"
                  aria-label="Increase start padding"
                >
                  <Plus className="size-3.5" />
                </button>
              </div>
            </div>

            {/* Tail / End Padding (+ -) */}
            <div className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2">
              <div className="flex flex-col pr-2">
                <span className="text-xs font-medium text-foreground">Piche ki Padding (End / Tail)</span>
                <span className="text-[11px] text-muted-foreground">
                  {tailPaddingSec > 0 ? `Movie end ke baad +${tailPaddingSec}s extra` : 'Normal (0s extra end)'}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setTailPaddingSec((prev) => Math.max(0, prev - 1))}
                  disabled={rendering || tailPaddingSec <= 0}
                  className="flex h-7 w-7 items-center justify-center rounded border border-border bg-secondary text-foreground hover:bg-secondary/80 active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition-all cursor-pointer font-bold text-xs"
                  title="1 second piche se kam karein (-)"
                  aria-label="Decrease end padding"
                >
                  <Minus className="size-3.5" />
                </button>
                <span className="w-10 text-center font-mono text-xs font-semibold text-primary">
                  +{tailPaddingSec}s
                </span>
                <button
                  type="button"
                  onClick={() => setTailPaddingSec((prev) => Math.min(60, prev + 1))}
                  disabled={rendering || tailPaddingSec >= 60}
                  className="flex h-7 w-7 items-center justify-center rounded border border-border bg-secondary text-foreground hover:bg-secondary/80 active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition-all cursor-pointer font-bold text-xs"
                  title="1 second piche add karein (+)"
                  aria-label="Increase end padding"
                >
                  <Plus className="size-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!rendering && (
            <button
              type="button"
              onClick={() => void startRender()}
              disabled={actionBusy}
              className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground disabled:opacity-40"
            >
              <Clapperboard className="size-3.5" aria-hidden />
              {done || failed ? 'Re-render & Export' : 'Render & Export'}
            </button>
          )}
          {rendering && (
            <button
              type="button"
              onClick={() => void cancelRender()}
              disabled={actionBusy}
              className="flex items-center gap-1.5 rounded-md border border-destructive/50 px-4 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-40"
            >
              <X className="size-3.5" aria-hidden /> Cancel render
            </button>
          )}
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            {resolution} · {fps}fps · {videoKbps}k video / {audioKbps}k audio
            {(headPaddingSec > 0 || tailPaddingSec > 0) ? ` · Pad: +${headPaddingSec}s/+${tailPaddingSec}s` : ''}
          </span>
        </div>

        {actionError && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {actionError}
          </p>
        )}

        {rendering && job && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />
                Rendering {job.segmentCount} scenes with ffmpeg (original movie quality source)...
              </span>
              <span className="font-mono">
                {job.pct}%
                {job.etaSeconds !== null && job.etaSeconds > 0 ? ` · ~${fmtTime(job.etaSeconds)} left` : ''}
                {elapsed > 0 ? ` · ${fmtTime(elapsed)} elapsed` : ''}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={job.pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${job.pct}%` }} />
            </div>
          </div>
        )}

        {failed && job?.error && (
          <p role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Render failed: {job.error}
          </p>
        )}

        {done && job && (
          <div className="mt-3 flex flex-col gap-2 rounded-md border border-success/40 bg-success/5 p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-success">Render complete</span>
              {job.fileSize !== null && <span className="font-mono text-muted-foreground">{fmtBytes(job.fileSize)}</span>}
              {job.settings && (
                <span className="font-mono text-muted-foreground">
                  {job.settings.resolution} · {job.settings.fps}fps · {job.settings.videoBitrateKbps}k
                </span>
              )}
              <button
                type="button"
                onClick={() => void downloadRender()}
                disabled={downloading}
                className="ml-auto flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
              >
                {downloading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
                {downloading ? `Downloading… ${downloadPct ?? 0}%` : 'Download MP4'}
              </button>
            </div>
            {downloading && (
              <div>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Fetching rendered file (same-origin, blob save)…</span>
                  <span className="font-mono">
                    {fmtBytes(downloadedBytes)}
                    {job.fileSize ? ` / ${fmtBytes(job.fileSize)}` : ''}
                  </span>
                </div>
                <div
                  className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuenow={downloadPct ?? 0}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${downloadPct ?? 0}%` }} />
                </div>
              </div>
            )}
            {downloadError && (
              <p role="alert" className="text-xs text-destructive">
                {downloadError}
              </p>
            )}
            <video
              key={job.finishedAt ?? 0}
              src={downloadBase}
              controls
              preload="metadata"
              playsInline
              className="aspect-video w-full rounded-md border border-border bg-black object-contain"
            />
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-4">
        <ScanTimingReport scan={scan} />
        <ScanUsageReport scan={scan} />
      </div>
    </section>
  )
}

// ---------- Instant stitched preview (zero processing) ----------

function StitchedPreview({
  scan,
  segments,
  totalSeconds,
}: {
  scan: Scan
  segments: RenderSegment[]
  totalSeconds: number
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [segIdx, setSegIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [stitchedPos, setStitchedPos] = useState(0)
  // CANDIDATE VIEW: null = the scene's MAIN window plays; a number = that
  // candidate window (from candidateOptions) is previewed in place of the scene.
  const [candIdx, setCandIdx] = useState<number | null>(null)

  // Seconds of stitched output before segment i starts.
  const offsets = useMemo(() => {
    const out: number[] = []
    let acc = 0
    for (const s of segments) {
      out.push(acc)
      acc += Math.max(0, s.movieEnd - s.movieStart)
    }
    return out
  }, [segments])

  // Every scene's alternative windows (candidates of the groups covering its short window).
  const optionsPerSegment = useMemo(
    () => segments.map((s) => candidateOptionsFor(scan, s.shortStart, s.shortEnd)),
    [scan, segments],
  )
  const current = segments[segIdx]
  const currentShortStartRef = useRef<number>(0)
  if (current) {
    currentShortStartRef.current = current.shortStart
  }
  const candidateOptions = optionsPerSegment[segIdx] ?? []
  const showChooser = hasAlternatives(candidateOptions)
  const viewing = candIdx === null ? null : candidateOptions[Math.min(candIdx, candidateOptions.length - 1)]
  // The window the player is clamped to right now.
  const activeStart = viewing ? viewing.movieStart : current?.movieStart ?? 0
  const activeEnd = viewing ? viewing.movieEnd : current?.movieEnd ?? 0

  // Preserve scene position when segment count changes (e.g. after user pick or scan updates).
  useEffect(() => {
    if (segments.length === 0) {
      setSegIdx(0)
      setPlaying(false)
      setStitchedPos(0)
      setCandIdx(null)
      return
    }
    const targetShort = currentShortStartRef.current
    const found = segments.findIndex((s) => Math.abs(s.shortStart - targetShort) < 0.35)
    if (found >= 0) {
      setSegIdx(found)
    } else {
      setSegIdx((prev) => Math.min(prev, Math.max(0, segments.length - 1)))
    }
    setCandIdx(null)
  }, [segments.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // A user pick can replace the current scene with a same-length movie window.
  // Seek immediately so the paused frame agrees with the refreshed MAIN label.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !current || candIdx !== null) return
    v.currentTime = current.movieStart
    setStitchedPos(offsets[segIdx] ?? 0)
    if (playing) void v.play()
  }, [current?.movieStart, current?.movieEnd, segIdx, candIdx]) // eslint-disable-line react-hooks/exhaustive-deps

  function seekToSegment(i: number, autoplay: boolean) {
    const v = videoRef.current
    const seg = segments[i]
    if (!v || !seg) return
    setSegIdx(i)
    setCandIdx(null)
    try {
      v.currentTime = seg.movieStart
    } catch {}
    if (autoplay) {
      void v.play().catch(() => {})
      setPlaying(true)
    }
  }

  /** Candidate browser → show that window (or back to main) at the same scene. */
  function viewCandidate(idx: number | null) {
    const v = videoRef.current
    setCandIdx(idx)
    const win = idx === null ? current : candidateOptions[idx]
    if (!v || !win) return
    try {
      v.currentTime = win.movieStart
    } catch {}
    if (playing) void v.play().catch(() => {})
  }

  function onTimeUpdate() {
    const v = videoRef.current
    const seg = segments[segIdx]
    if (!v || !seg || v.seeking) return
    if (viewing) {
      // Candidate preview: loop inside the candidate window only, never auto-advance.
      if (v.currentTime < activeStart - 0.3 || v.currentTime >= activeEnd - 0.05) {
        try { v.currentTime = activeStart } catch {}
        v.pause()
        setPlaying(false)
      }
      return
    }
    setStitchedPos(offsets[segIdx] + Math.max(0, v.currentTime - seg.movieStart))
    // Drifted before the window (user scrubbed native controls are hidden, but seek safety):
    if (v.currentTime < seg.movieStart - 0.5) {
      try { v.currentTime = seg.movieStart } catch {}
      return
    }
    // Segment finished — jump instantly to the next scene.
    if (v.currentTime >= seg.movieEnd - 0.05) {
      if (segIdx < segments.length - 1) {
        seekToSegment(segIdx + 1, true)
      } else {
        v.pause()
        setPlaying(false)
        seekToSegment(0, false)
      }
    }
  }

  function togglePlay() {
    const v = videoRef.current
    if (!v) return
    if (playing) {
      v.pause()
      setPlaying(false)
    } else {
      if (current && (v.currentTime < activeStart - 0.3 || v.currentTime >= activeEnd - 0.05)) {
        try { v.currentTime = activeStart } catch {}
      }
      void v.play().catch(() => {})
      setPlaying(true)
    }
  }

  function restart() {
    seekToSegment(0, playing)
    setStitchedPos(0)
  }

  return (
    <div className="mt-3 rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold">Instant stitched preview</h3>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px]">
          scene {segIdx + 1}/{segments.length}
        </span>
        {current && (
          <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px]">
            {viewing ? 'candidate' : 'movie'} {fmtTime(activeStart)}–{fmtTime(activeEnd)}
          </span>
        )}
        {showChooser && (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[10px] text-primary">
            {candidateOptions.length} candidates
          </span>
        )}
        {current && (current.userPick || candidateOptions.some((o) => o.isMain && o.isUserPick)) && (
          <span className="rounded-full bg-success/15 px-2 py-0.5 font-mono text-[10px] text-success">your choice</span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {fmtTime(stitchedPos)} / {fmtTime(totalSeconds)}
        </span>
      </div>

      <video
        ref={videoRef}
        src={`/api/scans/${scan.id}/media?kind=movie`}
        preload="metadata"
        playsInline
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={() => {
          const v = videoRef.current
          const seg = segments[0]
          if (v && seg && segIdx === 0 && !playing) v.currentTime = seg.movieStart
        }}
        className="mt-2 aspect-video w-full rounded-md border border-border bg-black object-contain"
      />

      {/* Proportional segment timeline */}
      <div className="mt-2 flex h-2.5 w-full gap-px overflow-hidden rounded-full" role="group" aria-label="Stitched scene timeline">
        {segments.map((s, i) => {
          const w = totalSeconds > 0 ? (Math.max(0, s.movieEnd - s.movieStart) / totalSeconds) * 100 : 0
          const active = i === segIdx
          const alts = hasAlternatives(optionsPerSegment[i] ?? [])
          return (
            <button
              key={`${s.movieStart}-${i}`}
              type="button"
              onClick={() => seekToSegment(i, playing)}
              title={`Scene ${i + 1}: movie ${fmtTime(s.movieStart)}–${fmtTime(s.movieEnd)} (short ${fmtTime(s.shortStart)}–${fmtTime(s.shortEnd)})${alts ? ` · ${optionsPerSegment[i].length} candidates` : ''}`}
              aria-label={`Jump to scene ${i + 1}${alts ? ' (has candidates)' : ''}`}
              className={`h-full min-w-1 transition-colors ${
                active ? 'bg-primary' : alts ? 'bg-primary/35 hover:bg-primary/60' : 'bg-muted hover:bg-primary/50'
              }`}
              style={{ width: `${w}%` }}
            />
          )
        })}
      </div>

      {/* CANDIDATE BROWSER — only for scenes that have alternative movie windows */}
      {showChooser && (
        <div className="mt-2">
          <CandidateChooser scan={scan} options={candidateOptions} viewIdx={candIdx} onView={viewCandidate} compact />
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={togglePlay}
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground"
        >
          {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          {playing ? 'Pause' : viewing ? 'Play candidate' : 'Play stitched'}
        </button>
        <button
          type="button"
          onClick={() => seekToSegment(segIdx - 1, playing)}
          disabled={segIdx === 0}
          aria-label="Previous scene"
          className="flex items-center gap-1 rounded-md border border-input px-2.5 py-2 text-xs font-medium hover:bg-secondary disabled:opacity-40"
        >
          <ChevronLeft className="size-3.5" aria-hidden /> Prev scene
        </button>
        <button
          type="button"
          onClick={() => seekToSegment(segIdx + 1, playing)}
          disabled={segIdx >= segments.length - 1}
          aria-label="Next scene"
          className="flex items-center gap-1 rounded-md border border-input px-2.5 py-2 text-xs font-medium hover:bg-secondary disabled:opacity-40"
        >
          Next scene <ChevronRight className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={restart}
          className="flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-xs font-medium hover:bg-secondary"
        >
          <RotateCcw className="size-3.5" aria-hidden /> Restart
        </button>
        <button
          type="button"
          onClick={() => {
            const v = videoRef.current
            if (v) {
              v.pause()
              setPlaying(false)
            }
            seekToSegment(0, false)
            setStitchedPos(0)
          }}
          className="flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-xs font-medium hover:bg-secondary"
        >
          <Square className="size-3.5" aria-hidden /> Stop
        </button>
        <span className="ml-auto text-[10px] text-muted-foreground">audio on · plays scenes back-to-back from the original movie</span>
      </div>
    </div>
  )
}
