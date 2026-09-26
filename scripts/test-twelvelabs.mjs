/**
 * STANDALONE Twelve Labs test — app se bilkul alag, app ko touch nahi karta.
 * Test: short video (1st minute) + movie chunk 0 ko Twelve Labs par index karke
 *   1) Pegasus se chunk + short ka time-map (app ke prompt jaisa) nikalna
 *   2) Marengo embeddings se short-vs-chunk segment matching (kaha kaha match)
 *
 * Run: node scripts/test-twelvelabs.mjs
 * NOTE: ye TEST key hai, user baad me delete kar dega.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const API_KEY = process.env.TWELVELABS_API_KEY || 'tlk_2WYPVHQ2QSPJFD26TPZSA1S0C5Z4'
const BASE = 'https://api.twelvelabs.io/v1.3'

const MEDIA = '/vercel/share/v0-project/data/media/6ce3202a6a652efc'
// segments/seg-0000.mp4 = SHORT ka pehla 1-minute segment (app ne pehle hi kaata hua, 24fps)
const SHORT_60 = `${MEDIA}/segments/seg-0000.mp4`
const MOVIE_SRC = `${MEDIA}/movie.mp4`
// Movie chunk 0 (00:00 - 01:00) — app ke SAME ffmpeg settings se /tmp me cut hoga
const CHUNK_SRC = '/tmp/tl-movie-chunk-0000.mp4'

// App ka chunk-map prompt, Twelve Labs (single-video Pegasus) ke liye adapt kiya —
// HISSA 1 wala time-map style, dialogue verbatim quote rule same rakha hai.
const TIME_MAP_PROMPT = `You are a forensic video analyst.

Respond in Hinglish (Hindi written in Latin script). Spoken dialogue must always be QUOTED VERBATIM in its original language.

Watch this video from start to finish and break it into small, fine-grained segments:
- Har segment chhota hona chahiye — zyada tar segments 1-2 second ke hone chahiye. Ek lambi continuous shot ko bhi chhote sub-segments me todo taaki mapping precise rahe.
- Segments contiguous hone chahiye: har segment ka start = pichle segment ka end. Pehla segment 00:00.000 se shuru ho, aakhri segment video ki total duration par khatam ho. Koi gap nahi, koi overlap nahi.
- Har line ka format:
  mm:ss.mmm - mm:ss.mmm: <SHORT description, max 10-12 words — kaun kya kar raha hai; agar koi bolta hai to sirf exact quoted words>
- Description LAMBA MAT karo. Sirf identify karne layak minimum detail + exact dialogue quote.
- Dialogue sabse strong fingerprint hai — kabhi summarize mat karo, hamesha exact words quote karo.

Sirf time map lines do, aur kuch nahi.`

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'x-api-key': API_KEY, ...(opts.headers || {}) },
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) {
    throw new Error(`${opts.method || 'GET'} ${path} -> HTTP ${res.status}: ${text.slice(0, 800)}`)
  }
  return json
}

function fileForm(fields, filePath, fileField) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  const buf = readFileSync(filePath)
  form.append(fileField, new Blob([buf], { type: 'video/mp4' }), filePath.split('/').pop())
  return form
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // ---- 0. Movie ka chunk 0 (00:00 - 01:00) cut karo — app ke same encode settings ----
  if (!existsSync(CHUNK_SRC)) {
    const ffmpeg = require('ffmpeg-static')
    log('Cutting movie.mp4 -> chunk 0 (first 60s, 640px/24fps/crf28 — app jaisa) ...')
    execFileSync(
      ffmpeg,
      [
        '-y', '-i', MOVIE_SRC, '-t', '60',
        '-vf', 'scale=640:-2,fps=24',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
        '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
        CHUNK_SRC,
      ],
      { stdio: 'pipe' },
    )
  }
  log('Videos ready:', SHORT_60, '+', CHUNK_SRC)

  console.log('\n========= PROMPT JO TWELVE LABS (PEGASUS) KO BHEJA JA RAHA HAI =========\n')
  console.log(TIME_MAP_PROMPT)
  console.log('\n=========================================================================\n')

  // ---- 1. Index banao (Marengo = matching/embeddings, Pegasus = text analysis) ----
  log('Creating index ...')
  const index = await api('/indexes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      index_name: `copyright-test-${Date.now()}`,
      // NOTE: is API key/plan par sirf marengo3.0 allowed hai (Pegasus available nahi —
      // HTTP 400 "You should use one of the following values: marengo3.0")
      models: [
        { model_name: 'marengo3.0', model_options: ['visual', 'audio'] },
      ],
    }),
  })
  const indexId = index._id
  log('Index created:', indexId)

  // ---- 2. Dono videos upload karo ----
  async function uploadAndWait(label, filePath) {
    log(`Uploading ${label} ...`)
    const task = await api('/tasks', {
      method: 'POST',
      body: fileForm({ index_id: indexId }, filePath, 'video_file'),
    })
    log(`${label} task:`, task._id)
    for (let i = 0; i < 120; i++) {
      await sleep(10000)
      const st = await api(`/tasks/${task._id}`)
      log(`${label} status: ${st.status}`)
      if (st.status === 'ready') return st.video_id
      if (st.status === 'failed') throw new Error(`${label} indexing FAILED: ${JSON.stringify(st)}`)
    }
    throw new Error(`${label} indexing timeout`)
  }

  const [shortVideoId, chunkVideoId] = await Promise.all([
    uploadAndWait('SHORT(60s)', SHORT_60),
    uploadAndWait('CHUNK-0', CHUNK_SRC),
  ])
  log('Indexed. shortVideoId =', shortVideoId, ', chunkVideoId =', chunkVideoId)

  // ---- 3. Pegasus analyze — app-style time map prompt dono par ----
  async function analyze(label, videoId) {
    log(`Pegasus analyzing ${label} ...`)
    try {
      const out = await api('/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ video_id: videoId, prompt: TIME_MAP_PROMPT, temperature: 0.2, stream: false }),
      })
      console.log(`\n================ PEGASUS TIME MAP — ${label} ================\n`)
      console.log(out.data || JSON.stringify(out, null, 2))
      console.log('\n=============================================================\n')
    } catch (e) {
      log(`Pegasus analyze FAILED for ${label} (continuing to embeddings):`, e.message)
    }
  }
  await analyze('CHUNK-0 (movie ka 1st minute)', chunkVideoId)
  await analyze('SHORT (1st 60s)', shortVideoId)

  // ---- 4. Marengo embeddings — short vs chunk segment matching ----
  async function embed(label, filePath) {
    log(`Embedding ${label} (2s clips) ...`)
    let task
    for (const modelName of ['Marengo-retrieval-2.7', 'marengo3.0', 'Marengo-retrieval-3.0']) {
      try {
        task = await api('/embed/tasks', {
          method: 'POST',
          body: fileForm(
            { model_name: modelName, video_clip_length: '2', video_embedding_scope: 'clip' },
            filePath,
            'video_file',
          ),
        })
        log(`${label}: embed model "${modelName}" accepted`)
        break
      } catch (e) {
        log(`${label}: embed model "${modelName}" rejected — ${e.message.slice(0, 200)}`)
      }
    }
    if (!task) throw new Error(`${label}: koi embed model name accept nahi hua`)
    for (let i = 0; i < 90; i++) {
      await sleep(8000)
      const st = await api(`/embed/tasks/${task._id}/status`)
      log(`${label} embed status: ${st.status}`)
      if (st.status === 'ready') break
      if (st.status === 'failed') throw new Error(`${label} embedding FAILED`)
    }
    const result = await api(`/embed/tasks/${task._id}?embedding_option=visual&embedding_option=audio`)
    const segs = result.video_embedding?.segments || []
    log(`${label}: ${segs.length} embedding segments`)
    return segs.filter((s) => s.embedding_option === 'visual')
  }

  const [shortSegs, chunkSegs] = [await embed('SHORT', SHORT_60), await embed('CHUNK-0', CHUNK_SRC)]

  const cosine = (a, b) => {
    let dot = 0, na = 0, nb = 0
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    return dot / (Math.sqrt(na) * Math.sqrt(nb))
  }
  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`

  console.log('\n============ MARENGO EMBEDDING MATCH (SHORT -> CHUNK-0) ============')
  console.log('Har short 2s-segment ka best match chunk me (cosine similarity):\n')
  for (const ss of shortSegs) {
    let best = null
    for (const cs of chunkSegs) {
      const sim = cosine(ss.float, cs.float)
      if (!best || sim > best.sim) best = { cs, sim }
    }
    const verdict = best.sim >= 0.85 ? 'STRONG MATCH' : best.sim >= 0.7 ? 'possible' : 'no match'
    console.log(
      `Short ${fmt(ss.start_offset_sec)}-${fmt(ss.end_offset_sec)} --> Chunk ${fmt(best.cs.start_offset_sec)}-${fmt(best.cs.end_offset_sec)}  sim=${best.sim.toFixed(3)}  [${verdict}]`,
    )
  }
  console.log('\n============================== DONE ==============================')
}

main().catch((e) => {
  console.error('\nTEST FAILED:', e.message)
  process.exit(1)
})
