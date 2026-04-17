import { NextResponse } from "next/server"
import { randomBytes } from "crypto"
import {
  getSession,
  listNotes,
  listConnections,
  createNote,
  createConnection,
  deleteNote,
} from "@/lib/server/db"

// POST /api/drive-turn-tools
// Body: { transcript: string, session_id: string }
// Returns: {
//   action: "add" | "delete" | "delete_all" | "rearrange" | "noop",
//   text: string,                         // what TTS should speak
//   diff?: { new_blocks, new_connections },
//   delete_snapshot?: { deleted_notes, deleted_connections },
//   deleted_count?: number,
//   tool_calls: [{name, args}],          // what the model decided to do
//   model: string,
//   elapsed_ms: number,
// }
//
// Tool-calling variant of /api/drive-turn. Instead of a JSON-classifier +
// JSON-dispatch + JSON-respond pipeline, this hands the LLM (Qwen3.6 on the
// AI Server via Ollama) a set of canvas-mutation tools and lets the model
// decide what to call. Two round-trips per turn:
//   1. user message → model emits tool_calls (or just text for describe/silent)
//   2. tool results appended → model emits final spoken text
// Self-hosted, no per-call cost, fully private.

const OLLAMA_URL = process.env.OLLAMA_URL || "http://100.95.37.85:11434"
const OLLAMA_MODEL = process.env.OLLAMA_DRIVE_MODEL || "qwen3.6:35b-a3b-q4_K_M"
const MAX_BLOCKS_IN_PROMPT = 40
const MAX_BLOCK_TEXT = 200

const SYSTEM_PROMPT = `You are the voice partner of someone driving while brainstorming on a thinking canvas. They speak; you listen, decide whether the canvas needs to change, then respond out loud — briefly, like a peer riding shotgun.

# Available tools (call AT MOST ONE per turn)
- add_blocks: when the user contributes a NEW thought, idea, plan, or detail not already on the canvas.
- delete_blocks: when the user explicitly identifies specific blocks to remove ("delete the caffeine one").
- delete_all_blocks: when the user wants to wipe everything ("clear the canvas", "start over", "delete all notes").
- rearrange_canvas: when the user explicitly asks to re-layout (move, cluster, timeline). NOTE: voice rearrange isn't supported; tool will return a "not yet" stub. Only call if they really meant rearrange.

# When NOT to call any tool
- They're asking what's on the canvas ("remind me", "what do we have", "summarize") — just describe in your spoken response.
- They're thinking aloud, mumbling, agreeing, repeating something already on the canvas — just acknowledge briefly.
- The thought duplicates a block that's already there — don't re-add. Just acknowledge.
- If you're unsure whether they want a change, DO NOT call a tool. Cluttering or wrongly deleting is worse than doing nothing.

# Spoken response style (the assistant message text after any tool call)
- Speak TO them. Second person.
- One short sentence. ≤25 words. (For describe action: ≤35 words.)
- No openers ("Okay", "Got it", "Great", "Sure", "Right"). No "you're building", "you're starting", "you're capturing". No nodding-affirm. No compliments.
- No questions back. No markdown. No lists. Plain spoken English.
- Don't say "the canvas" or "the system" — talk about the IDEAS.
- After add: name a connection / push the thought one beat / notice what's missing. Don't list everything.
- After delete: confirm WHAT and HOW MANY. Don't list ids. ("Removed the caffeine one." / "Cleared all 4 blocks.")
- After describe (no tool): group similar blocks; end with the shape/pattern if there is one.
- After silent (no tool): "Already covered." / "Just noted." / "Same ground." Pick whatever fits in <12 words.
- After rearrange tool: "Rearrange isn't on voice yet — open the canvas to do it." (the tool returns this).

# HARD RULES (do not violate)
1. If you describe an action — "cleared", "removed", "deleted", "added", "wrote down", "noted that down" — you MUST have just called the corresponding tool. Speaking an action you did not perform is a bug.
2. If the user's request implies a canvas change (clear / wipe / delete / add / capture / write down), you MUST call the matching tool BEFORE speaking. No exceptions.
3. If you are NOT calling a tool, your spoken text must be PURELY descriptive or acknowledging — no past-tense action verbs about the canvas.
4. "clear the canvas" / "delete all" / "wipe everything" / "start over" → ALWAYS call delete_all_blocks. Never just speak about clearing.

You receive: the user's transcript + the current canvas (each block prefixed with [id:xxxxxxxx] so you can reference exact ids in delete_blocks).`

