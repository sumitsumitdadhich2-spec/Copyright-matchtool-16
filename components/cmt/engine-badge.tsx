'use client'

import useSWR from 'swr'
import { Cpu } from 'lucide-react'
import { fetcher } from '@/lib/format'

interface EngineInfo {
  engine?: { cores: number; engines: number; active: number; queued: number }
}

/**
 * "16 cores / 16 engines · 3 active" — the ffmpeg engine pool as reported by
 * GET /api/settings. Shares the SWR cache with the API key panel, so opening
 * Settings never adds a request; `live` polls while jobs are running.
 */
export function EngineBadge({ live = false, className = '' }: { live?: boolean; className?: string }) {
  const { data } = useSWR<EngineInfo>('/api/settings', fetcher, {
    refreshInterval: live ? 4000 : 0,
    revalidateOnFocus: false,
  })
  const e = data?.engine
  if (!e) return null
  const busy = e.active > 0 || e.queued > 0
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-0.5 font-mono text-[11px] text-muted-foreground ${className}`}
      title={`ffmpeg engine pool: ${e.cores} CPU cores detected, ${e.engines} single-threaded ffmpeg engines${busy ? ` — ${e.active} running, ${e.queued} queued` : ''}`}
    >
      <Cpu className={`size-3 ${busy ? 'text-primary' : ''}`} aria-hidden />
      <span>
        {e.cores} cores / {e.engines} engines
      </span>
      {busy && (
        <span className="text-foreground">
          · {e.active} active{e.queued > 0 ? `, ${e.queued} queued` : ''}
        </span>
      )}
    </span>
  )
}
