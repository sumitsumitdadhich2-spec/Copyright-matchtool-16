'use client'

import { useState } from 'react'
import { Check, Loader2, ListChecks } from 'lucide-react'
import type { MinuteSuggestion } from '@/lib/types'
import { fmtTime } from '@/lib/format'

/** APPROVAL STEP: Pegasus segment_4 se bani "in movie minutes ko check karna
 *  hai" list. User review + approve karta hai — approve ke BAAD hi Gemini
 *  compare start hota hai (existing pipeline). */
export function MinuteApproval({
  scanId,
  suggestions,
  onApproved,
}: {
  scanId: string
  suggestions: MinuteSuggestion[]
  onApproved: () => void
}) {
  // Default: sab minutes checked.
  const [selected, setSelected] = useState<Set<number>>(() => new Set(suggestions.map((s) => s.minute)))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggle(minute: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(minute)) next.delete(minute)
      else next.add(minute)
      return next
    })
  }

  async function approve() {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/scans/${scanId}/merge-pipeline/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes: [...selected] }),
    })
    setSubmitting(false)
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      setError(j.error || 'Approve failed')
      return
    }
    onApproved()
  }

  function confSummary(confidences: string[]): string | null {
    if (confidences.length === 0) return null
    const counts = new Map<string, number>()
    for (const c of confidences) {
      const key = c.toLowerCase().trim()
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    return [...counts.entries()].map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(', ')
  }

  return (
    <div className="mt-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center gap-2">
        <ListChecks className="size-4 text-primary" aria-hidden />
        <h3 className="text-sm font-semibold">Check karne hain — approve karo</h3>
        <span className="ml-auto text-xs text-muted-foreground">
          {selected.size}/{suggestions.length} selected
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Pegasus segment_4 matching se ye movie minutes nikle hain. Approve karne ke baad Gemini SIRF in minutes par
        short-vs-movie compare karega.
      </p>
      <ul className="mt-2 space-y-1.5">
        {suggestions.map((s) => {
          const conf = confSummary(s.confidences)
          return (
            <li key={s.minute}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 bg-background/50 px-2.5 py-1.5 text-xs hover:bg-secondary/50">
                <input
                  type="checkbox"
                  checked={selected.has(s.minute)}
                  onChange={() => toggle(s.minute)}
                  className="size-3.5 accent-primary"
                  aria-label={`Movie minute ${s.minute} (${fmtTime(s.minute * 60)}–${fmtTime((s.minute + 1) * 60)}) approve karo`}
                />
                <span className="font-medium tabular-nums">
                  Minute {s.minute}{' '}
                  <span className="font-mono text-muted-foreground">
                    {fmtTime(s.minute * 60)}–{fmtTime((s.minute + 1) * 60)}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  — {s.sceneCount} scene{s.sceneCount > 1 ? 's' : ''}
                  {conf ? ` (confidence: ${conf})` : ''}
                </span>
              </label>
            </li>
          )
        })}
      </ul>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <button
        type="button"
        onClick={() => approve()}
        disabled={submitting || selected.size === 0}
        className="btn-press mt-3 flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm disabled:opacity-40"
      >
        {submitting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
        {submitting ? 'Starting...' : 'Approve & Start Gemini Scan'}
      </button>
    </div>
  )
}
