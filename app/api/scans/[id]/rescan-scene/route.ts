import { NextResponse } from 'next/server'
import path from 'node:path'
import fs from 'node:fs'
import { GoogleGenAI } from '@google/genai'
import { getScan, saveScan, addLog, scanMediaDir, incrementModelUsage } from '@/lib/store'
import { getSession } from '@/lib/users'
import { getAllUserApiKeys } from '@/lib/user-keys'
import { extractClipPrecise } from '@/lib/ffmpeg'
import { uploadVideo, deleteFileQuiet, rescanRequest, parseRescanMatch, classifyError } from '@/lib/gemini'
import { globalGeminiCoordinator, type CandidateLane } from '@/lib/global-gemini-coordinator'
import { CHUNK_COOLDOWN_MS } from '@/lib/models'
import { sameShortSegment, applyGroupMatches } from '@/lib/candidate-pick'
import { invalidateRenderedOutput } from '@/lib/render'
import { fmtTime } from '@/lib/format'

export const runtime = 'nodejs'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const scan = getScan(id)
  if (!scan) {
    return NextResponse.json({ ok: false, error: 'Scan not found' }, { status: 404 })
  }

  const body = await req.json().catch(() => ({}))
  const shortStart = Number(body.shortStart)
  const shortEnd = Number(body.shortEnd)

  if (!Number.isFinite(shortStart) || !Number.isFinite(shortEnd) || shortEnd <= shortStart) {
    return NextResponse.json({ ok: false, error: 'Invalid short start/end timestamps' }, { status: 400 })
  }

  const movieStart = Number.isFinite(Number(body.movieStart)) ? Number(body.movieStart) : 0
  const movieEnd = Number.isFinite(Number(body.movieEnd)) ? Number(body.movieEnd) : 0
  const shortDur = shortEnd - shortStart

  // Determine chunk index
  const chunkIndex = Number.isInteger(body.chunkIndex) && body.chunkIndex >= 0
    ? Number(body.chunkIndex)
    : Math.floor(movieStart / 60)

  const mediaDir = scanMediaDir(id)
  const shortFile = path.join(mediaDir, 'short.mp4')
  const movieFile = path.join(mediaDir, 'movie.mp4')

  if (!fs.existsSync(shortFile) || !fs.existsSync(movieFile)) {
    return NextResponse.json({ ok: false, error: 'Media files not found on server' }, { status: 404 })
  }

  const clipsDir = path.join(mediaDir, 'clips')
  if (!fs.existsSync(clipsDir)) {
    fs.mkdirSync(clipsDir, { recursive: true })
  }

  // Calculate chunk boundaries in movie
  const chunkStart = chunkIndex * 60
  const movieDuration = scan.movieDuration || 7200
  const chunkEnd = Math.min(movieDuration, (chunkIndex + 1) * 60)

  const padBefore = shortDur < 2.0 ? 1.0 : 0
  const padAfter = shortDur < 2.0 ? 1.0 : 0
  const needsPad = padBefore > 0 || padAfter > 0
  const clipShortStart = Math.max(0, shortStart - padBefore)
  const clipShortEnd = Math.min(scan.shortDuration || 300, shortEnd + padAfter)

  const shortClipFile = path.join(clipsDir, `rescan-short-${Date.now()}-${Math.floor(Math.random() * 1000)}.mp4`)
  const chunkClipFile = path.join(clipsDir, `rescan-chunk-${chunkIndex}-${Date.now()}-${Math.floor(Math.random() * 1000)}.mp4`)

  let opSecs = 0

  try {
    addLog(scan, 'info', `[Rescan Scene] Starting targeted rescan for Short ${fmtTime(shortStart)}–${fmtTime(shortEnd)} inside Movie chunk ${chunkIndex + 1} (${fmtTime(chunkStart)}–${fmtTime(chunkEnd)})...`)

    // 1. Cut short clip and chunk clip
    await extractClipPrecise(shortFile, clipShortStart, clipShortEnd, shortClipFile)
    await extractClipPrecise(movieFile, chunkStart, chunkEnd, chunkClipFile)

    // 2. Select API keys and models
    const userKeys = await getAllUserApiKeys(session.username)
    const scanKeys = scan.apiKeys || []
    const envKey = process.env.GEMINI_API_KEY || ''
    const allKeys = Array.from(new Set([...userKeys, ...scanKeys, envKey].filter(Boolean)))

    if (allKeys.length === 0) {
      return NextResponse.json({ ok: false, error: 'No Gemini API keys configured' }, { status: 400 })
    }

    const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null
    const allowedModels = requestedModel
      ? [requestedModel]
      : ['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.6-flash']

    const candidates = allKeys.flatMap((k, ki) =>
      allowedModels.map((mId) => ({
        apiKey: k,
        keyIdx: ki + 1,
        modelId: mId,
        rpd: 20,
      })),
    )

    opSecs = Math.ceil(shortDur + padBefore + padAfter + (chunkEnd - chunkStart))

    // 4. Build hints & prompt notes
    const padNote = needsPad
      ? `NOTE: Video 1 contains ${padBefore.toFixed(1)}s before and ${padAfter.toFixed(1)}s after padding. Focus specifically on the central target segment.`
      : undefined

    const hintLocalStart = Math.max(0, movieStart - chunkStart)
    const hintLocalEnd = Math.max(0, movieEnd - chunkStart)
    const hintNote =
      movieEnd > movieStart && hintLocalEnd > hintLocalStart
        ? `HINT — PEHLE YAHAN DEKHO: Previous match claimed Video 2 around ${fmtTime(hintLocalStart)}–${fmtTime(hintLocalEnd)}. Check this region first with frame precision, but scan the full video if boundaries shifted.`
        : undefined

    let raw = ''
    let selectedLane: CandidateLane | null = null
    const maxRescanAttempts = 3

    for (let attempt = 1; attempt <= maxRescanAttempts; attempt++) {
      let currentRelease: ((sec?: number, cd?: number) => void) | null = null
      const currentUploadedNames: string[] = []
      let currentAi: GoogleGenAI | null = null

      try {
        const { selected, release } = await globalGeminiCoordinator.acquireFirstAvailableLane({
          scanId: id,
          scanTitle: scan.shortName || id,
          candidates,
          operation: `Rescan Scene Short ${fmtTime(shortStart)}`,
          videoSeconds: opSecs,
          onWait: (msg) => addLog(scan, 'info', msg),
        })
        selectedLane = selected
        currentRelease = release
        currentAi = new GoogleGenAI({ apiKey: selected.apiKey })

        // Upload clips to Gemini Files API for this key
        const upShort = await uploadVideo(currentAi, shortClipFile)
        const upChunk = await uploadVideo(currentAi, chunkClipFile)
        currentUploadedNames.push(upShort.name, upChunk.name)

        raw = await rescanRequest(currentAi, selected.modelId, upShort.uri, upChunk.uri, padNote, hintNote)
        globalGeminiCoordinator.recordSuccess(selected.apiKey, selected.modelId, 0)
        incrementModelUsage(selected.modelId, selected.apiKey)
        break // Success!
      } catch (err) {
        const ge = classifyError(err)
        if ((ge.kind === 'rate' || ge.kind === 'rpd') && selectedLane) {
          const outcome = globalGeminiCoordinator.handleQuotaOrRateError(
            selectedLane.apiKey,
            selectedLane.modelId,
            0,
            selectedLane.rpd || 20,
            ge.kind === 'rpd',
          )
          addLog(scan, 'warn', `[Rescan Scene] ${outcome.reason} (attempt ${attempt}/${maxRescanAttempts})`)
          if (currentRelease) {
            currentRelease(opSecs, CHUNK_COOLDOWN_MS)
            currentRelease = null
          }
          if (attempt < maxRescanAttempts) continue
        }
        throw err
      } finally {
        if (currentRelease) currentRelease(opSecs)
        if (currentAi && currentUploadedNames.length > 0) {
          for (const name of currentUploadedNames) {
            deleteFileQuiet(currentAi, name).catch(() => {})
          }
        }
      }
    }

    if (!selectedLane) throw new Error('No candidate lane could be acquired for rescan')
    const selected = selectedLane
    const found = parseRescanMatch(raw)

    if (!found) {
      addLog(scan, 'warn', `[Rescan Scene] AI did not find a match for Short ${fmtTime(shortStart)}–${fmtTime(shortEnd)} in chunk ${chunkIndex + 1}`)
      return NextResponse.json({
        ok: false,
        found: false,
        error: `AI could not find a match in Movie chunk ${chunkIndex + 1} (${fmtTime(chunkStart)}–${fmtTime(chunkEnd)}). Try adjusting or selecting a different chunk.`,
      })
    }

    const newMovieStart = Math.max(0, Number((chunkStart + found.start).toFixed(3)))
    const newMovieEnd = Number((chunkStart + found.end).toFixed(3))

    // 6. Update candidate groups & scan.matches
    if (!Array.isArray(scan.candidateGroups)) scan.candidateGroups = []

    let g = scan.candidateGroups.find((grp) => sameShortSegment(grp.shortStart, grp.shortEnd, shortStart, shortEnd))
    if (!g) {
      g = {
        id: `cg-rescan-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        shortStart,
        shortEnd,
        status: 'confirmed',
        candidates: [],
        confirmedIndex: 0,
        confirmedViaRescan: true,
        attempts: 1,
        origin: 'rescan',
      }
      scan.candidateGroups.push(g)
    }

    // Preserve previous active match as a candidate if not already in candidates list
    const prevMatch = (scan.matches || []).find((m) => sameShortSegment(m.shortStart, m.shortEnd, shortStart, shortEnd))
    if (prevMatch) {
      const alreadyIn = g.candidates.some(
        (c) => Math.abs(c.movieStart - prevMatch.movieStart) < 0.5 && Math.abs(c.movieEnd - prevMatch.movieEnd) < 0.5,
      )
      if (!alreadyIn) {
        g.candidates.push({
          chunkIndex: prevMatch.chunkIndex,
          movieStart: prevMatch.movieStart,
          movieEnd: prevMatch.movieEnd,
          confidence: 0.9,
          reason: prevMatch.reason || 'Previous match',
          model: prevMatch.model,
          verdict: prevMatch.verified ? 'same' : 'different',
        })
      }
    }

    // Add new rescan candidate
    const newCandIndex = g.candidates.length
    g.candidates.push({
      chunkIndex,
      movieStart: newMovieStart,
      movieEnd: newMovieEnd,
      confidence: 0.99,
      reason: `Targeted Rescan (${selected.modelId})`,
      model: selected.modelId,
      verdict: 'same',
      rescan: 'found',
      rescanMovieStart: newMovieStart,
      rescanMovieEnd: newMovieEnd,
      rescanVerdict: 'same',
      rescanReason: `Found via targeted rescan on ${selected.modelId} (User Review)`,
    })

    g.status = 'confirmed'
    g.confirmedIndex = newCandIndex
    g.confirmedViaRescan = true
    g.userPick = { index: newCandIndex, viaRescan: true, at: Date.now() }

    // Make newly rescanned clip the MAIN clip in scan.matches using applyGroupMatches
    applyGroupMatches(scan, g)

    const newMatch = scan.matches.find(
      (m) =>
        m.userPick &&
        Math.abs(m.movieStart - newMovieStart) < 0.5 &&
        Math.abs(m.movieEnd - newMovieEnd) < 0.5,
    ) || {
      shortStart,
      shortEnd,
      movieStart: newMovieStart,
      movieEnd: newMovieEnd,
      chunkIndex,
      model: selected.modelId,
      verified: true,
      viaRescan: true,
      userPick: true,
      origin: 'rescan',
      originWindow: g.originWindow,
      reason: `Rescanned via Retry (${selected.modelId}) — User Review`,
    }

    // Invalidate previous export so render/download exports the updated main clip
    if (invalidateRenderedOutput(scan)) {
      addLog(scan, 'warn', '[Rescan Scene] Previous export cleared because main clip was rescanned — render again to export the updated merge')
    }

    if (scan.report) scan.report.matches = scan.matches
    saveScan(scan, { immediate: true })

    addLog(
      scan,
      'success',
      `[Rescan Scene] Successfully rescanned Short ${fmtTime(shortStart)}–${fmtTime(shortEnd)} → Movie ${fmtTime(newMovieStart)}–${fmtTime(newMovieEnd)} (${selected.modelId}, Key ${selected.keyIdx}). Set as MAIN clip with previous match stored in candidates.`,
    )

    return NextResponse.json({
      ok: true,
      found: true,
      movieStart: newMovieStart,
      movieEnd: newMovieEnd,
      chunkIndex,
      model: selected.modelId,
      newMatch,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    addLog(scan, 'error', `[Rescan Scene] Failed: ${msg.slice(0, 150)}`)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  } finally {
    // Clean up local temp files
    try {
      if (fs.existsSync(shortClipFile)) fs.unlinkSync(shortClipFile)
      if (fs.existsSync(chunkClipFile)) fs.unlinkSync(chunkClipFile)
    } catch {}
  }
}
