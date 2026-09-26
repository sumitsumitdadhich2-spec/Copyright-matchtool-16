import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe binary resolution (long-lived server, NOT serverless).
//
//   1. FFMPEG_PATH / FFPROBE_PATH env  (explicit override)
//   2. /usr/bin/ffmpeg, /usr/bin/ffprobe (Docker image: apt-get install ffmpeg
//      → ffmpeg + ffprobe are the SAME version, ≥ 6.x)
//   3. anything on PATH
//   4. node_modules/ffmpeg-static + ffprobe-static (local dev fallback only)
//
// Resolution happens once per process and is cached.
// ---------------------------------------------------------------------------

const LOCAL_FFMPEG = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg')
const LOCAL_FFPROBE = path.join(
  process.cwd(),
  'node_modules',
  'ffprobe-static',
  'bin',
  process.platform,
  process.arch,
  process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
)

function isExecutable(p: string | undefined): p is string {
  if (!p) return false
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function fromPath(name: string): string | null {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const d of dirs) {
    const p = path.join(d, name)
    if (isExecutable(p)) return p
  }
  return null
}

function resolve(name: 'ffmpeg' | 'ffprobe', envVar: string, local: string): string {
  const fromEnv = process.env[envVar]
  if (isExecutable(fromEnv)) return fromEnv
  const system = `/usr/bin/${name}`
  if (isExecutable(system)) return system
  const onPath = fromPath(name)
  if (onPath) return onPath
  if (isExecutable(local)) return local
  throw new Error(
    `${name} binary not found. Set ${envVar}, install it (apt-get install ffmpeg) or add ${name === 'ffmpeg' ? 'ffmpeg-static' : 'ffprobe-static'} for local dev.`,
  )
}

let ffmpegPath: string | null = null
let ffprobePath: string | null = null

/** Absolute path to a runnable ffmpeg binary. */
export async function getFfmpegPath(): Promise<string> {
  if (!ffmpegPath) ffmpegPath = resolve('ffmpeg', 'FFMPEG_PATH', LOCAL_FFMPEG)
  return ffmpegPath
}

/** Absolute path to a runnable ffprobe binary. */
export async function getFfprobePath(): Promise<string> {
  if (!ffprobePath) ffprobePath = resolve('ffprobe', 'FFPROBE_PATH', LOCAL_FFPROBE)
  return ffprobePath
}

/** Synchronous variant for boot-time logging (same resolution order). */
export function getFfmpegPathSync(): string {
  if (!ffmpegPath) ffmpegPath = resolve('ffmpeg', 'FFMPEG_PATH', LOCAL_FFMPEG)
  return ffmpegPath
}
