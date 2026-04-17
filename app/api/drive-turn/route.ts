import { NextResponse } from "next/server"
import { headers } from "next/headers"
import { getSettings, getSession, listNotes, listConnections } from "@/lib/server/db"
import { decrypt, isSensitiveKey } from "@/lib/server/crypto"

// POST /api/drive-turn
// Body: { transcript: string, session_id: string }
// Returns: {
//   action: "add" | "describe" | "silent" | "rearrange",
//   reason: string,
//   text: string,                 // what TTS should speak
//   diff?: { ... },               // present when action=add
//   models: { classifier, responder },
//   elapsed_ms: number,
// }
//
// One round-trip orchestrator for Drive Mode:
// 1. Read current canvas state.
// 2. Classify intent: is the user adding, asking-what's-here, or just talking?
// 3. Dispatch:
//    - "add": call structured augment internally, then narrate the diff.
//    - "describe": no DB writes; describe what's already on the canvas.
//    - "silent": no DB writes; brief acknowledgment.
//    - "rearrange": (stubbed — voice can't drive canvas-image rearrange yet,
//       falls back to "describe" with a note.)
//
// Replaces the previous always-augment pipeline that was generating duplicate
// "dim the lights" blocks every turn regardless of what was said.

const FAST_MODEL = "google/gemini-2.5-flash-lite"
const MAX_BLOCKS_IN_PROMPT = 40 // beyond this, summarize
const MAX_BLOCK_TEXT = 200

type Intent = "add" | "describe" | "silent" | "rearrange"

const CLASSIFIER_SYSTEM_PROMPT = `You decide what a voice user wants from their thinking canvas. They speak; you pick ONE action.

Output: one JSON object, nothing else:
{ "action": "add" | "describe" | "silent" | "rearrange", "reason": "<one short sentence>" }

Rules:

"add" — they're contributing a NEW thought, idea, plan, or detail that isn't already on the canvas.
  Examples: "let's also think about cost", "the third option is X", "I want to capture that...", "add a note that..."
  CRITICAL: if their utterance is a near-duplicate of what's already on the canvas (same topic, same level, same wording shape), choose "silent" instead — never re-add the same thing.

"describe" — they're asking what's there, what the state is, what we have so far.
  Examples: "what's on the canvas", "remind me what we have", "tell me what's there", "summarize", "where are we", "read it back".

"rearrange" — they explicitly want layout changed (move blocks, reorganize, cluster, timeline).
  Examples: "rearrange these as a timeline", "cluster by topic", "move the X block over there".
  If unsure, do NOT pick rearrange — voice rearrange is brittle. Default to "silent" or "add".

"silent" — they're thinking aloud, acknowledging, repeating themselves, mumbling, or saying something the canvas already covers.
  Examples: "hmm", "okay", "yeah", "interesting", "right", filler, vague nonspecific musing, anything that's already on the canvas.

When in doubt between "add" and "silent", prefer "silent". Cluttering the canvas is worse than missing one.`

const RESPONDER_SYSTEM_PROMPT = `You are the spoken voice partner of someone driving while brainstorming on a thinking canvas. They speak; the canvas does something (or doesn't); you respond, briefly, like a peer riding shotgun.

# Style
- Speak TO them. Second person.
- One short sentence. Maximum 25 words. They're driving.
- No openers ("Okay", "Got it", "Great", "Sure", "Right"). No "you're building", "you're starting", "you're capturing", "you're working on". No nodding-affirm. No compliments.
- No questions. No markdown. No lists. Plain spoken English.
- Don't say "the canvas" or "the system" — talk about the IDEAS.

# Per action

action="add" — what got added. Pick the strongest move: name a connection, push the thought one beat, or notice what's missing. Don't list everything.

action="describe" — read the canvas back to them. Group similar blocks; don't enumerate every line. End with the shape/pattern if there is one ("It's clustered around wind-down and morning routine, no overlap yet"). Maximum 35 words for describe (only exception to 25 ceiling).

action="silent" — brief honest acknowledgment that nothing changed. Don't pretend. Examples: "Already covered." / "Just noted, nothing new." / "Same ground." Pick whatever fits in <12 words.

action="rearrange" — voice rearrange isn't wired yet. Say so plainly: "Rearrange isn't on voice yet — open the canvas to do it."

You will receive: the user's transcript + a summary of canvas state + (for add) the diff. Respond per the rules above.`

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

function snippet(text: string, max: number): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  return flat.slice(0, max - 1).trimEnd() + "…"
}

