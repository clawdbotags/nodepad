import { NextResponse } from "next/server"

// Same Whisper endpoint Matrix voice transcription uses.
// Env-overridable so this can move to a different AI server without a redeploy.
const WHISPER_API_URL =
  process.env.WHISPER_API_URL || "http://100.95.37.85:8080/v1/audio/transcriptions"
const WHISPER_MODEL =
  process.env.WHISPER_MODEL || "Systran/faster-whisper-large-v3"

export const runtime = "nodejs"
// Audio uploads can take a few seconds; don't let the platform kill the
// connection while Whisper is grinding through a 30-second clip.
export const maxDuration = 60

export async function POST(req: Request) {
  try {
    const inForm = await req.formData()
    const audio = inForm.get("audio")
    if (!(audio instanceof Blob)) {
      return NextResponse.json({ error: "no audio file" }, { status: 400 })
    }
    if (audio.size === 0) {
      return NextResponse.json({ error: "empty audio" }, { status: 400 })
    }
    if (audio.size > 25 * 1024 * 1024) {
      return NextResponse.json({ error: "audio too large (>25MB)" }, { status: 413 })
    }

    // Browser MediaRecorder defaults to webm/opus on Chrome/Edge and mp4 on
    // Safari. faster-whisper-server (which uses ffmpeg) accepts both. Pass
    // through the original mime + a sensible filename so the server can demux.
    const mime = (audio as any).type || "audio/webm"
    const ext =
      mime.includes("mp4") ? "mp4"
      : mime.includes("ogg") ? "ogg"
      : mime.includes("wav") ? "wav"
      : mime.includes("mpeg") ? "mp3"
      : "webm"

    const outForm = new FormData()
    outForm.append("file", audio, `voice.${ext}`)
    outForm.append("model", WHISPER_MODEL)
    outForm.append("response_format", "json")

    const t0 = Date.now()
    const upstream = await fetch(WHISPER_API_URL, {
      method: "POST",
      body: outForm,
    })
    const elapsed = Date.now() - t0

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "")
      return NextResponse.json(
        { error: `whisper ${upstream.status}: ${text.slice(0, 300)}` },
        { status: 502 }
      )
    }

    const data = await upstream.json().catch(() => ({} as any))
    const transcript = typeof data?.text === "string" ? data.text.trim() : ""
    return NextResponse.json({ text: transcript, elapsed_ms: elapsed, model: WHISPER_MODEL })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "transcribe failed" }, { status: 500 })
  }
}