type ToolCall = { name: string; arguments: any }

function snippet(text: string, max: number): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  return flat.slice(0, max - 1).trimEnd() + "…"
}

function summarizeCanvas(notes: any[]): string {
  if (!notes.length) return "(canvas is empty)"
  const lines: string[] = []
  if (notes.length <= MAX_BLOCKS_IN_PROMPT) {
    for (const n of notes) lines.push(`- [id:${n.id}] ${snippet(n.text, MAX_BLOCK_TEXT)}`)
  } else {
    for (const n of notes.slice(0, 30)) lines.push(`- [id:${n.id}] ${snippet(n.text, 120)}`)
    lines.push(`... (${notes.length - 40} more blocks omitted)`)
    for (const n of notes.slice(-10)) lines.push(`- [id:${n.id}] ${snippet(n.text, 120)}`)
  }
  return lines.join("\n")
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "add_blocks",
      description:
        "Add one or more new blocks to the canvas. Each block is a short text snippet (sentence fragment to one paragraph). Use only when the user is genuinely contributing new content not already on the canvas.",
      parameters: {
        type: "object",
        properties: {
          blocks: {
            type: "array",
            description: "Array of block text contents. Each string becomes one block.",
            items: { type: "string" },
            minItems: 1,
          },
          connect_to_existing: {
            type: "array",
            description:
              "Optional connections between new blocks (by index in `blocks`) and existing blocks (by id). Each item: {from_new_index, to_existing_id}.",
            items: {
              type: "object",
              properties: {
                from_new_index: { type: "integer" },
                to_existing_id: { type: "string" },
              },
              required: ["from_new_index", "to_existing_id"],
            },
          },
        },
        required: ["blocks"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_blocks",
      description:
        "Delete specific blocks from the canvas by their exact ids (the [id:xxxxxxxx] prefix). Only call when user clearly references which blocks they mean.",
      parameters: {
        type: "object",
        properties: {
          block_ids: {
            type: "array",
            description: "Exact block ids to delete (without the 'id:' prefix).",
            items: { type: "string" },
            minItems: 1,
          },
        },
        required: ["block_ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_all_blocks",
      description:
        "Wipe every block on the canvas. Only call when the user says 'all', 'everything', 'clear', 'wipe', 'start over'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "rearrange_canvas",
      description:
        "STUBBED — voice rearrange is not yet wired. Calling this returns a 'not supported' message that you should relay verbatim.",
      parameters: { type: "object", properties: {} },
    },
  },
]

function shortId(): string {
  // 8-char base36 — same shape as existing nodepad ids
  return randomBytes(5).toString("hex").slice(0, 8)
}

async function ollamaChat(messages: any[], tools: any[] | null): Promise<any> {
  const body: any = {
    model: OLLAMA_MODEL,
    messages,
    stream: false,
    // CRITICAL: Qwen3 thinking mode is on by default and burns through
    // num_predict on internal reasoning before ever emitting tool_calls or
    // content (done_reason="length", empty everything). Disable thinking on
    // the hot path — the system prompt already steers behavior, no chain-of-
    // thought needed for a 4-tool decision. ~30x token savings, ~10x speedup.
    think: false,
    options: {
      temperature: 0.4,
      num_predict: 400,
    },
  }
  if (tools) body.tools = tools
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => "")
    throw new Error(`ollama ${res.status}: ${t.slice(0, 200)}`)
  }
  return res.json()
}

