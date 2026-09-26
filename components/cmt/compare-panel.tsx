'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FastForward,
  ListFilter,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  SplitSquareHorizontal,
  Terminal,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import type { Scan } from '@/lib/types'
import { fmtTime } from '@/lib/format'
import { displayModelName } from '@/lib/models'
import { candidateOptionsFor, hasAlternatives, sameShortSegment, resolveMainMatches } from '@/lib/candidate-pick'
import { CandidateChooser } from './candidate-chooser'

interface RescanLogEntry {
  time: string
  msg: string
  type: 'info' | 'warn' | 'success' | 'error'
}

interface RescanTaskState {
  taskKey: string
  pairIndex: number
  shortStart: number
  shortEnd: number
  chunkIndex: number
  status: 'preparing' | 'uploading' | 'scanning' | 'retrying' | 'done' | 'error'
  progressMsg: string
  attempt: number
  maxAttempts: number
  model?: string
  logs: RescanLogEntry[]
  result?: { movieStart: number; movieEnd: number; model: string }
  errorMsg?: string
}

interface ToastNotification {
  id: string
  title: string
  msg: string
  shortStart: number
  shortEnd: number
  pairIndex: number
  taskKey: string
  status: 'success' | 'error'
}

function playRescanChime() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    const now = ctx.currentTime

    // Note 1 (C5 - 523.25Hz)
    const osc1 = ctx.createOscillator()
    const gain1 = ctx.createGain()
    osc1.type = 'sine'
    osc1.frequency.setValueAtTime(523.25, now)
    gain1.gain.setValueAtTime(0.12, now)
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3)
    osc1.connect(gain1)
    gain1.connect(ctx.destination)
    osc1.start(now)
    osc1.stop(now + 0.3)

    // Note 2 (G5 - 783.99Hz)
    const osc2 = ctx.createOscillator()
    const gain2 = ctx.createGain()
    osc2.type = 'sine'
    osc2.frequency.setValueAtTime(783.99, now + 0.12)
    gain2.gain.setValueAtTime(0.18, now + 0.12)
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.5)
    osc2.connect(gain2)
    gain2.connect(ctx.destination)
    osc2.start(now + 0.12)
    osc2.stop(now + 0.5)
  } catch {}
}

/** Side-by-side preview of matched windows with:
 *  - Non-blocking background rescan with clickable completion notification & jump back
 *  - Direct scene jump (type scene #, e.g. 61, or pick from searchable list)
 *  - Autoplay continuous playback mode with pause-anywhere capability
 *  - Buttery smooth video playback with micro-drift sync & DOM-ref progress tracking
 */
