'use client'

import { useEffect, useRef, useState, type DragEvent } from 'react'
import { useSWRConfig } from 'swr'
import { Film, Clapperboard, Loader2, CheckCircle2, X, RefreshCw, WifiOff, Zap, FolderOpen } from 'lucide-react'
import type { Scan } from '@/lib/types'
import { fmtTime, fmtBytes } from '@/lib/format'
import { uploadVideoStream, fmtMbps, fmtEta, UploadError, type UploadProgress, type UploadKind } from '@/lib/upload-client'

interface Props {
  scan: Scan | null
  /** The dashboard's selected scan id — null means "new scan", so a fresh scan must be created on upload. */
  selectedScanId: string | null
  onScanCreated: (id: string) => void
  refresh: () => void
}

type Kind = UploadKind

/** Info shown the INSTANT a file is picked — read locally in the browser, no
 *  server round-trip. Replaced by the server's data once the upload lands. */
interface LocalPick {
  name: string
  size: number
  /** Duration read from the browser's video decoder; null while loading /
   *  when the container can't be parsed client-side (e.g. some MKVs or 4K Blu-ray). */
  duration: number | null
}

interface Job {
  key: string
  scanId: string | null
  kind: Kind
  progress: UploadProgress
}

/** Comprehensive list of supported video formats — Blu-ray, 4K/2K, MKV, M2TS, MP4, etc. */
export const ALL_VIDEO_EXTENSIONS = [
  '.mp4',
  '.mkv',
  '.m2ts',
  '.mts',
  '.ts',
  '.mov',
  '.webm',
  '.avi',
  '.wmv',
  '.m4v',
  '.flv',
  '.f4v',
  '.vob',
  '.mpg',
  '.mpeg',
  '.m2v',
  '.3gp',
  '.3g2',
  '.ogv',
  '.divx',
  '.asf',
  '.rm',
  '.rmvb',
  '.dat',
  '.iso',
]

/** Broad accept filter for file pickers (including video types and universal wildcard) */
const ACCEPT_ALL_VIDEOS =
  'video/*,.mkv,.mp4,.mov,.webm,.m2ts,.mts,.ts,.avi,.wmv,.flv,.m4v,.3gp,.3g2,.vob,.mpg,.mpeg,.divx,.asf,.rmvb,*/*'

function isAllowedVideo(f: File): boolean {
  if (!f || f.size === 0) return false
  const name = (f.name || '').toLowerCase()

  // 1. Matches any known video extension
  if (ALL_VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext))) return true

  // 2. Matches video MIME type or common video container MIME
  const type = (f.type || '').toLowerCase()
  if (type.startsWith('video/')) return true
  if (
    type.includes('matroska') ||
    type.includes('mp4') ||
    type.includes('quicktime') ||
    type.includes('webm') ||
    type.includes('mpeg') ||
    type.includes('m2ts') ||
    type.includes('avi')
  ) {
    return true
  }

  // 3. Exclude obvious non-video files
  const nonVideoExt = [
    '.txt', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.zip', '.rar', '.7z', '.tar', '.gz', '.apk', '.exe',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
    '.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg',
    '.srt', '.vtt', '.ass', '.sub',
  ]
  if (nonVideoExt.some((ext) => name.endsWith(ext))) return false

  // 4. Any other file picked by the user via file manager or storage is accepted:
  // FFmpeg on the server will definitively verify and probe it.
  return true
}

/** Read the video's duration in the browser (usually < 100 ms — it only parses
 *  the header, never the whole file). Resolves null if the browser can't (e.g. 4K HEVC or unsupported MKVs). */
function readLocalDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false
    let url = ''
    try {
      url = URL.createObjectURL(file)
    } catch {
      resolve(null)
      return
    }
    const v = document.createElement('video')
    v.preload = 'metadata'
    const finish = (d: number | null) => {
      if (settled) return
      settled = true
      try {
        URL.revokeObjectURL(url)
        v.removeAttribute('src')
        v.load()
      } catch {
        // ignore
      }
      resolve(d)
    }
    v.onloadedmetadata = () => finish(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null)
    v.onerror = () => finish(null)
    // Quick timeout: don't hang if hardware cannot decode 4K/MKV locally
    setTimeout(() => finish(null), 2500)
    try {
      v.src = url
    } catch {
      finish(null)
    }
  })
}

