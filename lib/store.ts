import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Scan, ScanSummary, LogEntry } from './types'
import { MODEL_POOL, getModelDailyCap } from './models'
import { backupScan, deleteScanRemote } from './scan-store'
import { DATA_DIR, SCANS_DIR, MEDIA_DIR, MAX_SCANS } from './paths'
import { removeScanWork } from './work-dir'

export { DATA_DIR, SCANS_DIR, MEDIA_DIR, MAX_SCANS }

function ensureDirs() {
  for (const d of [DATA_DIR, SCANS_DIR, MEDIA_DIR]) {
    if (!fs.existsSync(/*turbopackIgnore: true*/ d)) fs.mkdirSync(d, { recursive: true })
  }
}

function readJSON<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJSON(file: string, data: unknown) {
  ensureDirs()
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, file)
}

// ---------- Settings (API key) ----------

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')

/** Up to 20 Gemini API keys. Key 1 is required; 2-20 are optional parallel workers. */
export const MAX_API_KEYS = 20

interface Settings {
  /** Slot 1 keeps the legacy `apiKey` field name; slots 2-20 use `apiKey2`...`apiKey20`. */
  apiKey?: string
  [key: `apiKey${number}`]: string | undefined
}

function keyField(n: number): keyof Settings {
  return (n === 1 ? 'apiKey' : `apiKey${n}`) as keyof Settings
}

/** Read API key for slot n (1-20). Slot 1 keeps the legacy `apiKey` field name. */
export function getApiKeyN(n: number): string | null {
  const s = readJSON<Settings>(SETTINGS_FILE, {})
  return (s[keyField(n)] as string | undefined) || null
}

export function getApiKey(): string | null {
  return getApiKeyN(1)
}

/** All configured keys in slot order, de-duplicated (a repeated key gives no extra quota). */
export function getAllApiKeys(): string[] {
  const out: string[] = []
  for (let n = 1; n <= MAX_API_KEYS; n++) {
    const k = getApiKeyN(n)
    if (k && !out.includes(k)) out.push(k)
  }
  return out
}

export function setApiKeyN(n: number, key: string) {
  const s = readJSON<Settings>(SETTINGS_FILE, {})
  writeJSON(SETTINGS_FILE, { ...s, [keyField(n)]: key })
}

/** Remove the key in slot n (slot 1 can also be cleared, but scanning then stops working). */
export function clearApiKeyN(n: number) {
  const s = readJSON<Settings>(SETTINGS_FILE, {})
  delete s[keyField(n)]
  writeJSON(SETTINGS_FILE, s)
}

export function apiKeyHash(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 10)
}

// ---------- Per-model daily request counters ----------
// Gemini daily quotas reset at midnight Pacific Time. Intl handles PST/PDT,
// including both daylight-saving boundaries, without relying on server locale.

const COUNTERS_FILE = path.join(DATA_DIR, 'counters.json')

interface CountersData {
  _lastActiveDay?: string
  _lastResetTime?: number
  [key: string]: number | string | boolean | undefined
}

let cachedCounters: CountersData | null = null
let cachedCountersTimestamp = 0
const CACHE_TTL_MS = 300 // fast cache: 0ms for tight loops, auto-refreshed periodically

function getCachedCounters(): CountersData {
  const now = Date.now()
  if (!cachedCounters || now - cachedCountersTimestamp > CACHE_TTL_MS) {
    ensureDirs()
    cachedCounters = readJSON<CountersData>(COUNTERS_FILE, {})
    cachedCountersTimestamp = now
  }
  return cachedCounters
}

function saveCounters(data: CountersData) {
  cachedCounters = data
  cachedCountersTimestamp = Date.now()
  writeJSON(COUNTERS_FILE, data)
}

