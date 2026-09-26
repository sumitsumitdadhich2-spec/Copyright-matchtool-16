#!/usr/bin/env node
/**
 * STANDALONE CHUNK-PROMPT TEST SCRIPT (app ke bahar Gemini ko directly test karne ke liye)
 * =======================================================================================
 * Ye script EXACTLY wahi karta hai jo app ka scheduler ek chunk ke liye karta hai:
 *   1. lib/gemini.ts se CHUNK_MAP_PROMPT ko runtime par padhta hai (copy nahi — hamesha app wala hi prompt).
 *   2. Movie ko app ke SAME ffmpeg command se 1-minute chunks me kaatta hai (24fps, 640px, CRF28,
 *      forced keyframes @60s, segment muxer) — bilkul lib/ffmpeg.ts chunkMovie() jaisa.
 *   3. short.mp4 + chunk-XXXX.mp4 dono ko Gemini Files API par upload karta hai.
 *   4. generateContent bhejta hai app ke SAME config ke saath: videoMetadata { fps: 24 }, temperature: 0.
 *   5. Gemini ka RAW output VERBATIM print karta hai + token usage (promptTokenCount etc).
 *
 * USAGE (project root se):
 *   node scripts/test-chunk-prompt.mjs --list-models
 *   node scripts/test-chunk-prompt.mjs --model gemini-2.5-flash --chunk 1
 *   node scripts/test-chunk-prompt.mjs --model gemini-2.5-flash-lite --chunk 1 --scan fa10a62dcb5f4120
 *
 * Options:
 *   --list-models        Sirf available models list karo (gemini-3 / 2.5 flash / lite check).
 *   --model <id>         Model id (required for test). e.g. gemini-2.5-flash
 *   --chunk <n>          Chunk index (0-based). chunk 1 = movie 01:00 - 02:00. Default: 1
 *   --scan <id>          data/media/<id>/ folder jisme short.mp4 + movie.mp4 hain.
 *                        Default: fa10a62dcb5f4120
 *   --key <n>            Kaunsa API key slot use kare (1-5, data/settings.json se). Default: 1
 *
 * NOTE: API key data/settings.json se aati hai (app wali hi keys). Key kabhi print nahi hoti.
 * Chunks data/media/<scan>/chunks/ me cache hote hain — dobara run par re-encode nahi hota.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { GoogleGenAI } from '@google/genai'

const ROOT = process.cwd()
const FFMPEG = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg')
const CHUNK_SECONDS = 60
const SCAN_FPS = 24

// ---------- args ----------
const args = process.argv.slice(2)
function arg(name, def) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const LIST_ONLY = args.includes('--list-models')
const MODEL = arg('model', null)
const CHUNK_INDEX = Number(arg('chunk', '1'))
const SCAN_ID = arg('scan', 'fa10a62dcb5f4120')
const KEY_SLOT = Number(arg('key', '1'))

// ---------- exact prompt from the app (read at runtime, never copied) ----------
function readAppPrompt() {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'gemini.ts'), 'utf8')
  const m = src.match(/export const CHUNK_MAP_PROMPT = `([\s\S]*?)`\n/)
  if (!m) throw new Error('CHUNK_MAP_PROMPT not found in lib/gemini.ts')
  return m[1]
}

// ---------- API key from app settings (never printed) ----------
function readApiKey(slot) {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'settings.json'), 'utf8'))
  const key = slot === 1 ? s.apiKey : s[`apiKey${slot}`]
  if (!key) throw new Error(`API key slot ${slot} is empty in data/settings.json`)
  return key
}

// ---------- ffmpeg (same command as lib/ffmpeg.ts chunkMovie) ----------
function run(bin, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, cmdArgs)
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))))
  })
}

async function ensureChunks(mediaDir) {
  const outDir = path.join(mediaDir, 'chunks')
  const wanted = path.join(outDir, `chunk-${String(CHUNK_INDEX).padStart(4, '0')}.mp4`)
  if (fs.existsSync(wanted)) {
    console.log(`[chunk] cached: ${wanted}`)
    return wanted
  }
  fs.mkdirSync(outDir, { recursive: true })
  console.log('[chunk] cutting movie into 1-minute chunks (same ffmpeg command as the app)...')
  await run(FFMPEG, [
    '-y',
    '-i', path.join(mediaDir, 'movie.mp4'),
    '-vf', `scale=640:-2,fps=${SCAN_FPS}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-force_key_frames', `expr:gte(t,n_forced*${CHUNK_SECONDS})`,
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    '-f', 'segment',
    '-segment_time', String(CHUNK_SECONDS),
    '-reset_timestamps', '1',
    path.join(outDir, 'chunk-%04d.mp4'),
  ])
  if (!fs.existsSync(wanted)) throw new Error(`Chunk ${CHUNK_INDEX} does not exist (movie too short?)`)
  console.log(`[chunk] ready: ${wanted}`)
  return wanted
}

// ---------- Gemini Files API upload (same as lib/gemini.ts uploadVideo) ----------
async function uploadVideo(ai, filePath, label) {
  console.log(`[upload] ${label}: ${path.basename(filePath)} (${(fs.statSync(filePath).size / 1e6).toFixed(1)} MB)...`)
  let f = await ai.files.upload({ file: filePath, config: { mimeType: 'video/mp4' } })
  const deadline = Date.now() + 5 * 60_000
  while (f.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error('File processing timed out')
    await new Promise((r) => setTimeout(r, 2500))
    f = await ai.files.get({ name: f.name })
  }
  if (f.state !== 'ACTIVE') throw new Error(`File upload failed (state=${f.state})`)
  console.log(`[upload] ${label}: ACTIVE`)
  return f
}

// ---------- main ----------
async function main() {
  const apiKey = readApiKey(KEY_SLOT)
  const ai = new GoogleGenAI({ apiKey })

  if (LIST_ONLY) {
    console.log('=== AVAILABLE MODELS (is API key ke liye) ===')
    const pager = await ai.models.list()
    const names = []
    for await (const m of pager) names.push(m.name?.replace('models/', '') || '')
    for (const n of names.sort()) console.log('  ' + n)
    console.log('\n=== POOL CHECK ===')
    for (const id of ['gemini-3-flash', 'gemini-3-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-flash-lite-latest']) {
      console.log(`  ${id}: ${names.includes(id) ? 'AVAILABLE' : 'NOT AVAILABLE'}`)
    }
    return
  }

  if (!MODEL) throw new Error('Missing --model <id> (ya --list-models use karo)')

  const mediaDir = path.join(ROOT, 'data', 'media', SCAN_ID)
  const shortFile = path.join(mediaDir, 'short.mp4')
  if (!fs.existsSync(shortFile)) throw new Error(`short.mp4 not found in ${mediaDir}`)

  const prompt = readAppPrompt()
  console.log(`[prompt] loaded from lib/gemini.ts (${prompt.length} chars) — app ka EXACT chunk prompt`)

  const chunkFile = await ensureChunks(mediaDir)
  const shortUp = await uploadVideo(ai, shortFile, 'short video')
  const chunkUp = await uploadVideo(ai, chunkFile, `movie chunk ${CHUNK_INDEX} (${CHUNK_INDEX}:00 - ${CHUNK_INDEX + 1}:00)`)

  console.log(`\n[request] model=${MODEL} | fps=${SCAN_FPS} | temperature=0 | media resolution=default (same as app)`)
  const t0 = Date.now()
  const resp = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { fileData: { fileUri: shortUp.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
          { fileData: { fileUri: chunkUp.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
          { text: prompt },
        ],
      },
    ],
    config: { temperature: 0 },
  })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  console.log('\n================= RAW GEMINI OUTPUT (VERBATIM) =================')
  console.log(resp.text ?? '(empty response)')
  console.log('================= END RAW OUTPUT =================\n')

  const u = resp.usageMetadata || {}
  console.log('=== TOKEN USAGE ===')
  console.log(`  promptTokenCount:     ${u.promptTokenCount ?? 'n/a'}`)
  console.log(`  candidatesTokenCount: ${u.candidatesTokenCount ?? 'n/a'}`)
  console.log(`  thoughtsTokenCount:   ${u.thoughtsTokenCount ?? 'n/a'}`)
  console.log(`  totalTokenCount:      ${u.totalTokenCount ?? 'n/a'}`)
  console.log(`  time: ${secs}s`)

  // cleanup uploaded files (best effort)
  for (const f of [shortUp, chunkUp]) {
    try { await ai.files.delete({ name: f.name }) } catch {}
  }
}

main().catch((err) => {
  console.error('\n[ERROR]', err?.message || err)
  process.exit(1)
})
