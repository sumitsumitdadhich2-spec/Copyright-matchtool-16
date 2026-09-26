import { NextResponse } from 'next/server'
import { getAllUsage, getAllExhausted, MAX_API_KEYS, reconcileTodayCounters } from '@/lib/store'
import {
  getUserKeyN,
  setUserKeyN,
  clearUserKeyN,
  getAllUserApiKeys,
  getUserTwelveLabsKey,
  setUserTwelveLabsKey,
  clearUserTwelveLabsKey,
  getUserMinuteFinderMode,
  setUserMinuteFinderMode,
  isMinuteFinderMode,
  getUserVerifierEnabled,
  setUserVerifierEnabled,
  getUserAutoMode,
  setUserAutoMode,
} from '@/lib/user-keys'
import { getSession } from '@/lib/users'
import { MODEL_POOL } from '@/lib/models'
import { poolSnapshot } from '@/lib/ffmpeg-pool'
import { getKeyStorageInfo, deleteAllFilesOnKey } from '@/lib/gemini'

export const runtime = 'nodejs'

function mask(key: string) {
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Reconcile and cleanse today's counters and spurious exhaustion flags
  try {
    reconcileTodayCounters()
  } catch (err) {
    console.error('[Settings GET] Failed to reconcile today counters:', err)
  }

  const rawKeys: { n: number; k: string | null }[] = []
  for (let n = 1; n <= MAX_API_KEYS; n++) {
    const k = await getUserKeyN(session.username, n)
    rawKeys.push({ n, k })
  }

  // Fetch storage stats per key concurrently
  const storageResults = await Promise.all(
    rawKeys.map(async ({ k }) => {
      if (!k) return null
      try {
        return await Promise.race([
          getKeyStorageInfo(k),
          new Promise<null>((res) => setTimeout(() => res(null), 2500)),
        ])
      } catch {
        return null
      }
    })
  )

  const keys: {
    index: number
    hasKey: boolean
    maskedKey: string | null
    usage: Record<string, number> | null
    exhausted: Record<string, boolean> | null
    totalRequests: number
    storage: { fileCount: number; totalMB: string } | null
  }[] = []

  for (let i = 0; i < rawKeys.length; i++) {
    const { n, k } = rawKeys[i]
    const usage = k ? getAllUsage(k) : null
    const exhausted = k ? getAllExhausted(k) : null
    let totalRequests = 0
    if (usage) {
      for (const val of Object.values(usage)) {
        if (typeof val === 'number') totalRequests += val
      }
    }
    const st = storageResults[i]
    keys.push({
      index: n,
      hasKey: Boolean(k),
      maskedKey: k ? mask(k) : null,
      usage,
      exhausted,
      totalRequests,
      storage: st ? { fileCount: st.fileCount, totalMB: st.totalMB } : null,
    })
  }
  const key1 = await getUserKeyN(session.username, 1)
  const tlKey = await getUserTwelveLabsKey(session.username)
  const minuteFinder = await getUserMinuteFinderMode(session.username)
  const verifierEnabled = await getUserVerifierEnabled(session.username)
  const autoMode = await getUserAutoMode(session.username)
  return NextResponse.json({
    keys,
    maxKeys: MAX_API_KEYS,
    // Verifier toggle: true (default) | false
    verifierEnabled,
    // Auto scan toggle: true (default, full movie + full short + auto window scan) | false
    autoMode,
    // Minute finder toggle: 'gemini' (default) | 'twelvelabs' | 'off'
    minuteFinder,
    // OPTIONAL Twelve Labs pre-filter key (missing = feature off, app unchanged)
    twelveLabs: { hasKey: Boolean(tlKey), maskedKey: tlKey ? mask(tlKey) : null },
    // legacy fields kept for older clients
    hasKey: keys[0].hasKey,
    maskedKey: keys[0].maskedKey,
    hasKey2: keys[1].hasKey,
    maskedKey2: keys[1].maskedKey,
    usage: key1 ? getAllUsage(key1) : null,
    models: MODEL_POOL,
    // ffmpeg engine pool: one single-threaded ffmpeg per core.
    engine: (() => {
      const p = poolSnapshot()
      return { cores: p.cores, engines: p.engines, active: p.active, queued: p.queued }
    })(),
  })
}

/** PUT { minuteFinder?: 'gemini' | 'twelvelabs' | 'off', verifierEnabled?: boolean, autoMode?: boolean } — persist settings. */
export async function PUT(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  if (body.autoMode !== undefined) {
    const enabled = Boolean(body.autoMode)
    await setUserAutoMode(session.username, enabled)
    return NextResponse.json({ ok: true, autoMode: enabled })
  }
  if (body.verifierEnabled !== undefined) {
    const enabled = Boolean(body.verifierEnabled)
    await setUserVerifierEnabled(session.username, enabled)
    return NextResponse.json({ ok: true, verifierEnabled: enabled })
  }
  if (!isMinuteFinderMode(body.minuteFinder)) {
    return NextResponse.json({ error: 'minuteFinder must be gemini | twelvelabs | off' }, { status: 400 })
  }
  await setUserMinuteFinderMode(session.username, body.minuteFinder)
  return NextResponse.json({ ok: true, minuteFinder: body.minuteFinder })
}

