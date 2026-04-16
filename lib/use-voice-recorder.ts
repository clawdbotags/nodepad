"use client"

import { useCallback, useRef, useState } from "react"

type Options = {
  /** Called with the transcribed text when recording stops + Whisper succeeds. */
  onTranscript: (text: string) => void
  /** Called for non-fatal status messages (mic-error, "too short", etc). */
  onError?: (msg: string) => void
}

/**
 * Browser MediaRecorder → /api/transcribe → callback. Encapsulates:
 * - secure-context detection (gives a useful HTTPS-needed error)
 * - mime-type negotiation (webm/opus on Chromium, mp4 on Safari)
 * - mic stream cleanup so the browser's "in use" indicator clears
 * - "too short" / "nothing transcribed" guards
 *
 * Exposes recording / transcribing booleans so the caller can render a
 * pulsing dot or disable the button accordingly.
 */
export function useVoiceRecorder({ onTranscript, onError }: Options) {
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  const stopStream = useCallback(() => {
    const s = streamRef.current
    if (s) {
      for (const t of s.getTracks()) t.stop()
      streamRef.current = null
    }
  }, [])

  const stop = useCallback(() => {
    const r = recorderRef.current
    if (r && r.state !== "inactive") r.stop()
  }, [])

  const start = useCallback(async () => {
    if (recording || transcribing) return
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      const insecure = typeof window !== "undefined" && !window.isSecureContext
      onError?.(
        insecure
          ? "Voice needs HTTPS — open the https:// URL"
          : "Voice input not supported in this browser"
      )
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/ogg;codecs=opus",
      ]
      let mime = ""
      for (const c of candidates) {
        if ((window as any).MediaRecorder?.isTypeSupported?.(c)) {
          mime = c
          break
        }
      }
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = e => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = async () => {
        stopStream()
        recorderRef.current = null
        setRecording(false)
        const chunks = chunksRef.current
        chunksRef.current = []
        if (chunks.length === 0) return
        const blob = new Blob(chunks, { type: chunks[0].type || mime || "audio/webm" })
        if (blob.size < 800) {
          onError?.("Recording too short")
          return
        }
        setTranscribing(true)
        try {
          const fd = new FormData()
          fd.append("audio", blob, `voice.${(blob.type.split("/")[1] || "webm").split(";")[0]}`)
          const res = await fetch("/api/transcribe", { method: "POST", body: fd })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(data?.error || `transcribe ${res.status}`)
          const text = String(data?.text || "").trim()
          if (!text) {
            onError?.("Nothing transcribed")
            return
          }
          onTranscript(text)
        } catch (e: any) {
          onError?.(`Transcribe error: ${e.message}`)
        } finally {
          setTranscribing(false)
        }
      }
      recorderRef.current = rec
      rec.start()
      setRecording(true)
    } catch (e: any) {
      onError?.(`Mic error: ${e.message}`)
      setRecording(false)
      stopStream()
    }
  }, [recording, transcribing, onTranscript, onError, stopStream])

  const toggle = useCallback(() => {
    if (recording) stop()
    else start()
  }, [recording, start, stop])

  return { recording, transcribing, start, stop, toggle }
}
