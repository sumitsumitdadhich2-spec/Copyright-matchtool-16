'use client'

import { useMemo, useState, useEffect } from 'react'
import {
  Activity,
  Bot,
  Film,
  Sparkles,
  Search,
  Scissors,
  CheckCircle2,
  Clock,
  ArrowDown,
  Layers,
  Zap,
} from 'lucide-react'
import type { Scan } from '@/lib/types'

interface LiveActivityBarProps {
  scan: Scan
  onScrollToLogs?: () => void
}

export function LiveActivityBar({ scan, onScrollToLogs }: LiveActivityBarProps) {
  // Tick every second to update elapsed/relative times
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  // Analyze active operations across all systems
  const activity = useMemo(() => {
    // 1. Batch Verifier active check
    const batchResults = scan.batchVerify?.results || {}
    const minuteEntries = Object.entries(batchResults)
    const verifyingMinute = minuteEntries.find(([, r]) => r.status === 'verifying')
    const completedMinutes = minuteEntries.filter(([, r]) => r.status === 'done').length
    const totalMinutes = scan.shortDuration ? Math.ceil(scan.shortDuration / 60) : minuteEntries.length

    // 2. Render / Export active check
    const isRendering = scan.renderJob?.status === 'rendering'
    const renderPct = scan.renderJob?.pct ?? 0
    const renderEta = scan.renderJob?.etaSeconds ?? null
    const renderSegments = scan.renderJob?.segmentCount ?? 0

    // 3. Rescan active check (look at most recent logs)
    const logs = Array.isArray(scan.logs) ? scan.logs : []
    const recentLogs = logs.slice(-5)
    const activeRescanLog = recentLogs.find(
      (l) =>
        l?.msg &&
        l.msg.includes('[Rescan Scene]') &&
        !l.msg.includes('SUCCESS:') &&
        !l.msg.includes('Failed:') &&
        !l.msg.includes('did not find') &&
        Date.now() - l.t < 35000,
    )

    // 4. Scanning / Chunking active check
    const isChunking = scan.status === 'chunking'
    const isScanning = scan.status === 'scanning' || scan.status === 'verifying'

    // Determine current priority state
    if (isRendering) {
      return {
        type: 'rendering' as const,
        badge: '🎬 Export Video Render',
        badgeColor: 'border-amber-500/40 bg-amber-500/15 text-amber-400',
        title: 'Abhi ye chal raha hai: Export Video Stitching',
        description: `FFmpeg high-speed render: ${renderSegments} matched scenes ko sequence me merge kiya ja raha hai (Padding & Audio sync active).`,
        progress: renderPct,
        progressLabel: `${renderPct}% Complete${renderEta !== null && renderEta > 0 ? ` · ETA: ${renderEta}s` : ''}`,
        icon: Film,
        isLive: true,
      }
    }

    if (verifyingMinute) {
      const minNum = Number(verifyingMinute[0]) + 1
      const partCount = verifyingMinute[1].parts?.length || 0
      const activeModel = verifyingMinute[1].model || 'Gemini 3.6/3.7/3.8 Flash'
      return {
        type: 'batch_verify' as const,
        badge: '🤖 24 FPS Batch Verifier',
        badgeColor: 'border-violet-500/40 bg-violet-500/15 text-violet-400',
        title: `Abhi ye chal raha hai: Minute ${minNum} (Batch Verify)`,
        description: `Minute ${minNum} ke ${partCount} matched scenes ko 24 FPS stitched video bana kar ${activeModel} se verify kiya ja raha hai.`,
        progress: totalMinutes > 0 ? Math.round((completedMinutes / totalMinutes) * 100) : 50,
        progressLabel: `Min ${minNum} of ${totalMinutes || '?'} (${completedMinutes} verified)`,
        icon: Bot,
        isLive: true,
      }
    }

    if (activeRescanLog) {
      return {
        type: 'rescan' as const,
        badge: '🎯 Targeted Scene Rescan',
        badgeColor: 'border-cyan-500/40 bg-cyan-500/15 text-cyan-400',
        title: 'Abhi ye chal raha hai: Targeted Scene Rescan',
        description: activeRescanLog.msg.replace(/flash/gi, 'shiva'),
        progress: 50,
        progressLabel: 'AI Rescan in progress...',
        icon: Zap,
        isLive: true,
      }
    }

    if (isChunking) {
      const pct = scan.chunkingProgress ?? 0
      return {
        type: 'chunking' as const,
        badge: '✂️ Video Splitting',
        badgeColor: 'border-blue-500/40 bg-blue-500/15 text-blue-400',
        title: 'Abhi ye chal raha hai: Movie 1-Minute Chunking',
        description: 'Movie ko 1-1 minute ke chunks me lossless split kiya ja raha hai taaki parallel AI scanning shuru ho sake.',
        progress: pct,
        progressLabel: `${pct}% Split complete`,
        icon: Scissors,
        isLive: true,
      }
    }

    if (isScanning) {
      const segCount = scan.shortSegments?.length ?? 0
      const matchesCount = scan.matches?.length ?? 0
      return {
        type: 'scanning' as const,
        badge: '🔍 AI Multi-Engine Scanner',
        badgeColor: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400',
        title: 'Abhi ye chal raha hai: Gemini Parallel 1-Prompt/Min Scan',
        description: `Movie chunks ko Gemini parallel lanes par scan kiya ja raha hai (${matchesCount} scenes already matched).`,
        progress: segCount > 0 ? Math.min(95, Math.round((matchesCount / (segCount * 5)) * 100)) : 30,
        progressLabel: `Scanning active · ${matchesCount} scenes found`,
        icon: Search,
        isLive: true,
      }
    }

    // Finished or Idle states
    if (scan.status === 'done' || scan.status === 'stopped') {
      const matches = scan.matches?.length ?? 0
      const confirmed = scan.matches?.filter((m) => m.batchVerified === 'confirmed').length ?? 0
      const hasBatch = Object.keys(batchResults).length > 0
      return {
        type: 'done' as const,
        badge: '✨ System Ready',
        badgeColor: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
        title: 'System Ready: Scan Complete & Matched',
        description: hasBatch
          ? `${matches} matched scenes available (${confirmed} confirmed by 24fps Batch Verifier). Ready for export.`
          : `${matches} matched scenes available. Batch Verifier chala kar 100% accuracy verify kar sakte hain ya export render kar sakte hain.`,
        progress: 100,
        progressLabel: `${matches} Scenes Ready`,
        icon: CheckCircle2,
        isLive: false,
      }
    }

    return {
      type: 'idle' as const,
      badge: '⚡ Ready',
      badgeColor: 'border-border bg-secondary text-muted-foreground',
      title: 'Ready for Next Step',
      description: 'Short aur Movie ready hain. Scan shuru karne par yahan live progress dikhegi.',
      progress: 0,
      progressLabel: 'Idle',
      icon: Sparkles,
      isLive: false,
    }
  }, [scan])

  const logs = Array.isArray(scan.logs) ? scan.logs : []
  const latestLog = logs[logs.length - 1]

  const handleScrollToLogs = () => {
    if (onScrollToLogs) {
      onScrollToLogs()
    } else {
      const el = document.getElementById('cmt-logs-section')
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }
  }

  const Icon = activity.icon

  return (
    <aside
      aria-label="Current system activity"
      className={`relative overflow-hidden rounded-xl border transition-all duration-300 ${
        activity.isLive
          ? 'border-primary/50 bg-gradient-to-r from-card via-card to-primary/5 shadow-lg shadow-primary/10'
          : 'border-border bg-card/60'
      }`}
    >
      {/* Top ambient animated pulse strip when live */}
      {activity.isLive && (
        <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent animate-pulse" />
      )}

      <div className="p-3.5 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          {/* Main Status & Heading */}
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <div
              className={`relative flex size-10 shrink-0 items-center justify-center rounded-lg border transition-all ${
                activity.isLive
                  ? 'border-primary/40 bg-primary/15 text-primary shadow-md shadow-primary/20'
                  : 'border-border bg-muted text-muted-foreground'
              }`}
            >
              <Icon className={`size-5 ${activity.isLive ? 'animate-pulse' : ''}`} />
              {activity.isLive && (
                <span className="absolute -top-1 -right-1 flex size-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex size-3 rounded-full bg-primary" />
                </span>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase ${activity.badgeColor}`}
                >
                  {activity.badge}
                </span>
                <span className="inline-flex items-center rounded-full border border-border/80 bg-background/80 px-2.5 py-0.5 text-[11px] font-bold text-foreground truncate max-w-[200px]">
                  {scan.customName || scan.shortName || scan.movieName || `Scan ${scan.id.slice(0, 6)}`}
                </span>
                {activity.isLive && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-mono font-medium text-primary">
                    <Activity className="size-3 animate-spin text-primary" />
                    LIVE
                  </span>
                )}
              </div>

              <h2 className="mt-1 text-sm sm:text-base font-semibold text-foreground tracking-tight flex items-center gap-1.5 truncate">
                {activity.title}
              </h2>
              <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5 leading-relaxed">
                {activity.description}
              </p>
            </div>
          </div>

          {/* Quick Jump to Logs Button */}
          <button
            type="button"
            onClick={handleScrollToLogs}
            className="btn-press flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-secondary/80 hover:bg-secondary hover:border-primary/40 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            title="Logs panel par jump karein"
          >
            <Layers className="size-3.5 text-primary" />
            <span>Logs ({scan.logs.length})</span>
            <ArrowDown className="size-3" />
          </button>
        </div>

        {/* Progress Bar (when progress is relevant) */}
        {activity.isLive && activity.progress > 0 && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-[11px] font-mono text-muted-foreground mb-1">
              <span className="text-foreground font-medium flex items-center gap-1">
                <span className="inline-block size-1.5 rounded-full bg-primary animate-pulse" />
                Live Progress
              </span>
              <span className="font-semibold text-primary">{activity.progressLabel}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted border border-border/40">
              <div
                className="h-full bg-gradient-to-r from-primary/80 to-primary transition-all duration-500 rounded-full"
                style={{ width: `${Math.min(100, Math.max(5, activity.progress))}%` }}
              />
            </div>
          </div>
        )}

        {/* Latest Log Ticker */}
        {latestLog && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-3 py-1.5 font-mono text-[11px]">
            <Clock className="size-3.5 shrink-0 text-muted-foreground/80" />
            <span className="shrink-0 text-muted-foreground/60">
              {new Date(latestLog.t).toLocaleTimeString([], { hour12: false })}
            </span>
            <span className="shrink-0 text-primary font-medium">⚡ [Abhi-Abhi]:</span>
            <span className="truncate text-foreground/90 font-sans">
              {latestLog.msg.replace(/flash/gi, 'shiva')}
            </span>
          </div>
        )}
      </div>
    </aside>
  )
}
