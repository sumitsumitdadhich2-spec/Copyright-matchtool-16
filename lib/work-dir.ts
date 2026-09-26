import fs from 'node:fs'
import path from 'node:path'
import { WORK_DIR, DISK_WORK_DIR, WORK_RAM_BUDGET_BYTES } from './paths'

// ---------------------------------------------------------------------------
// RAM working area for ffmpeg intermediates (movie chunks, short segments,
// verifier clips, render parts, prescan / merge slices).
//
//   WORK_DIR         = tmpfs (/dev/shm/cmt)          — hot, RAM speed
//   DISK_WORK_DIR    = DATA_DIR/work (EBS)            — overflow fallback
//
// Before a stage writes, the caller passes an estimated output size. If the
// RAM budget (WORK_RAM_BUDGET_MB) would be exceeded the stage transparently
// lands on disk instead. Per-scan dirs are cleaned after each stage and on
// scan delete; stale dirs are wiped on boot.
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __cmtWorkBooted?: boolean }

function ensure(dir: string) {
  if (!fs.existsSync(/*turbopackIgnore: true*/ dir)) fs.mkdirSync(dir, { recursive: true })
}

/** Wipe stale work dirs (once per process boot). */
export function bootWorkDirs() {
  if (g.__cmtWorkBooted) return
  g.__cmtWorkBooted = true
  for (const d of [WORK_DIR, DISK_WORK_DIR]) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      // ignore
    }
    try {
      ensure(d)
    } catch (err) {
      console.error('[work-dir] cannot create', d, err instanceof Error ? err.message : err)
    }
  }
  console.log(`[work-dir] RAM work dir: ${WORK_DIR} (budget ${(WORK_RAM_BUDGET_BYTES / 1048576).toFixed(0)} MB), disk fallback: ${DISK_WORK_DIR}`)
}

/** Recursive byte size of a directory (0 when missing). */
export function dirSize(dir: string): number {
  let total = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) total += dirSize(p)
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return total
}

/** Bytes currently used inside the RAM work dir. */
export function ramWorkUsed(): number {
  return dirSize(WORK_DIR)
}

export interface WorkPlacement {
  dir: string
  inRam: boolean
}

/**
 * Pick where a stage's output should go. `estimatedBytes` is the caller's
 * estimate of what the stage will write; if it does not fit in the remaining
 * RAM budget the stage goes to disk. Returns the (created) directory.
 */
export function placeWork(scanId: string, stage: string, estimatedBytes: number): WorkPlacement {
  bootWorkDirs()
  const used = ramWorkUsed()
  const fits = used + Math.max(0, estimatedBytes) <= WORK_RAM_BUDGET_BYTES
  const base = fits ? WORK_DIR : DISK_WORK_DIR
  const dir = path.join(base, scanId, stage)
  ensure(dir)
  if (!fits) {
    console.log(
      `[work-dir] ${scanId}/${stage}: est ${(estimatedBytes / 1048576).toFixed(0)} MB exceeds RAM budget (used ${(used / 1048576).toFixed(0)} MB) → disk`,
    )
  }
  return { dir, inRam: fits }
}

/** Existing stage dir (RAM first, then disk) without creating anything. */
export function findWork(scanId: string, stage: string): string | null {
  for (const base of [WORK_DIR, DISK_WORK_DIR]) {
    const dir = path.join(base, scanId, stage)
    if (fs.existsSync(/*turbopackIgnore: true*/ dir)) return dir
  }
  return null
}

/** Stage dir that exists, or a freshly placed one. */
export function stageDir(scanId: string, stage: string, estimatedBytes: number): string {
  return findWork(scanId, stage) ?? placeWork(scanId, stage, estimatedBytes).dir
}

/** Remove one stage's work dir (both locations). */
export function removeStageWork(scanId: string, stage: string) {
  for (const base of [WORK_DIR, DISK_WORK_DIR]) {
    try {
      fs.rmSync(path.join(base, scanId, stage), { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

/** Remove everything a scan left in the work areas. */
export function removeScanWork(scanId: string) {
  for (const base of [WORK_DIR, DISK_WORK_DIR]) {
    try {
      fs.rmSync(path.join(base, scanId), { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

/** Rough size estimate for a scan-copy encode (640px / 24 fps / CRF 28 ≈ 0.5 MB per second). */
export function estimateScanCopyBytes(seconds: number): number {
  return Math.ceil(Math.max(1, seconds) * 0.5 * 1024 * 1024)
}

/** Rough size estimate for a bitrate-driven encode. */
export function estimateBitrateBytes(seconds: number, videoKbps: number, audioKbps: number): number {
  return Math.ceil((Math.max(1, seconds) * (videoKbps + audioKbps) * 1000) / 8)
}