function summarizeCanvas(notes: any[], connections: any[]): string {
  if (!notes.length) return "(canvas is empty)"
  const lines: string[] = []
  if (notes.length <= MAX_BLOCKS_IN_PROMPT) {
    for (const n of notes) {
      lines.push(`- ${snippet(n.text, MAX_BLOCK_TEXT)}`)
    }
  } else {
    // Too many — sample first 30 + last 10
    for (const n of notes.slice(0, 30)) lines.push(`- ${snippet(n.text, 120)}`)
    lines.push(`... (${notes.length - 40} more blocks omitted)`)
    for (const n of notes.slice(-10)) lines.push(`- ${snippet(n.text, 120)}`)
  }
  if (connections.length) {
    lines.push("")
    lines.push(`(${connections.length} connection${connections.length === 1 ? "" : "s"})`)
  }
  return lines.join("\n")
}

async function callOR(
  apiKey: string,
  baseUrl: string,
  model: string,
  system: string,
  user: string,
  jsonOnly: boolean,
  maxTokens: number
): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://nodepad.local",
      "X-Title": "nodepad-v2 drive-turn",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: jsonOnly ? 0.1 : 0.6,
      max_tokens: maxTokens,
      provider: { sort: "latency" },
      ...(jsonOnly ? { response_format: { type: "json_object" } } : {}),
    }),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => "")
    throw new Error(`OR ${res.status}: ${t.slice(0, 200)}`)
  }
  const data = await res.json().catch(() => ({}))
  return String(data?.choices?.[0]?.message?.content || "").trim()
}

