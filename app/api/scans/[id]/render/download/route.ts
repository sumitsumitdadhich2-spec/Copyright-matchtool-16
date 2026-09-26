import fs from 'node:fs'
import { Readable } from 'node:stream'
import { getScan } from '@/lib/store'
import { renderOutputPath } from '@/lib/render'

export const runtime = 'nodejs'

/** Serve the rendered MP4 with HTTP Range support (seekable preview) and
 *  Content-Disposition so ?download=1 saves the file. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const scan = getScan(id)
  if (!scan) return new Response('Not found', { status: 404 })

  const file = renderOutputPath(id)
  if (!fs.existsSync(file) || scan.renderJob?.status !== 'done') {
    return new Response('Rendered file not found', { status: 404 })
  }

  const url = new URL(req.url)
  const asDownload = url.searchParams.get('download') === '1'
  const baseName = (scan.movieName || 'render').replace(/\.[^.]+$/, '')
  const fileName = `${baseName}-stitched-${scan.renderJob.settings?.resolution || 'export'}.mp4`

  const dispo: Record<string, string> = asDownload
    ? { 'Content-Disposition': `attachment; filename="${fileName.replace(/[^\w.\- ]+/g, '_')}"` }
    : {}

  const stat = fs.statSync(file)
  const range = req.headers.get('range')

  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/)
    if (m) {
      const start = Number(m[1])
      const end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : Math.min(start + 4 * 1024 * 1024 - 1, stat.size - 1)
      if (start >= stat.size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
      }
      const stream = fs.createReadStream(file, { start, end })
      return new Response(toWeb(stream), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Content-Type': 'video/mp4',
          ...dispo,
        },
      })
    }
  }

  const stream = fs.createReadStream(file)
  return new Response(toWeb(stream), {
    status: 200,
    headers: {
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Content-Type': 'video/mp4',
      ...dispo,
    },
  })
}

/** BACKPRESSURE-SAFE adapter: Readable.toWeb only pulls the next chunk when the
 *  client is ready. The old hand-rolled version enqueued every 'data' event
 *  immediately, so a slow client buffered the ENTIRE file in server memory —
 *  that was the crash on big downloads. */
function toWeb(stream: fs.ReadStream): ReadableStream {
  return Readable.toWeb(stream) as unknown as ReadableStream
}