function extractToolCalls(msg: any): ToolCall[] {
  const calls: ToolCall[] = []
  for (const tc of msg?.tool_calls || []) {
    const fn = tc?.function || {}
    let args = fn.arguments
    if (typeof args === "string") {
      try { args = JSON.parse(args) } catch { args = {} }
    }
    calls.push({ name: String(fn.name || ""), arguments: args || {} })
  }
  return calls
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
    const canvasSummary = summarizeCanvas(notes)

    const userContent =
      `Transcript: "${transcript}"\n\n` +
      `Current canvas (${notes.length} block${notes.length === 1 ? "" : "s"}):\n${canvasSummary}`

    const messages: any[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ]

    // Round 1: model decides whether to call a tool.
    let r1: any
    try {
      r1 = await ollamaChat(messages, TOOLS)
    } catch (e: any) {
      console.error("[drive-turn-tools] round-1 failed:", e?.message)
      return NextResponse.json({
        action: "noop",
        text: "Voice brain is offline — try again in a moment.",
        error: e?.message,
        model: OLLAMA_MODEL,
        elapsed_ms: Date.now() - t0,
      })
    }

    let r1msg = r1?.message || {}
    let toolCalls = extractToolCalls(r1msg)
    let r1text = String(r1msg?.content || "").trim()
    console.log(`[drive-turn-tools] r1 tool_calls=${toolCalls.length} text_len=${r1text.length}`)

    // Classify what the user asked for, once. We scrub/retry only when there
    // is a real mismatch between intent and action.
    const userWantsClear = looksLikeClearRequest(transcript)
    const userWantsDelete = looksLikeDeleteRequest(transcript)
    const userWantsAction = userWantsClear || userWantsDelete

    // ── Ghost-action retry ────────────────────────────────────────────────
    // If the user clearly asked for a clear/delete and the model failed to
    // call any tool, do ONE retry with a stronger reminder. We don't retry
    // on ghost text alone — for describe/silent turns, action verbs in the
    // response can be perfectly legitimate ("you've added two blocks…").
    if (!toolCalls.length && userWantsAction) {
      console.log(
        `[drive-turn-tools] retry (clearReq=${userWantsClear} deleteReq=${userWantsDelete})`,
      )
      const retryMessages: any[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
        {
          role: "system",
          content:
            "RETRY: The user is asking you to mutate the canvas. You MUST invoke a tool. " +
            "If they want everything cleared, call delete_all_blocks. " +
            "If they want specific blocks removed, call delete_blocks with the matching ids. " +
            "Do not describe the action — perform it.",
        },
      ]
      try {
        const r1b = await ollamaChat(retryMessages, TOOLS)
        const r1bMsg = r1b?.message || {}
        const r1bCalls = extractToolCalls(r1bMsg)
        if (r1bCalls.length) {
          r1msg = r1bMsg
          toolCalls = r1bCalls
          r1text = String(r1bMsg?.content || "").trim()
          console.log(`[drive-turn-tools] retry rescued tool_calls=${toolCalls.length}`)
        } else {
          console.log("[drive-turn-tools] retry still produced no tool_calls")
        }
      } catch (e: any) {
        console.warn("[drive-turn-tools] ghost-action retry failed:", e?.message)
      }
    }

    // ── No tool called → describe / silent path ───────────────────────────
    if (!toolCalls.length) {
      let text = cleanSpoken(r1text) || "Nothing to add."
      // Only scrub when there's an actual mismatch: user asked for an action
      // AND the model is now speaking as if it performed one. For describe
      // turns we let action verbs through unchanged.
      if (userWantsAction && looksLikeGhostAction(text)) {
        text = "Didn't catch that clearly — say it again?"
      }
      return NextResponse.json({
        action: "noop",
        text,
        tool_calls: [],
        model: OLLAMA_MODEL,
        elapsed_ms: Date.now() - t0,
      })
    }

    // ── Execute the (first) tool call ─────────────────────────────────────
    const call = toolCalls[0]
    let action = "noop"
    let toolResult: any = {}
    let diff: any = undefined
    let deleteSnapshot: any = undefined
    let deletedCount = 0

    if (call.name === "add_blocks") {
      action = "add"
      const blocksIn: string[] = Array.isArray(call.arguments?.blocks)
        ? call.arguments.blocks.map((s: any) => String(s)).filter(Boolean)
        : []
      const conns: any[] = Array.isArray(call.arguments?.connect_to_existing)
        ? call.arguments.connect_to_existing
        : []

      const newBlocks: any[] = []
      // Auto-layout: stack new blocks below the lowest existing block, or
      // start at (100, 100) if canvas is empty.
      const baseY = notes.length
        ? Math.max(...notes.map(n => n.y + (n.height || 120))) + 40
        : 100
      const baseX = 100
      let i = 0
      for (const text of blocksIn) {
        const id = shortId()
        const created = createNote({
          id, session_id: sessionId, text,
          x: baseX, y: baseY + i * 140,
          width: 240, height: 0, // 0 = auto-size
          kind: "text", is_ai_generated: true,
        })
        newBlocks.push(created)
        i++
      }
      const newConns: any[] = []
      for (const c of conns) {
        const fromIdx = Number(c?.from_new_index)
        const toId = String(c?.to_existing_id || "")
        if (
          Number.isFinite(fromIdx) && fromIdx >= 0 && fromIdx < newBlocks.length &&
          notes.some(n => n.id === toId)
        ) {
          try {
            const conn = createConnection({
              id: shortId(), session_id: sessionId,
              from_block_id: newBlocks[fromIdx].id, to_block_id: toId,
            })
            newConns.push(conn)
          } catch (e: any) {
            console.warn("[drive-turn-tools] connect failed:", e?.message)
          }
        }
      }
      diff = {
        new_blocks: newBlocks.map(b => ({ id: b.id, text: b.text })),
        new_connections: newConns.map(c => ({ id: c.id, from: c.from_block_id, to: c.to_block_id })),
      }
      toolResult = { added: newBlocks.length, connected: newConns.length }
    } else if (call.name === "delete_blocks") {
      action = "delete"
      const ids: string[] = Array.isArray(call.arguments?.block_ids)
        ? call.arguments.block_ids.map((s: any) => String(s)).filter(Boolean)
        : []
      const validIdSet = new Set(notes.map(n => n.id))
      const targets = notes.filter(n => ids.includes(n.id) && validIdSet.has(n.id))
      const targetIdSet = new Set(targets.map(n => n.id))
      const affectedConns = connections.filter(
        c => targetIdSet.has(c.from_block_id) || targetIdSet.has(c.to_block_id),
      )
      deleteSnapshot = {
        deleted_notes: targets.map(n => ({ ...n })),
        deleted_connections: affectedConns.map(c => ({ ...c })),
      }
      for (const n of targets) {
        try { deleteNote(n.id) } catch (e: any) {
          console.warn(`[drive-turn-tools] deleteNote(${n.id}) failed:`, e?.message)
        }
      }
      deletedCount = targets.length
      toolResult = { deleted: deletedCount, requested: ids.length }
    } else if (call.name === "delete_all_blocks") {
      action = "delete_all"
      const targets = notes
      const targetIdSet = new Set(targets.map(n => n.id))
      const affectedConns = connections.filter(
        c => targetIdSet.has(c.from_block_id) || targetIdSet.has(c.to_block_id),
      )
      deleteSnapshot = {
        deleted_notes: targets.map(n => ({ ...n })),
        deleted_connections: affectedConns.map(c => ({ ...c })),
      }
      for (const n of targets) {
        try { deleteNote(n.id) } catch (e: any) {
          console.warn(`[drive-turn-tools] deleteNote(${n.id}) failed:`, e?.message)
        }
      }
      deletedCount = targets.length
      toolResult = { deleted: deletedCount }
    } else if (call.name === "rearrange_canvas") {
      action = "rearrange"
      toolResult = {
        supported: false,
        message: "Voice rearrange isn't on yet. Open the canvas to do it.",
      }
    } else {
      console.warn("[drive-turn-tools] unknown tool:", call.name)
      toolResult = { error: `unknown tool: ${call.name}` }
    }

    // ── Round 2: feed tool result back, get spoken response ───────────────
    const r2messages = [
      ...messages,
      { role: "assistant", content: r1text || "", tool_calls: r1msg.tool_calls },
      { role: "tool", content: JSON.stringify(toolResult), name: call.name },
    ]
    let spokenText = ""
    try {
      const r2 = await ollamaChat(r2messages, null)
      spokenText = cleanSpoken(String(r2?.message?.content || ""))
    } catch (e: any) {
      console.warn("[drive-turn-tools] round-2 failed:", e?.message)
    }
    if (!spokenText) spokenText = hardFallback(action, toolResult)

    return NextResponse.json({
      action,
      text: spokenText,
      diff,
      delete_snapshot: deleteSnapshot,
      deleted_count: deletedCount,
      tool_calls: toolCalls.map(tc => ({ name: tc.name, args: tc.arguments })),
      model: OLLAMA_MODEL,
      elapsed_ms: Date.now() - t0,
    })
  } catch (e: any) {
    console.error("[drive-turn-tools] crash:", e)
    return NextResponse.json({ error: e?.message || "drive-turn-tools failed" }, { status: 500 })
  }
}

