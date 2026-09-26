'use client'

import { useState } from 'react'
import { useSWRConfig } from 'swr'
import { Loader2 } from 'lucide-react'
import type { MinuteFinderMode } from '@/lib/types'

const OPTIONS: { value: MinuteFinderMode; label: string; title: string }[] = [
  { value: 'gemini', label: 'Gemini', title: 'Gemini Minute Finder — 20-min windows @ 10fps/1fps, phir auto chunk scan' },
  { value: 'twelvelabs', label: 'TwelveLabs', title: 'Purana flow — merge → Marengo → Pegasus → minute approval' },
  { value: 'off', label: 'Off', title: 'Koi minute finder nahi — manual Start = normal Full scan' },
]

/** Segmented control: which minute finder runs after upload + trim confirm.
 *  Persists via PUT /api/settings. A running pipeline is not affected — the
 *  new mode applies from the next upload/trim. */
export function MinuteFinderToggle({
  mode,
  onChanged,
}: {
  mode: MinuteFinderMode
  onChanged?: (mode: MinuteFinderMode) => void
}) {
  const { mutate } = useSWRConfig()
  const [saving, setSaving] = useState<MinuteFinderMode | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function pick(next: MinuteFinderMode) {
    if (next === mode || saving) return
    setSaving(next)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minuteFinder: next }),
    })
    setSaving(null)
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      setError(j.error || 'Save failed')
      return
    }
    void mutate('/api/settings')
    onChanged?.(next)
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div
        role="radiogroup"
        aria-label="Minute finder"
        className="flex items-center gap-1 rounded-lg border border-input bg-background p-0.5 text-xs"
      >
        <span className="px-1.5 text-[11px] text-muted-foreground">Minute finder:</span>
        {OPTIONS.map((o) => {
          const active = o.value === mode
          const busy = saving === o.value
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              title={o.title}
              disabled={saving !== null}
              onClick={() => pick(o.value)}
              className={`btn-press flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors ${
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              } disabled:opacity-60`}
            >
              {busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
              {o.label}
            </button>
          )
        })}
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
