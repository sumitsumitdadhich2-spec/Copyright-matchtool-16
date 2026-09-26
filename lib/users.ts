import 'server-only'

import bcrypt from 'bcryptjs'
import { cookies } from 'next/headers'
import { SESSION_COOKIE, verifySessionToken, type SessionUser } from './session'
import { readJSONRecord, writeJSONRecord } from './json-record'

// ---------------------------------------------------------------------------
// Main admin — hardcoded, always works, cannot be deleted or edited.
// Username: shiva
// Only the admin can create / delete / disable users.
// ---------------------------------------------------------------------------
const ADMIN_USERNAME = 'shiva'
const ADMIN_PASSWORD_HASH = '$2b$10$SJEoi7jHco55ifsYRxF0ju7SHy9yYF8ULJDt551L4jfUeVBZEHeFC'

// Stored on local disk (DATA_DIR/auth/users.json) AND mirrored to S3
// (auth/users.json) — see lib/json-record.ts.
const USERS_RECORD = 'auth/users.json'

export interface StoredUser {
  username: string
  passwordHash: string
  createdAt: string
  disabled?: boolean
}

export async function readUsers(): Promise<StoredUser[]> {
  const data = await readJSONRecord<StoredUser[]>(USERS_RECORD)
  return Array.isArray(data) ? data : []
}

async function writeUsers(users: StoredUser[]): Promise<void> {
  await writeJSONRecord(USERS_RECORD, users)
}

// ---------------------------------------------------------------------------
// Auth operations
// ---------------------------------------------------------------------------

export async function verifyLogin(username: string, password: string): Promise<SessionUser | null> {
  const name = username.trim().toLowerCase()

  if (name === ADMIN_USERNAME) {
    const ok = await bcrypt.compare(password, ADMIN_PASSWORD_HASH)
    return ok ? { username: ADMIN_USERNAME, role: 'admin' } : null
  }

  const users = await readUsers()
  const user = users.find((u) => u.username.toLowerCase() === name)
  if (!user || user.disabled) return null
  const ok = await bcrypt.compare(password, user.passwordHash)
  return ok ? { username: user.username, role: 'user' } : null
}

export async function createUser(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const name = username.trim()
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(name)) {
    return { ok: false, error: 'Username: 3-32 chars, letters/numbers/_ . - only' }
  }
  if (password.length < 6 || password.length > 72) {
    return { ok: false, error: 'Password must be 6-72 characters' }
  }
  if (name.toLowerCase() === ADMIN_USERNAME) {
    return { ok: false, error: 'This username is reserved' }
  }
  const users = await readUsers()
  if (users.some((u) => u.username.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: 'Username already exists' }
  }
  users.push({
    username: name,
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: new Date().toISOString(),
  })
  await writeUsers(users)
  return { ok: true }
}

export async function deleteUser(username: string): Promise<boolean> {
  const users = await readUsers()
  const next = users.filter((u) => u.username.toLowerCase() !== username.trim().toLowerCase())
  if (next.length === users.length) return false
  await writeUsers(next)
  return true
}

export async function setUserDisabled(username: string, disabled: boolean): Promise<boolean> {
  const users = await readUsers()
  const user = users.find((u) => u.username.toLowerCase() === username.trim().toLowerCase())
  if (!user) return false
  user.disabled = disabled
  await writeUsers(users)
  return true
}

export async function resetUserPassword(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  if (password.length < 6 || password.length > 72) {
    return { ok: false, error: 'Password must be 6-72 characters' }
  }
  const users = await readUsers()
  const user = users.find((u) => u.username.toLowerCase() === username.trim().toLowerCase())
  if (!user) return { ok: false, error: 'User not found' }
  user.passwordHash = await bcrypt.hash(password, 10)
  await writeUsers(users)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Session helpers for server components / route handlers
// ---------------------------------------------------------------------------

export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies()
  return verifySessionToken(cookieStore.get(SESSION_COOKIE)?.value)
}

export async function requireSession(): Promise<SessionUser | null> {
  return getSession()
}

export async function requireAdmin(): Promise<SessionUser | null> {
  const session = await getSession()
  return session?.role === 'admin' ? session : null
}
