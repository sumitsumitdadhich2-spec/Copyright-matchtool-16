'use client'

import useSWR from 'swr'
import { Coins } from 'lucide-react'
import { fetcher } from '@/lib/format'

export interface TokenInfo {
  unlimited: boolean
  balance: number | null
  scanCost: number
}

/** Live token balance — polls every 5s and revalidates on focus. */
export function useTokens() {
  const { data, mutate } = useSWR<TokenInfo>('/api/tokens', fetcher, {
    refreshInterval: 5000,
    revalidateOnFocus: true,
  })
  const exhausted = Boolean(data && !data.unlimited && (data.balance ?? 0) < data.scanCost)
  return { tokens: data ?? null, exhausted, refreshTokens: () => void mutate() }
}

/** Header badge: token logo + live balance + "100 tokens = 1 scan". */
export function TokenBadge({ tokens }: { tokens: TokenInfo | null }) {
  if (!tokens) return null

  const low = !tokens.unlimited && (tokens.balance ?? 0) < tokens.scanCost

  return (
    <span
      title={`1 scan = ${tokens.scanCost} tokens`}
      className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-semibold ${
        low
          ? 'border-destructive/50 bg-destructive/10 text-destructive'
          : 'border-warning/40 bg-warning/10 text-warning'
      }`}
    >
      <span
        aria-hidden
        className={`flex size-5 items-center justify-center rounded-full ${
          low ? 'bg-destructive text-destructive-foreground' : 'bg-warning text-warning-foreground'
        }`}
      >
        <Coins className="size-3.5" />
      </span>
      <span className="font-mono tabular-nums">{tokens.unlimited ? '∞' : (tokens.balance ?? 0)}</span>
      <span className="hidden text-[10px] font-medium uppercase tracking-wider opacity-80 md:inline">
        {tokens.scanCost} tokens = 1 scan
      </span>
      <span className="sr-only">
        {tokens.unlimited ? 'Unlimited tokens' : `${tokens.balance ?? 0} tokens remaining, ${tokens.scanCost} tokens per scan`}
      </span>
    </span>
  )
}

/** Big blocking banner shown when the user's tokens are exhausted. */
export function TokensExhaustedBanner({ tokens }: { tokens: TokenInfo | null }) {
  if (!tokens || tokens.unlimited) return null

  return (
    <div
      role="alert"
      className="alert-in flex flex-col items-center gap-3 rounded-2xl border-2 border-destructive bg-destructive/10 px-6 py-8 text-center shadow-lg"
    >
      <span className="flex size-14 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-md">
        <Coins className="size-7" aria-hidden />
      </span>
      <p className="text-2xl font-bold tracking-tight text-destructive md:text-3xl">TOKENS KHATM HO GAYE HAIN!</p>
      <p className="max-w-md text-sm text-destructive/90">
        Aapke tokens khatm ho chuke hain — scan ab block hai. Naye tokens ke liye admin se contact karo.
      </p>
      <p className="rounded-full border border-destructive/40 bg-card px-4 py-1.5 font-mono text-xs font-semibold text-destructive">
        {tokens.scanCost} tokens = 1 scan · Balance: {tokens.balance ?? 0}
      </p>
    </div>
  )
}
