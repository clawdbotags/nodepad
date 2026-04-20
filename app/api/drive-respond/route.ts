import { NextResponse } from "next/server"
import { getSettings } from "@/lib/server/db"
import { decrypt, isSensitiveKey } from "@/lib/server/crypto"
import { callClaudeCode } from "@/lib/server/claude-subprocess"

// POST /api/drive-respond
// Body: {
//   transcript: string,           // what the user said this turn
//   diff: {                       // what the structured-augment did
//     new_blocks?: { id: string; text: string }[],
//     new_connections?: { id: string; from: string; to: string }[],
//     new_note_text?: string,    // for default-mode augments
//   }
// }
// Returns: { text: string, model: string, elapsed_ms: number }
//
// Generates a SHORT spoken-style conversational response for Drive Mode TTS.
// Replaces the deterministic templated rundown when we want it to feel like
// a human collaborator, not a system narrator.
//
// Defaults to a fast cheap conversational model (Gemini 2.5 Flash on
// OpenRouter); overridable via settings.driveRespondModelId.

// gemini-2.5-flash-lite via OpenRouter Google direct: ~0.5-0.7s p50, $0.00001/call.
// Set provider.sort: "latency" so OR picks the lowest-TTFB upstream (Google direct
// rather than a slow re-host). Override via settings.driveRespondModelId if Albert
// wants to A/B claude-haiku-4.5 / gpt-5-nano / etc.
const FAST_MODEL_DEFAULT = "google/gemini-2.5-flash-lite"
const MAX_TEXT_CHARS = 600 // upper cap so we don't TTS a monologue

const SYSTEM_PROMPT = `You are a thinking partner riding shotgun while someone drives and brainstorms aloud. They speak a thought; their canvas system breaks it into blocks and connections; you respond as their collaborator — short, real, present.

# Style
- Speak TO them. Second person.
- One sentence ideal, two if needed. Hard cap: ~25 words.
- No openers. No "Okay", "Got it", "Great", "Sure", "Right". No "you're building", "you're starting", "you're capturing". No nodding/affirming.
- No status-narrating ("I added X to your canvas"). Talk about the ideas, not the system.
- No questions. They can't answer while driving.
- No emojis, no markdown, no lists. Plain spoken English.
- Never compliment ("great", "interesting", "smart"). Just engage with the substance.

# What to actually say
Pick one of these shapes per turn:
- **Name the connection.** If two ideas just got linked, say what that link MEANS: "Latency ceiling and Redis hit-rate are the same constraint, just from different sides."
- **Push the thought one step.** Take the most interesting block and add one beat — a consequence, a reframe, a counter: "If wind-down starts at 9:30, the screen cutoff at 8:30 is the real constraint, not the 10pm bedtime."
- **Notice what's missing.** "There's nothing yet about what triggers the wind-down — that's where it'll stick or slip."
- **Reflect a pattern.** If the canvas now has a clear shape (timeline, tradeoff, system), name it: "It's becoming a tradeoff between depth and recovery."

# When little happened
If only one or two blocks were added with nothing connected, name the one piece in one short beat. If literally nothing happened, say so plainly. Don't pad. Don't repeat any phrasing from these instructions verbatim.

# Input
You'll get: what they said + a JSON summary of what the canvas did. Respond in 1-2 sentences as described.`

type DriveDiff = {
  new_blocks?: { id: string; text: string }[]
  new_connections?: { id: string; from: string; to: string }[]
  new_note_text?: string
}

function fallbackRundown(diff: DriveDiff): string {
  const blocks = (diff.new_blocks || []).filter(b => b && b.text)
  if (!blocks.length && diff.new_note_text) {
    return `Pulled it together into one thread — ${snippet(diff.new_note_text, 50)}.`
  }
  if (!blocks.length) return "Nothing new took hold this time."
  if (blocks.length === 1) return `One thread there — ${snippet(blocks[0].text, 60)}.`
  return `${blocks.length} new threads. The strongest one: ${snippet(blocks[0].text, 60)}.`
}

function snippet(text: string, max: number): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  return flat.slice(0, max - 1).trimEnd() + "…"
}

function loadSettings(): Record<string, string> {
  const rows = getSettings()
  const out: Record<string, string> = {}
  for (const r of rows) {
    if (isSensitiveKey(r.key)) {
      try { out[r.key] = decrypt(r.value) } catch { out[r.key] = "" }
    } else {
      out[r.key] = r.value
    }
  }
  return out
}