export async function PATCH(req: Request) {
  return PUT(req)
}

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const username = session.username

  const body = (await req.json()) as Record<string, unknown>

  // ----- Verifier toggle -----
  if (body.verifierEnabled !== undefined) {
    const enabled = Boolean(body.verifierEnabled)
    await setUserVerifierEnabled(username, enabled)
    return NextResponse.json({ ok: true, verifierEnabled: enabled })
  }

  // ----- Minute finder toggle (also accepted via POST for older clients) -----
  if (body.minuteFinder !== undefined) {
    if (!isMinuteFinderMode(body.minuteFinder)) {
      return NextResponse.json({ error: 'minuteFinder must be gemini | twelvelabs | off' }, { status: 400 })
    }
    await setUserMinuteFinderMode(username, body.minuteFinder)
    return NextResponse.json({ ok: true })
  }

  // ----- Twelve Labs key (optional pre-filter): { twelveLabsKey } / { clearTwelveLabs: true } -----
  if (body.clearTwelveLabs === true) {
    await clearUserTwelveLabsKey(username)
    return NextResponse.json({ ok: true })
  }
  if (typeof body.twelveLabsKey === 'string') {
    const key = body.twelveLabsKey.trim()
    if (key.length < 10) {
      return NextResponse.json({ error: 'Invalid Twelve Labs API key' }, { status: 400 })
    }
    await setUserTwelveLabsKey(username, key)
    return NextResponse.json({ ok: true })
  }

  // ----- Delete all files on a single key: { deleteKeyFiles: number } -----
  if (typeof body.deleteKeyFiles === 'number') {
    const keyIdx = body.deleteKeyFiles
    const k = await getUserKeyN(username, keyIdx)
    if (!k) return NextResponse.json({ error: `Key ${keyIdx} not found` }, { status: 404 })
    const res = await deleteAllFilesOnKey(k)
    return NextResponse.json({ ok: true, keyIndex: keyIdx, deleted: res.deleted })
  }

  // ----- On-demand Gemini storage sweep: { cleanupStorage: true } / { deleteAllFiles: true } -----
  if (body.cleanupStorage === true || body.deleteAllFiles === true) {
    const keys = await getAllUserApiKeys(username)
    let totalDeleted = 0
    for (const k of keys) {
      const res = await deleteAllFilesOnKey(k)
      totalDeleted += res.deleted
    }
    return NextResponse.json({ ok: true, deleted: totalDeleted, total: totalDeleted })
  }

  // ----- Reset daily quota counters: { resetCounters: true } -----
  if (body.resetCounters === true) {
    const { resetAllDailyCounters, clearAllExhaustedFlags } = await import('@/lib/store')
    const { globalGeminiCoordinator } = await import('@/lib/global-gemini-coordinator')
    resetAllDailyCounters()
    clearAllExhaustedFlags()
    globalGeminiCoordinator.resetAllLanes()
    return NextResponse.json({ ok: true, message: 'All daily quota counters and coordinator lanes have been reset to 0' })
  }

  // ----- Reconcile counters from today's real scans: { reconcileCounters: true } -----
  if (body.reconcileCounters === true) {
    const { reconcileTodayCounters, clearAllExhaustedFlags } = await import('@/lib/store')
    const { globalGeminiCoordinator } = await import('@/lib/global-gemini-coordinator')
    clearAllExhaustedFlags()
    globalGeminiCoordinator.resetAllLanes()
    reconcileTodayCounters()
    return NextResponse.json({ ok: true, message: 'Counters successfully reconciled from today’s completed scans' })
  }

  // ----- Clear a key slot: { clear: n } -----
  if (typeof body.clear === 'number') {
    const n = body.clear
    if (!Number.isInteger(n) || n < 1 || n > MAX_API_KEYS) {
      return NextResponse.json({ error: 'Invalid key slot' }, { status: 400 })
    }
    await clearUserKeyN(username, n)
    return NextResponse.json({ ok: true })
  }

  // ----- Save keys: accepts apiKey/apiKey1 ... apiKey20, any combination -----
  const updates: { n: number; key: string }[] = []
  for (let n = 1; n <= MAX_API_KEYS; n++) {
    const raw = n === 1 ? (body.apiKey1 ?? body.apiKey) : body[`apiKey${n}`]
    const key = typeof raw === 'string' ? raw.trim() : ''
    if (key) updates.push({ n, key })
  }
  if (updates.length === 0) {
    return NextResponse.json({ error: 'No API key provided' }, { status: 400 })
  }

  // Validate each key: length + must be DIFFERENT from every other slot (same key = no extra quota).
  for (const u of updates) {
    if (u.key.length < 10) {
      return NextResponse.json({ error: `Invalid API key ${u.n}` }, { status: 400 })
    }
    for (let other = 1; other <= MAX_API_KEYS; other++) {
      if (other === u.n) continue
      const otherKey = updates.find((x) => x.n === other)?.key ?? (await getUserKeyN(username, other))
      if (otherKey && otherKey === u.key) {
        return NextResponse.json(
          { error: `Key ${u.n} must be DIFFERENT from Key ${other} — the same key gives no extra quota` },
          { status: 400 },
        )
      }
    }
  }

  for (const u of updates) await setUserKeyN(username, u.n, u.key)
  return NextResponse.json({ ok: true })
}
