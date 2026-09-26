import fs from 'node:fs'
import path from 'node:path'
import type { Scan } from './types'
import { deletePrefix, getObjectText, listObjects, putObject, storageEnabled } from './storage'

// Scan records live on local disk (DATA_DIR/scans/<id>.json — the source of
// truth for the running server) and are mirrored to S3 (scans/<id>.json) so
// history and results survive an instance replacement. Originals are mirrored
// separately by lib/media.ts under media/<id>/.

const S3_SCAN_PREFIX = 'scans/'

function s3Key(id: string) {
  return `${S3_SCAN_PREFIX}${id}.json`
}

// ---------- Throttled backup ----------
// saveScan() fires extremely often during a scan (progress updates), so we
// throttle uploads per scan id and always flush a trailing write.

const THROTTLE_MS = 15_000
const lastUpload = new Map<string, number>()
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
const latestPayload = new Map<string, string>()

async function uploadNow(id: string) {
  const payload = latestPayload.get(id)
  if (!payload || !storageEnabled()) return
  lastUpload.set(id, Date.now())
  try {
    await putObject(s3Key(id), payload, 'application/json')
  } catch (err) {
    console.error('[scan-store] S3 backup failed:', err instanceof Error ? err.message : err)
  }
}

/** Fire-and-forget: mirror the scan JSON to S3 (throttled, trailing flush).
 *  immediate=true skips the throttle window (e.g. upload finalized). */
export function backupScan(scan: Scan, immediate = false) {
  if (!storageEnabled()) return
  const id = scan.id
  latestPayload.set(id, JSON.stringify(scan))

  const isFinal = scan.status === 'done' || scan.status === 'error' || scan.finishedAt != null
  const elapsed = Date.now() - (lastUpload.get(id) || 0)

  if (immediate || isFinal || elapsed >= THROTTLE_MS) {
    const t = pendingTimers.get(id)
    if (t) {
      clearTimeout(t)
      pendingTimers.delete(id)
    }
    void uploadNow(id)
    return
  }

  if (!pendingTimers.has(id)) {
    const t = setTimeout(() => {
      pendingTimers.delete(id)
      void uploadNow(id)
    }, THROTTLE_MS - elapsed)
    if (typeof t.unref === 'function') t.unref()
    pendingTimers.set(id, t)
  }
}

/** Awaitable flush: uploads the scan JSON to S3 right now. */
export async function flushScan(scan: Scan): Promise<void> {
  const id = scan.id
  latestPayload.set(id, JSON.stringify(scan))
  const t = pendingTimers.get(id)
  if (t) {
    clearTimeout(t)
    pendingTimers.delete(id)
  }
  await uploadNow(id)
}

/** Delete ALL of a scan's S3 data: the JSON record, its videos and embeddings. */
export async function deleteScanRemote(id: string) {
  lastUpload.delete(id)
  latestPayload.delete(id)
  const t = pendingTimers.get(id)
  if (t) {
    clearTimeout(t)
    pendingTimers.delete(id)
  }
  if (!storageEnabled()) return
  try {
    await Promise.all([deletePrefix(s3Key(id)), deletePrefix(`media/${id}/`), deletePrefix(`tl/${id}-`)])
  } catch (err) {
    console.error('[scan-store] S3 delete failed:', err instanceof Error ? err.message : err)
  }
}

// ---------- Restore ----------
// On a fresh instance DATA_DIR/scans may be empty. Pull the JSON records
// back from S3 so history/results reappear. Runs once per process.

let restored = false
let restoring: Promise<void> | null = null

export function restoreScans(scansDir: string): Promise<void> {
  if (restored || !storageEnabled()) return Promise.resolve()
  if (restoring) return restoring
  restoring = (async () => {
    try {
      const objects = await listObjects(S3_SCAN_PREFIX)
      fs.mkdirSync(scansDir, { recursive: true })
      let pulled = 0
      for (const o of objects) {
        const name = path.basename(o.key)
        if (!name.endsWith('.json')) continue
        const local = path.join(scansDir, name)
        if (fs.existsSync(/*turbopackIgnore: true*/ local)) continue
        try {
          const text = await getObjectText(o.key)
          if (!text) continue
          JSON.parse(text) // validate before writing
          fs.writeFileSync(local, text)
          pulled++
        } catch (err) {
          console.error('[scan-store] restore of', name, 'failed:', err instanceof Error ? err.message : err)
        }
      }
      if (pulled > 0) console.log(`[scan-store] restored ${pulled} scan record(s) from S3`)
      restored = true
    } catch (err) {
      console.error('[scan-store] restore failed:', err instanceof Error ? err.message : err)
    } finally {
      restoring = null
    }
  })()
  return restoring
}
