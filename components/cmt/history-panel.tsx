'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { History, Plus, Trash2, Loader2, Pencil, Check, X } from 'lucide-react'
import type { ScanSummary } from '@/lib/types'
import { fetcher, fmtTime } from '@/lib/format'

const STATUS_CLS: Record<string, string> = {
  done: 'bg-success/15 text-success',
  scanning: 'bg-primary/15 text-primary',
  verifying: 'bg-primary/15 text-primary',
  stopped: 'bg-amber-500/15 text-amber-400',
  error: 'bg-destructive/15 text-destructive',
  queued: 'bg-muted text-muted-foreground',
}

export function HistoryPanel({ activeId, onSelect, onNew }: { activeId: string | null; onSelect: (id: string) => void; onNew: () => void }) {
  const { data, mutate } = useSWR<{ scans: ScanSummary[] }>('/api/scans', fetcher, { refreshInterval: 5000 })
  const scans = data?.scans || []

  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmClearAll, setConfirmClearAll] = useState(false)
  const [clearingAll, setClearingAll] = useState(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [savingName, setSavingName] = useState(false)

  async function handleSaveName(id: string) {
    if (!editingName.trim()) return
    setSavingName(true)
    try {
      const res = await fetch(`/api/scans/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customName: editingName.trim() }),
      })
      if (res.ok) {
        await mutate()
        setEditingId(null)
      }
    } catch (err) {
      console.error('Failed to rename scan:', err)
    } finally {
      setSavingName(false)
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      const res = await fetch(`/api/scans/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete scan')
      if (id === activeId) {
        onNew()
      }
      await mutate()
    } catch (err) {
      console.error(err)
    } finally {
      setDeletingId(null)
      setConfirmId(null)
    }
  }

  async function handleClearAll() {
    setClearingAll(true)
    try {
      const res = await fetch('/api/scans', { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to clear history')
      onNew()
      await mutate()
    } catch (err) {
      console.error(err)
    } finally {
      setClearingAll(false)
      setConfirmClearAll(false)
    }
  }

  return (
    <section aria-label="Scan history" className="panel">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <History className="size-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold">Scan History</h2>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {scans.length > 0 && (
            confirmClearAll ? (
              <div className="flex items-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/15 px-2 py-1 text-xs">
                <span className="text-destructive font-semibold">Delete all videos & history?</span>
                <button
                  type="button"
                  disabled={clearingAll}
                  onClick={handleClearAll}
                  className="btn-press flex items-center gap-1 rounded bg-destructive px-2 py-0.5 font-bold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                  title="Permanently delete all scans and videos from server"
                >
                  {clearingAll ? <Loader2 className="size-3 animate-spin" /> : 'Yes, Delete All'}
                </button>
                <button
                  type="button"
                  disabled={clearingAll}
                  onClick={() => setConfirmClearAll(false)}
                  className="btn-press rounded bg-muted px-2 py-0.5 text-muted-foreground hover:bg-muted/80"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmClearAll(true)}
                className="btn-press flex items-center gap-1 rounded-lg border border-input px-2.5 py-1 text-xs font-medium text-muted-foreground hover:border-destructive/40 hover:bg-destructive/15 hover:text-destructive transition-colors"
                title="Delete all scans and videos from server"
              >
                <Trash2 className="size-3" aria-hidden /> Delete All
              </button>
            )
          )}
          <button
            type="button"
            onClick={onNew}
            className="btn-press flex items-center gap-1 rounded-lg border border-input px-2.5 py-1 text-xs font-medium hover:border-primary/40 hover:bg-secondary"
          >
            <Plus className="size-3.5" aria-hidden /> New scan
          </button>
        </div>
      </div>

      {scans.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No scans yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {scans.map((s) => (
            <li key={s.id} className="relative">
              <div
                className={`flex items-stretch rounded-lg border transition-all ${
                  s.id === activeId
                    ? 'border-primary/50 bg-primary/10 shadow-md shadow-primary/10'
                    : 'border-border bg-background/60 hover:border-primary/30 hover:bg-secondary/40'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(s.id)}
                  className="btn-press flex-1 min-w-0 p-2.5 text-left focus-visible:outline-none"
                >
                  <div className="flex items-center gap-2">
                    {editingId === s.id ? (
                      <div className="flex items-center gap-1 min-w-0 flex-1" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleSaveName(s.id)
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          placeholder="Scan name..."
                          className="w-full rounded border border-primary bg-background px-1.5 py-0.5 text-xs text-foreground focus:outline-none"
                          autoFocus
                        />
                        <button
                          type="button"
                          disabled={savingName}
                          onClick={() => void handleSaveName(s.id)}
                          className="rounded bg-primary p-1 text-primary-foreground hover:opacity-90"
                          title="Save scan name"
                        >
                          {savingName ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="rounded bg-muted p-1 text-muted-foreground hover:bg-muted/80"
                          title="Cancel"
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 min-w-0 flex-1 group/name">
                        <span className="truncate font-medium text-xs text-foreground">
                          {s.customName || s.movieName || s.shortName || 'Untitled scan'}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingId(s.id)
                            setEditingName(s.customName || s.movieName || s.shortName || '')
                          }}
                          className="opacity-0 group-hover/name:opacity-100 rounded p-0.5 text-muted-foreground hover:text-foreground transition-opacity"
                          title="Rename scan"
                        >
                          <Pencil className="size-3" />
                        </button>
                      </div>
                    )}
                    <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] ${STATUS_CLS[s.status] || 'bg-muted text-muted-foreground'}`}>
                      {s.background?.state === 'queued' ? `queued${s.background.position ? ` #${s.background.position}` : ''}` : s.background?.state === 'running' ? 'background' : s.status}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2 text-muted-foreground text-[11px]">
                    <span>{new Date(s.createdAt).toLocaleString()}</span>
                    {s.movieDuration ? <span className="font-mono">{fmtTime(s.movieDuration)}</span> : null}
                    <span className="ml-auto font-mono font-medium">{s.matchCount} match(es)</span>
                  </div>
                </button>

                <div className="flex items-center pr-2 pl-1 shrink-0 border-l border-border/40 my-1.5">
                  {confirmId === s.id ? (
                    <div className="flex items-center gap-1 bg-destructive/15 border border-destructive/40 rounded px-2 py-1 text-xs">
                      <span className="text-destructive font-medium text-[11px]">Delete video & server files?</span>
                      <button
                        type="button"
                        disabled={deletingId === s.id}
                        onClick={() => handleDelete(s.id)}
                        className="btn-press rounded bg-destructive px-2 py-0.5 font-bold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50 text-xs"
                        title="Permanently delete video and all files from server"
                      >
                        {deletingId === s.id ? <Loader2 className="size-3 animate-spin" /> : 'Delete'}
                      </button>
                      <button
                        type="button"
                        disabled={deletingId === s.id}
                        onClick={() => setConfirmId(null)}
                        className="btn-press rounded bg-muted px-2 py-0.5 text-muted-foreground hover:bg-muted/80 text-xs"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmId(s.id)}
                      disabled={deletingId === s.id}
                      className="btn-press rounded-md p-2 text-muted-foreground hover:bg-destructive/15 hover:text-destructive transition-colors"
                      title="Delete this scan, video and all server data"
                      aria-label={`Delete scan ${s.movieName || s.id}`}
                    >
                      {deletingId === s.id ? (
                        <Loader2 className="size-4 animate-spin text-destructive" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

