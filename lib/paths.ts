import path from 'node:path'

// ---------------------------------------------------------------------------
// On-disk layout (long-lived server, NOT serverless):
//
//   DATA_DIR  (EBS, e.g. /data)      durable-ish working store
//     scans/<id>.json                 scan records (mirrored to S3)
//     media/<id>/short.mp4            originals (mirrored to S3)
//     media/<id>/movie.mp4
//     media/<id>/render.mp4           outputs
//     media/<id>/merged.mp4
//     settings.json, counters.json
//     work/                            disk fallback for WORK_DIR overflow
//
//   WORK_DIR  (tmpfs, e.g. /dev/shm/cmt)  RAM hot area for ffmpeg intermediates
//     <id>/chunks, <id>/segments, <id>/clips, <id>/render-parts, ...
// ---------------------------------------------------------------------------

export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), 'data')
export const SCANS_DIR = path.join(DATA_DIR, 'scans')
export const MEDIA_DIR = path.join(DATA_DIR, 'media')
export const DISK_WORK_DIR = path.join(DATA_DIR, 'work')

export const WORK_DIR = process.env.WORK_DIR ? path.resolve(process.env.WORK_DIR) : path.join(DATA_DIR, 'work-ram')

/** RAM budget for WORK_DIR before jobs spill to disk (default 6 GB of a 16 GB box). */
export const WORK_RAM_BUDGET_BYTES = Math.max(256, Number.parseInt(process.env.WORK_RAM_BUDGET_MB || '6144', 10) || 6144) * 1024 * 1024

/** Storage cap for the local media store (default 100 GB EBS). */
export const DISK_LIMIT_BYTES = Math.max(1, Number.parseFloat(process.env.DISK_LIMIT_GB || '100') || 100) * 1024 * 1024 * 1024

/** Keep at most this many scans (videos). Creating the next one deletes the oldest. */
export const MAX_SCANS = Math.max(1, Number.parseInt(process.env.MAX_SCANS || '10', 10) || 10)
