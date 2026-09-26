'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Film, CheckCircle2, Video, Sparkles, Download, X } from 'lucide-react'
import type { Scan } from '@/lib/types'

export type MilestoneType =
  | 'chunks_cut'
  | 'movie_copy_complete'
  | 'scan_complete'
  | 'missing_scene_complete'
  | 'export_complete'

export interface MilestoneNotification {
  id: string
  type: MilestoneType
  scanId: string
  scanName: string
  title: string
  message: string
  createdAt: number
}

export function getScanDisplayName(scan: { customName?: string | null; shortName?: string | null; movieName?: string | null; id?: string } | null | undefined): string {
  if (!scan) return 'Scan'
  if (scan.customName && scan.customName.trim()) return scan.customName.trim()
  if (scan.shortName && scan.shortName.trim()) return scan.shortName.trim()
  if (scan.movieName && scan.movieName.trim()) return scan.movieName.trim()
  return `Scan ${scan.id ? scan.id.slice(0, 6) : ''}`
}

export function playMilestoneSound(type: MilestoneType) {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    const now = ctx.currentTime

    if (type === 'chunks_cut') {
      // Soft double pop chime
      ;[440, 554.37].forEach((freq, idx) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, now + idx * 0.1)
        gain.gain.setValueAtTime(0.12, now + idx * 0.1)
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.1 + 0.22)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start(now + idx * 0.1)
        osc.stop(now + idx * 0.1 + 0.22)
      })
    } else if (type === 'movie_copy_complete') {
      // Gentle subtle tone ("halka sa sound")
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(659.25, now) // E5
      gain.gain.setValueAtTime(0.08, now)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now)
      osc.stop(now + 0.35)
    } else if (type === 'scan_complete') {
      // Triumphant victory 4-note chord ("1 jordaar avaaj baje jisse pta chal jae scan pura ho gya he")
      const notes = [523.25, 659.25, 783.99, 1046.5] // C5, E5, G5, C6
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'triangle'
        osc.frequency.setValueAtTime(freq, now + idx * 0.12)
        gain.gain.setValueAtTime(0.2, now + idx * 0.12)
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.12 + 0.65)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start(now + idx * 0.12)
        osc.stop(now + idx * 0.12 + 0.65)
      })
    } else if (type === 'missing_scene_complete') {
      // Bright distinct dual-tone search chime
      ;[587.33, 880].forEach((freq, idx) => { // D5, A5
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, now + idx * 0.14)
        gain.gain.setValueAtTime(0.15, now + idx * 0.14)
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.14 + 0.4)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start(now + idx * 0.14)
        osc.stop(now + idx * 0.14 + 0.4)
      })
    } else if (type === 'export_complete') {
      // Majestic fanfare audio chime
      const notes = [440, 554.37, 659.25, 880] // A4, C#5, E5, A5
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, now + idx * 0.15)
        gain.gain.setValueAtTime(0.18, now + idx * 0.15)
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.15 + 0.7)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start(now + idx * 0.15)
        osc.stop(now + idx * 0.15 + 0.7)
      })
    }
  } catch {
    /* AudioContext unavailable or blocked */
  }
}

interface TopMilestoneBannerProps {
  scan: Scan | null
  onSelectScan?: (id: string) => void
}

