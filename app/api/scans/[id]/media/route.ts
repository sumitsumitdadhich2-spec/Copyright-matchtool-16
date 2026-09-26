import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { getScan, SCANS_DIR, scanMediaDir } from '@/lib/store'
import { restoreScans } from '@/lib/scan-store'
import { ensureLocalMedia } from '@/lib/media'
import { getSession } from '@/lib/users'
import { triggerFastPreview } from '@/lib/ffmpeg'

export const runtime = 'nodejs'

/** Serve uploaded videos with HTTP Range support so previews are seekable.
 *  If the local file is missing it is pulled back from S3 first.
 *  Automatically prefers fast web-optimized lightweight preview copies for instantaneous seeking.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return new Response('Unauthorized', { status: 401 })
  const { id } = await ctx.params
  if (!getScan(id)) await restoreScans(SCANS_DIR)
  const scan = getScan(id)
  if (!scan || (session.role !== 'admin' && scan.ownerUsername !== session.username)) return new Response('Not found', { status: 404 })

  const url = new URL(req.url)
  const kind = url.searchParams.get('kind') === 'short' ? 'short' : 'movie'
  const file = await ensureLocalMedia(id, kind)
  if (!file) return new Response('File not found', { status: 404 })

  let streamFile = file
  const mediaDir = scanMediaDir(id)

  const previewFile = path.join(mediaDir, `preview-${kind}.mp4`)
  const prescanFile = path.join(mediaDir, `prescan-${kind}.mp4`)
  if (fs.existsSync(previewFile) && fs.statSync(previewFile).size > 1000) {
    streamFile = previewFile
  } else if (
    kind === 'movie' &&
    fs.existsSync(prescanFile) &&
    fs.statSync(prescanFile).size > 1000 &&
    fs.statSync(prescanFile).size < fs.statSync(file).size * 0.75
  ) {
    // prescan-movie is a re-encoded lightweight copy!
    streamFile = prescanFile
  } else {
    // Trigger background fast preview so subsequent seeks/loads are instantaneous
    triggerFastPreview(id, file, mediaDir, kind)
  }

  const stat = fs.statSync(streamFile)
  const range = req.headers.get('range')
  const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`

  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/)
    if (m) {
      const start = Number(m[1])
      // 16 MB chunk size provides smooth, uninterrupted buffer ahead without freezing
      const CHUNK_SIZE = 16 * 1024 * 1024
      const end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : Math.min(start + CHUNK_SIZE - 1, stat.size - 1)
      if (start >= stat.size) {
        return new Response(null, {
          status: 416,
          headers: {
            'Content-Range': `bytes */${stat.size}`,
          },
        })
      }
      const nodeStream = fs.createReadStream(streamFile, { start, end })
      return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Content-Type': 'video/mp4',
          'Cache-Control': 'public, max-age=86400, stale-while-revalidate=3600',
          'ETag': etag,
        },
      })
    }
  }

  const nodeStream = fs.createReadStream(streamFile)
  return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
    status: 200,
    headers: {
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Content-Type': 'video/mp4',
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=3600',
      'ETag': etag,
    },
  })
}
