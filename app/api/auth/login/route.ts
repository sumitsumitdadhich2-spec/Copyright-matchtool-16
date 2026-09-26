import { type NextRequest, NextResponse } from 'next/server'
import { verifyLogin } from '@/lib/users'
import { SESSION_COOKIE, signSession, sessionCookieOptions } from '@/lib/session'

export async function POST(request: NextRequest) {
  try {
    const { username, password } = (await request.json()) as { username?: string; password?: string }
    if (!username || !password) {
      return NextResponse.json({ error: 'Username and password required' }, { status: 400 })
    }

    const user = await verifyLogin(username, password)
    if (!user) {
      return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 })
    }

    const res = NextResponse.json({ ok: true, user })
    res.cookies.set(SESSION_COOKIE, signSession(user), sessionCookieOptions())
    return res
  } catch {
    return NextResponse.json({ error: 'Login failed' }, { status: 500 })
  }
}