export function ComparePanel({ scan }: { scan: Scan }) {
  const { mutate } = useSWRConfig()
  const pairs = useMemo(() => {
    return resolveMainMatches(scan.matches || [])
  }, [scan.matches])

  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [autoplay, setAutoplay] = useState(false)
  const [playbackRate, setPlaybackRate] = useState<number>(1)
  const [candIdx, setCandIdx] = useState<number | null>(null)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [showConsole, setShowConsole] = useState(true)

  // Direct Jump controls
  const [jumpInput, setJumpInput] = useState(() => '1')
  const [showSceneList, setShowSceneList] = useState(false)
  const [sceneSearch, setSceneSearch] = useState('')

  // Persistent rescan task tracking keyed by `${shortStart.toFixed(1)}-${shortEnd.toFixed(1)}`
  const [rescanTasks, setRescanTasks] = useState<Record<string, RescanTaskState>>({})
  const [toastNotification, setToastNotification] = useState<ToastNotification | null>(null)

  const shortRef = useRef<HTMLVideoElement>(null)
  const movieRef = useRef<HTMLVideoElement>(null)
  const shortBarRef = useRef<HTMLDivElement>(null)
  const movieBarRef = useRef<HTMLDivElement>(null)
  const animFrameRef = useRef<number | null>(null)
  const isSeekingRef = useRef(false)
  const autoplayRef = useRef(false)
  autoplayRef.current = autoplay
  const playbackRateRef = useRef(1)
  playbackRateRef.current = playbackRate
  const pendingAutoPlayRef = useRef(false)
  const [audioTrack, setAudioTrack] = useState<'none' | 'short' | 'movie'>('none')

  // Stability & Self-healing Watchdog tracking
  const lastFingerprintRef = useRef<string>('')
  const sceneStartTimeRef = useRef<number>(0)
  const lastProgressCheckRef = useRef<{ shortTime: number; movieTime: number; timestamp: number } | null>(null)
  const firstEndedRef = useRef<{ who: 'short' | 'movie'; timestamp: number } | null>(null)

  const pair = pairs[Math.min(idx, Math.max(0, pairs.length - 1))]
  const pairShortStart = pair?.shortStart ?? 0
  const pairShortEnd = pair?.shortEnd ?? 0

  const options = useMemo(
    () => (pair ? candidateOptionsFor(scan, pairShortStart, pairShortEnd) : []),
    [scan, pair, pairShortStart, pairShortEnd],
  )
  const showChooser = hasAlternatives(options)
  const viewing = candIdx === null ? null : options[Math.min(candIdx, options.length - 1)]

  // Movie-side and short-side windows actually shown (candidate or the pair's own window).
  const movieStart = viewing ? viewing.movieStart : pair?.movieStart ?? 0
  const movieEnd = viewing ? viewing.movieEnd : pair?.movieEnd ?? 0
  const shortStart = viewing?.shortStart ?? pair?.shortStart ?? 0
  const shortEnd = viewing?.shortEnd ?? pair?.shortEnd ?? 0
  const shortDur = Math.max(0.1, shortEnd - shortStart)
  const movieDur = Math.max(0.1, movieEnd - movieStart)

  const isCurrentRescanned = !!(
    pair?.viaRescan ||
    pair?.origin === 'rescan' ||
    viewing?.viaRescan ||
    viewing?.origin === 'rescan'
  )

  // Keep index in range when pairs change between refreshes.
  useEffect(() => {
    if (idx > 0 && idx >= pairs.length) {
      setIdx(Math.max(0, pairs.length - 1))
    }
  }, [idx, pairs.length])

  // Sync jump input with current idx
  useEffect(() => {
    setJumpInput(String(idx + 1))
  }, [idx])

  // Leaving a pair always returns to its main window.
  useEffect(() => {
    setCandIdx(null)
  }, [idx, pairShortStart])

  // External jump to scene listener (e.g. from Batch Verifier "View" button)
  useEffect(() => {
    function handleJumpToScene(e: CustomEvent<{ shortStart?: number; shortEnd?: number; pairIndex?: number }>) {
      if (typeof e.detail?.pairIndex === 'number' && e.detail.pairIndex >= 0 && e.detail.pairIndex < pairs.length) {
        setIdx(e.detail.pairIndex)
        const el = document.getElementById('compare-panel')
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
      if (typeof e.detail?.shortStart === 'number') {
        const targetStart = e.detail.shortStart
        const targetEnd = e.detail.shortEnd
        const foundIdx = pairs.findIndex((p) =>
          (targetEnd !== undefined && sameShortSegment(p.shortStart, p.shortEnd, targetStart, targetEnd)) ||
          Math.abs(p.shortStart - targetStart) < 0.35 ||
          (p.shortStart <= targetStart + 0.1 && p.shortEnd >= targetStart - 0.1),
        )
        if (foundIdx !== -1) {
          setIdx(foundIdx)
          const el = document.getElementById('compare-panel')
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      }
    }

    window.addEventListener('jump-to-compare-scene', handleJumpToScene as EventListener)
    return () => {
      window.removeEventListener('jump-to-compare-scene', handleJumpToScene as EventListener)
    }
  }, [pairs])

  // Safe seek helper to prevent video decode lockup during rapid switching
  const safeSeek = useCallback((video: HTMLVideoElement | null, targetTime: number) => {
    if (!video) return
    try {
      if (Number.isFinite(targetTime) && targetTime >= 0) {
        if (video.readyState >= 1) {
          video.currentTime = targetTime
        } else {
          const onMeta = () => {
            try {
              video.currentTime = targetTime
            } catch {}
          }
          video.addEventListener('loadedmetadata', onMeta, { once: true })
        }
      }
    } catch {}
  }, [])

  // Start synchronized playback
  const startPlayback = useCallback(() => {
    const sv = shortRef.current
    const mv = movieRef.current
    if (!sv || !mv || !pair) return

    // Re-align to start if either has reached the end or is out of bounds
    if (sv.currentTime >= shortEnd - 0.05 || sv.currentTime < shortStart - 0.2) {
      try { sv.currentTime = shortStart } catch {}
    }
    if (mv.currentTime >= movieEnd - 0.05 || mv.currentTime < movieStart - 0.2) {
      try { mv.currentTime = movieStart } catch {}
    }

    sv.playbackRate = playbackRateRef.current
    mv.playbackRate = playbackRateRef.current
    sv.muted = audioTrack !== 'short'
    mv.muted = audioTrack !== 'movie'

    firstEndedRef.current = null
    sceneStartTimeRef.current = Date.now()

    const p1 = sv.play().catch(() => {})
    const p2 = mv.play().catch(() => {})
    void Promise.all([p1, p2]).then(() => {
      setPlaying(true)
    })
  }, [pair, shortStart, shortEnd, movieStart, movieEnd, audioTrack])

  // Reactively apply audio track mute states to existing video DOM instances
  useEffect(() => {
    const sv = shortRef.current
    const mv = movieRef.current
    if (sv) sv.muted = audioTrack !== 'short'
    if (mv) mv.muted = audioTrack !== 'movie'
  }, [audioTrack])

  // Pause playback cleanly and stop autoplay
  const pauseBoth = useCallback(() => {
    const sv = shortRef.current
    const mv = movieRef.current
    if (sv) sv.pause()
    if (mv) mv.pause()
    setPlaying(false)
    pendingAutoPlayRef.current = false
    firstEndedRef.current = null
  }, [])

  // Seek both players to window start whenever shown windows change
  useEffect(() => {
    if (!pair) return

    const fingerprint = `${idx}:${candIdx ?? 'main'}:${shortStart.toFixed(2)}:${movieStart.toFixed(2)}`

    // CRITICAL: Prevent SWR poll data refresh from resetting active playback!
    // If the scene coordinates haven't changed, do not disrupt current playback.
    if (lastFingerprintRef.current === fingerprint) {
      return
    }
    lastFingerprintRef.current = fingerprint

    isSeekingRef.current = true
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = null
    }

    const sv = shortRef.current
    const mv = movieRef.current
    safeSeek(sv, shortStart)
    safeSeek(mv, movieStart)
    if (shortBarRef.current) shortBarRef.current.style.width = '0%'
    if (movieBarRef.current) movieBarRef.current.style.width = '0%'

    firstEndedRef.current = null

    if (pendingAutoPlayRef.current && autoplayRef.current) {
      pendingAutoPlayRef.current = false

      // Synchronization barrier: wait for both videos to decode their seeked frames (or max 280ms)
      let settled = false
      const proceed = () => {
        if (settled) return
        settled = true
        startPlayback()
      }

      const timer = setTimeout(proceed, 280)

      const checkReady = () => {
        const sReady = !sv || (!sv.seeking && sv.readyState >= 2)
        const mReady = !mv || (!mv.seeking && mv.readyState >= 2)
        if (sReady && mReady) {
          clearTimeout(timer)
          proceed()
        }
      }

      if (sv) {
        sv.addEventListener('seeked', checkReady, { once: true })
        sv.addEventListener('canplay', checkReady, { once: true })
      }
      if (mv) {
        mv.addEventListener('seeked', checkReady, { once: true })
        mv.addEventListener('canplay', checkReady, { once: true })
      }
      checkReady()

      return () => {
        clearTimeout(timer)
      }
    } else {
      setPlaying(false)
    }
    isSeekingRef.current = false
  }, [idx, candIdx, shortStart, movieStart, pair, safeSeek, startPlayback])

  // High-frequency synchronized frame loop during playback (No React state re-render = 60fps smooth)
  useEffect(() => {
    if (!playing || !pair) {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
        animFrameRef.current = null
      }
      return
    }

    let isRunning = true
    const checkFrames = () => {
      if (!isRunning) return

      const sv = shortRef.current
      const mv = movieRef.current
      const baseSpeed = playbackRateRef.current

      let shortEnded = false
      let movieEnded = false

      if (sv) {
        const cur = sv.currentTime
        const rel = Math.max(0, cur - shortStart)
        const pct = Math.min(100, (rel / shortDur) * 100)
        if (shortBarRef.current) {
          shortBarRef.current.style.width = `${pct}%`
        }

        if (cur >= shortEnd - 0.04) {
          sv.pause()
          sv.currentTime = shortEnd
          shortEnded = true
        } else if (cur < shortStart - 0.5 && !sv.seeking) {
          try { sv.currentTime = shortStart } catch {}
        }
      } else {
        shortEnded = true
      }

      if (mv) {
        const cur = mv.currentTime
        const rel = Math.max(0, cur - movieStart)
        const pct = Math.min(100, (rel / movieDur) * 100)
        if (movieBarRef.current) {
          movieBarRef.current.style.width = `${pct}%`
        }

        if (cur >= movieEnd - 0.04) {
          mv.pause()
          mv.currentTime = movieEnd
          movieEnded = true
        } else if (cur < movieStart - 0.5 && !mv.seeking) {
          try { mv.currentTime = movieStart } catch {}
        }
      } else {
        movieEnded = true
      }

      // Record when one video reaches the cut earlier than the other
      if (shortEnded && !movieEnded) {
        if (!firstEndedRef.current) {
          firstEndedRef.current = { who: 'short', timestamp: Date.now() }
        }
      } else if (movieEnded && !shortEnded) {
        if (!firstEndedRef.current) {
          firstEndedRef.current = { who: 'movie', timestamp: Date.now() }
        }
      }

      // Micro-drift correction without choppy seeks (only when both actively playing)
      if (sv && mv && !sv.paused && !mv.paused && !shortEnded && !movieEnded && !sv.seeking && !mv.seeking) {
        const relShort = (sv.currentTime - shortStart) / shortDur
        const relMovie = (mv.currentTime - movieStart) / movieDur
        const drift = relShort - relMovie

        if (drift > 0.08) {
          mv.playbackRate = baseSpeed * 1.05
          sv.playbackRate = baseSpeed * 0.95
        } else if (drift < -0.08) {
          sv.playbackRate = baseSpeed * 1.05
          mv.playbackRate = baseSpeed * 0.95
        } else {
          if (sv.playbackRate !== baseSpeed) sv.playbackRate = baseSpeed
          if (mv.playbackRate !== baseSpeed) mv.playbackRate = baseSpeed
        }
      }

      // Robust clip completion detection:
      // Prevents hang if one video stalls near boundary or finishes slightly sooner
      const firstEndedDuration = firstEndedRef.current ? Date.now() - firstEndedRef.current.timestamp : 0
      const clipFinished =
        (shortEnded && movieEnded) ||
        (shortEnded && (mv ? mv.currentTime >= movieEnd - 0.15 || mv.paused || firstEndedDuration > 600 : true)) ||
        (movieEnded && (sv ? sv.currentTime >= shortEnd - 0.15 || sv.paused || firstEndedDuration > 600 : true))

      if (clipFinished) {
        if (autoplayRef.current) {
          pendingAutoPlayRef.current = true
          setIdx((cur) => (cur + 1) % pairs.length)
        } else {
          setPlaying(false)
        }
        return
      }

      animFrameRef.current = requestAnimationFrame(checkFrames)
    }

    animFrameRef.current = requestAnimationFrame(checkFrames)

    return () => {
      isRunning = false
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
        animFrameRef.current = null
      }
    }
  }, [playing, pair, shortStart, shortEnd, movieStart, movieEnd, shortDur, movieDur, pairs.length])

  // 1-Second Watchdog / Self-Healing Heartbeat ("refresh hota he har 1 sec me taki atke nhi")
  // Automatically detects decoder stalls, frozen frames, or hanging playback and self-heals
  useEffect(() => {
    const watchdog = setInterval(() => {
      if (!playing && !autoplayRef.current) return
      const sv = shortRef.current
      const mv = movieRef.current
      if (!sv || !mv || !pair) return

      const now = Date.now()
      const speed = playbackRateRef.current || 1
      const maxSceneDuration = Math.max(shortDur, movieDur) / speed

      // 1. Scene Max Duration Timeout Guard:
      // If a scene runs longer than its video duration + 2.2 seconds, automatically advance!
      if (sceneStartTimeRef.current > 0) {
        const elapsedSec = (now - sceneStartTimeRef.current) / 1000
        if (elapsedSec > maxSceneDuration + 2.2) {
          if (autoplayRef.current) {
            pendingAutoPlayRef.current = true
            setIdx((cur) => (cur + 1) % pairs.length)
            return
          } else {
            pauseBoth()
            return
          }
        }
      }

      // 2. Playback Stall & Unexpected Pause Auto-Recovery:
      if (playing) {
        const curShort = sv.currentTime
        const curMovie = mv.currentTime
        const shortNearEnd = curShort >= shortEnd - 0.15
        const movieNearEnd = curMovie >= movieEnd - 0.15

        // If both videos reached or passed near-end, advance
        if (shortNearEnd && movieNearEnd) {
          if (autoplayRef.current) {
            pendingAutoPlayRef.current = true
            setIdx((cur) => (cur + 1) % pairs.length)
            return
          }
        }

        // If either video was paused unexpectedly in mid-scene, kickstart it!
        if (sv.paused && !shortNearEnd && !sv.seeking) {
          void sv.play().catch(() => {})
        }
        if (mv.paused && !movieNearEnd && !mv.seeking) {
          void mv.play().catch(() => {})
        }

        // Progress check: compare with position 1s ago to detect decode freeze
        const lastCheck = lastProgressCheckRef.current
        if (lastCheck) {
          const svDelta = Math.abs(curShort - lastCheck.shortTime)
          const mvDelta = Math.abs(curMovie - lastCheck.movieTime)

          // If neither video moved by more than 0.03s in the last second while supposed to be playing
          if (svDelta < 0.03 && mvDelta < 0.03 && now - lastCheck.timestamp >= 1000) {
            if (shortNearEnd || movieNearEnd) {
              if (autoplayRef.current) {
                pendingAutoPlayRef.current = true
                setIdx((cur) => (cur + 1) % pairs.length)
                return
              }
            } else {
              void sv.play().catch(() => {})
              void mv.play().catch(() => {})
            }
          }
        }

        lastProgressCheckRef.current = {
          shortTime: curShort,
          movieTime: curMovie,
          timestamp: now,
        }
      }
    }, 1000)

    return () => clearInterval(watchdog)
  }, [playing, pair, shortDur, movieDur, shortEnd, movieEnd, pairs.length, pauseBoth])

  const togglePlay = useCallback(() => {
    if (playing) {
      pauseBoth()
      if (autoplay) setAutoplay(false)
    } else {
      startPlayback()
    }
  }, [playing, autoplay, pauseBoth, startPlayback])

  const toggleAutoplay = useCallback(() => {
    if (autoplay) {
      setAutoplay(false)
      pauseBoth()
    } else {
      setAutoplay(true)
      startPlayback()
    }
  }, [autoplay, pauseBoth, startPlayback])

  const changePlaybackRate = useCallback((speed: number) => {
    setPlaybackRate(speed)
    playbackRateRef.current = speed
    if (shortRef.current) shortRef.current.playbackRate = speed
    if (movieRef.current) movieRef.current.playbackRate = speed
  }, [])

  const restart = useCallback(() => {
    const sv = shortRef.current
    const mv = movieRef.current
    if (sv) {
      sv.pause()
      sv.currentTime = shortStart
    }
    if (mv) {
      mv.pause()
      mv.currentTime = movieStart
    }
    if (shortBarRef.current) shortBarRef.current.style.width = '0%'
    if (movieBarRef.current) movieBarRef.current.style.width = '0%'
    setPlaying(false)
  }, [shortStart, movieStart])

  // Fast match cycling helper (instant and responsive)
  const handleCycleMatch = useCallback((delta: number) => {
    if (pairs.length <= 1) return
    setIdx((cur) => (cur + delta + pairs.length) % pairs.length)
  }, [pairs.length])

  // Direct Jump application handler
  const applyJump = useCallback((val: string) => {
    const num = parseInt(val.trim(), 10)
    if (!isNaN(num) && pairs.length > 0) {
      const clamped = Math.max(0, Math.min(pairs.length - 1, num - 1))
      setIdx(clamped)
      setJumpInput(String(clamped + 1))
      setShowSceneList(false)
    } else {
      setJumpInput(String(idx + 1))
    }
  }, [pairs.length, idx])

  // Filtered scenes for the jump-to popover
  const filteredScenes = useMemo(() => {
    if (!sceneSearch.trim()) return pairs.map((p, i) => ({ pair: p, index: i }))
    const q = sceneSearch.toLowerCase().trim()
    return pairs
      .map((p, i) => ({ pair: p, index: i }))
      .filter(({ pair: p, index: i }) => {
        const numStr = String(i + 1)
        const shortStr = `${fmtTime(p.shortStart)} ${fmtTime(p.shortEnd)}`
        const movieStr = `${fmtTime(p.movieStart)} ${fmtTime(p.movieEnd)}`
        const chunkStr = `chunk ${p.chunkIndex}`
        const statusStr = p.batchVerified || (p.viaRescan ? 'rescan' : '')
        return (
          numStr.includes(q) ||
          shortStr.includes(q) ||
          movieStr.includes(q) ||
          chunkStr.includes(q) ||
          statusStr.includes(q)
        )
      })
  }, [pairs, sceneSearch])

  // Current scene task key
  const currentTaskKey = pair ? `${pair.shortStart.toFixed(1)}-${pair.shortEnd.toFixed(1)}` : ''
  const currentTask = currentTaskKey ? rescanTasks[currentTaskKey] : undefined
  const isCurrentRescanning =
    currentTask?.status === 'preparing' ||
    currentTask?.status === 'uploading' ||
    currentTask?.status === 'scanning' ||
    currentTask?.status === 'retrying'

  // All active background rescans
  const activeBackgroundTasks = useMemo(() => {
    return Object.values(rescanTasks).filter(
      (t) =>
        t.status === 'preparing' ||
        t.status === 'uploading' ||
        t.status === 'scanning' ||
        t.status === 'retrying',
    )
  }, [rescanTasks])

  // Jump to specific short segment scene
  const jumpToShortSegment = useCallback(
    (tShortStart: number, tShortEnd: number) => {
      const targetIdx = pairs.findIndex((p) =>
        sameShortSegment(p.shortStart, p.shortEnd, tShortStart, tShortEnd),
      )
      if (targetIdx !== -1) {
        setIdx(targetIdx)
      }
    },
    [pairs],
  )

  // Jump to scene from toast notification
  const jumpToToastScene = useCallback(() => {
    if (!toastNotification) return
    jumpToShortSegment(toastNotification.shortStart, toastNotification.shortEnd)
    setToastNotification(null)
  }, [toastNotification, jumpToShortSegment])

  // Targeted Rescan / Retry handler with Non-blocking execution
  async function handleRescanScene(chosenModel?: string) {
    if (!pair) return
    setShowModelPicker(false)

    const taskKey = `${pair.shortStart.toFixed(1)}-${pair.shortEnd.toFixed(1)}`
    const existing = rescanTasks[taskKey]
    if (
      existing?.status === 'preparing' ||
      existing?.status === 'uploading' ||
      existing?.status === 'scanning' ||
      existing?.status === 'retrying'
    ) {
      return // Already in flight for this scene
    }

    const pairIndex = idx
    const activeChunk = viewing ? viewing.chunkIndex : (pair.chunkIndex ?? Math.max(0, Math.floor((movieStart || 0) / 60)))
    const targetShortStart = pair.shortStart
    const targetShortEnd = pair.shortEnd
    const targetMovieStart = movieStart
    const targetMovieEnd = movieEnd

    const appendLog = (msg: string, type: RescanLogEntry['type'] = 'info') => {
      const time = new Date().toLocaleTimeString('en-US', { hour12: false })
      setRescanTasks((prev) => {
        const cur = prev[taskKey] || {
          taskKey,
          pairIndex,
          shortStart: targetShortStart,
          shortEnd: targetShortEnd,
          chunkIndex: activeChunk,
          status: 'preparing',
          progressMsg: 'Starting rescan...',
          attempt: 1,
          maxAttempts: 4,
          model: chosenModel,
          logs: [],
        }
        return {
          ...prev,
          [taskKey]: {
            ...cur,
            logs: [...cur.logs, { time, msg, type }],
          },
        }
      })
    }

    appendLog(
      `[Rescan Init] Short ${fmtTime(targetShortStart)}–${fmtTime(targetShortEnd)} | Movie chunk ${activeChunk + 1} | Model: ${chosenModel ? displayModelName(chosenModel) : 'Auto (First Available)'}`,
    )

    for (let attempt = 1; attempt <= 4; attempt++) {
      setRescanTasks((prev) => {
        const cur = prev[taskKey] || {
          taskKey,
          pairIndex,
          shortStart: targetShortStart,
          shortEnd: targetShortEnd,
          chunkIndex: activeChunk,
          status: 'preparing',
          progressMsg: '',
          attempt,
          maxAttempts: 4,
          model: chosenModel,
          logs: [],
        }
        return {
          ...prev,
          [taskKey]: {
            ...cur,
            status: attempt === 1 ? 'preparing' : 'retrying',
            attempt,
            maxAttempts: 4,
            progressMsg:
              attempt === 1
                ? 'Preparing short & movie chunk clips...'
                : `High demand / API error — Auto-retrying attempt ${attempt}/4...`,
          },
        }
      })

      if (attempt > 1) {
        appendLog(`[Attempt ${attempt}/4] High demand / rate limit backoff — waiting 3s before auto-retry...`, 'warn')
        await new Promise((r) => setTimeout(r, 3000))
      }

      appendLog(`[Attempt ${attempt}/4] Cutting Short clip ${fmtTime(targetShortStart)}–${fmtTime(targetShortEnd)} & Movie chunk ${activeChunk + 1}...`, 'info')

      setRescanTasks((prev) => ({
        ...prev,
        [taskKey]: {
          ...prev[taskKey]!,
          status: 'uploading',
          progressMsg: `Attempt ${attempt}/4: Uploading video clips to Gemini Files API...`,
        },
      }))
      appendLog(`[Attempt ${attempt}/4] Uploading video clips to Gemini Files API...`, 'info')

      setRescanTasks((prev) => ({
        ...prev,
        [taskKey]: {
          ...prev[taskKey]!,
          status: 'scanning',
          progressMsg: `Attempt ${attempt}/4: Requesting frame-precise scan on ${chosenModel ? displayModelName(chosenModel) : 'Gemini'}...`,
        },
      }))
      appendLog(`[Attempt ${attempt}/4] Calling Gemini AI for frame-precise rescan...`, 'info')

      try {
        const res = await fetch(`/api/scans/${scan.id}/rescan-scene`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shortStart: targetShortStart,
            shortEnd: targetShortEnd,
            chunkIndex: activeChunk,
            movieStart: targetMovieStart,
            movieEnd: targetMovieEnd,
            model: chosenModel || undefined,
          }),
        })

        const data = await res.json().catch(() => ({}))

        if (res.ok && data.ok) {
          appendLog(`✅ Rescan Successful! Found Movie ${fmtTime(data.movieStart)}–${fmtTime(data.movieEnd)} on ${displayModelName(data.model)}. Set as MAIN clip.`, 'success')

          setRescanTasks((prev) => ({
            ...prev,
            [taskKey]: {
              ...prev[taskKey]!,
              status: 'done',
              progressMsg: `Rescan Successful! Found Movie ${fmtTime(data.movieStart)}–${fmtTime(data.movieEnd)}`,
              result: { movieStart: data.movieStart, movieEnd: data.movieEnd, model: data.model },
            },
          }))

          playRescanChime()

          setToastNotification({
            id: `toast-${Date.now()}`,
            title: '✨ Rescan Successful!',
            msg: `Short ${fmtTime(targetShortStart)}–${fmtTime(targetShortEnd)} → Movie ${fmtTime(data.movieStart)}–${fmtTime(data.movieEnd)} (${displayModelName(data.model)})`,
            shortStart: targetShortStart,
            shortEnd: targetShortEnd,
            pairIndex,
            taskKey,
            status: 'success',
          })

          setCandIdx(null)
          await mutate(`/api/scans/${scan.id}`)
          return
        }

        const errStr = String(data.error || '').toLowerCase()
        const isRetryable =
          errStr.includes('high demand') ||
          errStr.includes('quota') ||
          errStr.includes('rate') ||
          errStr.includes('429') ||
          errStr.includes('503') ||
          errStr.includes('busy') ||
          res.status === 429 ||
          res.status === 503

        if (isRetryable && attempt < 4) {
          appendLog(`⚠️ Attempt ${attempt}/4 encountered high demand / rate limit: "${data.error || 'Server busy'}". Automatic retry ${attempt + 1}/4 scheduled.`, 'warn')
          continue
        } else {
          appendLog(`❌ Rescan failed (Attempt ${attempt}/4): ${data.error || 'No match found in chunk'}`, 'error')
          setRescanTasks((prev) => ({
            ...prev,
            [taskKey]: {
              ...prev[taskKey]!,
              status: 'error',
              progressMsg: `Rescan Failed: ${data.error || 'No match found'}`,
              errorMsg: data.error || 'No match found in chunk',
            },
          }))

          setToastNotification({
            id: `toast-${Date.now()}`,
            title: '⚠️ Rescan Finished: No Match',
            msg: `Short ${fmtTime(targetShortStart)}–${fmtTime(targetShortEnd)}: ${data.error || 'No match found in chunk'}`,
            shortStart: targetShortStart,
            shortEnd: targetShortEnd,
            pairIndex,
            taskKey,
            status: 'error',
          })
          return
        }
      } catch {
        if (attempt < 4) {
          appendLog(`⚠️ Attempt ${attempt}/4 network error. Scheduling automatic retry ${attempt + 1}/4...`, 'warn')
          continue
        } else {
          appendLog(`❌ Network error after 4 attempts.`, 'error')
          setRescanTasks((prev) => ({
            ...prev,
            [taskKey]: {
              ...prev[taskKey]!,
              status: 'error',
              progressMsg: 'Network error after 4 attempts',
              errorMsg: 'Network error after 4 attempts',
            },
          }))

          setToastNotification({
            id: `toast-${Date.now()}`,
            title: '❌ Rescan Network Error',
            msg: `Short ${fmtTime(targetShortStart)}–${fmtTime(targetShortEnd)}: Network error after 4 attempts`,
            shortStart: targetShortStart,
            shortEnd: targetShortEnd,
            pairIndex,
            taskKey,
            status: 'error',
          })
          return
        }
      }
    }
  }

  // Keyboard navigation for lightning-fast review
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        handleCycleMatch(-1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        handleCycleMatch(1)
      } else if (e.key === ' ' && !e.repeat) {
        e.preventDefault()
        togglePlay()
      } else if (e.key.toLowerCase() === 'a' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        toggleAutoplay()
      } else if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        restart()
      } else if (e.key === 'Escape') {
        setShowSceneList(false)
        setShowModelPicker(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleCycleMatch, togglePlay, toggleAutoplay, restart])

  if (!pair) return null

  const src = (kind: 'short' | 'movie') => `/api/scans/${scan.id}/media?kind=${kind}`

  return (
    <section id="compare-panel" aria-label="Side-by-side comparison" className="panel relative">
      {/* Top Header Bar */}
      <div className="flex flex-wrap items-center gap-2">
        <SplitSquareHorizontal className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Side-by-Side Match Comparison</h2>

        <span className="rounded-full bg-secondary px-2.5 py-0.5 font-mono text-xs font-medium">
          match {idx + 1} / {pairs.length}
        </span>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">
          {shortDur.toFixed(3)}s
        </span>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">
          chunk {viewing ? viewing.chunkIndex : pair.chunkIndex}
        </span>

        {/* Rescan Branding Badge */}
        {isCurrentRescanned && (
          <span className="flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-0.5 font-mono text-xs font-semibold text-indigo-400">
            <RotateCcw className="size-3 animate-spin-slow" aria-hidden />
            🔄 Rescanned (User Review)
          </span>
        )}

        {/* Active Background Rescan Pill */}
        {activeBackgroundTasks.length > 0 && (
          <button
            type="button"
            onClick={() => jumpToShortSegment(activeBackgroundTasks[0].shortStart, activeBackgroundTasks[0].shortEnd)}
            className="flex items-center gap-1.5 rounded-full border border-indigo-500/50 bg-indigo-500/15 px-2.5 py-0.5 font-mono text-xs font-semibold text-indigo-300 animate-pulse hover:bg-indigo-500/25 transition-colors cursor-pointer"
            title="Click to jump to active background rescan"
          >
            <RefreshCw className="size-3 animate-spin text-indigo-400" />
            <span>
              {activeBackgroundTasks.length === 1
                ? `Rescanning Short ${fmtTime(activeBackgroundTasks[0].shortStart)} (Attempt ${activeBackgroundTasks[0].attempt}/4)`
                : `${activeBackgroundTasks.length} Rescans running in background...`}
            </span>
          </button>
        )}

        {/* Batch Verifier Verdict Badge */}
        {pair.batchVerified === 'confirmed' && (
          <span className="flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-0.5 font-mono text-xs font-semibold text-emerald-400">
            <CheckCircle2 className="size-3" aria-hidden />
            Batch Verified: CONFIRMED
          </span>
        )}
        {pair.batchVerified === 'rejected' && (
          <span className="flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/15 px-2.5 py-0.5 font-mono text-xs font-semibold text-rose-400" title={pair.batchReason}>
            <AlertCircle className="size-3" aria-hidden />
            Batch Verifier: REJECTED (Rescan Required)
          </span>
        )}
        {!pair.verified && !pair.batchVerified && !pair.userPick && (
          <span className="rounded-full border border-amber-500/40 bg-amber-500/15 px-2.5 py-0.5 font-mono text-xs font-medium text-amber-400">
            Unconfirmed (Pending 24fps)
          </span>
        )}

        {showChooser && (
          <span className="rounded-full bg-primary/15 px-2.5 py-0.5 font-mono text-xs text-primary font-medium">
            {options.length} candidates
          </span>
        )}

        {pair.userPick && !viewing && !isCurrentRescanned && (
          <span className="rounded-full bg-success/15 px-2 py-0.5 font-mono text-xs text-success">
            your choice
          </span>
        )}

        {/* Fast Navigation & Direct Scene Jump Bar */}
        <div className="ml-auto flex flex-wrap items-center gap-1.5 sm:gap-2">
          {/* Prev Button (Never blocked by background rescan!) */}
          <button
            type="button"
            onClick={() => handleCycleMatch(-1)}
            disabled={pairs.length <= 1}
            className="flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary active:scale-95 disabled:opacity-40 cursor-pointer"
            title="Previous match (← Left Arrow)"
          >
            <ChevronLeft className="size-3.5" aria-hidden /> Prev
          </button>

          {/* Direct Scene Jump Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              applyJump(jumpInput)
            }}
            className="flex items-center gap-1 bg-secondary/50 rounded-md px-1.5 py-0.5 border border-border/50"
          >
            <span className="text-[11px] font-medium text-muted-foreground select-none">Scene</span>
            <input
              type="number"
              min={1}
              max={pairs.length}
              value={jumpInput}
              onChange={(e) => setJumpInput(e.target.value)}
              onBlur={() => applyJump(jumpInput)}
              className="w-12 rounded border border-input bg-card px-1 py-0.5 text-center font-mono text-xs font-bold text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              title="Type scene number (e.g. 61) and press Enter to jump directly"
            />
            <span className="font-mono text-xs text-muted-foreground select-none">/ {pairs.length}</span>
          </form>

          {/* Next Button (Never blocked by background rescan!) */}
          <button
            type="button"
            onClick={() => handleCycleMatch(1)}
            disabled={pairs.length <= 1}
            className="flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary active:scale-95 disabled:opacity-40 cursor-pointer"
            title="Next match (→ Right Arrow)"
          >
            Next <ChevronRight className="size-3.5" aria-hidden />
          </button>

          {/* Jump to Scene Popover Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowSceneList((prev) => !prev)}
              className={`flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                showSceneList
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-input bg-card text-muted-foreground hover:bg-secondary hover:text-foreground'
              }`}
              title="Browse and jump directly to any scene"
            >
              <ListFilter className="size-3.5" aria-hidden />
              <span>Jump ▾</span>
            </button>

            {/* Popover Menu */}
            {showSceneList && (
              <div className="absolute right-0 top-full mt-1.5 w-84 max-w-[90vw] rounded-xl border border-border bg-card/98 p-2.5 shadow-2xl backdrop-blur-md z-50 animate-in fade-in zoom-in-95">
                <div className="flex items-center justify-between border-b border-border/50 pb-2 mb-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <ListFilter className="size-4 text-primary" />
                    <span>Jump to Any Scene</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowSceneList(false)}
                    className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    ✕
                  </button>
                </div>

                {/* Search input */}
                <div className="relative mb-2">
                  <Search className="absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
                  <input
                    type="text"
                    value={sceneSearch}
                    onChange={(e) => setSceneSearch(e.target.value)}
                    placeholder="Filter scene # or timestamp (e.g. 61, 04:12)..."
                    className="w-full rounded-md border border-input bg-background/80 py-1.5 pl-8 pr-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    autoFocus
                  />
                </div>

                {/* Fast shortcuts */}
                <div className="flex items-center justify-between gap-1 mb-2">
                  <button
                    type="button"
                    onClick={() => applyJump('1')}
                    className="flex-1 rounded bg-secondary/80 py-1 text-[10px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors cursor-pointer text-center"
                  >
                    First (#1)
                  </button>
                  <button
                    type="button"
                    onClick={() => applyJump(String(Math.max(1, idx + 1 - 10)))}
                    className="flex-1 rounded bg-secondary/80 py-1 text-[10px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors cursor-pointer text-center"
                  >
                    -10 Scenes
                  </button>
                  <button
                    type="button"
                    onClick={() => applyJump(String(Math.min(pairs.length, idx + 1 + 10)))}
                    className="flex-1 rounded bg-secondary/80 py-1 text-[10px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors cursor-pointer text-center"
                  >
                    +10 Scenes
                  </button>
                  <button
                    type="button"
                    onClick={() => applyJump(String(pairs.length))}
                    className="flex-1 rounded bg-secondary/80 py-1 text-[10px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors cursor-pointer text-center"
                  >
                    Last (#{pairs.length})
                  </button>
                </div>

                {/* Scrollable scene list */}
                <div className="max-h-60 overflow-y-auto space-y-1 pr-1">
                  {filteredScenes.length === 0 ? (
                    <div className="py-4 text-center text-xs text-muted-foreground">
                      No scenes matched your search
                    </div>
                  ) : (
                    filteredScenes.map(({ pair: p, index: i }) => {
                      const isSelected = i === idx
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => {
                            setIdx(i)
                            setShowSceneList(false)
                          }}
                          className={`w-full flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-left transition-all cursor-pointer ${
                            isSelected
                              ? 'bg-primary/20 text-primary font-bold border border-primary/40'
                              : 'hover:bg-secondary text-foreground'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[11px] font-bold w-7 text-muted-foreground">
                              #{i + 1}
                            </span>
                            <div className="flex flex-col">
                              <span className="font-mono text-[11px]">
                                {fmtTime(p.shortStart)} – {fmtTime(p.shortEnd)}
                              </span>
                              <span className="font-mono text-[10px] text-muted-foreground">
                                Movie: {fmtTime(p.movieStart)} – {fmtTime(p.movieEnd)}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-1">
                            <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] font-mono text-muted-foreground">
                              c{p.chunkIndex}
                            </span>
                            {p.batchVerified === 'confirmed' ? (
                              <span className="rounded bg-emerald-500/20 text-emerald-400 px-1 py-0.5 text-[9px] font-semibold">
                                CONFIRMED
                              </span>
                            ) : p.batchVerified === 'rejected' ? (
                              <span className="rounded bg-rose-500/20 text-rose-400 px-1 py-0.5 text-[9px] font-semibold">
                                REJECTED
                              </span>
                            ) : p.viaRescan ? (
                              <span className="rounded bg-indigo-500/20 text-indigo-300 px-1 py-0.5 text-[9px] font-semibold">
                                RESCAN
                              </span>
                            ) : null}
                          </div>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Video Preview Grid with Hardware Decoded Smooth Playback */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:gap-3">
        {/* Short Video View */}
        <figure className="flex flex-col gap-1.5">
          <figcaption className="flex flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-foreground">Short video</span>
              {viewing && (Math.abs(viewing.shortStart - (pair?.shortStart ?? 0)) > 0.1 || Math.abs(viewing.shortEnd - (pair?.shortEnd ?? 0)) > 0.1) && (
                <span className="rounded bg-amber-500/20 px-1 py-0.2 text-[9px] font-mono font-medium text-amber-300">
                  CANDIDATE DURATION ({(shortEnd - shortStart).toFixed(1)}s)
                </span>
              )}
            </div>
            <span className="font-mono text-muted-foreground text-[11px]">
              {fmtTime(shortStart)} – {fmtTime(shortEnd)}
            </span>
          </figcaption>
          <div className="relative overflow-hidden rounded-md border border-border bg-black">
            <video
              ref={shortRef}
              src={src('short')}
              preload="metadata"
              muted={audioTrack !== 'short'}
              playsInline
              onLoadedMetadata={() => {
                if (shortRef.current) safeSeek(shortRef.current, shortStart)
              }}
              onWaiting={() => {
                // If waiting for buffer during playback, keep smooth state
              }}
              onError={() => {
                // Caught and handled safely by 1-second watchdog
              }}
              className="aspect-video w-full object-contain"
            />
            {/* Smooth hardware progress line (Direct DOM-ref update without 60fps React re-render) */}
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/10">
              <div
                ref={shortBarRef}
                className="h-full bg-primary"
                style={{ width: '0%' }}
              />
            </div>
          </div>
        </figure>

        {/* Movie Video View */}
        <figure className="flex flex-col gap-1.5">
          <figcaption className="flex flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-foreground">
                {viewing ? 'Movie — candidate' : isCurrentRescanned ? 'Movie — Rescanned' : 'Movie'}
              </span>
              {isCurrentRescanned && (
                <span className="rounded bg-indigo-500/20 px-1 py-0.2 text-[9px] font-mono font-medium text-indigo-300">
                  RESCAN
                </span>
              )}
            </div>
            <span className="font-mono text-muted-foreground text-[11px]">
              {fmtTime(movieStart)} – {fmtTime(movieEnd)}
            </span>
          </figcaption>
          <div className={`relative overflow-hidden rounded-md border bg-black ${viewing ? 'border-primary' : isCurrentRescanned ? 'border-indigo-500/60' : 'border-border'}`}>
            <video
              ref={movieRef}
              src={src('movie')}
              preload="metadata"
              muted={audioTrack !== 'movie'}
              playsInline
              onLoadedMetadata={() => {
                if (movieRef.current) safeSeek(movieRef.current, movieStart)
              }}
              onWaiting={() => {
                // If waiting for buffer during playback, keep smooth state
              }}
              onError={() => {
                // Caught and handled safely by 1-second watchdog
              }}
              className="aspect-video w-full object-contain"
            />
            {/* Smooth hardware progress line */}
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/10">
              <div
                ref={movieBarRef}
                className={`h-full ${isCurrentRescanned ? 'bg-indigo-400' : 'bg-primary'}`}
                style={{ width: '0%' }}
              />
            </div>
          </div>
        </figure>
      </div>

      {/* Batch Verifier Forensic Note */}
      {pair.batchReason && (
        <div className={`mt-2.5 rounded-md border px-3 py-2 text-xs flex items-start gap-2 ${
          pair.batchVerified === 'confirmed'
            ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300'
            : 'border-rose-500/30 bg-rose-500/5 text-rose-300'
        }`}>
          <span className="font-semibold text-foreground shrink-0">Batch Verifier:</span>
          <span>{pair.batchReason}</span>
        </div>
      )}

      {/* Candidate Chooser with full alternative list */}
      {showChooser && (
        <div className="mt-3">
          <CandidateChooser scan={scan} options={options} viewIdx={candIdx} onView={setCandIdx} />
        </div>
      )}

      {/* Live Rescan Terminal Log Console */}
      {currentTask && (
        <div className="mt-3 overflow-hidden rounded-lg border border-indigo-500/30 bg-black/90 p-3 shadow-lg font-mono text-xs text-foreground">
          <div className="flex items-center justify-between border-b border-border/40 pb-2 mb-2">
            <div className="flex flex-wrap items-center gap-2">
              <Terminal className="size-4 text-indigo-400" />
              <span className="font-semibold text-indigo-300">Rescan Live Console</span>
              <span className="rounded bg-indigo-500/20 px-2 py-0.5 text-[10px] text-indigo-300 border border-indigo-500/30">
                Attempt {currentTask.attempt}/{currentTask.maxAttempts}
              </span>
              {isCurrentRescanning ? (
                <span className="flex items-center gap-1.5 rounded-full bg-amber-500/20 text-amber-300 px-2.5 py-0.5 text-[10px] border border-amber-500/30 animate-pulse">
                  <RefreshCw className="size-3 animate-spin" />
                  {currentTask.status === 'retrying' ? 'High Demand Auto-Retry...' : 'Scanning Chunk...'}
                </span>
              ) : currentTask.status === 'done' ? (
                <span className="flex items-center gap-1 rounded-full bg-emerald-500/20 text-emerald-300 px-2.5 py-0.5 text-[10px] border border-emerald-500/30">
                  <CheckCircle2 className="size-3" /> Rescan Complete
                </span>
              ) : (
                <span className="flex items-center gap-1 rounded-full bg-rose-500/20 text-rose-300 px-2.5 py-0.5 text-[10px] border border-rose-500/30">
                  <AlertCircle className="size-3" /> Error Encountered
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowConsole((prev) => !prev)}
              className="text-[11px] font-sans text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              {showConsole ? 'Minimize Console ▲' : 'Expand Logs ▼'}
            </button>
          </div>

          <div className="text-[11px] text-indigo-200/90 mb-2 font-sans font-medium flex items-center justify-between">
            <span>{currentTask.progressMsg}</span>
            <span className="text-[10px] text-muted-foreground font-mono">
              Short {fmtTime(currentTask.shortStart)}–${fmtTime(currentTask.shortEnd)}
            </span>
          </div>

          {showConsole && (
            <div className="max-h-36 overflow-y-auto space-y-1 rounded bg-black/80 p-2 border border-white/5 font-mono text-[11px]">
              {currentTask.logs.map((l, i) => (
                <div key={i} className="flex items-start gap-2 leading-snug">
                  <span className="text-muted-foreground shrink-0 select-none">[{l.time}]</span>
                  <span
                    className={
                      l.type === 'success'
                        ? 'text-emerald-400 font-semibold'
                        : l.type === 'warn'
                        ? 'text-amber-300 font-medium'
                        : l.type === 'error'
                        ? 'text-rose-400 font-semibold'
                        : 'text-zinc-300'
                    }
                  >
                    {l.msg}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Bottom Action Controls */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* Play/Pause Button */}
        <button
          type="button"
          onClick={togglePlay}
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground shadow-sm transition-transform active:scale-95 cursor-pointer"
        >
          {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          {playing ? 'Pause both' : 'Play both'}
        </button>

        {/* Continuous Autoplay Mode Button */}
        <button
          type="button"
          onClick={toggleAutoplay}
          className={`flex items-center gap-1.5 rounded-md px-3.5 py-2 text-xs font-bold transition-all cursor-pointer shadow-sm ${
            autoplay
              ? 'bg-emerald-500 text-emerald-950 ring-2 ring-emerald-400 ring-offset-2 ring-offset-background animate-pulse'
              : 'border border-input bg-card text-foreground hover:bg-secondary'
          }`}
          title="Autoplay continuously: automatically moves to next scene when current clip ends. Click or press Space to pause anywhere!"
        >
          {autoplay ? <Pause className="size-3.5" aria-hidden /> : <FastForward className="size-3.5" aria-hidden />}
          <span>{autoplay ? 'Stop Autoplay' : 'Autoplay (Continuous)'}</span>
        </button>

        {/* Playback Speed Selector */}
        <div className="flex items-center rounded-md border border-input bg-card/70 p-0.5 text-xs">
          {([1, 1.25, 1.5] as const).map((spd) => (
            <button
              key={spd}
              type="button"
              onClick={() => changePlaybackRate(spd)}
              className={`rounded px-2 py-1 font-mono text-[11px] font-medium transition-colors cursor-pointer ${
                playbackRate === spd
                  ? 'bg-primary text-primary-foreground font-bold shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title={`Playback speed ${spd}x`}
            >
              {spd}x
            </button>
          ))}
        </div>

        {/* Audio Track Selector */}
        <div className="flex items-center rounded-md border border-input bg-card/70 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setAudioTrack('none')}
            className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
              audioTrack === 'none'
                ? 'bg-secondary text-foreground font-semibold shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            title="Mute both (safest for continuous autoplay)"
          >
            <VolumeX className="size-3" aria-hidden /> Mute
          </button>
          <button
            type="button"
            onClick={() => setAudioTrack('short')}
            className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
              audioTrack === 'short'
                ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            title="Listen to Short audio"
          >
            <Volume2 className="size-3" aria-hidden /> Short Audio
          </button>
          <button
            type="button"
            onClick={() => setAudioTrack('movie')}
            className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
              audioTrack === 'movie'
                ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            title="Listen to Movie audio"
          >
            <Volume2 className="size-3" aria-hidden /> Movie Audio
          </button>
        </div>

        {/* Restart Match Playback */}
        <button
          type="button"
          onClick={restart}
          className="flex items-center gap-1.5 rounded-md border border-input bg-card px-3 py-2 text-xs font-medium hover:bg-secondary transition-colors cursor-pointer"
          title="Restart playback from match start (R)"
        >
          <RotateCcw className="size-3.5" aria-hidden /> Restart
        </button>

        {/* Retry / Rescan Button with Model Selection (3.6, 3.7, 3.8) */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              if (isCurrentRescanning) return
              setShowModelPicker((prev) => !prev)
            }}
            disabled={isCurrentRescanning}
            className="flex items-center gap-1.5 rounded-md border border-indigo-500/50 bg-indigo-500/10 px-3.5 py-2 text-xs font-semibold text-indigo-300 hover:bg-indigo-500/20 active:scale-95 transition-all disabled:opacity-50 cursor-pointer"
            title="Rescan this scene with Gemini Models (3.6, 3.7, 3.8) & 4x auto-retry. Runs in background so you can continue reviewing!"
          >
            {isCurrentRescanning ? (
              <Loader2 className="size-3.5 animate-spin text-indigo-400" aria-hidden />
            ) : (
              <Sparkles className="size-3.5 text-indigo-400" aria-hidden />
            )}
            {isCurrentRescanning ? (
              <span>Rescanning (Attempt {currentTask?.attempt || 1}/4)...</span>
            ) : (
              <>
                <span>Rescan Scene (Retry)</span>
                <ChevronDown className="size-3 opacity-70" />
              </>
            )}
          </button>

          {/* Model Selection Menu */}
          {showModelPicker && !isCurrentRescanning && (
            <div className="absolute bottom-full left-0 mb-2 w-60 rounded-lg border border-indigo-500/30 bg-card/95 p-1.5 shadow-xl backdrop-blur-md z-50 animate-in fade-in zoom-in-95">
              <div className="px-2 py-1 text-[11px] font-semibold text-muted-foreground border-b border-border/50 mb-1 flex items-center justify-between">
                <span>Choose Rescan Model:</span>
                <button
                  type="button"
                  onClick={() => setShowModelPicker(false)}
                  className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  ✕
                </button>
              </div>
              <button
                type="button"
                onClick={() => void handleRescanScene('gemini-3.7-flash')}
                className="w-full flex items-center justify-between rounded px-2 py-1.5 text-xs text-foreground hover:bg-indigo-500/20 hover:text-indigo-300 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                  <span className="font-medium">Gemini 3.7 Flash</span>
                </div>
                <span className="text-[10px] text-muted-foreground">High Precision</span>
              </button>
              <button
                type="button"
                onClick={() => void handleRescanScene('gemini-3.8-flash')}
                className="w-full flex items-center justify-between rounded px-2 py-1.5 text-xs text-foreground hover:bg-indigo-500/20 hover:text-indigo-300 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan-400"></span>
                  <span className="font-medium">Gemini 3.8 Flash</span>
                </div>
                <span className="text-[10px] text-muted-foreground">Latest Gen</span>
              </button>
              <button
                type="button"
                onClick={() => void handleRescanScene('gemini-3.6-flash')}
                className="w-full flex items-center justify-between rounded px-2 py-1.5 text-xs text-foreground hover:bg-indigo-500/20 hover:text-indigo-300 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400"></span>
                  <span className="font-medium">Gemini 3.6 Flash</span>
                </div>
                <span className="text-[10px] text-muted-foreground">Fast Pool</span>
              </button>
              <div className="border-t border-border/40 my-1"></div>
              <button
                type="button"
                onClick={() => void handleRescanScene(undefined)}
                className="w-full flex items-center justify-between rounded px-2 py-1.5 text-xs text-foreground hover:bg-indigo-500/20 hover:text-indigo-300 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary"></span>
                  <span className="font-medium">Auto (First Free)</span>
                </div>
                <span className="text-[10px] text-muted-foreground">3.6 / 3.7 / 3.8</span>
              </button>
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {isCurrentRescanned && (
            <span className="rounded-full bg-indigo-500/10 border border-indigo-500/30 px-2 py-0.5 text-[10px] font-mono text-indigo-300">
              User Verified
            </span>
          )}
          <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs text-muted-foreground">
            {displayModelName(viewing ? viewing.model : pair.model)}
          </span>
        </div>
      </div>

      {/* Floating Bottom Clickable Toast Notification with Sound & Instant Jump Link */}
      {toastNotification && (
        <div className="fixed bottom-6 right-6 z-50 max-w-sm animate-in slide-in-from-bottom-5 fade-in duration-300">
          <div className="flex items-start gap-3 rounded-xl border border-indigo-500/50 bg-zinc-950/95 p-3.5 shadow-2xl backdrop-blur-md ring-1 ring-indigo-500/20">
            <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg border ${
              toastNotification.status === 'success'
                ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                : 'bg-amber-500/20 text-amber-400 border-amber-500/30'
            }`}>
              {toastNotification.status === 'success' ? (
                <Bell className="size-5 animate-bounce" />
              ) : (
                <AlertCircle className="size-5" />
              )}
            </div>
            <div className="flex-1 space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-foreground">{toastNotification.title}</p>
                <button
                  type="button"
                  onClick={() => setToastNotification(null)}
                  className="text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <p className="text-xs text-muted-foreground leading-snug">{toastNotification.msg}</p>
              <button
                type="button"
                onClick={jumpToToastScene}
                className="mt-1.5 flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-500 active:scale-95 transition-all cursor-pointer shadow-md"
              >
                <span>Jump to Rescanned Scene</span>
                <ChevronRight className="size-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
