import 'server-only'

import { readJSONRecord, writeJSONRecord } from './json-record'

// ---------------------------------------------------------------------------
// Per-user token balances — one JSON record on local disk + S3.
// 1 scan = 100 tokens. Admin (shiva) has unlimited tokens.
// ---------------------------------------------------------------------------

export const SCAN_TOKEN_COST = 100

const TOKENS_RECORD = 'auth/tokens.json'

type TokenMap = Record<string, number>

async function readTokenMap(): Promise<TokenMap> {
  const data = await readJSONRecord<TokenMap>(TOKENS_RECORD)
  return data && typeof data === 'object' ? data : {}
}

async function writeTokenMap(map: TokenMap): Promise<void> {
  await writeJSONRecord(TOKENS_RECORD, map)
}

function keyFor(username: string): string {
  return username.trim().toLowerCase()
}

/** Current token balance for a user (0 if never set). */
export async function getTokenBalance(username: string): Promise<number> {
  const map = await readTokenMap()
  return map[keyFor(username)] ?? 0
}

/** Admin: set a user's balance to an exact amount. */
export async function setTokenBalance(username: string, amount: number): Promise<number> {
  const map = await readTokenMap()
  const next = Math.max(0, Math.floor(amount))
  map[keyFor(username)] = next
  await writeTokenMap(map)
  return next
}

/**
 * Deduct tokens for a scan. Returns the new balance, or null if the user
 * does not have enough tokens (nothing is deducted in that case).
 */
export async function deductTokens(username: string, amount: number): Promise<number | null> {
  const map = await readTokenMap()
  const key = keyFor(username)
  const current = map[key] ?? 0
  if (current < amount) return null
  map[key] = current - amount
  await writeTokenMap(map)
  return map[key]
}

/** Refund tokens (e.g. when a scan fails to start after deduction). */
export async function refundTokens(username: string, amount: number): Promise<number> {
  const map = await readTokenMap()
  const key = keyFor(username)
  map[key] = (map[key] ?? 0) + amount
  await writeTokenMap(map)
  return map[key]
}

/** Remove a deleted user's balance entry. */
export async function deleteTokenEntry(username: string): Promise<void> {
  const map = await readTokenMap()
  const key = keyFor(username)
  if (!(key in map)) return
  delete map[key]
  await writeTokenMap(map)
}

/** Balances for many users at once (for the admin panel list). */
export async function getTokenBalances(usernames: string[]): Promise<Record<string, number>> {
  const map = await readTokenMap()
  const out: Record<string, number> = {}
  for (const u of usernames) out[u] = map[keyFor(u)] ?? 0
  return out
}