export async function POST(req: Request) {
  const t0 = Date.now()
  try {
    const body = await req.json().catch(() => ({}))
    const transcript: string = String(body.transcript || "").slice(0, 2000)
    const diff: DriveDiff = body.diff || {}

    if (!transcript) {
      return NextResponse.json({ error: "transcript required" }, { status: 400 })
    }

    // Short-circuit: empty diff → don't burn an LLM call. Drive Mode would
    // otherwise speak something like "nothing connected yet" generated from
    // empty input; the deterministic fallback is more honest and 0ms.
    const hasAnyChange = (diff.new_blocks?.length || 0) > 0 || !!diff.new_note_text
    if (!hasAnyChange) {
      return NextResponse.json({
        text: "Nothing landed from that one — try saying it differently.",
        model: "short-circuit (empty diff)",
        elapsed_ms: Date.now() - t0,
      })
    }

    const settings = loadSettings()
    const apiKey = settings.apiKey || ""
    const provider = settings.provider || "openrouter"
    const model = settings.driveRespondModelId || FAST_MODEL_DEFAULT
    const baseUrl =
      settings.customBaseUrl ||
      (provider === "openai" ? "https://api.openai.com/v1" : "https://openrouter.ai/api/v1")

    // Claude Code backend short-circuit. When driveBackend === "claude-code"
    // this path runs via the CLI subprocess — bypasses OR apiKey requirement.
    const useClaudeCode = settings.driveBackend === "claude-code"
    const ccModel = settings.claudeCodeModel || "claude-opus-4-7"

    // No key configured AND not using claude-code? Don't break the loop —
    // return a graceful fallback.
    if (!apiKey && !useClaudeCode) {
      return NextResponse.json({
        text: fallbackRundown(diff),
        model: "fallback (no api key)",
        elapsed_ms: Date.now() - t0,
      })
    }

    // Build a compact diff summary for the model. Don't dump full text of huge
    // blocks — cap each at 200 chars; cap total list at 8 items.
    const blocks = (diff.new_blocks || []).slice(0, 8).map(b => ({
      id: b.id,
      text: snippet(b.text, 200),
    }))
    const conns = (diff.new_connections || []).slice(0, 12).map(c => {
      const fromText = blocks.find(b => b.id === c.from)?.text
      const toText = blocks.find(b => b.id === c.to)?.text
      return { from: snippet(fromText || c.from, 60), to: snippet(toText || c.to, 60) }
    })

    const userContent =
      `What I said: "${transcript}"\n\n` +
      `What the canvas did:\n` +
      JSON.stringify(
        {
          new_blocks: blocks.map(b => b.text),
          new_connections: conns,
          new_note_text: diff.new_note_text ? snippet(diff.new_note_text, 200) : undefined,
        },
        null,
        2
      )

    let raw: string = ""
    if (useClaudeCode) {
      try {
        const cc = await callClaudeCode({
          prompt: userContent,
          systemPrompt: SYSTEM_PROMPT,
          model: ccModel,
          timeoutMs: 60_000,
        })
        raw = cc.text.trim()
      } catch (ccErr: any) {
        console.warn("[drive-respond] claude-code error → fallback:", ccErr?.message)
        return NextResponse.json({
          text: fallbackRundown(diff),
          model: `fallback (cc: ${(ccErr?.message || "err").slice(0, 80)})`,
          elapsed_ms: Date.now() - t0,
        })
      }
    } else {
      let res: Response
      try {
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            // OpenRouter conventions for proper attribution / rankings
            "HTTP-Referer": "https://nodepad.local",
            "X-Title": "nodepad-v2 drive-mode",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userContent },
            ],
            temperature: 0.6,
            max_tokens: 120,
            // OR picks lowest-TTFB upstream — critical for the live voice loop.
            provider: { sort: "latency" },
          }),
        })
      } catch (netErr: any) {
        console.warn("[drive-respond] network error → fallback:", netErr?.message)
        return NextResponse.json({
          text: fallbackRundown(diff),
          model: `fallback (net: ${netErr?.message || "err"})`,
          elapsed_ms: Date.now() - t0,
        })
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "")
        console.warn(`[drive-respond] ${model} ${res.status}: ${errBody.slice(0, 300)}`)
        return NextResponse.json({
          text: fallbackRundown(diff),
          model: `fallback (${res.status})`,
          elapsed_ms: Date.now() - t0,
        })
      }

      const data = await res.json().catch(() => ({}))
      raw = String(data?.choices?.[0]?.message?.content || "").trim()
    }
    if (!raw) {
      return NextResponse.json({
        text: fallbackRundown(diff),
        model: `fallback (empty)`,
        elapsed_ms: Date.now() - t0,
      })
    }

    // Strip any accidental markdown / quotes the model added.
    const cleaned = raw
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/^[*_-]\s+/gm, "")
      .replace(/\*\*/g, "")
      .slice(0, MAX_TEXT_CHARS)
      .trim()

    return NextResponse.json({
      text: cleaned || fallbackRundown(diff),
      model: useClaudeCode ? `claude-code/${ccModel}` : model,
      elapsed_ms: Date.now() - t0,
    })
  } catch (e: any) {
    console.error("[drive-respond] crash:", e)
    return NextResponse.json({ error: e?.message || "drive-respond failed" }, { status: 500 })
  }
}
