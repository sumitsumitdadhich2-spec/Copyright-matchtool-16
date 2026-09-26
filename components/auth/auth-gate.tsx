'use client'

import { createContext, useContext } from 'react'
import useSWR from 'swr'
import { Loader2 } from 'lucide-react'
import { LoginScreen } from './login-screen'

export interface AuthUser {
  username: string
  role: 'admin' | 'user'
}

const AuthContext = createContext<{ user: AuthUser; logout: () => void } | null>(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthGate')
  return ctx
}

async function meFetcher(url: string): Promise<{ user: AuthUser | null }> {
  const res = await fetch(url)
  if (res.status === 401) return { user: null }
  if (!res.ok) throw new Error('Failed to check session')
  return res.json()
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { data, isLoading, mutate } = useSWR('/api/auth/me', meFetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
        <span className="sr-only">Checking session</span>
      </div>
    )
  }

  const user = data?.user ?? null

  if (!user) {
    return <LoginScreen onLoggedIn={(u) => void mutate({ user: u }, { revalidate: false })} />
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    void mutate({ user: null }, { revalidate: false })
  }

  return <AuthContext.Provider value={{ user, logout }}>{children}</AuthContext.Provider>
}