// ---- The ONLY upload path: browser → app server (EC2) → EBS disk, as ONE
// continuous stream (see lib/upload-client.ts). No chunk slicing: the whole
// file goes out in a single request body at whatever speed the connection
// gives. If the connection drops or stalls, the browser asks the server how
// many bytes already landed and continues from exactly there. ffprobe starts
// the instant the last byte lands; the S3 backup happens in the background.

export function UploadPanel({ scan, selectedScanId, onScanCreated, refresh }: Props) {
  const { mutate: mutateCache } = useSWRConfig()
  const [jobs, setJobs] = useState<Job[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [local, setLocal] = useState<Record<string, LocalPick>>({})
  const [reused, setReused] = useState<Record<string, boolean>>({})
  const controllers = useRef(new Map<string, AbortController>())
  const scanIdRef = useRef<string | null>(selectedScanId)
  const creatingScanRef = useRef<Promise<string> | null>(null)

  useEffect(() => {
    scanIdRef.current = selectedScanId
  }, [selectedScanId])

  const uploading = jobs.length > 0
  useEffect(() => {
    if (!uploading) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [uploading])

  async function ensureScan(): Promise<string> {
    if (scanIdRef.current) return scanIdRef.current
    if (creatingScanRef.current) return creatingScanRef.current
    creatingScanRef.current = (async () => {
      const res = await fetch('/api/scans', { method: 'POST' })
      if (res.status === 401) throw new UploadError('Session expired — please log in again', true)
      const j = (await res.json().catch(() => ({}))) as { id?: unknown; error?: string }
      if (!res.ok || typeof j.id !== 'string' || j.id.length === 0) throw new UploadError(j.error || `Could not create a scan (HTTP ${res.status}). Please try again.`, true)
      scanIdRef.current = j.id
      onScanCreated(j.id)
      return j.id
    })().finally(() => {
      creatingScanRef.current = null
    })
    return creatingScanRef.current
  }

  function uploadFile(kind: Kind, file: File) {
    const initialScanId = scanIdRef.current
    const tempKey = `${initialScanId ?? 'new'}/${kind}`
    if (!isAllowedVideo(file)) {
      setErrors((previous) => ({
        ...previous,
        [tempKey]: 'Please select a valid video file (MP4, MKV, M2TS, TS, AVI, MOV, WebM, 4K/Blu-ray, etc.)',
      }))
      return
    }
    const controller = new AbortController()
    controllers.current.set(tempKey, controller)
    setErrors((previous) => { const next = { ...previous }; delete next[tempKey]; return next })
    const initialProgress: UploadProgress = { phase: 'probing', sent: 0, total: file.size, bytesPerSec: null, peakBytesPerSec: 0, avgBytesPerSec: null, etaSec: null, reconnects: 0, resumedFrom: 0, offline: false }
    setJobs((previous) => [...previous.filter((item) => item.key !== tempKey), { key: tempKey, scanId: initialScanId, kind, progress: initialProgress }])
    setReused((previous) => ({ ...previous, [tempKey]: false }))
    setLocal((previous) => ({ ...previous, [tempKey]: { name: file.name, size: file.size, duration: null } }))
    void readLocalDuration(file).then((duration) => setLocal((previous) => previous[tempKey]?.name === file.name ? { ...previous, [tempKey]: { ...previous[tempKey], duration } } : previous))

    void (async () => {
      let key = tempKey
      try {
        const id = await ensureScan()
        key = `${id}/${kind}`
        if (key !== tempKey) {
          controllers.current.delete(tempKey)
          controllers.current.set(key, controller)
          setJobs((previous) => previous.map((item) => item.key === tempKey ? { ...item, key, scanId: id } : item))
          setLocal((previous) => {
            const next = { ...previous, [key]: previous[tempKey] }
            delete next[tempKey]
            return next
          })
          setReused((previous) => {
            const next = { ...previous, [key]: previous[tempKey] || false }
            delete next[tempKey]
            return next
          })
          setErrors((previous) => {
            if (!previous[tempKey]) return previous
            const next = { ...previous, [key]: previous[tempKey] }
            delete next[tempKey]
            return next
          })
        }
        const result = await uploadVideoStream({
          scanId: id,
          kind,
          file,
          signal: controller.signal,
          onProgress: (progress) => setJobs((previous) => previous.map((item) => item.key === key ? { ...item, progress } : item)),
        })
        setJobs((previous) => previous.filter((item) => item.key !== key))
        setReused((previous) => ({ ...previous, [key]: result.reused }))
        setErrors((previous) => { const next = { ...previous }; delete next[key]; delete next[tempKey]; return next })
        await Promise.all([mutateCache(`/api/scans/${id}`), mutateCache('/api/scans')])
        if (scanIdRef.current === id) refresh()
      } catch (err) {
        setJobs((previous) => previous.filter((item) => item.key !== key && item.key !== tempKey))
        if (!controller.signal.aborted) {
          const message = err instanceof Error ? err.message : 'Upload failed. Please try again.'
          setErrors((previous) => ({ ...previous, [key]: message }))
        }
        const failedScanId = key.split('/')[0]
        if (failedScanId && failedScanId !== 'new') {
          await Promise.all([mutateCache(`/api/scans/${failedScanId}`), mutateCache('/api/scans')])
          if (scanIdRef.current === failedScanId) refresh()
        }
      } finally {
        controllers.current.delete(key)
        controllers.current.delete(tempKey)
      }
    })()
  }

  function cancelUpload(kind: Kind) {
    const visible = jobs.find((item) => item.scanId === selectedScanId && item.kind === kind)
    if (visible) controllers.current.get(visible.key)?.abort()
  }

  const chunking = scan?.status === 'chunking'

  // Every card reads only its selected scan + media-kind job. Uploads for other
  // history entries keep running in the same component without leaking progress.
  const scope = selectedScanId ?? 'new'
  const shortKey = `${scope}/short`
  const movieKey = `${scope}/movie`
  const shortLocal = local[shortKey]
  const movieLocal = local[movieKey]
  const shortJob = jobs.find((item) => item.key === shortKey) ?? null
  const movieJob = jobs.find((item) => item.key === movieKey) ?? null
  const shortServer = Boolean(scan?.shortName && scan?.shortDuration)
  const movieServer = Boolean(scan?.movieName && scan?.movieDuration)
  const visibleErrors = [errors[shortKey], errors[movieKey]].filter((message): message is string => Boolean(message))

  return (
    <section aria-label="Upload videos" className="panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Source Files</h2>
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
            ✓ All formats supported: MKV, Blu-ray (M2TS/TS), 4K/2K, MP4, AVI, MOV, WebM, etc.
          </span>
        </div>
        {scan?.autoMode !== false ? (
          <span className="flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-cyan-300">
            <Zap className="size-3 text-cyan-400" aria-hidden />
            Auto Scan: Full movie & clip will automatically scan on upload
          </span>
        ) : null}
      </div>

      <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-2.5 text-xs text-muted-foreground">
        <FolderOpen className="size-4 shrink-0 text-primary mt-0.5" aria-hidden />
        <p className="leading-relaxed">
          <strong className="text-foreground font-semibold">Tablet / Android Tip:</strong> Agar aapke tablet ki Gallery me 2K / 4K ya MKV Blu-ray movie na dikhe (kyunki Gallery unhe filter kar deti hai), to card me diye gaye <strong className="text-foreground">&ldquo;Browse Storage / All Files&rdquo;</strong> button par click karein aur apne Downloads ya Internal Storage se file select karein.
        </p>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Dropzone
          kind="short"
          icon={<Film className="size-5" aria-hidden />}
          title="Short video"
          subtitle="The clip to find — any length, scanned minute-by-minute (original quality preserved)"
          name={shortServer ? scan?.shortName : shortLocal?.name}
          duration={shortServer ? scan?.shortDuration : shortLocal?.duration}
          size={shortServer ? scan?.shortSize : shortLocal?.size}
          progress={shortJob?.progress ?? null}
          disabled={shortJob !== null || shortServer}
          onFile={(f) => uploadFile('short', f)}
          onCancel={() => cancelUpload('short')}
          extraInfo={[
            reused[shortKey] ? 'Already on server — linked instantly, nothing uploaded' : null,
            scan?.shortSegments && scan.shortSegments.length > 1 ? `${scan.shortSegments.length} minutes — scanned minute-by-minute` : null,
          ]
            .filter(Boolean)
            .join(' · ') || undefined}
        />
        <Dropzone
          kind="movie"
          icon={<Clapperboard className="size-5" aria-hidden />}
          title="Movie"
          subtitle="Any length — chunked into 1-min pieces"
          name={movieServer ? scan?.movieName : movieLocal?.name}
          duration={movieServer ? scan?.movieDuration : movieLocal?.duration}
          size={movieServer ? scan?.movieSize : movieLocal?.size}
          progress={movieJob?.progress ?? null}
          disabled={movieJob !== null || movieServer}
          onFile={(f) => uploadFile('movie', f)}
          onCancel={() => cancelUpload('movie')}
          extraInfo={reused[movieKey] ? 'Already on server — linked instantly, nothing uploaded' : undefined}
        />
      </div>
      {chunking && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />
              ffmpeg chunking movie into {scan?.chunkCount} one-minute chunks...
            </span>
            <span className="font-mono">{scan?.chunkingProgress}%</span>
          </div>
          <div className="progress-track mt-1.5" role="progressbar" aria-valuenow={scan?.chunkingProgress}>
            <div className="progress-fill" style={{ width: `${scan?.chunkingProgress || 0}%` }} />
          </div>
        </div>
      )}
      {scan?.shortSegmentingProgress !== undefined && scan.shortSegmentingProgress < 100 && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />
              ffmpeg cutting short into {scan?.shortSegments?.length ?? 1} one-minute scan segment(s) — original untouched...
            </span>
            <span className="font-mono">{scan.shortSegmentingProgress}%</span>
          </div>
          <div className="progress-track mt-1.5" role="progressbar" aria-valuenow={scan.shortSegmentingProgress}>
            <div className="progress-fill" style={{ width: `${scan.shortSegmentingProgress}%` }} />
          </div>
        </div>
      )}
      {visibleErrors.map((message) => <p key={message} role="alert" className="mt-2 text-xs text-destructive">{message}</p>)}
    </section>
  )
}

