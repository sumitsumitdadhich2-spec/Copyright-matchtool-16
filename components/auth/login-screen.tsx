'use client'

import { useState } from 'react'
import { Loader2, Lock, ScanSearch } from 'lucide-react'

interface LoginScreenProps {
  onLoggedIn: (user: { username: string; role: 'admin' | 'user' }) => void
}

export function LoginScreen({ onLoggedIn }: LoginScreenProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'Login failed')
        return
      }
      onLoggedIn(data.user)
    } catch {
      setError('Network error — try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="alert-in w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <span className="flex size-14 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/30">
            <ScanSearch className="size-7" aria-hidden />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              Shiva <span className="text-primary">MatchTool</span>
            </h1>
            <p className="mt-1 flex items-center justify-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              <Lock className="size-3" aria-hidden /> Restricted access
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Username</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              required
              className="rounded-lg border border-input bg-background px-3 py-2.5 text-sm outline-none transition-colors focus:border-primary"
              placeholder="Enter username"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className="rounded-lg border border-input bg-background px-3 py-2.5 text-sm outline-none transition-colors focus:border-primary"
              placeholder="Enter password"
            />
          </label>

          {error && (
            <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !username || !password}
            className="btn-press mt-1 flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/25 hover:shadow-lg hover:shadow-primary/30 disabled:opacity-40 disabled:shadow-none"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Lock className="size-4" aria-hidden />}
            {busy ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
