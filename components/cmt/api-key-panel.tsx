'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { KeyRound, Check, ShieldCheck, X, Sparkles, HardDrive, RefreshCw } from 'lucide-react'
import { fetcher } from '@/lib/format'

interface ModelSpecInfo {
  id: string
  name: string
  rpd: number
  purpose?: string
}

interface KeySlot {
  index: number
  hasKey: boolean
  maskedKey: string | null
  usage?: Record<string, number> | null
  exhausted?: Record<string, boolean> | null
  totalRequests?: number
  storage?: { fileCount: number; totalMB: string } | null
}

interface SettingsResponse {
  keys: KeySlot[]
  maxKeys: number
  models?: ModelSpecInfo[]
  twelveLabs?: { hasKey: boolean; maskedKey: string | null }
}

const MAX_SLOTS = 20

function slotLabel(n: number): string {
  if (n === 1) return 'API Key 1 — Window & Backup Finder (Priority)'
  if (n === 2) return 'API Key 2 — Window & Backup Finder (Priority)'
  return `API Key ${n} — Chunk Scan Worker (optional)`
}

export function ApiKeyPanel() {
  const { data, mutate } = useSWR<SettingsResponse>('/api/settings', fetcher)
  const [values, setValues] = useState<Record<number, string>>({})
  const [saving, setSaving] = useState<number | null>(null)
  const [saved, setSaved] = useState<number | null>(null)
  const [removing, setRemoving] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tlValue, setTlValue] = useState('')
  const [tlSaving, setTlSaving] = useState(false)
  const [tlSaved, setTlSaved] = useState(false)
  const [cleaningStorage, setCleaningStorage] = useState(false)
  const [deletingKeyStorage, setDeletingKeyStorage] = useState<number | null>(null)
  const [cleanMsg, setCleanMsg] = useState<string | null>(null)
  const [resettingCounters, setResettingCounters] = useState(false)
  const [reconcilingCounters, setReconcilingCounters] = useState(false)
  const [resetMsg, setResetMsg] = useState<string | null>(null)

  async function deleteKeyFiles(n: number) {
    if (!confirm(`Are you sure you want to delete all movie & temporary files from Gemini Files API for Key ${n}?`)) return
    setDeletingKeyStorage(n)
    setCleanMsg(null)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteKeyFiles: n }),
    })
    setDeletingKeyStorage(null)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || `Failed to delete files for Key ${n}`)
      return
    }
    const j = (await res.json().catch(() => ({}))) as { deleted?: number }
    setCleanMsg(`Key ${n}: Deleted ${j.deleted ?? 0} file(s) from Gemini Cloud storage.`)
    setTimeout(() => setCleanMsg(null), 5000)
    void mutate()
  }

  async function reconcileQuotaCounters() {
    setReconcilingCounters(true)
    setResetMsg(null)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reconcileCounters: true }),
    })
    setReconcilingCounters(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to sync quota')
      return
    }
    setResetMsg('Quota synced: only actual successful requests today are counted; false exhaustion cleared.')
    setTimeout(() => setResetMsg(null), 5000)
    void mutate()
  }

  async function resetQuotaCounters() {
    if (!confirm('Are you sure you want to reset all Gemini daily usage counters and clear 20/20 exhaustion flags back to 0?')) return
    setResettingCounters(true)
    setResetMsg(null)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetCounters: true }),
    })
    setResettingCounters(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to reset daily quota counters')
      return
    }
    setResetMsg('All daily quota usage counters and model exhaustion states have been reset to 0.')
    setTimeout(() => setResetMsg(null), 5000)
    void mutate()
  }

  const [deletingAllFiles, setDeletingAllFiles] = useState(false)

  async function deleteAllCloudFiles() {
    if (!confirm('Are you sure you want to delete ALL uploaded movie & temporary files across ALL your Gemini API keys? This will free up 100% of your Gemini Files storage.')) return
    setDeletingAllFiles(true)
    setCleanMsg(null)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteAllFiles: true }),
    })
    setDeletingAllFiles(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to delete files across all keys')
      return
    }
    const j = (await res.json().catch(() => ({}))) as { deleted?: number }
    setCleanMsg(`Deleted ${j.deleted ?? 0} file(s) across all API keys. Cloud storage is clean.`)
    setTimeout(() => setCleanMsg(null), 5000)
    void mutate()
  }

  async function cleanGeminiStorage() {
    setCleaningStorage(true)
    setCleanMsg(null)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cleanupStorage: true }),
    })
    setCleaningStorage(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to sweep Gemini cloud storage')
      return
    }
    const j = (await res.json().catch(() => ({}))) as { deleted?: number; total?: number }
    setCleanMsg(`Storage Cleaned: ${j.deleted ?? 0} temporary file(s) deleted from Gemini Cloud Files API (Checked ${j.total ?? 0}).`)
    setTimeout(() => setCleanMsg(null), 5000)
  }

  async function saveTl() {
    const v = tlValue.trim()
    if (!v) return
    setTlSaving(true)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ twelveLabsKey: v }),
    })
    setTlSaving(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to save Twelve Labs key')
      return
    }
    setTlValue('')
    setTlSaved(true)
    setTimeout(() => setTlSaved(false), 2500)
    void mutate()
  }

  async function removeTl() {
    setTlSaving(true)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearTwelveLabs: true }),
    })
    setTlSaving(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to remove Twelve Labs key')
      return
    }
    void mutate()
  }

  const slots: KeySlot[] =
    data?.keys ?? Array.from({ length: MAX_SLOTS }, (_, i) => ({ index: i + 1, hasKey: false, maskedKey: null }))

  async function save(n: number) {
    const v = (values[n] || '').trim()
    if (!v) return
    setSaving(n)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [`apiKey${n}`]: v }),
    })
    setSaving(null)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to save key')
      return
    }
    setValues((p) => ({ ...p, [n]: '' }))
    setSaved(n)
    setTimeout(() => setSaved(null), 2500)
    void mutate()
  }

  async function remove(n: number) {
    setRemoving(n)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: n }),
    })
    setRemoving(null)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to remove key')
      return
    }
    void mutate()
  }

  return (
    <section aria-label="API key settings" className="panel">
      {slots.map((slot) => {
        const n = slot.index
        const Icon = n === 1 ? KeyRound : ShieldCheck
        return (
          <div key={n} className={n === 1 ? '' : 'mt-4 border-t border-border pt-4'}>
            <div className="flex items-center gap-2 flex-wrap">
              <Icon className="size-4 text-primary" aria-hidden />
              <h2 className="text-sm font-semibold">{slotLabel(n)}</h2>
              {n <= 2 && (
                <span className="rounded-full bg-primary/15 border border-primary/30 px-2 py-0.5 font-mono text-[10px] font-semibold text-primary">
                  Window & Backup Priority
                </span>
              )}
              {slot.hasKey ? (
                <span className="ml-auto flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 font-mono text-xs text-success">
                  <Check className="size-3" aria-hidden />
                  {slot.maskedKey}
                </span>
              ) : n === 1 ? (
                <span className="ml-auto rounded-full bg-destructive/15 px-2 py-0.5 text-xs text-destructive">not set</span>
              ) : (
                <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">not set</span>
              )}
            </div>
            <div className="mt-3 flex gap-2">
              <input
                type="password"
                value={values[n] || ''}
                onChange={(e) => setValues((p) => ({ ...p, [n]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) save(n)
                }}
                placeholder={
                  slot.hasKey
                    ? 'Paste a new key to replace'
                    : n === 1
                      ? 'Paste your Gemini API key'
                      : `Paste Gemini API key ${n} (different account)`
                }
                aria-label={`Gemini API key ${n}`}
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => save(n)}
                disabled={saving !== null || !(values[n] || '').trim()}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
              >
                {saving === n ? 'Saving...' : saved === n ? 'Saved' : slot.hasKey ? 'Update' : 'Save'}
              </button>
              {slot.hasKey && (
                <button
                  type="button"
                  onClick={() => remove(n)}
                  disabled={removing !== null}
                  aria-label={`Remove API key ${n}`}
                  title="Remove this key"
                  className="rounded-md border border-border px-2.5 py-2 text-sm text-muted-foreground hover:text-destructive disabled:opacity-40"
                >
                  {removing === n ? '...' : <X className="size-4" aria-hidden />}
                </button>
              )}
            </div>

            {/* ---------- Per-Key Daily Usage Tracking ---------- */}
            {slot.hasKey && (
              <div className="mt-2.5 rounded-md border border-border/70 bg-card/60 p-2.5 text-xs">
                <div className="flex items-center justify-between font-medium mb-2 flex-wrap gap-2">
                  <div className="flex items-center gap-1.5 text-foreground">
                    <span className="size-2 rounded-full bg-emerald-500 animate-pulse" aria-hidden />
                    <span>Daily Model Usage</span>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-muted-foreground flex-wrap">
                    <span>
                      Total: <strong className="text-foreground font-semibold">{slot.totalRequests ?? 0}</strong> reqs
                    </span>
                    {slot.storage && (
                      <span className="border-l border-border/80 pl-2">
                        Files: <strong className="text-foreground font-semibold">{slot.storage.totalMB}</strong> ({slot.storage.fileCount})
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => deleteKeyFiles(n)}
                      disabled={deletingKeyStorage === n}
                      className="rounded border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
                      title="Clear movie and temporary files from this key's Gemini Cloud storage"
                    >
                      {deletingKeyStorage === n ? 'Deleting...' : 'Delete Files'}
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 font-mono">
                  {(data?.models ?? [
                    { id: 'gemini-2.5-flash', name: '2.5 Flash', rpd: 20 },
                    { id: 'gemini-2.5-pro', name: '2.5 Pro', rpd: 20 },
                    { id: 'gemini-3-flash', name: '3 Flash', rpd: 20 },
                    { id: 'gemini-3.5-flash', name: '3.5 Flash', rpd: 20 },
                    { id: 'gemini-3.5-flash-lite', name: '3.5 Flash-Lite', rpd: 500 },
                    { id: 'gemini-3.1-flash-lite', name: '3.1 Flash-Lite', rpd: 500 },
                  ]).map((m) => {
                    const used = slot.usage?.[m.id] ?? 0
                    const isExhausted = Boolean(slot.exhausted?.[m.id]) || used >= m.rpd
                    const isNear = used >= m.rpd * 0.8 && !isExhausted
                    return (
                      <div
                        key={m.id}
                        className={`flex items-center justify-between rounded px-2 py-1 border transition-colors ${
                          isExhausted
                            ? 'border-destructive/40 bg-destructive/10 text-destructive'
                            : isNear
                              ? 'border-warning/40 bg-warning/10 text-warning'
                              : 'border-border/60 bg-background/60 text-foreground/90'
                        }`}
                      >
                        <span className="truncate pr-1 text-[11px]" title={m.id}>
                          {m.name || m.id.replace('gemini-', '')}
                        </span>
                        <span className="font-semibold text-[11px] shrink-0">
                          {used}/{m.rpd}
                          {isExhausted && used < m.rpd && <span className="ml-1 text-[9px] font-normal opacity-85">(Exh)</span>}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )
      })}

      {/* ---------- Twelve Labs (OPTIONAL pre-filter) ---------- */}
      <div className="mt-4 border-t border-border pt-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold">Twelve Labs API Key — Pre-Filter (optional)</h2>
          {data?.twelveLabs?.hasKey ? (
            <span className="ml-auto flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 font-mono text-xs text-success">
              <Check className="size-3" aria-hidden />
              {data.twelveLabs.maskedKey}
            </span>
          ) : (
            <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">not set</span>
          )}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            type="password"
            value={tlValue}
            onChange={(e) => setTlValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) saveTl()
            }}
            placeholder={data?.twelveLabs?.hasKey ? 'Paste a new key to replace' : 'Paste your Twelve Labs API key (optional)'}
            aria-label="Twelve Labs API key"
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="button"
            onClick={() => saveTl()}
            disabled={tlSaving || !tlValue.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
          >
            {tlSaving ? 'Saving...' : tlSaved ? 'Saved' : data?.twelveLabs?.hasKey ? 'Update' : 'Save'}
          </button>
          {data?.twelveLabs?.hasKey && (
            <button
              type="button"
              onClick={() => removeTl()}
              disabled={tlSaving}
              aria-label="Remove Twelve Labs API key"
              title="Remove this key"
              className="rounded-md border border-border px-2.5 py-2 text-sm text-muted-foreground hover:text-destructive disabled:opacity-40"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Optional embedding pre-filter — jab set hai to scan se pehle Twelve Labs sirf matching movie chunks select
          karta hai (Gemini quota saver). Khali chhodo to app bilkul normal full-scan mode me chalega, koi asar nahi.
        </p>
      </div>

      {/* ---------- Gemini Cloud Files API Storage Cleaner & Daily Quota Reset ---------- */}
      {slots.some((s) => s.hasKey) && (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-lg border border-border bg-card/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <HardDrive className="size-4 text-primary" aria-hidden />
                <div>
                  <h2 className="text-sm font-semibold">Gemini Cloud Storage</h2>
                  <p className="text-xs text-muted-foreground">
                    Temporary video files sweep (20 GB quota).
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => cleanGeminiStorage()}
                  disabled={cleaningStorage || deletingAllFiles}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-xs font-medium hover:bg-secondary/80 disabled:opacity-50"
                  title="Sweep temporary/prescan movie clips"
                >
                  <Sparkles className="size-3 text-primary" aria-hidden />
                  {cleaningStorage ? 'Sweeping...' : 'Sweep Temp'}
                </button>
                <button
                  type="button"
                  onClick={() => deleteAllCloudFiles()}
                  disabled={deletingAllFiles || cleaningStorage}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
                  title="Delete all uploaded movie and temporary files across all API keys"
                >
                  <X className="size-3" aria-hidden />
                  {deletingAllFiles ? 'Deleting...' : 'Delete All Files'}
                </button>
              </div>
            </div>
            {cleanMsg && (
              <p className="mt-2 text-xs font-medium text-success">
                ✓ {cleanMsg}
              </p>
            )}
          </div>

          <div className="rounded-lg border border-border bg-card/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <KeyRound className="size-4 text-primary" aria-hidden />
                <div>
                  <h2 className="text-sm font-semibold">Daily Quota Counters</h2>
                  <p className="text-xs text-muted-foreground">
                    Clear all 20/20 counters & exhaustion flags back to 0.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => reconcileQuotaCounters()}
                  disabled={reconcilingCounters || resettingCounters}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-xs font-medium hover:bg-secondary/80 disabled:opacity-50"
                  title="Recalculate today's usage from actual completed scans and clear false exhaustion flags"
                >
                  <RefreshCw className={`size-3 text-primary ${reconcilingCounters ? 'animate-spin' : ''}`} aria-hidden />
                  {reconcilingCounters ? 'Syncing...' : 'Sync Quota'}
                </button>
                <button
                  type="button"
                  onClick={() => resetQuotaCounters()}
                  disabled={resettingCounters || reconcilingCounters}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-medium hover:bg-secondary/80 disabled:opacity-50"
                >
                  {resettingCounters ? 'Resetting...' : 'Reset to 0/20'}
                </button>
              </div>
            </div>
            {resetMsg && (
              <p className="mt-2 text-xs font-medium text-success">
                ✓ {resetMsg}
              </p>
            )}
          </div>
        </div>
      )}

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Add 1 to 20 keys — the scan works with ANY number. All keys scan chunks in parallel first, then all keys run 24fps
        verification together, and whichever key is free picks up any pending work. Each key uses all 6 models with its own
        daily counters. More keys = faster scans. Keys are stored server-side only.
      </p>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      {!slots[0]?.hasKey && <p className="mt-1 text-xs text-destructive">No Key 1 = no scan. Add it to enable scanning.</p>}
    </section>
  )
}
