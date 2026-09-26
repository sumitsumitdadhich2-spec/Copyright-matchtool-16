// Locked model pool: ONLY models with 250K TPM on the free tier.
// Real measured token rate at DEFAULT media resolution is ~65 tokens/frame
// (NOT the 258 in the docs — that figure only applies to MEDIA_RESOLUTION_HIGH).
// Each chunk-map request (short ~60-90s + 60s chunk @ 24 fps) is ~190K-234K tokens,
// so every model is effectively limited to 1 request per minute by TPM regardless of RPM.
export interface ModelSpec {
  id: string
  rpm: number
  rpd: number
}

/** CHUNK-MAP models (locked): gemini-3.6-flash, gemini-3.7-flash, and
 * gemini-3.8-flash are allowed to run chunk-time mapping requests. Every other
 * model is BANNED from this phase. All API keys run all three models in
 * parallel on the shared chunk queue. */
export const CHUNK_MODEL_POOL: ModelSpec[] = [
  { id: 'gemini-3.6-flash', rpm: 5, rpd: 20 },
  { id: 'gemini-3.7-flash', rpm: 5, rpd: 20 },
  { id: 'gemini-3.8-flash', rpm: 5, rpd: 20 },
]

/** VERIFY models (locked): gemini-3.5-flash-lite + gemini-3.1-flash-lite ONLY.
 * Dono ki daily limit 500 RPD each hai — har model ek sath 3 parallel requests handle kar sakta hai.
 * 1 key par 2 models × 3 requests = 6 parallel requests. 5 keys par = 30 parallel requests.
 * Clips <= 4s hone ki wajah se TPM 250K cap ke andar safe rehta hai. */
export const VERIFY_MODEL_POOL: ModelSpec[] = [
  { id: 'gemini-3.5-flash-lite', rpm: 15, rpd: 500 },
  { id: 'gemini-3.1-flash-lite', rpm: 15, rpd: 500 },
]

/** RESCAN models (primary): gemini-3-flash-preview and gemini-3.5-flash run
 * rescan requests (full-chunk segment hunt). Thinking level HIGH and max
 * output tokens apply globally to every request (see GEN_CONFIG). */
export const RESCAN_MODEL_POOL: ModelSpec[] = [
  { id: 'gemini-3-flash-preview', rpm: 5, rpd: 20 },
  { id: 'gemini-3.5-flash', rpm: 5, rpd: 500 },
]

/** RESCAN BACKUP models: jab primary rescan models (3-flash-preview / 3.5-flash)
 * ki daily limit khatam ho jaye, to rescan in HIGH-LIMIT lite models par
 * fallback karta hai (500 RPD each) — rescan kabhi ruke nahi. */
export const RESCAN_BACKUP_POOL: ModelSpec[] = [
  { id: 'gemini-3.5-flash-lite', rpm: 15, rpd: 500 },
  { id: 'gemini-3.1-flash-lite', rpm: 15, rpd: 500 },
]

export interface GapFinderModelOption {
  id: string
  name: string
  rpd: number
  rpm: number
  description: string
  recommended?: boolean
}

export const GAP_FINDER_AVAILABLE_MODELS: GapFinderModelOption[] = [
  { id: 'gemini-3.7-flash', name: '3.7-shiva', rpd: 20, rpm: 5, description: 'Fast, balanced high-accuracy forensic', recommended: true },
  { id: 'gemini-3.8-flash', name: '3.8-shiva', rpd: 20, rpm: 5, description: 'Deep forensic multi-frame analysis', recommended: true },
  { id: 'gemini-3.6-flash', name: '3.6-shiva', rpd: 20, rpm: 5, description: 'Robust baseline scene comparison', recommended: true },
  { id: 'gemini-3.5-flash', name: '3.5-shiva', rpd: 500, rpm: 5, description: 'Precision chunk matcher', recommended: false },
  { id: 'gemini-3.5-flash-lite', name: '3.5-shiva-lite', rpd: 500, rpm: 15, description: 'High daily quota (500 RPD)', recommended: false },
  { id: 'gemini-3.1-flash-lite', name: '3.1-shiva-lite', rpd: 500, rpm: 15, description: 'High daily quota (500 RPD)', recommended: false },
]

/** Is this model one of the primary rescan models? */
export function isRescanModel(id: string): boolean {
  return RESCAN_MODEL_POOL.some((m) => m.id === id)
}

/** PADDED-VERIFY models: locked to gemini-3.5-flash-lite and gemini-3.1-flash-lite ONLY. */
export const PADDED_VERIFY_MODEL_POOL: ModelSpec[] = [
  { id: 'gemini-3.5-flash-lite', rpm: 15, rpd: 500 },
  { id: 'gemini-3.1-flash-lite', rpm: 15, rpd: 500 },
]

