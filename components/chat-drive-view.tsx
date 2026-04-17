"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useVoiceRecorder } from "@/lib/use-voice-recorder"

/**
 * Chat Drive Mode — voice-first agent chat for driving.
 *
 * Flow:
 *   1. Tap big button to start recording. Silent-loop audio engages so the
 *      car shows the session as a call, and so BT / Android Auto / headset
 *      media-key events route to us via MediaSession.
 *   2. User speaks their request.
 *   3. User signals done — tap anywhere on overlay, OR car "end call" /
 *      steering-wheel BT button (fires MediaSession pause/stop).
 *   4. Silent loop IMMEDIATELY releases. Music resumes on the car. In the
 *      background: whisper transcribe → POST to Matrix room → wait.
 *   5. While waiting for the agent to reply, there's NO active audio
 *      session — user listens to music unimpeded.
 *   6. When an agent reply arrives (non-self m.text event), start a
 *      5-second quiet-timer. Coalesce subsequent messages into one reply.
 *   7. When quiet-timer fires: TTS the concatenated body. This briefly
 *      ducks the music while the reply plays, then music returns.
 *   8. After TTS ends: "ready" — tap once to start the next turn.
 *
 * Contrast with the canvas Drive Mode: that one keeps the silent loop ON
 * continuously so slap-anywhere works for every turn. This one CANNOT
 * because the user explicitly wants music between turns. The trade-off:
 * between recording and the next tap, BT buttons won't route to us —
 * user must tap the screen to rearm. Acceptable since the waiting phase
 * is agent-driven and the user isn't trying to cancel it.
 */

const CHAT_DRIVE_SILENT_LOOP_SRC =
  "data:audio/wav;base64,UklGRmQGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YUAGAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA"

type Props = {
  roomId: string
  roomName: string
  me: string | null
  onClose: () => void
}

type Phase = "idle" | "recording" | "processing" | "waiting" | "speaking" | "error" | "ready"

type MsgEvent = {
  id: string
  sender: string
  body: string
  ts: number
  msgtype: string
}

type SyncResp = {
  next_batch: string
  me: string | null
  rooms: Array<{
    id: string
    name: string
    timeline: MsgEvent[]
  }>
}

const QUIET_MS = 5000        // how long after last reply event before TTS fires
const HARD_TIMEOUT_MS = 180000 // 3 min cap on waiting for agent reply

