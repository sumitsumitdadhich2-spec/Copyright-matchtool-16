import { NextResponse } from 'next/server'
import { getFreshScan } from '@/lib/store'
import { getSession } from '@/lib/users'
import { getUserTwelveLabsKey } from '@/lib/user-keys'
import { loadEmbeddings } from '@/lib/twelvelabs'

export const runtime = 'nodejs'

/** GET: Twelve Labs status for this scan (key set? indexed? embeddings saved?).
 *  Indexing itself now runs ONLY through the auto merge pipeline
 *  (/api/scans/[id]/merge-pipeline) — the old manual flow is gone. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const scan = await getFreshScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const tlKey = await getUserTwelveLabsKey(session.username)
  const emb = await loadEmbeddings(id, 'movie')

  return NextResponse.json({
    hasKey: Boolean(tlKey),
    twelveLabs: scan.twelveLabs ?? { status: 'none' },
    embeddingsSaved: Boolean(emb),
    embeddingsCount: emb?.segments.length ?? 0,
    prefilter: scan.prefilter ?? null,
  })
}

/** POST: REPLACED by the auto merge pipeline. The old manual
 *  "Index Movie on Twelve Labs" flow no longer exists. */
export async function POST() {
  return NextResponse.json(
    { error: 'Manual indexing hata diya gaya hai — ab auto merge pipeline use hoti hai (/merge-pipeline).' },
    { status: 410 },
  )
}
