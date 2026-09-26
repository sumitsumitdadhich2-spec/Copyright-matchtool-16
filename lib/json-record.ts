import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths'
import { getObjectJSON, putObjectJSON, deleteObject, storageEnabled } from './storage'

// ---------------------------------------------------------------------------
// Small JSON records (users, per-user keys, token balances) live in THREE
// places, checked in this order:
//   1. in-memory cache (per process, invalidated on write)
//   2. local disk  DATA_DIR/<key>              (fast, survives restarts)
//   3. S3          <key>                        (survives instance loss)
// Writes go to disk synchronously and to S3 awaited, so a record is durable
// before the API responds.
// ---------------------------------------------------------------------------

const cache = new Map<string, { value: unknown; at: number }>()
const CACHE_MS = 30_000

function localPath(key: string): string {
  return path.join(DATA_DIR, key)
}

export async function readJSONRecord<T>(key: string): Promise<T | null> {
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value as T | null

  const file = localPath(key)
  try {
    if (fs.existsSync(/*turbopackIgnore: true*/ file)) {
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as T
      cache.set(key, { value, at: Date.now() })
      return value
    }
  } catch {
    // corrupt local copy — fall through to S3
  }

  let value: T | null = null
  try {
    value = await getObjectJSON<T>(key)
  } catch (err) {
    console.error('[json-record] S3 read failed for', key, err instanceof Error ? err.message : err)
  }
  if (value !== null) {
    // Re-hydrate the local copy so the next read is a plain disk hit.
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(value))
    } catch {
      // ignore
    }
  }
  cache.set(key, { value, at: Date.now() })
  return value
}

export async function writeJSONRecord(key: string, value: unknown): Promise<void> {
  const file = localPath(key)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
  cache.set(key, { value, at: Date.now() })
  if (storageEnabled()) {
    try {
      await putObjectJSON(key, value)
    } catch (err) {
      console.error('[json-record] S3 write failed for', key, err instanceof Error ? err.message : err)
    }
  }
}

export async function deleteJSONRecord(key: string): Promise<void> {
  cache.delete(key)
  try {
    fs.unlinkSync(localPath(key))
  } catch {
    // ignore
  }
  try {
    await deleteObject(key)
  } catch {
    // best-effort
  }
}

export function invalidateJSONRecord(key: string) {
  cache.delete(key)
}
