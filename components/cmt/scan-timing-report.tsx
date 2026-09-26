'use client'

import { useMemo } from 'react'
import { Clock, Timer, CheckCircle2, Loader2, Hourglass } from 'lucide-react'
import type { Scan } from '@/lib/types'
import { computeScanTiming } from '@/lib/scan-timing'

export function ScanTimingReport({ scan }: { scan: Scan }) {
  const timing = useMemo(() => computeScanTiming(scan), [scan])

  if (!timing.hasCompletedTasks) return null

  return (
    <div className="rounded-xl border border-border/80 bg-card p-4 shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
            <Timer className="size-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-foreground">
              Task Timing & Execution Duration Report
            </h3>
            <p className="text-xs text-muted-foreground">
              Har kaam ka alag time aur grand total execution time
            </p>
          </div>
        </div>

        {/* Grand Total Duration Pill */}
        <div className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-3 py-1 text-xs font-bold text-emerald-400 shadow-sm">
          <Clock className="size-3.5 animate-pulse text-emerald-400" />
          <span>Grand Total Time: {timing.totalFormatted}</span>
        </div>
      </div>

      {/* Task Timing List / Grid */}
      <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {timing.tasks.map((task) => {
          const isRunning = task.status === 'running'

          return (
            <div
              key={task.id}
              className={`flex flex-col justify-between rounded-lg border p-3 transition-all ${
                isRunning
                  ? 'border-primary/50 bg-primary/10 shadow-md shadow-primary/5'
                  : 'border-border/70 bg-muted/30 hover:border-border hover:bg-muted/50'
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-bold text-foreground">{task.title}</span>
                  <span className="shrink-0 rounded-full bg-background/80 border border-border px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                    {task.badge}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">
                  {task.description}
                </p>
              </div>

              <div className="mt-3 pt-2 border-t border-border/40">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    {isRunning ? (
                      <Loader2 className="size-3.5 animate-spin text-primary" />
                    ) : (
                      <CheckCircle2 className="size-3.5 text-emerald-400" />
                    )}
                    <span className="font-mono text-sm font-bold text-foreground">
                      {task.durationFormatted}
                    </span>
                  </div>
                  <span className="font-mono text-xs font-semibold text-muted-foreground">
                    {task.pctOfTotal}% of total
                  </span>
                </div>

                {/* Progress bar representing percentage share of total workflow time */}
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      isRunning ? 'bg-primary animate-pulse' : 'bg-emerald-500'
                    }`}
                    style={{ width: `${Math.max(4, task.pctOfTotal)}%` }}
                  />
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Summary Footer */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5 font-medium">
          <Hourglass className="size-3.5 text-primary" />
          <span>Completed Tasks Recorded: {timing.tasks.length}</span>
        </span>
        <span className="font-mono font-semibold text-foreground">
          Cumulative Total: {timing.totalFormatted}
        </span>
      </div>
    </div>
  )
}
