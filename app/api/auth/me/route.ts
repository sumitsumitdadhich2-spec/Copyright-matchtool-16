import { NextResponse } from 'next/server'
import { getSession } from '@/lib/users'
import { bootQuotaCheck } from '@/lib/store'

export async function GET() {
  bootQuotaCheck()
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ user: null }, { status: 401 })
  }
  return NextResponse.json({ user: session })
}
