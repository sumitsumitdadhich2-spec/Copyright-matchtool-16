'use client'

import { Cpu } from 'lucide-react'
import type { Scan, ModelLiveState } from '@/lib/types'
import { MODEL_POOL, displayModelName } from '@/lib/models'

const STATE_LABEL: Record<ModelLiveState['state'], { label: string; cls: string }> = {
  idle: { label: 'idle', cls: 'bg-muted text-muted-foreground' },
  active: { label: 'active', cls: 'bg-primary/15 text-primary' },
  waiting: { label: 'waiting', cls: 'bg-secondary text-secondary-foreground' },
  cooling: { label: 'cooling down', cls: 'bg-amber-500/15 text-amber-400' },
  exhausted: { label: 'exhausted', cls: 'bg-destructive/15 text-destructive' },
}

export function ModelBoard({ scan, usage }: { scan: Scan | null; usage: Record<string, number> | null }) {
  return (
    <section aria-label="Model status board" className="panel">
      <div className="flex items-center gap-2">
        <Cpu className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Model Pool</h2>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {MODEL_POOL.map((m) => {
          const live = scan?.modelStates?.[m.id]
          const isActivelyScanning = scan?.status === 'running' || scan?.status === 'scanning'
          const used = isActivelyScanning && typeof live?.usedToday === 'number'
            ? live.usedToday
            : (usage?.[m.id] ?? (typeof live?.usedToday === 'number' ? live.usedToday : 0))
          const exhausted = used >= m.rpd
          const state: ModelLiveState['state'] = exhausted ? 'exhausted' : live?.state || 'idle'
          const badge = STATE_LABEL[state] || STATE_LABEL.idle
          const pct = Math.min(100, Math.round((used / m.rpd) * 100))
          return (
            <div
              key={m.id}
              className="rounded-lg border border-border bg-background/60 p-3 transition-colors hover:border-primary/30"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-xs">{displayModelName(m.id)}</span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.cls}`}>{badge.label}</span>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-mono">
                  {used}/{m.rpd} today
                </span>
                {live?.currentChunk !== null && live?.currentChunk !== undefined && (
                  <span className="font-mono text-primary">chunk {live.currentChunk}</span>
                )}
              </div>
              <div className="progress-track mt-1.5 !h-1" role="progressbar" aria-valuenow={pct} aria-label={`${displayModelName(m.id)} daily usage`}>
                <div
                  className={`progress-fill ${exhausted ? '!bg-destructive' : ''}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
