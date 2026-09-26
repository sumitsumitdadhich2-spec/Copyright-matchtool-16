'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Coins, KeyRound, Loader2, Plus, Trash2, UserX, UserCheck, Users, X } from 'lucide-react'

interface ManagedUser {
  username: string
  createdAt: string
  disabled: boolean
  tokens: number
}

async function usersFetcher(url: string): Promise<{ users: ManagedUser[] }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error('Failed to load users')
  return res.json()
}

export function UsersDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, mutate, isLoading } = useSWR(open ? '/api/auth/users' : null, usersFetcher)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  if (!open) return null

  async function call(method: string, body: object): Promise<boolean> {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch('/api/auth/users', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(j.error || 'Action failed')
        return false
      }
      void mutate()
      return true
    } catch {
      setError('Network error')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function addUser(e: React.FormEvent) {
    e.preventDefault()
    const ok = await call('POST', { username: newUsername, password: newPassword })
    if (ok) {
      setNotice(`User "${newUsername}" created — share the ID and password with them.`)
      setNewUsername('')
      setNewPassword('')
    }
  }

  async function resetPassword(username: string) {
    const pw = window.prompt(`New password for "${username}" (min 6 chars):`)
    if (!pw) return
    const ok = await call('PATCH', { username, password: pw })
    if (ok) setNotice(`Password updated for "${username}".`)
  }

  async function setTokens(username: string, current: number) {
    const input = window.prompt(`"${username}" ke liye tokens set karo (100 tokens = 1 scan):`, String(current))
    if (input === null) return
    const amount = Number(input)
    if (!Number.isFinite(amount) || amount < 0) {
      setError('Valid token amount daalo (0 ya usse zyada)')
      return
    }
    const ok = await call('PATCH', { username, tokens: Math.floor(amount) })
    if (ok) setNotice(`"${username}" ke tokens ab ${Math.floor(amount)} hain.`)
  }

  async function removeUser(username: string) {
    if (!window.confirm(`Delete user "${username}"? They will lose access permanently.`)) return
    const ok = await call('DELETE', { username })
    if (ok) setNotice(`User "${username}" deleted.`)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Manage users"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
    >
      <div className="alert-in flex max-h-[85vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Users className="size-4 text-primary" aria-hidden /> Manage users
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="btn-press rounded-lg border border-input bg-background p-1.5 hover:bg-secondary"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <form onSubmit={addUser} className="flex flex-col gap-2 rounded-xl border border-border bg-background p-3">
          <p className="text-xs font-medium text-muted-foreground">Create new user ID</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="Username"
              autoCapitalize="none"
              required
              className="min-w-0 flex-1 rounded-lg border border-input bg-card px-3 py-2 text-sm outline-none focus:border-primary"
            />
            <input
              type="text"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Password (min 6)"
              required
              className="min-w-0 flex-1 rounded-lg border border-input bg-card px-3 py-2 text-sm outline-none focus:border-primary"
            />
            <button
              type="submit"
              disabled={busy || !newUsername || !newPassword}
              className="btn-press flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-40"
            >
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
              Create
            </button>
          </div>
        </form>

        {error && (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">{notice}</p>
        )}

        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Users {data ? `(${data.users.length})` : ''}
          </p>
          {isLoading && (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Loading users...
            </div>
          )}
          {data && data.users.length === 0 && (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
              No users yet — create the first ID above.
            </p>
          )}
          {data?.users.map((u) => (
            <div
              key={u.username}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {u.username}
                  {u.disabled && (
                    <span className="ml-2 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-destructive">
                      Disabled
                    </span>
                  )}
                </p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  Created {new Date(u.createdAt).toLocaleDateString()}
                </p>
                <p className="mt-1 inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 font-mono text-[11px] font-semibold text-warning">
                  <Coins className="size-3" aria-hidden />
                  {u.tokens} tokens
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setTokens(u.username, u.tokens)}
                  disabled={busy}
                  title="Set tokens (100 tokens = 1 scan)"
                  aria-label={`Set tokens for ${u.username}`}
                  className="btn-press rounded-lg border border-warning/50 bg-card p-2 text-warning hover:bg-warning/10 disabled:opacity-40"
                >
                  <Coins className="size-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => resetPassword(u.username)}
                  disabled={busy}
                  title="Reset password"
                  aria-label={`Reset password for ${u.username}`}
                  className="btn-press rounded-lg border border-input bg-card p-2 hover:bg-secondary disabled:opacity-40"
                >
                  <KeyRound className="size-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => call('PATCH', { username: u.username, disabled: !u.disabled })}
                  disabled={busy}
                  title={u.disabled ? 'Enable user' : 'Disable user'}
                  aria-label={`${u.disabled ? 'Enable' : 'Disable'} ${u.username}`}
                  className="btn-press rounded-lg border border-input bg-card p-2 hover:bg-secondary disabled:opacity-40"
                >
                  {u.disabled ? <UserCheck className="size-4" aria-hidden /> : <UserX className="size-4" aria-hidden />}
                </button>
                <button
                  type="button"
                  onClick={() => removeUser(u.username)}
                  disabled={busy}
                  title="Delete user"
                  aria-label={`Delete ${u.username}`}
                  className="btn-press rounded-lg border border-destructive/50 bg-card p-2 text-destructive hover:bg-destructive/10 disabled:opacity-40"
                >
                  <Trash2 className="size-4" aria-hidden />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
