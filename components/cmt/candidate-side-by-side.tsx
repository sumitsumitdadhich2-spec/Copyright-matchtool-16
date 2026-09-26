'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Play,
  Pause,
  RotateCcw,
  Volume2,
  VolumeX,
  Check,
  X,
  Loader2,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  Repeat,
} from 'lucide-react'
import type { MissingSceneCandidate, Scan } from '@/lib/types'
import { fmtTime } from '@/lib/format'

interface CandidateSideBySideProps {
  scan: Scan
  candidates: MissingSceneCandidate[]
  selectedCandidateId: string | null
  onSelectCandidate: (id: string) => void
  onAccept: (candidateId: string) => Promise<void>
  onReject: (candidateId: string) => Promise<void>
  reviewingId: string | null
}

export function CandidateSideBySide({
  scan,
  candidates,
  selectedCandidateId,
  onSelectCandidate,
  onAccept,
  onReject,
  reviewingId,
}: CandidateSideBySideProps) {
  const activeCandidate =
    candidates.find((c) => c.id === selectedCandidateId) || candidates[0]

  const activeIndex = activeCandidate
    ? candidates.findIndex((c) => c.id === activeCandidate.id)
    : 0

  const shortRef = useRef<HTMLVideoElement>(null)
  const movieRef = useRef<HTMLVideoElement>(null)
  const shortBarRef = useRef<HTMLDivElement>(null)
  const movieBarRef = useRef<HTMLDivElement>(null)
  const animFrameRef = useRef<number | null>(null)

  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(true)
  const [playbackRate, setPlaybackRate] = useState<number>(1)
  const [audioTrack, setAudioTrack] = useState<'none' | 'short' | 'movie'>('none')

  const shortStart = activeCandidate?.shortStart ?? 0
  const shortEnd = activeCandidate?.shortEnd ?? 0
  const movieStart = activeCandidate?.movieStart ?? 0
  const movieEnd = activeCandidate?.movieEnd ?? 0

  const shortDuration = Math.max(0.1, shortEnd - shortStart)
  const movieDuration = Math.max(0.1, movieEnd - movieStart)

  const src = (kind: 'short' | 'movie') => `/api/scans/${scan.id}/media?kind=${kind}`

  // Safe seek utility
  const safeSeek = useCallback((video: HTMLVideoElement, targetTime: number) => {
    try {
      if (Number.isFinite(targetTime) && targetTime >= 0) {
        if (Math.abs(video.currentTime - targetTime) > 0.05) {
          video.currentTime = targetTime
        }
      }
    } catch {}
  }, [])

  // Seek both videos to the candidate segment start when candidate changes
  useEffect(() => {
    setPlaying(false)
    if (shortRef.current) {
      shortRef.current.pause()
      safeSeek(shortRef.current, shortStart)
    }
    if (movieRef.current) {
      movieRef.current.pause()
      safeSeek(movieRef.current, movieStart)
    }
    if (shortBarRef.current) shortBarRef.current.style.width = '0%'
    if (movieBarRef.current) movieBarRef.current.style.width = '0%'
  }, [activeCandidate?.id, shortStart, movieStart, safeSeek])

  // Playback rate handler
  useEffect(() => {
    if (shortRef.current) shortRef.current.playbackRate = playbackRate
    if (movieRef.current) movieRef.current.playbackRate = playbackRate
  }, [playbackRate])

  // Synchronized playback loop & DOM-ref progress tracking
  useEffect(() => {
    const sEl = shortRef.current
    const mEl = movieRef.current

    const tick = () => {
      if (!sEl || !mEl) return

      const sCur = sEl.currentTime
      const mCur = mEl.currentTime

      const sProg = Math.max(0, Math.min(1, (sCur - shortStart) / shortDuration))
      const mProg = Math.max(0, Math.min(1, (mCur - movieStart) / movieDuration))

      if (shortBarRef.current) {
        shortBarRef.current.style.width = `${sProg * 100}%`
      }
      if (movieBarRef.current) {
        movieBarRef.current.style.width = `${mProg * 100}%`
      }

      // Check if segment ended
      const sDone = sCur >= shortEnd - 0.04
      const mDone = mCur >= movieEnd - 0.04

      if (sDone || mDone) {
        if (loop) {
          safeSeek(sEl, shortStart)
          safeSeek(mEl, movieStart)
          void sEl.play().catch(() => {})
          void mEl.play().catch(() => {})
        } else {
          sEl.pause()
          mEl.pause()
          setPlaying(false)
        }
      }

      animFrameRef.current = requestAnimationFrame(tick)
    }

    if (playing) {
      animFrameRef.current = requestAnimationFrame(tick)
    } else {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    }

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    }
  }, [playing, loop, shortStart, shortEnd, movieStart, movieEnd, shortDuration, movieDuration, safeSeek])

  const togglePlay = () => {
    const sEl = shortRef.current
    const mEl = movieRef.current
    if (!sEl || !mEl) return

    if (playing) {
      sEl.pause()
      mEl.pause()
      setPlaying(false)
    } else {
      // If at end, seek to start before playing
      if (sEl.currentTime >= shortEnd - 0.05 || sEl.currentTime < shortStart) {
        safeSeek(sEl, shortStart)
      }
      if (mEl.currentTime >= movieEnd - 0.05 || mEl.currentTime < movieStart) {
        safeSeek(mEl, movieStart)
      }
      void sEl.play().catch(() => {})
      void mEl.play().catch(() => {})
      setPlaying(true)
    }
  }

  const restartBoth = () => {
    const sEl = shortRef.current
    const mEl = movieRef.current
    if (!sEl || !mEl) return

    safeSeek(sEl, shortStart)
    safeSeek(mEl, movieStart)
    if (shortBarRef.current) shortBarRef.current.style.width = '0%'
    if (movieBarRef.current) movieBarRef.current.style.width = '0%'

    void sEl.play().catch(() => {})
    void mEl.play().catch(() => {})
    setPlaying(true)
  }

  if (!activeCandidate) return null

  const isAccepted = activeCandidate.status === 'confirmed'
  const isRejected = activeCandidate.status === 'rejected'
  const isBusy = reviewingId === activeCandidate.id

  return (
    <div className="mt-3 rounded-xl border border-primary/30 bg-card/80 p-3.5 shadow-md backdrop-blur-sm">
      {/* HEADER & CANDIDATE NAV */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2.5">
        <div className="flex items-center gap-2">
          <div className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Sparkles className="size-3.5" aria-hidden />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-foreground">
                Side-by-Side Candidate Verification
              </span>
              <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-primary">
                Candidate {activeIndex + 1} of {candidates.length}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Compare Short video vs Movie chunk side-by-side to verify match before accepting
            </p>
          </div>
        </div>

        {/* PREV / NEXT CANDIDATE BUTTONS */}
        {candidates.length > 1 && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={activeIndex === 0}
              onClick={() => onSelectCandidate(candidates[activeIndex - 1].id)}
              className="flex items-center gap-1 rounded-md border border-input bg-card px-2 py-1 text-xs font-medium text-foreground hover:bg-secondary disabled:opacity-40"
              title="Previous Candidate"
            >
              <ChevronLeft className="size-3.5" aria-hidden /> Prev
            </button>
            <span className="font-mono text-xs text-muted-foreground px-1">
              {activeIndex + 1}/{candidates.length}
            </span>
            <button
              type="button"
              disabled={activeIndex === candidates.length - 1}
              onClick={() => onSelectCandidate(candidates[activeIndex + 1].id)}
              className="flex items-center gap-1 rounded-md border border-input bg-card px-2 py-1 text-xs font-medium text-foreground hover:bg-secondary disabled:opacity-40"
              title="Next Candidate"
            >
              Next <ChevronRight className="size-3.5" aria-hidden />
            </button>
          </div>
        )}
      </div>

      {/* CANDIDATE SELECTOR PILLS (IF MULTIPLE) */}
      {candidates.length > 1 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5 border-b border-border/40 pb-2">
          {candidates.map((c, i) => {
            const isSelected = c.id === activeCandidate.id
            const isCConfirmed = c.status === 'confirmed'
            const isCRejected = c.status === 'rejected'

            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelectCandidate(c.id)}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-all ${
                  isSelected
                    ? 'border-primary bg-primary/15 font-semibold text-primary shadow-xs ring-1 ring-primary/40'
                    : 'border-border/70 bg-card/60 text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                <span>#{i + 1}</span>
                <span className="font-mono text-[11px]">
                  Short {fmtTime(c.shortStart)}–{fmtTime(c.shortEnd)} ➔ Movie {fmtTime(c.movieStart)}–{fmtTime(c.movieEnd)}
                </span>
                {isCConfirmed && (
                  <span className="rounded bg-success/20 px-1 py-0.2 text-[9px] font-bold text-success">
                    ACCEPTED
                  </span>
                )}
                {isCRejected && (
                  <span className="rounded bg-muted px-1 py-0.2 text-[9px] text-muted-foreground">
                    REJECTED
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* SIDE BY SIDE VIDEO PREVIEW */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:gap-3">
        {/* SHORT VIDEO */}
        <figure className="flex flex-col gap-1.5">
          <figcaption className="flex flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:justify-between">
            <span className="font-medium text-foreground">Short Video Scene</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {fmtTime(shortStart)} – {fmtTime(shortEnd)} ({shortDuration.toFixed(1)}s)
            </span>
          </figcaption>
          <div className="relative overflow-hidden rounded-lg border border-border bg-black shadow-inner">
            <video
              ref={shortRef}
              src={src('short')}
              preload="metadata"
              muted={audioTrack !== 'short'}
              playsInline
              onLoadedMetadata={() => {
                if (shortRef.current) safeSeek(shortRef.current, shortStart)
              }}
              className="aspect-video w-full object-contain"
            />
            {/* Direct DOM Progress Bar */}
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/20">
              <div
                ref={shortBarRef}
                className="h-full bg-primary transition-none"
                style={{ width: '0%' }}
              />
            </div>
          </div>
        </figure>

        {/* MOVIE VIDEO */}
        <figure className="flex flex-col gap-1.5">
          <figcaption className="flex flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-foreground">Movie Match</span>
              <span className="rounded bg-secondary px-1.5 py-0.2 font-mono text-[10px] text-muted-foreground">
                Chunk {activeCandidate.chunkIndex + 1}
              </span>
            </div>
            <span className="font-mono text-[11px] text-muted-foreground">
              {fmtTime(movieStart)} – {fmtTime(movieEnd)} ({movieDuration.toFixed(1)}s)
            </span>
          </figcaption>
          <div className="relative overflow-hidden rounded-lg border border-primary/40 bg-black shadow-inner">
            <video
              ref={movieRef}
              src={src('movie')}
              preload="metadata"
              muted={audioTrack !== 'movie'}
              playsInline
              onLoadedMetadata={() => {
                if (movieRef.current) safeSeek(movieRef.current, movieStart)
              }}
              className="aspect-video w-full object-contain"
            />
            {/* Direct DOM Progress Bar */}
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/20">
              <div
                ref={movieBarRef}
                className="h-full bg-primary transition-none"
                style={{ width: '0%' }}
              />
            </div>
          </div>
        </figure>
      </div>

      {/* PLAYBACK CONTROLS BAR */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-secondary/30 px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Play/Pause */}
          <button
            type="button"
            onClick={togglePlay}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-xs hover:bg-primary/90"
          >
            {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
            {playing ? 'Pause' : 'Play Both'}
          </button>

          {/* Restart */}
          <button
            type="button"
            onClick={restartBoth}
            className="flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary"
            title="Replay from start"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Restart
          </button>

          {/* Loop toggle */}
          <button
            type="button"
            onClick={() => setLoop((prev) => !prev)}
            className={`flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              loop
                ? 'border-primary/50 bg-primary/10 text-primary'
                : 'border-input bg-card text-muted-foreground hover:text-foreground'
            }`}
            title="Loop video comparison"
          >
            <Repeat className="size-3.5" aria-hidden />
            Loop {loop ? 'ON' : 'OFF'}
          </button>

          {/* Speed */}
          <div className="flex items-center rounded-md border border-input bg-card p-0.5 text-xs">
            {[1, 1.25, 1.5].map((rate) => (
              <button
                key={rate}
                type="button"
                onClick={() => setPlaybackRate(rate)}
                className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-medium transition-colors ${
                  playbackRate === rate
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {rate}x
              </button>
            ))}
          </div>
        </div>

        {/* Audio switch */}
        <div className="flex items-center gap-1 text-xs">
          <span className="text-muted-foreground text-[11px]">Audio:</span>
          <div className="flex items-center rounded-md border border-input bg-card p-0.5">
            <button
              type="button"
              onClick={() => setAudioTrack('none')}
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ${
                audioTrack === 'none'
                  ? 'bg-secondary font-semibold text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <VolumeX className="size-3" aria-hidden />
              Mute
            </button>
            <button
              type="button"
              onClick={() => setAudioTrack('short')}
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ${
                audioTrack === 'short'
                  ? 'bg-primary text-primary-foreground font-semibold'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Volume2 className="size-3" aria-hidden />
              Short
            </button>
            <button
              type="button"
              onClick={() => setAudioTrack('movie')}
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ${
                audioTrack === 'movie'
                  ? 'bg-primary text-primary-foreground font-semibold'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Volume2 className="size-3" aria-hidden />
              Movie
            </button>
          </div>
        </div>
      </div>

      {/* ACTION VERDICT BAR (ACCEPT / REJECT) */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground">
              Candidate Verdict:
            </span>
            {isAccepted ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-success/20 px-2.5 py-0.5 text-xs font-bold text-success">
                <Check className="size-3.5" aria-hidden />
                ACCEPTED & ADDED TO MATCHES
              </span>
            ) : isRejected ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                <X className="size-3.5" aria-hidden />
                REJECTED
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/20 px-2.5 py-0.5 text-xs font-semibold text-amber-500">
                PENDING USER CONFIRMATION
              </span>
            )}
          </div>
          {activeCandidate.model && (
            <p className="text-[11px] text-muted-foreground">
              Detected by Gemini model <span className="font-mono text-foreground font-medium">{activeCandidate.model}</span> (Chunk {activeCandidate.chunkIndex + 1})
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!isAccepted && (
            <button
              type="button"
              onClick={() => onAccept(activeCandidate.id)}
              disabled={isBusy}
              className="btn-press flex items-center gap-1.5 rounded-lg bg-success px-4 py-2 text-xs font-bold text-success-foreground shadow-sm hover:bg-success/90 disabled:opacity-40 cursor-pointer"
            >
              {isBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
              Accept Match (Add to Timeline)
            </button>
          )}

          {!isRejected && (
            <button
              type="button"
              onClick={() => onReject(activeCandidate.id)}
              disabled={isBusy}
              className="btn-press flex items-center gap-1.5 rounded-lg border border-input bg-card px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40 cursor-pointer"
            >
              <X className="size-3.5" aria-hidden />
              Reject Match
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