/** Is this model allowed to verify PADDED clips? */
export function isPaddedVerifyModel(id: string): boolean {
  return PADDED_VERIFY_MODEL_POOL.some((m) => m.id === id)
}

/** UI-ONLY display name: strips the vendor prefix and shows "flash" as "shiva".
 * NEVER use this for API calls — real model ids stay unchanged in the backend. */
export function displayModelName(id: string): string {
  return id.replace('gemini-', '').replace(/flash/gi, 'shiva')
}

/** Full pool (chunk + verify + rescan + backups, de-duplicated) — used by the
 * UI model board and reports. */
export const MODEL_POOL: ModelSpec[] = [
  ...CHUNK_MODEL_POOL,
  ...VERIFY_MODEL_POOL,
  ...RESCAN_MODEL_POOL,
  ...RESCAN_BACKUP_POOL,
  ...PADDED_VERIFY_MODEL_POOL,
].filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i)

/** Returns the configured daily quota (RPD) for a model, defaulting safely to spec */
export function getModelDailyCap(modelId: string): number {
  const spec = MODEL_POOL.find((m) => m.id === modelId)
  if (spec && typeof spec.rpd === 'number') return spec.rpd
  if (modelId.includes('lite') || modelId.includes('3.5-flash')) return 500
  return 20
}

/** Is this model one of the three locked chunk-map models? */
export function isChunkModel(id: string): boolean {
  return CHUNK_MODEL_POOL.some((m) => m.id === id)
}

/** Max AUTOMATIC quality retries per chunk when the output looks like a false
 * result (extrapolated A-to-Z mapping / zero NOT FOUND lines). After this many
 * auto-retries the result is accepted as-is — quota is precious. */
export const MAX_QUALITY_RETRIES = 1

/** Thinking level for EVERY Gemini request (chunk map, verify, rescan). */
export const THINKING_LEVEL = 'high'

/** Max output tokens for EVERY Gemini request — always the maximum. */
export const MAX_OUTPUT_TOKENS = 65_536

/** Minimum spacing between requests per model (ms). TPM 250K vs ~190K tokens/request
 * (short + chunk @ 24 fps × 65 tok/frame at default resolution) => 1 req/min. */
export const MODEL_MIN_INTERVAL_MS = 60_000

/** Cooldown applied on RPM/TPM-type 429s (ms). */
export const RATE_COOLDOWN_MS = 60_000

/**
 * Mandatory cooldown per chunk request: 1 minute 10 seconds (70,000 ms).
 * After 1 request completes, this cooldown is recorded and enforced on that (key × model) lane.
 * During this 70s window, the system prepares and uploads the next movie chunk and short clip,
 * and sends the next request only after the 70s cooldown is 100% complete.
 */
export const CHUNK_COOLDOWN_MS = 70_000

/** fps used for every chunk-map request (locked).
 * Short + 60s chunk together @ 24 fps × 65 tok/frame ≈ ~190K tokens — fits under the 250K TPM cap at default resolution. */
export const SCAN_FPS = 24

export const CHUNK_SECONDS = 60

/** Free-tier TPM cap shared by every model in the pool. */
export const TPM_LIMIT = 250_000

/** Measured token cost per video frame at DEFAULT media resolution. */
export const TOKENS_PER_FRAME = 65

/** Estimate the token cost of a request from its total video seconds (all clips combined, 24 fps). */
export function estimateRequestTokens(totalVideoSeconds: number): number {
  return Math.ceil(totalVideoSeconds * SCAN_FPS * TOKENS_PER_FRAME) + 2_000
}

/** Minimum spacing (ms) between requests of this size on one (key × model) lane.
 * For chunk-mapping and full-minute rescan requests (>= 50s total video), strictly enforces the 1m 10s (70s) cooldown.
 * For small verify clips, scales down proportionally while strictly respecting model RPM limits:
 * - 5 RPM models (gemini-3.8-flash, 3.7-flash, 3.6-flash, 3-flash-preview, 3.5-flash): minimum 13,000ms spacing
 *   to guarantee requests never exceed 5 RPM (60s / 5 = 12s, with 1s safety margin).
 * - 15 RPM models (gemini-3.5-flash-lite, 3.1-flash-lite): minimum 5,000ms spacing. */
export function pacingIntervalMs(totalVideoSeconds: number, modelId?: string): number {
  if (totalVideoSeconds >= 50) {
    return CHUNK_COOLDOWN_MS
  }
  const tokens = estimateRequestTokens(totalVideoSeconds)
  const ms = Math.ceil((tokens / TPM_LIMIT) * 60_000)
  const is5Rpm = modelId ? !modelId.includes('lite') : (totalVideoSeconds > 8)
  const minRpmSpacing = is5Rpm ? 13_000 : 5_000
  return Math.min(MODEL_MIN_INTERVAL_MS, Math.max(minRpmSpacing, ms))
}
