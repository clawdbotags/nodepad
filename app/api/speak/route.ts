import { NextResponse } from "next/server"

/**
 * Text-to-speech proxy. Calls Kokoro-FastAPI (OpenAI-compatible /v1/audio/speech)
 * running on the AI server, streams the resulting MP3 back to the browser.
 *
 * Used by Drive Mode to read back the augment diff so the user can hear what
 * the canvas just did without taking eyes off the road.
 *
 * Env-overridable: TTS_API_URL, TTS_MODEL, TTS_VOICE.
 */
const TTS_API_URL =
  process.env.TTS_API_URL || "http://100.95.37.85:8880/v1/audio/speech"
const TTS_MODEL = process.env.TTS_MODEL || "kokoro"
const TTS_VOICE = process.env.TTS_VOICE || "af_heart"

export const runtime = "nodejs"
export const maxDuration = 30

type SpeakBody = {
  text?: string
  voice?: string
  speed?: number
  format?: "mp3" | "wav" | "opus" | "flac" | "aac" | "pcm"
}

export async function POST(req: Request) {
  let body: SpeakBody
  try {
    body = (await req.json()) as SpeakBody
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 })
  }

  const text = String(body?.text || "").trim()
  if (!text) return NextResponse.json({ error: "no text" }, { status: 400 })
  // Cap utterance length — driving rundowns should be one sentence, max 2.
  if (text.length > 2000) {
    return NextResponse.json({ error: "text too long (>2000 chars)" }, { status: 413 })
  }

  const voice = body.voice || TTS_VOICE
  const format = body.format || "mp3"
  const speed = typeof body.speed === "number" ? body.speed : 1.0

  const t0 = Date.now()
  let upstream: Response
  try {
    upstream = await fetch(TTS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TTS_MODEL,
        input: text,
        voice,
        response_format: format,
        speed,
      }),
    })
  } catch (e: any) {
    return NextResponse.json(
      { error: `tts upstream: ${e?.message || "unreachable"}` },
      { status: 502 }
    )
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "")
    return NextResponse.json(
      { error: `tts ${upstream.status}: ${errText.slice(0, 300)}` },
      { status: 502 }
    )
  }

  const audio = await upstream.arrayBuffer()
  const elapsed = Date.now() - t0

  const mime =
    format === "wav" ? "audio/wav"
    : format === "opus" ? "audio/opus"
    : format === "flac" ? "audio/flac"
    : format === "aac" ? "audio/aac"
    : format === "pcm" ? "audio/pcm"
    : "audio/mpeg"

  return new Response(audio, {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Cache-Control": "no-store",
      "X-TTS-Elapsed-Ms": String(elapsed),
      "X-TTS-Voice": voice,
      "X-TTS-Model": TTS_MODEL,
    },
  })
}
