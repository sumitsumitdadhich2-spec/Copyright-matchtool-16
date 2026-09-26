import { NextResponse } from 'next/server'
import { getSession } from '@/lib/users'
import { enqueueBackgroundScan } from '@/lib/background-queue'
import { getAllUserApiKeys } from '@/lib/user-keys'
import { deductTokens, refundTokens, SCAN_TOKEN_COST } from '@/lib/tokens'
import { isMinuteFinderRunning, stopAndWaitMinuteFinder } from '@/lib/gemini-minute-finder'
import { getScan } from '@/lib/store'

export const runtime = 'nodejs'

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const scan = getScan(id)
  if (!scan || (session.role !== 'admin' && scan.ownerUsername !== session.username)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  let resume = false
  try {
    const body = (await req.json()) as { resume?: boolean }
    resume = Boolean(body.resume)
  } catch {
    // no body
  }

  // PER-USER KEYS: every scan runs ONLY on the logged-in user's own keys
  // (stored in their private Blob file) — never on anyone else's.
  const userApiKeys = await getAllUserApiKeys(session.username)
  if (userApiKeys.length === 0) {
    return NextResponse.json(
      { error: 'No Gemini API key configured for YOUR account. Add your key in Settings first.' },
      { status: 400 },
    )
  }

  // TOKENS: 1 fresh scan = 100 tokens. Resume is free (already paid).
  // Admin (shiva) has unlimited tokens and never gets charged.
  let charged = false
  if (session.role !== 'admin' && !resume) {
    const newBalance = await deductTokens(session.username, SCAN_TOKEN_COST)
    if (newBalance === null) {
      return NextResponse.json(
        { error: `Tokens khatm ho gaye hain! 1 scan = ${SCAN_TOKEN_COST} tokens. Admin se tokens lo.`, tokensExhausted: true },
        { status: 402 },
      )
    }
    charged = true
  }

  // Manual Start = the user's decision. A Gemini Minute Finder still running
  // for this scan is stopped first so it cannot fire its own scheduler.start
  // (or keep burning quota) underneath the manual scan.
  if (isMinuteFinderRunning(id)) {
    const idle = await stopAndWaitMinuteFinder(id, 'manual Start dabaya gaya', 20_000)
    if (!idle) {
      if (charged) await refundTokens(session.username, SCAN_TOKEN_COST)
      return NextResponse.json(
        { error: 'Gemini Minute Finder abhi band ho raha hai (request in flight) — kuch seconds baad Start dobara dabao.' },
        { status: 409 },
      )
    }
  }

  const result = await enqueueBackgroundScan(id, session.username, resume)
  if (!result.ok) {
    // Scan didn't enter the queue — give the tokens back.
    if (charged) await refundTokens(session.username, SCAN_TOKEN_COST)
    return NextResponse.json({ error: result.error }, { status: 400 })
  }
  return NextResponse.json({ ok: true, queued: true })
}
