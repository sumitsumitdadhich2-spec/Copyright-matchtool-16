import fs from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'

// ---------------------------------------------------------------------------
// Durable storage = Amazon S3 (single private bucket). The EC2 instance role
// supplies credentials (no static keys in code). Every JSON record (users,
// keys, tokens, scans, embeddings) and every original video is mirrored here
// so the app survives a container restart / instance replacement.
//
// Local EBS disk (DATA_DIR) is the working copy ffmpeg reads from; S3 is the
// backup/source of truth when the local file is missing.
// ---------------------------------------------------------------------------

export const S3_BUCKET = process.env.S3_BUCKET || ''
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1'

let client: S3Client | null = null
function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      region: REGION,
      // Local dev without a bucket: still construct the client so calls fail
      // softly in the try/catch blocks below instead of crashing the app.
      ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
    })
  }
  return client
}

/** True when S3 is configured — every function below is a no-op/null otherwise. */
export function storageEnabled(): boolean {
  return S3_BUCKET.length > 0
}

const MULTIPART_THRESHOLD = 8 * 1024 * 1024
const MULTIPART_PART = 16 * 1024 * 1024

/** Get an object as a Node Readable stream (null when missing/disabled). */
export async function getObjectStream(key: string): Promise<Readable | null> {
  if (!storageEnabled()) return null
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }))
    if (!res.Body) return null
    return res.Body as Readable
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

/** Get an object as a UTF-8 string (null when missing/disabled). */
export async function getObjectText(key: string): Promise<string | null> {
  const stream = await getObjectStream(key)
  if (!stream) return null
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  return Buffer.concat(chunks).toString('utf8')
}

/** Get + parse a JSON object (null when missing/invalid/disabled). */
export async function getObjectJSON<T>(key: string): Promise<T | null> {
  try {
    const text = await getObjectText(key)
    if (text === null) return null
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** Put a small string/buffer body. */
export async function putObject(key: string, body: string | Buffer, contentType = 'application/octet-stream'): Promise<void> {
  if (!storageEnabled()) return
  await s3().send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'no-store',
    }),
  )
}

export function putObjectJSON(key: string, data: unknown): Promise<void> {
  return putObject(key, JSON.stringify(data), 'application/json')
}

/** Upload a local file (multipart for anything > 8 MB, several parts in flight). */
export async function putFile(key: string, localPath: string, contentType = 'application/octet-stream'): Promise<void> {
  if (!storageEnabled()) return
  const size = fs.statSync(localPath).size
  if (size <= MULTIPART_THRESHOLD) {
    await s3().send(
      new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: fs.createReadStream(localPath), ContentType: contentType, ContentLength: size }),
    )
    return
  }
  const upload = new Upload({
    client: s3(),
    params: { Bucket: S3_BUCKET, Key: key, Body: fs.createReadStream(localPath), ContentType: contentType },
    partSize: MULTIPART_PART,
    queueSize: 6,
    leavePartsOnError: false,
  })
  await upload.done()
}

/** Download an object to a local file (atomic rename). Returns false when missing. */
export async function getFile(key: string, localPath: string): Promise<boolean> {
  const stream = await getObjectStream(key)
  if (!stream) return false
  const tmp = `${localPath}.dl-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await pipeline(stream, fs.createWriteStream(tmp))
    fs.renameSync(tmp, localPath)
    return true
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // ignore
    }
    throw err
  }
}

export async function deleteObject(key: string): Promise<void> {
  if (!storageEnabled()) return
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }))
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
}

export interface ListedObject {
  key: string
  size: number
  lastModified: number
}

/** List every object under a prefix (paginates). */
export async function listObjects(prefix: string): Promise<ListedObject[]> {
  if (!storageEnabled()) return []
  const out: ListedObject[] = []
  let token: string | undefined
  do {
    const res = await s3().send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken: token }))
    for (const o of res.Contents || []) {
      if (!o.Key) continue
      out.push({ key: o.Key, size: o.Size || 0, lastModified: o.LastModified ? o.LastModified.getTime() : 0 })
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (token)
  return out
}

/** Delete everything under a prefix (batches of 1000). */
export async function deletePrefix(prefix: string): Promise<number> {
  if (!storageEnabled()) return 0
  const objects = await listObjects(prefix)
  for (let i = 0; i < objects.length; i += 1000) {
    const batch = objects.slice(i, i + 1000)
    await s3().send(
      new DeleteObjectsCommand({
        Bucket: S3_BUCKET,
        Delete: { Objects: batch.map((o) => ({ Key: o.key })), Quiet: true },
      }),
    )
  }
  return objects.length
}

/**
 * Server-side copy inside the bucket (no download/upload through this box).
 * Returns false when the source is missing or storage is disabled.
 */
export async function copyObject(fromKey: string, toKey: string, contentType = 'application/octet-stream'): Promise<boolean> {
  if (!storageEnabled()) return false
  try {
    await s3().send(
      new CopyObjectCommand({
        Bucket: S3_BUCKET,
        CopySource: `${S3_BUCKET}/${encodeURIComponent(fromKey).replace(/%2F/g, '/')}`,
        Key: toKey,
        ContentType: contentType,
        MetadataDirective: 'REPLACE',
      }),
    )
    return true
  } catch (err) {
    if (isNotFound(err)) return false
    throw err
  }
}

export async function objectExists(key: string): Promise<boolean> {
  if (!storageEnabled()) return false
  try {
    await s3().send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }))
    return true
  } catch (err) {
    if (isNotFound(err)) return false
    throw err
  }
}

/** Cheap reachability probe for /api/health. */
export async function storageHealthy(): Promise<{ ok: boolean; error?: string }> {
  if (!storageEnabled()) return { ok: false, error: 'S3_BUCKET not set' }
  try {
    await s3().send(new ListObjectsV2Command({ Bucket: S3_BUCKET, MaxKeys: 1 }))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404
}
