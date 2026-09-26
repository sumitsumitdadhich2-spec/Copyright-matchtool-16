'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import {
  Terminal,
  Bot,
  Film,
  Search,
  Zap,
  AlertTriangle,
  Copy,
  Check,
  ArrowDownCircle,
  Filter,
  Layers,
  X,
  Radio,
} from 'lucide-react'
import type { Scan, LogEntry } from '@/lib/types'
import { EngineBadge } from './engine-badge'

type LogCategory = 'all' | 'batch' | 'render' | 'rescan' | 'scan' | 'alerts'

interface CategoryDef {
  id: LogCategory
  label: string
  icon: typeof Terminal
  countMatcher: (l: LogEntry) => boolean
}

const CATEGORIES: CategoryDef[] = [
  {
    id: 'all',
    label: 'All Logs',
    icon: Layers,
    countMatcher: () => true,
  },
  {
    id: 'batch',
    label: 'Batch 24fps',
    icon: Bot,
    countMatcher: (l) => {
      const msg = (l?.msg || '').toLowerCase()
      return (
        msg.includes('batch') ||
        msg.includes('stitch') ||
        msg.includes('verdict') ||
        msg.includes('confirmed via rescan')
      )
    },
  },
  {
    id: 'render',
    label: 'Render & Padding',
    icon: Film,
    countMatcher: (l) => {
      const msg = (l?.msg || '').toLowerCase()
      return (
        msg.includes('render') ||
        msg.includes('export') ||
        msg.includes('padding') ||
        msg.includes('ffmpeg')
      )
    },
  },
  {
    id: 'rescan',
    label: 'Scene Rescan',
    icon: Zap,
    countMatcher: (l) => {
      const msg = (l?.msg || '').toLowerCase()
      return (
        msg.includes('rescan') ||
        msg.includes('targeted') ||
        msg.includes('re-tested')
      )
    },
  },
  {
    id: 'scan',
    label: 'AI Scanner',
    icon: Search,
    countMatcher: (l) => {
      const msg = (l?.msg || '').toLowerCase()
      return (
        msg.includes('chunk') ||
        msg.includes('mapping short') ||
        msg.includes('segment') ||
        msg.includes('split')
      )
    },
  },
  {
    id: 'alerts',
    label: 'Alerts & Quota',
    icon: AlertTriangle,
    countMatcher: (l) => {
      const msg = (l?.msg || '').toLowerCase()
      return (
        l?.level === 'warn' ||
        l?.level === 'error' ||
        msg.includes('quota') ||
        msg.includes('exhausted') ||
        msg.includes('rate limit')
      )
    },
  },
]

function getLogCategoryTag(msg: string | undefined, level: string | undefined) {
  const m = (msg || '').toLowerCase()
  if (m.includes('[batch verifier]') || m.includes('batch verify') || m.includes('stitched')) {
    return {
      label: 'BATCH 24FPS',
      className: 'border-violet-500/30 bg-violet-500/10 text-violet-400',
    }
  }
  if (m.includes('render') || m.includes('export') || m.includes('padding') || m.includes('ffmpeg')) {
    return {
      label: 'RENDER',
      className: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
    }
  }
  if (m.includes('[rescan') || m.includes('rescan:')) {
    return {
      label: 'RESCAN',
      className: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400',
    }
  }
  if (m.includes('chunk ') || m.includes('chunking') || m.includes('mapping short')) {
    return {
      label: 'SCAN',
      className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
    }
  }
  if (level === 'error') {
    return {
      label: 'ERROR',
      className: 'border-destructive/40 bg-destructive/15 text-destructive',
    }
  }
  if (level === 'warn') {
    return {
      label: 'ALERT',
      className: 'border-amber-400/40 bg-amber-400/15 text-amber-400',
    }
  }
  return {
    label: 'SYSTEM',
    className: 'border-border bg-muted/50 text-muted-foreground',
  }
}