function Dropzone(props: {
  kind: Kind
  icon: React.ReactNode
  title: string
  subtitle: string
  name?: string | null
  duration?: number | null
  size?: number | null
  /** Live upload stats while THIS card is uploading, null otherwise. */
  progress: UploadProgress | null
  disabled: boolean
  onFile: (f: File) => void
  onCancel: () => void
  extraInfo?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const allFilesInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const uploading = props.progress !== null
  // A file is "picked" as soon as we know its name — locally or from the server.
  const picked = Boolean(props.name)
  const done = picked && !uploading

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f && !props.disabled) props.onFile(f)
  }

  return (
    <div className="relative">
      {/* Hidden file inputs: broad video types and direct storage/all files */}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ALL_VIDEOS}
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) props.onFile(f)
          e.target.value = ''
        }}
      />
      <input
        ref={allFilesInputRef}
        type="file"
        accept="*/*"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) props.onFile(f)
          e.target.value = ''
        }}
      />

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`flex w-full flex-col items-start gap-2 rounded-lg border border-dashed p-4 text-left transition-all ${
          dragOver
            ? 'scale-[1.01] border-primary bg-primary/10'
            : done
              ? 'border-success/40 bg-success/5'
              : picked
                ? 'border-primary/50 bg-primary/5'
                : 'border-input hover:border-primary/60 hover:bg-primary/5'
        } ${props.disabled ? 'opacity-60' : ''}`}
      >
        <div className="flex w-full items-center gap-2">
          <span className={done ? 'text-success' : 'text-primary'}>{done ? <CheckCircle2 className="size-5" aria-hidden /> : props.icon}</span>
          <span className="text-sm font-medium">{props.title}</span>
          {props.progress && (
            <span className="ml-auto mr-7 flex items-center gap-1 font-mono text-xs text-primary">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              {Math.floor((props.progress.sent / props.progress.total) * 100)}%
            </span>
          )}
        </div>

        {picked ? (
          <>
            <div className="w-full truncate font-mono text-xs text-muted-foreground">
              {props.name} · {props.duration ? fmtTime(props.duration) : 'Checking on server…'} · {props.size ? fmtBytes(props.size) : ''}
            </div>
            {props.progress ? (
              <UploadMeter p={props.progress} />
            ) : (
              props.extraInfo && <span className="text-[11px] text-primary">{props.extraInfo}</span>
            )}
          </>
        ) : (
          <div className="flex w-full flex-col gap-2">
            <span className="text-xs text-muted-foreground">{props.subtitle}</span>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={props.disabled}
                className="btn-press inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors cursor-pointer disabled:opacity-50"
                title="Select video using default gallery/files"
              >
                <Film className="size-3.5" aria-hidden /> Select Video
              </button>

              <button
                type="button"
                onClick={() => allFilesInputRef.current?.click()}
                disabled={props.disabled}
                className="btn-press inline-flex items-center gap-1.5 rounded-md border border-input bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:border-primary/60 hover:bg-secondary transition-colors cursor-pointer shadow-xs disabled:opacity-50"
                title="Open System File Manager (All Files / Storage) — bypasses gallery filters for 2K/4K Blu-ray & MKV"
              >
                <FolderOpen className="size-3.5 text-primary" aria-hidden /> Browse Storage (MKV · 4K · Blu-ray)
              </button>
            </div>
            <span className="text-[10px] text-muted-foreground/80">
              Drag & drop or select any video format: MKV, M2TS, TS, 4K/2K, MP4, AVI, MOV, WebM, etc.
            </span>
          </div>
        )}
      </div>

      {uploading && (
        <button
          type="button"
          onClick={props.onCancel}
          aria-label={`Cancel ${props.title.toLowerCase()} upload`}
          title="Cancel upload"
          className="absolute right-3 top-3 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive cursor-pointer"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  )
}

