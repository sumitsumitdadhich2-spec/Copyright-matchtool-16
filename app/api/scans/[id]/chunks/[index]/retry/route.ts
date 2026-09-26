import { NextResponse } from 'next/server'
import { scheduler } from '@/lib/scheduler'
import { getSession } from '@/lib/users'
import { getAllUserApiKeys } from '@/lib/user-keys'

export const runtime = 'nodejs'

/** MANUAL chunk retry: re-runs the chunk-map for one chunk on the locked
 * chunk models (gemini-3.6-flash / gemini-3.7-flash). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const { id, index } = await params
  const chunkIndex = Number.parseInt(index, 10)
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return NextResponse.json({ ok: false, error: 'Invalid chunk index' }, { status: 400 })
  }
  // Optional ?segment=N — which short minute this chunk retry belongs to
  // (default: the current/selected minute).
  const segParam = new URL(req.url).searchParams.get('segment')
  let segmentIndex: number | undefined
  if (segParam !== null) {
    segmentIndex = Number.parseInt(segParam, 10)
    if (!Number.isInteger(segmentIndex) || segmentIndex < 0) {
      return NextResponse.json({ ok: false, error: 'Invalid segment index' }, { status: 400 })
    }
  }
  // PER-USER KEYS: retry runs on the logged-in user's own keys (needed when the
  // retry has to restart a finished scan in resume mode).
  const userApiKeys = await getAllUserApiKeys(session.username)
  const result = await scheduler.retryChunk(id, chunkIndex, segmentIndex, userApiKeys)
  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}