function cleanSpoken(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/g, "") // strip Qwen3 thinking tags if any leak
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^[*_-]\s+/gm, "")
    .replace(/\*\*/g, "")
    .slice(0, 600)
    .trim()
}

// Detects spoken text that CLAIMS a canvas mutation. If the model emits any
// of these phrases without a tool_call, we have a ghost action and must
// either retry or scrub the response.
function looksLikeGhostAction(text: string): boolean {
  const t = String(text || "").toLowerCase()
  if (!t) return false
  // Action verbs (past, present-continuous, future) the model uses when it
  // thinks/claims it did or is doing something to the canvas.
  return (
    /\b(cleared|wiping|wiped|emptied|emptying|removed|removing|deleted|deleting|erased|erasing|added|adding|wrote (it|that) down|writing (it|that) down|noted (it|that) down|noting (it|that) down|captured (it|that)|capturing (it|that)|putting (it|that) on|put (it|that) on)\b/.test(
      t,
    ) ||
    /\bI('|’| wi)?ll (clear|wipe|delete|remove|add|note|capture|drop|nuke)\b/.test(t)
  )
}

function looksLikeClearRequest(transcript: string): boolean {
  const t = String(transcript || "").toLowerCase()
  if (!t) return false
  return (
    /\b(clear|wipe|empty|reset)\b.*\b(canvas|board|everything|all|notes?|blocks?)\b/.test(t) ||
    /\b(delete|remove)\b.*\b(all|everything|every (note|block))\b/.test(t) ||
    /\bstart over\b/.test(t) ||
    /\bnuke\b/.test(t)
  )
}

function looksLikeDeleteRequest(transcript: string): boolean {
  const t = String(transcript || "").toLowerCase()
  return /\b(delete|remove|drop|kill|trash|get rid of)\b/.test(t)
}

function hardFallback(action: string, toolResult: any): string {
  if (action === "add") return `${toolResult?.added || 0} new block${toolResult?.added === 1 ? "" : "s"}.`
  if (action === "delete") return `Removed ${toolResult?.deleted || 0} block${toolResult?.deleted === 1 ? "" : "s"}.`
  if (action === "delete_all") return `Cleared all ${toolResult?.deleted || 0} blocks.`
  if (action === "rearrange") return "Rearrange isn't on voice yet — open the canvas to do it."
  return "Done."
}