export function geminiUsageDay(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

function todayKey(): string {
  return geminiUsageDay()
}

/**
 * Checks if the calendar date has changed since the last recorded activity.
 * When a new day starts (at midnight Pacific Time / deployment startup on a new date),
 * all old day counters and exhausted states are automatically purged and reset to 0.
 */
export function checkDailyReset(): boolean {
  ensureDirs()
  const today = todayKey()
  const counters = getCachedCounters()
  const lastDay = counters._lastActiveDay

  if (lastDay && lastDay !== today) {
    console.log(`[Daily Quota Reset] New date detected (${today} vs previous ${lastDay}). Resetting all Gemini daily usage counters to 0.`)
    const newCounters: CountersData = {
      _lastActiveDay: today,
      _lastResetTime: Date.now(),
    }
    saveCounters(newCounters)
    return true
  }

  if (!counters._lastActiveDay) {
    counters._lastActiveDay = today
    counters._lastResetTime = Date.now()
    saveCounters(counters)
  }
  return false
}

function counterKey(model: string, apiKey: string): string {
  return `${model}|${todayKey()}|${apiKeyHash(apiKey)}`
}

function exhaustedKey(model: string, apiKey: string): string {
  return `_exh|${model}|${todayKey()}|${apiKeyHash(apiKey)}`
}

export function getModelUsage(model: string, apiKey: string): number {
  checkDailyReset()
  const counters = getCachedCounters()
  const val = counters[counterKey(model, apiKey)]
  return typeof val === 'number' ? val : 0
}

export function isModelDailyQuotaExhausted(model: string, apiKey: string, rpdCap?: number): boolean {
  checkDailyReset()
  const counters = getCachedCounters()
  const usage = getModelUsage(model, apiKey)
  const cap = rpdCap ?? getModelDailyCap(model)
  // CRITICAL USER RULE: If usage in Settings is below model cap, quota is STILL AVAILABLE today!
  // Clear any spurious exhaustion flag immediately and return false!
  if (usage < cap) {
    if (counters[exhaustedKey(model, apiKey)]) {
      delete counters[exhaustedKey(model, apiKey)]
      saveCounters(counters)
    }
    return false
  }
  return true
}

export function getModelExhausted(model: string, apiKey: string, rpdCap?: number): boolean {
  checkDailyReset()
  const cap = rpdCap ?? getModelDailyCap(model)
  const usage = getModelUsage(model, apiKey)
  if (usage < cap) return false
  const counters = getCachedCounters()
  return counters[exhaustedKey(model, apiKey)] === true
}

export function incrementModelUsage(model: string, apiKey: string): number {
  checkDailyReset()
  const counters = getCachedCounters()
  const key = counterKey(model, apiKey)
  const nextVal = ((typeof counters[key] === 'number' ? (counters[key] as number) : 0) || 0) + 1
  counters[key] = nextVal
  // prune keys from other days to keep the file small
  const today = todayKey()
  for (const k of Object.keys(counters)) {
    if (k.startsWith('_last')) continue
    if (!k.includes(`|${today}|`)) delete counters[k]
  }
  saveCounters(counters)
  return nextVal
}

export function decrementModelUsage(model: string, apiKey: string): number {
  checkDailyReset()
  const counters = getCachedCounters()
  const key = counterKey(model, apiKey)
  const current = typeof counters[key] === 'number' ? (counters[key] as number) : 0
  if (current > 0) {
    counters[key] = current - 1
  }
  saveCounters(counters)
  return (counters[key] as number) || 0
}

export function setModelExhausted(model: string, apiKey: string, rpdCap?: number) {
  checkDailyReset()
  const cap = rpdCap ?? getModelDailyCap(model)
  const usage = getModelUsage(model, apiKey)
  // CRITICAL USER RULE: Only mark exhausted if actual recorded usage in Settings has reached or exceeded cap!
  // If settings / store show usage < cap, quota is still remaining for the day!
  if (usage < cap) {
    // Quota still left in Settings — refuse to set exhausted flag and remove any old flag!
    clearModelExhausted(model, apiKey)
    return
  }
  const counters = getCachedCounters()
  counters[exhaustedKey(model, apiKey)] = true
  saveCounters(counters)
}

export function clearModelExhausted(model: string, apiKey: string): void {
  const counters = getCachedCounters()
  if (counters[exhaustedKey(model, apiKey)]) {
    delete counters[exhaustedKey(model, apiKey)]
    saveCounters(counters)
  }
}

export function clearAllExhaustedFlags(): void {
  const counters = getCachedCounters()
  for (const k of Object.keys(counters)) {
    if (k.startsWith('_exh|')) {
      delete counters[k]
    }
  }
  saveCounters(counters)
}

/**
 * Reconciles today's counters directly from all recorded scans.
 * Ensures usage reflects ONLY genuine completed successful requests.
 * Clears spurious exhaustion flags if no scans exist or if actual usage < cap.
 */
export function reconcileTodayCounters(): void {
  ensureDirs()
  const today = todayKey()
  const counters = getCachedCounters()

  // Clean all spurious exhaustion flags from previous days or unconfirmed states
  for (const k of Object.keys(counters)) {
    if (k.startsWith('_exh|') && !k.includes(`|${today}|`)) {
      delete counters[k]
    }
  }

  // Inspect existing scans
  const scans = listScans()
  const todayScans = scans.filter((s) => {
    const d1 = geminiUsageDay(new Date(s.createdAt))
    return d1 === today
  })

  if (todayScans.length === 0) {
    // If no scans ran today, usage across all models is 0 and no model is exhausted!
    for (const k of Object.keys(counters)) {
      if (k.startsWith('_last')) continue
      if (k.includes(`|${today}|`)) {
        delete counters[k]
      }
    }
    saveCounters(counters)
    return
  }

  // If scans exist, verify exhaustion flags against actual RPD caps
  for (const k of Object.keys(counters)) {
    if (k.startsWith('_exh|')) {
      const parts = k.split('|')
      if (parts.length >= 4) {
        const model = parts[1]
        const h = parts[3]
        const m = MODEL_POOL.find((item) => item.id === model)
        const rpd = m ? m.rpd : 20
        const usageKey = `${model}|${today}|${h}`
        const currentUsage = (counters[usageKey] as number) || 0
        if (currentUsage < rpd) {
          // If usage is below cap, it is not truly exhausted
          delete counters[k]
        }
      }
    }
  }

  saveCounters(counters)
}

export function resetAllDailyCounters(): void {
  ensureDirs()
  const today = todayKey()
  const newCounters: CountersData = {
    _lastActiveDay: today,
    _lastResetTime: Date.now(),
  }
  saveCounters(newCounters)
}

export function getAllUsage(apiKey: string): Record<string, number> {
  checkDailyReset()
  const out: Record<string, number> = {}
  for (const m of MODEL_POOL) out[m.id] = getModelUsage(m.id, apiKey)
  return out
}

export function getAllExhausted(apiKey: string): Record<string, boolean> {
  checkDailyReset()
  const out: Record<string, boolean> = {}
  for (const m of MODEL_POOL) out[m.id] = isModelDailyQuotaExhausted(m.id, apiKey, m.rpd)
  return out
}

// ---------- Scans ----------

function scanFile(id: string) {
  return path.join(SCANS_DIR, `${id}.json`)
}

/**
 * Deletes the oldest scans (JSON record + local media files + S3 backup)
 * so at most `keep` scans remain. Called when a new scan is created.
 */
export function pruneOldScans(keep: number = MAX_SCANS): string[] {
  ensureDirs()
  const all = listScans() // newest first
  const toDelete = all.slice(keep)
  const deleted: string[] = []
  for (const s of toDelete) {
    deleteScan(s.id)
    deleted.push(s.id)
  }
  return deleted
}

/**
 * Delete a scan EVERYWHERE: JSON record, local media files, RAM work dir and
 * ALL S3 objects (scan record + full videos + embeddings) so disk frees up.
 */
export function deleteScan(id: string) {
  try {
    fs.rmSync(scanFile(id), { force: true })
  } catch {
    // ignore
  }
  try {
    fs.rmSync(path.join(MEDIA_DIR, id), { recursive: true, force: true })
  } catch {
    // ignore
  }
  removeScanWork(id)
  void deleteScanRemote(id)
}

export function newScan(ownerUsername?: string): Scan {
  ensureDirs()
  const id = crypto.randomBytes(8).toString('hex')
  const scan: Scan = {
    id,
    createdAt: Date.now(),
    ownerUsername,
    status: 'created',
    shortName: null,
    movieName: null,
    shortSize: null,
    movieSize: null,
    shortDuration: null,
    movieDuration: null,
    chunkCount: 0,
    chunkingProgress: 0,
    chunks: [],
    matches: [],
    candidateGroups: [],
    logs: [],
    startedAt: null,
    finishedAt: null,
    error: null,
    report: null,
    modelStates: {},
    verifierEnabled: true,
    autoMode: true,
  }
  saveScan(scan)
  return scan
}

export function getScan(id: string): Scan | null {
  const scan = readJSON<Scan | null>(scanFile(id), null)
  if (!scan) return null

  if (!Array.isArray(scan.chunks)) scan.chunks = []
  if (!Array.isArray(scan.matches)) scan.matches = []
  if (!Array.isArray(scan.candidateGroups)) scan.candidateGroups = []
  if (!Array.isArray(scan.logs)) scan.logs = []

  // Backward compatibility: scans created before minute-wise scanning used
  // scan.chunks as their only chunk-state source. Expose that data as one
  // segment so old completed scans render consistently in every UI panel.
  if (!scan.shortSegments?.length && scan.shortDuration) {
    scan.shortSegments = [
      {
        index: 0,
        start: 0,
        end: scan.shortDuration,
        status: scan.status === 'done' ? 'done' : 'pending',
        chunks: scan.chunks,
      },
    ]
    scan.currentShortSegment = 0
  }

  if (Array.isArray(scan.shortSegments)) {
    for (const seg of scan.shortSegments) {
      if (!Array.isArray(seg.chunks)) seg.chunks = []
    }
  }

  return scan
}

/** Log retention: a real render alone emits ~80 scene lines on top of the scan's
 *  own thousands, and the old 600/500 cap threw away almost all of them. When the
 *  cap IS hit, INFO lines are dropped first — error/warn/success lines (the ones
 *  that explain what went wrong) are kept until nothing else is left to drop. */
const LOG_MAX = 4000
const LOG_KEEP = 3500

function trimLogs(logs: LogEntry[]): LogEntry[] {
  if (logs.length <= LOG_MAX) return logs
  let toDrop = logs.length - LOG_KEEP
  const keep = new Array<boolean>(logs.length).fill(true)
  // Oldest-first: drop info lines only.
  for (let i = 0; i < logs.length && toDrop > 0; i++) {
    if (logs[i].level === 'info') {
      keep[i] = false
      toDrop--
    }
  }
  // Still too long (almost all lines are warn/error) — drop the oldest of those.
  for (let i = 0; i < logs.length && toDrop > 0; i++) {
    if (keep[i]) {
      keep[i] = false
      toDrop--
    }
  }
  return logs.filter((_, i) => keep[i])
}

export function saveScan(scan: Scan, opts?: { immediate?: boolean }) {
  scan.logs = trimLogs(scan.logs)
  scan.updatedAt = Date.now()
  writeJSON(scanFile(scan.id), scan)
  // Mirror to S3 (throttled, fire-and-forget) so results survive instance loss.
  backupScan(scan, opts?.immediate === true)
}

/**
 * Single long-lived server: the local file IS the freshest copy. Kept as an
 * async function so existing route handlers need no changes.
 */
export async function getFreshScan(id: string): Promise<Scan | null> {
  return getScan(id)
}

export function listScans(): ScanSummary[] {
  ensureDirs()
  const files = fs.readdirSync(SCANS_DIR).filter((f) => f.endsWith('.json'))
  const out: ScanSummary[] = []
  for (const f of files) {
    const s = readJSON<Scan | null>(path.join(SCANS_DIR, f), null)
    if (!s) continue
    out.push({
      id: s.id,
      createdAt: s.createdAt,
      customName: s.customName || null,
      ownerUsername: s.ownerUsername,
      background: s.background,
      status: s.status,
      movieName: s.movieName,
      shortName: s.shortName,
      movieDuration: s.movieDuration,
      matchCount: (s.matches || []).length,
      finishedAt: s.finishedAt,
    })
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export function scanMediaDir(id: string): string {
  const dir = path.join(MEDIA_DIR, id)
  if (!fs.existsSync(/*turbopackIgnore: true*/ dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function addLog(scan: Scan, level: LogEntry['level'], msg: string) {
  if (!Array.isArray(scan.logs)) scan.logs = []
  scan.logs.push({ t: Date.now(), level, msg })
}