export function TopMilestoneBanner({ scan, onSelectScan }: TopMilestoneBannerProps) {
  const [notification, setNotification] = useState<MilestoneNotification | null>(null)

  // Tracking state refs to prevent duplicate triggers
  const knownStates = useRef<Record<string, Record<MilestoneType, boolean>>>({})

  const triggerNotification = useCallback((notif: MilestoneNotification) => {
    setNotification(notif)
    playMilestoneSound(notif.type)
  }, [])

  useEffect(() => {
    if (!scan) return

    const id = scan.id
    if (!knownStates.current[id]) {
      knownStates.current[id] = {
        chunks_cut: Boolean(scan.chunks && scan.chunks.length > 0 && scan.status !== 'uploading'),
        movie_copy_complete: Boolean(scan.geminiPrescan?.movieCopy?.path),
        scan_complete: Boolean(scan.status === 'done'),
        missing_scene_complete: Boolean(
          (scan.gapBackup && (scan.gapBackup.status === 'done' || scan.gapBackup.status === 'awaiting_review')) ||
          (scan.missingSceneScan && scan.missingSceneScan.status === 'done')
        ),
        export_complete: Boolean(scan.renderJob?.status === 'done'),
      }
      return
    }

    const prev = knownStates.current[id]
    const scanName = getScanDisplayName(scan)

    // 1. Chunks Cut Complete
    const isChunksCutNow = Boolean(scan.chunks && scan.chunks.length > 0 && scan.status !== 'uploading')
    if (!prev.chunks_cut && isChunksCutNow) {
      prev.chunks_cut = true
      triggerNotification({
        id: `${id}-chunks-${Date.now()}`,
        type: 'chunks_cut',
        scanId: id,
        scanName,
        title: 'Chunks Cut & Ready',
        message: 'Video chunks have been cut and prepared for AI scanning.',
        createdAt: Date.now(),
      })
    }

    // 2. Movie Copy Complete
    const isMovieCopyNow = Boolean(scan.geminiPrescan?.movieCopy?.path)
    if (!prev.movie_copy_complete && isMovieCopyNow) {
      prev.movie_copy_complete = true
      triggerNotification({
        id: `${id}-moviecopy-${Date.now()}`,
        type: 'movie_copy_complete',
        scanId: id,
        scanName,
        title: 'Movie Stream Copy Prepared',
        message: 'Fast stream copy file created for Gemini Files API.',
        createdAt: Date.now(),
      })
    }

    // 3. Full Scan & 24fps Verification Complete
    const isScanDoneNow = Boolean(scan.status === 'done')
    if (!prev.scan_complete && isScanDoneNow) {
      prev.scan_complete = true
      triggerNotification({
        id: `${id}-scandone-${Date.now()}`,
        type: 'scan_complete',
        scanId: id,
        scanName,
        title: '🎉 Full Scan & 24fps Verification Finished!',
        message: 'All video chunk scanning and frame-precise verifications have completed.',
        createdAt: Date.now(),
      })
    }

    // 4. Missing Scene Finder Complete
    const isMissingSceneDoneNow = Boolean(
      (scan.gapBackup && (scan.gapBackup.status === 'done' || scan.gapBackup.status === 'awaiting_review')) ||
      (scan.missingSceneScan && scan.missingSceneScan.status === 'done')
    )
    if (!prev.missing_scene_complete && isMissingSceneDoneNow) {
      prev.missing_scene_complete = true
      triggerNotification({
        id: `${id}-missingdone-${Date.now()}`,
        type: 'missing_scene_complete',
        scanId: id,
        scanName,
        title: '🔍 Missing Scene Finder Complete',
        message: 'All gap parts search and verifications are complete.',
        createdAt: Date.now(),
      })
    }

    // 5. Video Export Complete
    const isExportDoneNow = Boolean(scan.renderJob?.status === 'done')
    if (!prev.export_complete && isExportDoneNow) {
      prev.export_complete = true
      triggerNotification({
        id: `${id}-exportdone-${Date.now()}`,
        type: 'export_complete',
        scanId: id,
        scanName,
        title: '🎞️ Video Export & Stitching Complete',
        message: 'The output video rendering process has finished successfully.',
        createdAt: Date.now(),
      })
    }
  }, [scan, triggerNotification])

  if (!notification) return null

  const ICON_MAP = {
    chunks_cut: <Film className="size-5 text-indigo-400" />,
    movie_copy_complete: <Video className="size-5 text-cyan-400" />,
    scan_complete: <CheckCircle2 className="size-5 text-emerald-400 animate-bounce" />,
    missing_scene_complete: <Sparkles className="size-5 text-amber-400" />,
    export_complete: <Download className="size-5 text-purple-400" />,
  }

  const BORDER_MAP = {
    chunks_cut: 'border-indigo-500/50 bg-indigo-950/90 text-indigo-100',
    movie_copy_complete: 'border-cyan-500/50 bg-cyan-950/90 text-cyan-100',
    scan_complete: 'border-emerald-500/60 bg-emerald-950/95 text-emerald-100 shadow-emerald-500/20 shadow-2xl',
    missing_scene_complete: 'border-amber-500/50 bg-amber-950/90 text-amber-100',
    export_complete: 'border-purple-500/50 bg-purple-950/90 text-purple-100',
  }

  return (
    <div className="fixed top-4 left-1/2 z-50 -translate-x-1/2 w-full max-w-xl px-4 animate-in slide-in-from-top-6 fade-in duration-300">
      <div className={`flex items-start gap-3.5 rounded-2xl border p-4 shadow-2xl backdrop-blur-xl ring-1 ring-white/10 ${BORDER_MAP[notification.type] || 'border-indigo-500/50 bg-indigo-950/90 text-indigo-100'}`}>
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-black/40 border border-white/10">
          {ICON_MAP[notification.type] || <CheckCircle2 className="size-5 text-emerald-400" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate rounded-full bg-white/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider">
              {notification.scanName}
            </span>
            <button
              type="button"
              onClick={() => setNotification(null)}
              className="rounded-lg p-1 text-white/60 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
              aria-label="Close notification"
            >
              <X className="size-4" />
            </button>
          </div>
          <h3 className="mt-1 font-bold text-sm leading-snug">{notification.title}</h3>
          <p className="mt-0.5 text-xs text-white/80 leading-snug">{notification.message}</p>

          {onSelectScan && scan?.id !== notification.scanId && (
            <button
              type="button"
              onClick={() => {
                onSelectScan(notification.scanId)
                setNotification(null)
              }}
              className="mt-2.5 flex items-center gap-1 rounded-lg bg-white/20 px-3 py-1 text-xs font-semibold text-white hover:bg-white/30 transition-all cursor-pointer"
            >
              Open This Scan →
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
