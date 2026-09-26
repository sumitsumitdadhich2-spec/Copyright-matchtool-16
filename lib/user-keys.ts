import 'server-only'

import { MAX_API_KEYS } from './store'
import type { MinuteFinderMode } from './types'
import { readJSONRecord, writeJSONRecord, deleteJSONRecord } from './json-record'

// ---------------------------------------------------------------------------
// PER-USER Gemini API keys — local disk + S3 (lib/json-record.ts).
// Each account gets its own file: auth/keys/<username>.json
// so every user's keys are fully isolated from everyone else's.
// ---------------------------------------------------------------------------

const KEYS_PREFIX = 'auth/keys/'

/** slot number (as string) -> API key */
type UserKeys = Record<string, string>

function cacheKey(username: string): string {
  return username.trim().toLowerCase()
}

function recordFor(username: string): string {
  // Usernames are validated at creation ([a-zA-Z0-9_.-]{3,32}), safe as a path.
  return `${KEYS_PREFIX}${cacheKey(username)}.json`
}

async function readUserKeys(username: string): Promise<UserKeys> {
  const data = await readJSONRecord<UserKeys>(recordFor(username))
  return data && typeof data === 'object' ? data : {}
}

async function writeUserKeys(username: string, keys: UserKeys): Promise<void> {
  await writeJSONRecord(recordFor(username), keys)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read this user's API key for slot n (1-20). */
export async function getUserKeyN(username: string, n: number): Promise<string | null> {
  const keys = await readUserKeys(username)
  return keys[String(n)] || null
}

/** Save this user's API key in slot n (1-20). */
export async function setUserKeyN(username: string, n: number, key: string): Promise<void> {
  const keys = await readUserKeys(username)
  await writeUserKeys(username, { ...keys, [String(n)]: key })
}

/** Remove this user's key in slot n. */
export async function clearUserKeyN(username: string, n: number): Promise<void> {
  const keys = { ...(await readUserKeys(username)) }
  delete keys[String(n)]
  await writeUserKeys(username, keys)
}

/** All of this user's configured keys in slot order, de-duplicated. */
export async function getAllUserApiKeys(username: string): Promise<string[]> {
  const keys = await readUserKeys(username)
  const out: string[] = []
  for (let n = 1; n <= MAX_API_KEYS; n++) {
    const k = keys[String(n)]
    if (k && !out.includes(k)) out.push(k)
  }
  return out
}

// ---------------------------------------------------------------------------
// TWELVE LABS API key (optional pre-filter) — stored in the SAME per-user
// file under a reserved non-numeric slot so it never collides with Gemini
// slots 1-20. Missing key = pre-filter off, app runs exactly as before.
// ---------------------------------------------------------------------------

const TL_SLOT = 'twelvelabs'

/** Read this user's Twelve Labs API key (null = pre-filter disabled). */
export async function getUserTwelveLabsKey(username: string): Promise<string | null> {
  const keys = await readUserKeys(username)
  return keys[TL_SLOT] || null
}

/** Save this user's Twelve Labs API key. */
export async function setUserTwelveLabsKey(username: string, key: string): Promise<void> {
  const keys = await readUserKeys(username)
  await writeUserKeys(username, { ...keys, [TL_SLOT]: key })
}

/** Remove this user's Twelve Labs API key. */
export async function clearUserTwelveLabsKey(username: string): Promise<void> {
  const keys = { ...(await readUserKeys(username)) }
  delete keys[TL_SLOT]
  await writeUserKeys(username, keys)
}

// ---------------------------------------------------------------------------
// MINUTE FINDER MODE — per-user preference stored in the same file under a
// reserved non-numeric slot. Default 'gemini' (Gemini Minute Finder).
// ---------------------------------------------------------------------------

const MINUTE_FINDER_SLOT = 'minuteFinder'

export function isMinuteFinderMode(v: unknown): v is MinuteFinderMode {
  return v === 'gemini' || v === 'twelvelabs' || v === 'off'
}

/** Which minute finder runs for this user after upload + trim (default 'gemini'). */
export async function getUserMinuteFinderMode(username: string): Promise<MinuteFinderMode> {
  const keys = await readUserKeys(username)
  const v = keys[MINUTE_FINDER_SLOT]
  return isMinuteFinderMode(v) ? v : 'gemini'
}

export async function setUserMinuteFinderMode(username: string, mode: MinuteFinderMode): Promise<void> {
  const keys = await readUserKeys(username)
  await writeUserKeys(username, { ...keys, [MINUTE_FINDER_SLOT]: mode })
}

// ---------------------------------------------------------------------------
// VERIFIER ENABLED — per-user preference stored under a reserved slot.
// Default true (auto-verifier on).
// ---------------------------------------------------------------------------

const VERIFIER_ENABLED_SLOT = 'verifierEnabled'

/** Whether candidate verifier runs for this user (default true). */
export async function getUserVerifierEnabled(username: string): Promise<boolean> {
  const keys = await readUserKeys(username)
  const v = keys[VERIFIER_ENABLED_SLOT]
  return v === 'false' ? false : true
}

export async function setUserVerifierEnabled(username: string, enabled: boolean): Promise<void> {
  const keys = await readUserKeys(username)
  await writeUserKeys(username, { ...keys, [VERIFIER_ENABLED_SLOT]: enabled ? 'true' : 'false' })
}

// ---------------------------------------------------------------------------
// AUTO MODE ENABLED — per-user preference stored under a reserved slot.
// Default true (auto full-short, full-movie, auto-start window minute finder).
// ---------------------------------------------------------------------------

const AUTO_MODE_SLOT = 'autoMode'

/** Whether auto-mode (full movie, full short, automatic window minute finder start) is enabled (default true). */
export async function getUserAutoMode(username: string): Promise<boolean> {
  const keys = await readUserKeys(username)
  const v = keys[AUTO_MODE_SLOT]
  return v === 'false' ? false : true
}

export async function setUserAutoMode(username: string, enabled: boolean): Promise<void> {
  const keys = await readUserKeys(username)
  await writeUserKeys(username, { ...keys, [AUTO_MODE_SLOT]: enabled ? 'true' : 'false' })
}

/** Delete a user's entire key file (used when the account is deleted). */
export async function deleteUserKeys(username: string): Promise<void> {
  await deleteJSONRecord(recordFor(username))
}