/** Live speed / progress readout under the file name while uploading. */
function UploadMeter({ p }: { p: UploadProgress }) {
  const pct = Math.min(100, (p.sent / p.total) * 100)
  const live = p.phase === 'uploading' && p.bytesPerSec !== null

  let status: string
  switch (p.phase) {
    case 'probing':
      status = p.reconnects > 0 ? 'Checking what already reached the server…' : 'Connecting…'
      break
    case 'reconnecting':
      status = p.offline
        ? `No internet — waiting for the connection to come back (will resume from ${fmtBytes(p.sent)})`
        : `Connection dropped — resuming from ${fmtBytes(p.sent)} (retry ${p.reconnects})`
      break
    case 'finalizing':
      status = 'All bytes sent — server is verifying the file…'
      break
    case 'linking':
      status = 'Same video already on the server from an earlier scan — linking it, no upload needed…'
      break
    default:
      status =
        p.resumedFrom > 0
          ? `Resumed from ${fmtBytes(p.resumedFrom)} — one continuous stream, you can keep working`
          : 'One continuous stream — you can keep working'
  }

  const trouble = p.phase === 'reconnecting'

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div
        className="progress-track"
        role="progressbar"
        aria-label="Upload progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.floor(pct)}
      >
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-xs tabular-nums">
        {/* Live line speed — the number to compare with your internet plan. */}
        <span
          className={`text-base font-semibold leading-none ${live ? 'text-primary' : 'text-muted-foreground'}`}
          aria-live="polite"
          aria-label="Current upload speed"
        >
          {live ? fmtMbps(p.bytesPerSec!) : p.phase === 'uploading' ? 'measuring…' : p.phase === 'linking' ? 'instant' : '— Mbps'}
        </span>
        {live && <span className="text-muted-foreground">{fmtBytes(p.bytesPerSec!)}/s</span>}
        <span className="text-muted-foreground">
          {fmtBytes(p.sent)} / {fmtBytes(p.total)}
        </span>
        {p.etaSec !== null && <span className="ml-auto text-muted-foreground">{fmtEta(p.etaSec)}</span>}
        {(p.phase === 'finalizing' || p.phase === 'linking') && (
          <span className="ml-auto flex items-center gap-1 text-muted-foreground">
            <Loader2 className="size-3 animate-spin" aria-hidden /> {p.phase === 'linking' ? 'linking' : 'verifying'}
          </span>
        )}
      </div>
      <span className={`flex items-center gap-1 text-[11px] ${trouble ? 'text-destructive' : 'text-primary'}`}>
        {trouble && (p.offline ? <WifiOff className="size-3" aria-hidden /> : <RefreshCw className="size-3 animate-spin" aria-hidden />)}
        <span className="truncate">{status}</span>
        {p.phase === 'uploading' && (p.avgBytesPerSec !== null || p.peakBytesPerSec > 0) && (
          <span className="ml-auto shrink-0 font-mono text-muted-foreground">
            {p.avgBytesPerSec !== null && <>avg {fmtMbps(p.avgBytesPerSec)}</>}
            {p.avgBytesPerSec !== null && p.peakBytesPerSec > 0 && ' · '}
            {p.peakBytesPerSec > 0 && <>peak {fmtMbps(p.peakBytesPerSec)}</>}
          </span>
        )}
      </span>
    </div>
  )
}