function classifyIntent(raw: string): { action: Intent; reason: string } {
  // Try to parse model output as JSON. If it failed JSON mode (some models
  // wrap in fences), strip and retry.
  const cleaned = raw.replace(/^```json\s*|^```\s*|\s*```$/g, "").trim()
  try {
    const obj = JSON.parse(cleaned)
    let action = String(obj.action || "silent").toLowerCase() as Intent
    if (!["add", "describe", "silent", "rearrange"].includes(action)) action = "silent"
    return { action, reason: String(obj.reason || "") }
  } catch {
    // Heuristic fallback if model returned prose
    const lower = cleaned.toLowerCase()
    if (lower.startsWith("describe") || lower.includes("\"describe\"")) return { action: "describe", reason: "fallback parse" }
    if (lower.startsWith("add") || lower.includes("\"add\"")) return { action: "add", reason: "fallback parse" }
    if (lower.includes("\"rearrange\"")) return { action: "rearrange", reason: "fallback parse" }
    return { action: "silent", reason: "fallback parse — could not classify" }
  }
}

export async function POST(req: Request) {
  const t0 = Date.now()
  try {
    const body = await req.json().catch(() => ({}))
    const transcript: string = String(body.transcript || "").slice(0, 2000)
    const sessionId: string = String(body.session_id || "")

    if (!transcript) return NextResponse.json({ error: "transcript required" }, { status: 400 })
    if (!sessionId) return NextResponse.json({ error: "session_id required" }, { status: 400 })

    const session = getSession(sessionId)
    if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 })

    const notes = listNotes(sessionId)
    const connections = listConnections(sessionId)
    const canvasSummary = summarizeCanvas(notes, connections)

    const settings = loadSettings()
    const apiKey = settings.apiKey || ""
    const provider = settings.provider || "openrouter"
    const baseUrl =
      settings.customBaseUrl ||
      (provider === "openai" ? "https://api.openai.com/v1" : "https://openrouter.ai/api/v1")

    if (!apiKey) {
      return NextResponse.json({
        action: "silent",
        reason: "no api key",
        text: "Voice mode needs an OpenRouter API key in settings.",
        models: { classifier: "none", responder: "none" },
        elapsed_ms: Date.now() - t0,
      })
    }

    // ── Step 1: classify intent ───────────────────────────────────────────
    const classifyUser =
      `User said: "${transcript}"\n\n` +
      `Current canvas (${notes.length} block${notes.length === 1 ? "" : "s"}):\n${canvasSummary}`
    let classification: { action: Intent; reason: string }
    try {
      const raw = await callOR(apiKey, baseUrl, FAST_MODEL, CLASSIFIER_SYSTEM_PROMPT, classifyUser, true, 100)
      classification = classifyIntent(raw)
    } catch (e: any) {
      console.warn("[drive-turn] classify failed:", e?.message)
      classification = { action: "silent", reason: `classifier error: ${e?.message}` }
    }

    let diff: any = undefined
    let augmentRes: any = undefined

    // ── Step 2: dispatch ──────────────────────────────────────────────────
    if (classification.action === "add") {
      // Call structured augment internally. Reuse the existing endpoint via
      // localhost loopback so we don't duplicate its prompt logic.
      try {
        const hdrs = await headers()
        const host = hdrs.get("host") || "localhost:3034"
        const proto = hdrs.get("x-forwarded-proto") || "http"
        const augUrl = `${proto}://${host}/api/sessions/${sessionId}/augment`
        const augRes = await fetch(augUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: transcript,
            block_ids: [],
            mode: "structured",
          }),
        })
        if (!augRes.ok) {
          const errTxt = await augRes.text().catch(() => "")
          console.warn(`[drive-turn] augment ${augRes.status}: ${errTxt.slice(0, 200)}`)
          // Degrade: tell user it failed, don't pretend it worked.
          return NextResponse.json({
            action: "add",
            reason: classification.reason,
            text: "Couldn't add that — augment service errored.",
            error: `augment ${augRes.status}`,
            models: { classifier: FAST_MODEL, responder: "none" },
            elapsed_ms: Date.now() - t0,
          })
        }
        augmentRes = await augRes.json()
        diff = {
          new_blocks: (augmentRes.new_blocks || []).map((b: any) => ({ id: b.id, text: b.text })),
          new_connections: (augmentRes.new_connections || []).map((c: any) => ({
            id: c.id, from: c.from_block_id, to: c.to_block_id,
          })),
          snapshot: augmentRes.snapshot,
        }
      } catch (e: any) {
        console.warn("[drive-turn] augment internal call failed:", e?.message)
        return NextResponse.json({
          action: "add",
          reason: classification.reason,
          text: "Couldn't add that — augment unreachable.",
          models: { classifier: FAST_MODEL, responder: "none" },
          elapsed_ms: Date.now() - t0,
        })
      }
    }

    // ── Step 3: generate spoken response ──────────────────────────────────
    let responderUser = ""
    if (classification.action === "add") {
      const blocks = (diff?.new_blocks || []).slice(0, 8).map((b: any) => snippet(b.text, 200))
      const conns = (diff?.new_connections || []).slice(0, 12)
      responderUser =
        `User said: "${transcript}"\n` +
        `Action: add\n` +
        `Diff:\n${JSON.stringify({ new_blocks: blocks, new_connections_count: conns.length }, null, 2)}\n\n` +
        `Canvas now has ${notes.length + (diff?.new_blocks?.length || 0)} blocks total.`
    } else if (classification.action === "describe") {
      responderUser =
        `User asked you to describe the canvas.\n` +
        `Action: describe\n` +
        `Current canvas (${notes.length} block${notes.length === 1 ? "" : "s"}):\n${canvasSummary}`
    } else if (classification.action === "rearrange") {
      responderUser =
        `User wants to rearrange the layout.\n` +
        `Action: rearrange (not yet supported via voice)\n` +
        `Canvas: ${notes.length} blocks.`
    } else {
      // silent
      responderUser =
        `User said: "${transcript}" (likely repeating, vague, or already covered)\n` +
        `Action: silent (nothing changed on canvas)\n` +
        `Reason: ${classification.reason}`
    }

    let text = ""
    try {
      const respRaw = await callOR(apiKey, baseUrl, FAST_MODEL, RESPONDER_SYSTEM_PROMPT, responderUser, false, 120)
      text = respRaw
        .replace(/^["'`]+|["'`]+$/g, "")
        .replace(/^[*_-]\s+/gm, "")
        .replace(/\*\*/g, "")
        .slice(0, 600)
        .trim()
    } catch (e: any) {
      console.warn("[drive-turn] responder failed:", e?.message)
      // Hard fallback per action
      if (classification.action === "add") {
        text = diff?.new_blocks?.length
          ? `${diff.new_blocks.length} new block${diff.new_blocks.length === 1 ? "" : "s"}.`
          : "Nothing new took hold."
      } else if (classification.action === "describe") {
        text = `${notes.length} block${notes.length === 1 ? "" : "s"} on the canvas.`
      } else {
        text = "Nothing to add."
      }
    }

    return NextResponse.json({
      action: classification.action,
      reason: classification.reason,
      text,
      diff,
      augment_full: augmentRes, // so client can extract snapshot for undo
      models: { classifier: FAST_MODEL, responder: FAST_MODEL },
      elapsed_ms: Date.now() - t0,
    })
  } catch (e: any) {
    console.error("[drive-turn] crash:", e)
    return NextResponse.json({ error: e?.message || "drive-turn failed" }, { status: 500 })
  }
}