export function LogsPanel({ scan }: { scan: Scan }) {
  const [category, setCategory] = useState<LogCategory>('all')
  const [search, setSearch] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [copied, setCopied] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  const logs = useMemo(() => (Array.isArray(scan.logs) ? scan.logs : []), [scan.logs])

  // Auto-scroll when new logs arrive (if autoScroll is enabled)
  useEffect(() => {
    if (autoScroll && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight
    }
  }, [logs.length, autoScroll])

  // Compute category counts
  const categoryCounts = useMemo(() => {
    const counts: Record<LogCategory, number> = {
      all: logs.length,
      batch: 0,
      render: 0,
      rescan: 0,
      scan: 0,
      alerts: 0,
    }
    for (const l of logs) {
      if (!l) continue
      for (const cat of CATEGORIES) {
        if (cat.id !== 'all' && cat.countMatcher(l)) {
          counts[cat.id]++
        }
      }
    }
    return counts
  }, [logs])

  // Filter logs by active category and search
  const filteredLogs = useMemo(() => {
    const activeCat = CATEGORIES.find((c) => c.id === category)
    const matcher = activeCat ? activeCat.countMatcher : () => true
    const q = search.trim().toLowerCase()

    return logs.filter((l) => {
      if (!l) return false
      if (!matcher(l)) return false
      if (q && !(l.msg || '').toLowerCase().includes(q)) return false
      return true
    })
  }, [logs, category, search])

  // Current live status calculation for the panel header
  const liveSummary = useMemo(() => {
    const isRendering = scan.renderJob?.status === 'rendering'
    if (isRendering) {
      return {
        active: true,
        text: `Export Render Active: ${scan.renderJob?.pct ?? 0}% · Movie scene stitching in progress`,
        color: 'text-amber-400',
        badge: 'Rendering',
      }
    }

    const batchResults = scan.batchVerify?.results || {}
    const verifying = Object.entries(batchResults).find(([, r]) => r.status === 'verifying')
    if (verifying) {
      return {
        active: true,
        text: `Batch 24fps Verifier Active: Minute ${Number(verifying[0]) + 1} verifying on Gemini`,
        color: 'text-violet-400',
        badge: 'Batch Verifying',
      }
    }

    if (scan.status === 'chunking') {
      return {
        active: true,
        text: `Splitting Movie: ${scan.chunkingProgress ?? 0}% chunks ready`,
        color: 'text-blue-400',
        badge: 'Chunking',
      }
    }

    if (scan.status === 'scanning' || scan.status === 'verifying') {
      return {
        active: true,
        text: `AI Scanning in progress (${scan.matches?.length ?? 0} matches found)`,
        color: 'text-emerald-400',
        badge: 'Scanning',
      }
    }

    return {
      active: false,
      text: `System Ready · Total ${scan.logs.length} logged events`,
      color: 'text-muted-foreground',
      badge: 'Idle',
    }
  }, [scan])

  const handleCopyLogs = async () => {
    const text = filteredLogs
      .map(
        (l) =>
          `[${new Date(l.t).toLocaleTimeString([], { hour12: false })}] [${l.level.toUpperCase()}] ${l.msg}`,
      )
      .join('\n')
    await navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <section id="cmt-logs-section" aria-label="Live logs and system activity" className="panel">
      {/* Panel Header */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 pb-2 border-b border-border/60">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary/10 border border-primary/20 text-primary">
            <Terminal className="size-4" aria-hidden />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold tracking-tight text-foreground">Live Activity & Logs</h2>
              <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                {filteredLogs.length}{filteredLogs.length !== scan.logs.length ? ` / ${scan.logs.length}` : ''}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <EngineBadge
            live={scan.status === 'scanning' || scan.status === 'chunking' || scan.renderJob?.status === 'rendering'}
          />

          {/* Auto-scroll toggle */}
          <button
            type="button"
            onClick={() => setAutoScroll((v) => !v)}
            title={autoScroll ? 'Auto-scroll is ON (locking to bottom)' : 'Auto-scroll is PAUSED'}
            className={`btn-press flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
              autoScroll
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border bg-secondary text-muted-foreground hover:text-foreground'
            }`}
          >
            <ArrowDownCircle className={`size-3 ${autoScroll ? 'animate-bounce' : ''}`} />
            <span>{autoScroll ? 'Auto-scroll' : 'Paused'}</span>
          </button>

          {/* Copy Logs Button */}
          <button
            type="button"
            onClick={handleCopyLogs}
            disabled={filteredLogs.length === 0}
            title="Copy filtered logs to clipboard"
            className="btn-press flex items-center gap-1 rounded-md border border-border bg-secondary px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:border-primary/40 disabled:opacity-50 transition-colors"
          >
            {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
            <span>{copied ? 'Copied!' : 'Copy'}</span>
          </button>
        </div>
      </div>

      {/* Live "Abhi Ye Ho Raha Hai" Activity Ribbon */}
      <div className="mt-2.5 flex items-center justify-between rounded-lg border border-border/80 bg-background/60 px-3 py-2 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <span className="relative flex size-2 shrink-0">
            {liveSummary.active && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
            )}
            <span
              className={`relative inline-flex size-2 rounded-full ${
                liveSummary.active ? 'bg-primary' : 'bg-muted-foreground/40'
              }`}
            />
          </span>
          <span className="font-semibold text-foreground shrink-0 text-[11px] uppercase tracking-wider">
            Abhi Status:
          </span>
          <span className={`font-medium truncate ${liveSummary.color}`}>
            {liveSummary.text}
          </span>
        </div>

        {liveSummary.active && (
          <span className="hidden sm:inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-mono text-primary shrink-0 animate-pulse">
            <Radio className="size-3" />
            LIVE
          </span>
        )}
      </div>

      {/* Category Filter Pills & Search Box */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {CATEGORIES.map((cat) => {
            const count = categoryCounts[cat.id]
            const active = category === cat.id
            const CatIcon = cat.icon
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => setCategory(cat.id)}
                className={`btn-press inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-all ${
                  active
                    ? 'border-primary/60 bg-primary/15 text-primary font-semibold shadow-xs'
                    : 'border-border bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                <CatIcon className="size-3" />
                <span>{cat.label}</span>
                <span
                  className={`rounded-full px-1 text-[10px] font-mono ${
                    active ? 'bg-primary/20 text-primary' : 'bg-background/80 text-muted-foreground/70'
                  }`}
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>

        {/* Quick Search */}
        <div className="relative flex items-center min-w-[140px] max-w-[200px] flex-1 sm:flex-initial">
          <Search className="absolute left-2 size-3 text-muted-foreground/70" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search logs..."
            className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-6 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-hidden"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-1.5 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      {/* Log Feed Container */}
      <div
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget
          // If user scrolled up by more than 30px, pause sticky scrolling
          const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
          if (autoScroll !== isAtBottom) {
            setAutoScroll(isAtBottom)
          }
        }}
        className="mt-3 h-80 overflow-y-auto rounded-lg border border-border bg-background p-2.5 font-mono text-xs leading-relaxed divide-y divide-border/20"
        role="log"
        aria-live="polite"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center text-muted-foreground">
            <Filter className="size-7 stroke-[1.5] text-muted-foreground/40 mb-2" />
            <p className="text-xs font-medium text-foreground/80">
              {search ? 'Koi log match nahi hua' : 'Is category me abhi tak koi log nahi hai'}
            </p>
            <p className="text-[11px] text-muted-foreground/60 mt-1">
              {search ? `"${search}" filter clear karein ya dusra keyword try karein.` : 'Scan ya verification chalne par logs stream honge.'}
            </p>
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="mt-2 text-[11px] text-primary hover:underline font-sans"
              >
                Clear search
              </button>
            )}
          </div>
        ) : (
          filteredLogs.map((l, i) => {
            const tag = getLogCategoryTag(l.msg, l.level)
            const cleanMsg = l.msg.replace(/flash/gi, 'shiva')

            return (
              <div
                key={i}
                className="group flex flex-col sm:flex-row items-start sm:items-baseline gap-1.5 sm:gap-2 py-1.5 px-1 hover:bg-secondary/40 rounded transition-colors"
              >
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* Timestamp */}
                  <span className="shrink-0 text-muted-foreground/60 font-mono text-[11px] select-none">
                    {new Date(l.t).toLocaleTimeString([], { hour12: false })}
                  </span>

                  {/* Category Pill Tag */}
                  <span
                    className={`inline-block rounded px-1.5 py-0.2 text-[9px] font-semibold tracking-wider uppercase border ${tag.className}`}
                  >
                    {tag.label}
                  </span>
                </div>

                {/* Message Body with smart styling */}
                <div className="flex-1 break-words text-foreground/90 leading-snug">
                  {cleanMsg.includes('CONFIRMED') ? (
                    <span>
                      {cleanMsg.split('CONFIRMED')[0]}
                      <span className="inline-block rounded bg-emerald-500/20 text-emerald-400 font-bold px-1 mx-0.5 border border-emerald-500/30">
                        CONFIRMED
                      </span>
                      {cleanMsg.split('CONFIRMED').slice(1).join('CONFIRMED')}
                    </span>
                  ) : cleanMsg.includes('REJECTED') ? (
                    <span>
                      {cleanMsg.split('REJECTED')[0]}
                      <span className="inline-block rounded bg-rose-500/20 text-rose-400 font-bold px-1 mx-0.5 border border-rose-500/30">
                        REJECTED
                      </span>
                      {cleanMsg.split('REJECTED').slice(1).join('REJECTED')}
                    </span>
                  ) : cleanMsg.includes('SUCCESS') ? (
                    <span className="text-emerald-400 font-medium">{cleanMsg}</span>
                  ) : l.level === 'error' ? (
                    <span className="text-destructive font-medium">{cleanMsg}</span>
                  ) : l.level === 'warn' ? (
                    <span className="text-amber-400 font-medium">{cleanMsg}</span>
                  ) : (
                    <span>{cleanMsg}</span>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}
