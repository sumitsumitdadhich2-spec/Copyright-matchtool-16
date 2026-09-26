import { NextResponse } from 'next/server'
import { getSession } from '@/lib/users'
import { getTokenBalance, SCAN_TOKEN_COST } from '@/lib/tokens'

export const runtime = 'nodejs'

// Current user's live token balance — polled by the header badge.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Admin has unlimited tokens.
  if (session.role === 'admin') {
    return NextResponse.json({ unlimited: true, balance: null, scanCost: SCAN_TOKEN_COST })
  }

  const balance = await getTokenBalance(session.username)
  return NextResponse.json({ unlimited: false, balance, scanCost: SCAN_TOKEN_COST })
}