export function ChatDriveView({ roomId, roomName, me, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("idle")
  const [lastHeard, setLastHeard] = useState("")
  const [lastReplyPreview, setLastReplyPreview] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [audioStatus, setAudioStatus] = useState("")
  const [turnCount, setTurnCount] = useState(0)

  // Silent loop (only during recording)
  const silentRef = useRef<HTMLAudioElement | null>(null)
  // Latest-handleTap ref for MediaSession dispatch
  const handleTapRef = useRef<() => void>(() => {})

  // TTS playback
  const audioCtxRef = useRef<AudioContext | null>(null)
  const audioSrcRef = useRef<AudioBufferSourceNode | null>(null)

  // Reply collection
  const sinceRef = useRef<string | null>(null)
  const pollControllerRef = useRef<AbortController | null>(null)
  const collectedRef = useRef<string[]>([])
  const quietTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hardTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const waitingRef = useRef<boolean>(false)
  const meRef = useRef<string | null>(me)
  useEffect(() => { meRef.current = me }, [me])

  // ── Audio session engage/release ────────────────────────────────────────
  const engageSession = useCallback(async () => {
    const silent = silentRef.current
    if (silent) {
      silent.loop = true
      silent.volume = 0.001
      try { await silent.play() } catch (e: any) {
        console.warn("[chat-drive] silent loop play rejected:", e?.message)
      }
    }
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      const ms = navigator.mediaSession
      try {
        ms.metadata = new (window as any).MediaMetadata({
          title: `Chat: ${roomName}`,
          artist: "Nodepad",
          album: "Voice agent",
        })
      } catch {}
      try { ms.playbackState = "playing" } catch {}
      const dispatch = () => { try { handleTapRef.current?.() } catch {} }
      for (const action of ["play", "pause", "stop", "nexttrack", "previoustrack"] as const) {
        try { ms.setActionHandler(action, dispatch) } catch {}
      }
    }
  }, [roomName])

  const releaseSession = useCallback(() => {
    const silent = silentRef.current
    if (silent) {
      try { silent.pause(); silent.currentTime = 0 } catch {}
    }
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      const ms = navigator.mediaSession
      for (const action of ["play", "pause", "stop", "nexttrack", "previoustrack"] as const) {
        try { ms.setActionHandler(action, null) } catch {}
      }
      try { ms.playbackState = "none" } catch {}
      try { ms.metadata = null } catch {}
    }
  }, [])

  // ── Voice recorder ──────────────────────────────────────────────────────
  const voice = useVoiceRecorder({
    onTranscript: text => {
      setLastHeard(text)
      sendToMatrix(text)
    },
    onError: msg => {
      console.warn("[chat-drive] voice error:", msg)
      setError(msg)
      releaseSession()
      setPhase("error")
    },
  })
  const voiceRef = useRef(voice)
  useEffect(() => { voiceRef.current = voice }, [voice])

  // ── Send transcript to Matrix ───────────────────────────────────────────
  const sendToMatrix = useCallback(async (text: string) => {
    setPhase("processing")
    setAudioStatus("sending…")
    try {
      // First snapshot /sync so we have a `since` token that's strictly
      // AFTER the user's message lands. Any replies we see with the next
      // poll are new.
      const preRes = await fetch("/api/matrix/sync")
      const preData = (await preRes.json()) as SyncResp & { error?: string }
      if (preData.error) throw new Error(preData.error)
      sinceRef.current = preData.next_batch

      const res = await fetch(`/api/matrix/rooms/${encodeURIComponent(roomId)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `send ${res.status}`)

      setAudioStatus("waiting for reply…")
      setPhase("waiting")
      setTurnCount(c => c + 1)
      startReplyPoll()
    } catch (e: any) {
      setError(`Send failed: ${e?.message || e}`)
      setPhase("error")
    }
  }, [roomId])

  // ── Reply polling + quiet-window ────────────────────────────────────────
  const onQuietFired = useCallback(async () => {
    // Combine collected replies and TTS them as one utterance. Cancel
    // hard-timeout, stop polling, play audio.
    if (hardTimeoutRef.current) { clearTimeout(hardTimeoutRef.current); hardTimeoutRef.current = null }
    pollControllerRef.current?.abort()
    waitingRef.current = false
    const combined = collectedRef.current.join("\n\n").trim()
    collectedRef.current = []
    if (!combined) {
      // Nothing came in (shouldn't happen — quiet fires only after first event)
      setPhase("ready")
      setAudioStatus("")
      return
    }
    setLastReplyPreview(combined)
    setPhase("speaking")
    setAudioStatus("tts…")
    try {
      const speakRes = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: combined.length > 1500 ? combined.slice(0, 1500) + "…" : combined,
          format: "mp3",
        }),
      })
      if (!speakRes.ok) throw new Error(`tts ${speakRes.status}`)
      const buf = await speakRes.arrayBuffer()
      // Engage MediaSession for the duration of TTS so BT pause can skip.
      await engageSession()
      if (!audioCtxRef.current) {
        const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext
        if (Ctor) audioCtxRef.current = new Ctor()
      }
      const ctx = audioCtxRef.current
      if (!ctx) throw new Error("no audio context")
      if (ctx.state === "suspended") await ctx.resume()
      const decoded = await ctx.decodeAudioData(buf.slice(0))
      try { audioSrcRef.current?.stop() } catch {}
      const src = ctx.createBufferSource()
      src.buffer = decoded
      src.connect(ctx.destination)
      src.onended = () => {
        releaseSession()
        setPhase("ready")
        setAudioStatus("")
      }
      src.start(0)
      audioSrcRef.current = src
      setAudioStatus(`▶ ${decoded.duration.toFixed(1)}s`)
    } catch (e: any) {
      console.warn("[chat-drive] tts failed:", e)
      setError(`TTS error: ${e?.message || e}`)
      releaseSession()
      setPhase("ready")
      setAudioStatus("")
    }
  }, [engageSession, releaseSession])

  const onQuietFiredRef = useRef(onQuietFired)
  useEffect(() => { onQuietFiredRef.current = onQuietFired }, [onQuietFired])

  const startReplyPoll = useCallback(() => {
    waitingRef.current = true
    collectedRef.current = []
    if (quietTimerRef.current) { clearTimeout(quietTimerRef.current); quietTimerRef.current = null }
    if (hardTimeoutRef.current) clearTimeout(hardTimeoutRef.current)
    hardTimeoutRef.current = setTimeout(() => {
      if (!waitingRef.current) return
      waitingRef.current = false
      pollControllerRef.current?.abort()
      // Fire whatever we have (possibly nothing) — but if nothing, show error.
      if (collectedRef.current.length === 0) {
        setError("Agent didn't reply within 3 minutes")
        setPhase("ready")
        setAudioStatus("")
      } else {
        onQuietFiredRef.current?.()
      }
    }, HARD_TIMEOUT_MS)
    ;(async () => {
      while (waitingRef.current) {
        const since = sinceRef.current
        if (!since) break
        pollControllerRef.current = new AbortController()
        try {
          const q = new URLSearchParams({ since, timeout: "25000" })
          const res = await fetch(`/api/matrix/sync?${q}`, { signal: pollControllerRef.current.signal })
          if (!waitingRef.current) break
          const data = (await res.json()) as SyncResp & { error?: string }
          if (data.error) {
            await new Promise(r => setTimeout(r, 2000))
            continue
          }
          sinceRef.current = data.next_batch
          const room = data.rooms.find(r => r.id === roomId)
          const newText = (room?.timeline || []).filter(e =>
            e.msgtype === "m.text" && e.sender !== meRef.current
          )
          if (newText.length > 0) {
            for (const m of newText) collectedRef.current.push(m.body)
            if (quietTimerRef.current) clearTimeout(quietTimerRef.current)
            quietTimerRef.current = setTimeout(() => {
              if (!waitingRef.current) return
              onQuietFiredRef.current?.()
            }, QUIET_MS)
          }
        } catch (e: any) {
          if (e.name === "AbortError") break
          await new Promise(r => setTimeout(r, 2000))
        }
      }
    })()
  }, [roomId])

  // ── Tap handler — unified state transitions ─────────────────────────────
  const handleTap = useCallback(async () => {
    if (phase === "idle" || phase === "ready" || phase === "error") {
      // Start a new turn. Engage audio session so car routes BT buttons
      // to us. Start the recorder inside this user gesture.
      setError(null)
      setLastHeard("")
      setLastReplyPreview("")
      setAudioStatus("recording")
      await engageSession()
      setPhase("recording")
      setTimeout(() => { voiceRef.current?.start() }, 80)
      return
    }
    if (phase === "recording") {
      // Stop recording. Release audio session so music returns on the car.
      // The recorder's onTranscript will kick off sendToMatrix → waiting.
      setAudioStatus("processing…")
      voiceRef.current?.stop()
      releaseSession()
      return
    }
    if (phase === "speaking") {
      // Skip the TTS. Go straight to ready.
      try { audioSrcRef.current?.stop() } catch {}
      releaseSession()
      setPhase("ready")
      setAudioStatus("")
      return
    }
    // processing / waiting → tap is ignored (we don't want to cancel the
    // agent mid-response). To exit, the close button is still available.
  }, [phase, engageSession, releaseSession])

  useEffect(() => { handleTapRef.current = handleTap }, [handleTap])

  // ── Cleanup on unmount ──────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      waitingRef.current = false
      pollControllerRef.current?.abort()
      if (quietTimerRef.current) clearTimeout(quietTimerRef.current)
      if (hardTimeoutRef.current) clearTimeout(hardTimeoutRef.current)
      try { audioSrcRef.current?.stop() } catch {}
      try { voiceRef.current?.stop() } catch {}
      releaseSession()
    }
  }, [releaseSession])

  const handleClose = useCallback(() => {
    waitingRef.current = false
    pollControllerRef.current?.abort()
    if (quietTimerRef.current) clearTimeout(quietTimerRef.current)
    if (hardTimeoutRef.current) clearTimeout(hardTimeoutRef.current)
    try { audioSrcRef.current?.stop() } catch {}
    try { voiceRef.current?.stop() } catch {}
    releaseSession()
    onClose()
  }, [releaseSession, onClose])

  // ── UI ──────────────────────────────────────────────────────────────────
  const phaseLabel = (() => {
    switch (phase) {
      case "idle": return "Tap to talk"
      case "ready": return "Tap for next turn"
      case "recording": return "Listening"
      case "processing": return "Sending"
      case "waiting": return "Agent thinking"
      case "speaking": return "Playing reply"
      case "error": return "Error · tap to retry"
    }
  })()

  const hintLabel = (() => {
    switch (phase) {
      case "idle":
      case "ready":
      case "error":
        return "Tap anywhere · Headset / BT button"
      case "recording":
        return "Tap anywhere · End call button"
      case "processing":
      case "waiting":
        return "Music plays — reply will come as voice"
      case "speaking":
        return "Tap anywhere to skip"
    }
  })()

  const bigColor = (() => {
    switch (phase) {
      case "recording":
        return "bg-red-500/90 shadow-[0_0_60px_-10px_rgba(239,68,68,0.85)]"
      case "processing":
      case "waiting":
        return "bg-amber-500/80"
      case "speaking":
        return "bg-emerald-500/90 shadow-[0_0_60px_-10px_rgba(16,185,129,0.85)]"
      case "error":
        return "bg-orange-500/90"
      default:
        return "bg-primary/80 shadow-[0_0_40px_-10px_rgba(255,255,255,0.4)]"
    }
  })()

  return (
    <>
      {/* Silent audio — always mounted (even when not engaged) so the ref
          is live at the instant engageSession() calls .play(). */}
      <audio
        ref={silentRef}
        src={CHAT_DRIVE_SILENT_LOOP_SRC}
        loop
        playsInline
        preload="auto"
        aria-hidden="true"
        style={{ display: "none" }}
      />
      <div
        data-testid="chat-drive-overlay"
        onClick={handleTap}
        role="button"
        tabIndex={-1}
        className="fixed inset-0 z-[85] flex flex-col items-center justify-between bg-black/95 backdrop-blur-2xl px-4 py-8 select-none cursor-pointer"
      >
        {/* Top bar */}
        <div className="w-full flex items-center justify-between">
          <div className="flex flex-col min-w-0">
            <span className="font-mono text-xs font-bold uppercase tracking-[0.25em] text-white/85">
              Chat Drive
            </span>
            <span className="font-mono text-[10px] text-white/50 truncate">
              {roomName}
            </span>
          </div>
          <button
            data-testid="chat-drive-close"
            onClick={e => { e.stopPropagation(); handleClose() }}
            className="flex items-center justify-center h-11 w-11 rounded-sm border border-white/15 bg-white/[0.05] hover:bg-white/[0.1] text-white/85 transition-colors"
            aria-label="Exit Chat Drive"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Center */}
        <div className="flex flex-1 flex-col items-center justify-center gap-8 w-full">
          <div className="font-mono text-[11px] font-bold uppercase tracking-[0.4em] text-white/55 text-center">
            {phaseLabel}
          </div>
          <button
            data-testid="chat-drive-button"
            onClick={e => { e.stopPropagation(); handleTap() }}
            disabled={phase === "processing" || phase === "waiting"}
            className={`relative flex items-center justify-center rounded-full transition-all active:scale-[0.96] ${bigColor}`}
            style={{ width: "min(72vw, 240px)", height: "min(72vw, 240px)" }}
            aria-label="Chat Drive action button"
          >
            {phase === "recording" && (
              <span className="absolute inset-0 rounded-full bg-red-400/40 animate-ping" />
            )}
            {phase === "speaking" && (
              <span className="absolute inset-0 rounded-full bg-emerald-400/40 animate-ping" />
            )}
            {phase === "processing" || phase === "waiting" ? (
              <svg className="animate-spin" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-6.2-8.55" />
              </svg>
            ) : phase === "speaking" ? (
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 5L6 9H2v6h4l5 4V5z" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
            ) : (
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="2" width="6" height="13" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0" />
                <line x1="12" y1="18" x2="12" y2="22" />
              </svg>
            )}
          </button>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-white/40 text-center max-w-[88vw]">
            {hintLabel}
          </div>
        </div>

        {/* Bottom — transcripts */}
        <div className="w-full flex flex-col items-center gap-2">
          {lastHeard && (
            <div className="w-full max-w-[600px] rounded-sm border border-amber-400/20 bg-amber-400/[0.04] px-4 py-2 font-mono text-[13px] leading-snug text-amber-200/90 text-center">
              <span className="opacity-60">said: </span>
              &ldquo;{lastHeard}&rdquo;
            </div>
          )}
          {lastReplyPreview && (
            <div className="min-h-[48px] w-full max-w-[600px] rounded-sm border border-emerald-400/25 bg-emerald-400/[0.04] px-4 py-2 font-mono text-[13px] leading-snug text-emerald-100/90 text-center whitespace-pre-wrap">
              {lastReplyPreview.length > 400 ? lastReplyPreview.slice(0, 400) + "…" : lastReplyPreview}
            </div>
          )}
          {audioStatus && (
            <div className="font-mono text-[10px] tracking-[0.1em] text-emerald-300/70">
              {audioStatus}
            </div>
          )}
          {error && (
            <div className="font-mono text-[10px] tracking-[0.1em] text-red-300/80 text-center max-w-[88vw]">
              {error}
            </div>
          )}
          <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/35">
            {turnCount > 0 ? `${turnCount} turn${turnCount === 1 ? "" : "s"}` : "Ready"}
          </div>
        </div>
      </div>
    </>
  )
}
