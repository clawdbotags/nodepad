import { NextResponse } from "next/server"
import {
  getDb,
  listNotes,
  listConnections,
  createNote,
  createConnection,
  deleteNote,
  deleteConnection,
  getSettings,
} from "@/lib/server/db"
import { decrypt, isSensitiveKey } from "@/lib/server/crypto"

function genId() {
  return Math.random().toString(36).slice(2, 10)
}

function loadSettings(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of getSettings()) {
    if (isSensitiveKey(row.key)) {
      try {
        out[row.key] = decrypt(row.value)
      } catch {
        out[row.key] = ""
      }
    } else {
      out[row.key] = row.value
    }
  }
  return out
}

// Structured output: LLM returns JSON { blocks: [{text, x, y}], connections: [{from, to}] }
// where from/to are 0-based indices into blocks[]. x/y are optional — we auto-layout if missing.
type StructuredResult = {
  blocks: { text: string; x?: number; y?: number }[]
  connections: { from: number; to: number }[]
}

async function callLLMStructured(prompt: string, blocks: string[], settings: Record<string, string>): Promise<StructuredResult> {
  const provider = settings.provider || "openrouter"
  const apiKey = settings.apiKey || ""
  const modelId = settings.modelId || "anthropic/claude-3.5-sonnet"
  const baseUrl =
    settings.customBaseUrl ||
    (provider === "openai" ? "https://api.openai.com/v1" : "https://openrouter.ai/api/v1")
  if (!apiKey) throw new Error("No API key configured. Set it via /api/settings.")

  const systemPrompt = `You are a structuring engine for a spatial thinking canvas. The user provides source text and an instruction. You must return a JSON object that defines a graph of text blocks on a 2D canvas.

Return ONLY valid JSON. No markdown fences, no prose, no commentary. The exact shape is:

{
  "blocks": [
    { "text": "short label or concept", "x": 100, "y": 100 }
  ],
  "connections": [
    { "from": 0, "to": 1 }
  ]
}

Rules:
- "text" values are plain text, short (typically 2–12 words, max ~30). One idea per block. No markdown.
- "x"/"y" are optional; if omitted the canvas will auto-layout. Provide them if a specific spatial arrangement is part of the user's instruction (tree, flow, left-to-right, etc.). Use grid-like values in the 100–1600 range.
- "connections.from" and "connections.to" are 0-based indices into the blocks array. Only reference valid indices.
- Produce between 3 and 30 blocks depending on source richness. Err on the side of fewer, higher-signal blocks.
- Preserve the source's original language.
- Do NOT restate the user's instruction as a block. The blocks are the structure itself.`

  const userPrompt = `Instruction: ${prompt}\n\nSource blocks:\n\n${blocks
    .map((t, i) => `--- Block ${i + 1} ---\n${t}`)
    .join("\n\n")}`

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://nodepad.local",
      "X-Title": "nodepad-v2",
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`LLM call failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== "string") throw new Error("LLM returned no content")

  // Be lenient: strip ```json fences if the model slipped them in
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim()
  let parsed: any
  try { parsed = JSON.parse(cleaned) } catch (e: any) {
    throw new Error(`LLM returned invalid JSON: ${e.message}; got: ${cleaned.slice(0, 200)}`)
  }
  if (!parsed || !Array.isArray(parsed.blocks)) throw new Error("LLM JSON missing blocks[] array")
  const outBlocks = parsed.blocks
    .filter((b: any) => b && typeof b.text === "string" && b.text.trim())
    .map((b: any) => ({
      text: String(b.text).trim(),
      x: typeof b.x === "number" ? b.x : undefined,
      y: typeof b.y === "number" ? b.y : undefined,
    }))
  const outConns = Array.isArray(parsed.connections)
    ? parsed.connections
        .filter((c: any) => c && Number.isInteger(c.from) && Number.isInteger(c.to) && c.from !== c.to && c.from >= 0 && c.to >= 0 && c.from < outBlocks.length && c.to < outBlocks.length)
        .map((c: any) => ({ from: c.from as number, to: c.to as number }))
    : []
  if (outBlocks.length === 0) throw new Error("LLM returned no valid blocks")
  return { blocks: outBlocks, connections: outConns }
}

async function callLLM(prompt: string, blocks: string[], settings: Record<string, string>): Promise<string> {
  const provider = settings.provider || "openrouter"
  const apiKey = settings.apiKey || ""
  const modelId = settings.modelId || "anthropic/claude-3.5-sonnet"
  const baseUrl =
    settings.customBaseUrl ||
    (provider === "openai" ? "https://api.openai.com/v1" : "https://openrouter.ai/api/v1")

  if (!apiKey) throw new Error("No API key configured. Set it via /api/settings.")

  const systemPrompt = `You are an augmentation engine inside a spatial thinking canvas.
The user has selected one or more text blocks and issued an instruction.
Return ONE combined text block that satisfies the instruction — nothing more.

Rules:
- Be MINIMAL. Do only what the instruction says. Do not expand, elaborate, or add context the user didn't ask for.
- If the instruction implies a short output (rewrite, shorten, summarize, one sentence, etc.), keep it short. Match the length and register of the input unless told otherwise.
- Plain text only. No markdown formatting — no **bold**, no *italic*, no headings, no bullet lists, no numbered lists, no code fences. Write in prose or on separate lines with plain punctuation.
- No preamble, no commentary, no "here is" wrappers. Just the result.
- Preserve the user's original tone and language.`

  const userPrompt = `Instruction: ${prompt}\n\nSelected blocks:\n\n${blocks
    .map((t, i) => `--- Block ${i + 1} ---\n${t}`)
    .join("\n\n")}`

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://nodepad.local",
      "X-Title": "nodepad-v2",
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.4,
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`LLM call failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== "string") throw new Error("LLM returned no content")
  return content.trim()
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id: sessionId } = await ctx.params
    const body = await req.json().catch(() => ({}))
    const prompt: string = body.prompt || ""
    const selectedIds: string[] = Array.isArray(body.block_ids) ? body.block_ids : []
    const mode: string = body.mode === "structured" ? "structured" : "default"

    if (!prompt.trim()) return NextResponse.json({ error: "prompt required" }, { status: 400 })

    const allNotes = listNotes(sessionId)
    const allConns = listConnections(sessionId)

    // Whole canvas is the scope if no selection
    const scopeIds = selectedIds.length > 0 ? selectedIds : allNotes.map(n => n.id)
    const scopeSet = new Set(scopeIds)
    const scopeNotes = allNotes.filter(n => scopeSet.has(n.id))
    if (scopeNotes.length === 0) return NextResponse.json({ error: "no blocks in scope" }, { status: 400 })

    const settings = loadSettings()

    // ── Structured mode: LLM returns {blocks, connections} → create many notes + connections ──
    if (mode === "structured") {
      const structured = await callLLMStructured(prompt, scopeNotes.map(n => n.text), settings)

      // Snapshot for undo
      const snapshot = {
        mode: "structured" as const,
        deleted_notes: scopeNotes,
        deleted_connections: allConns.filter(c => scopeSet.has(c.from_block_id) || scopeSet.has(c.to_block_id)),
      }

      // Delete scope notes + their connections (internal + external — structured replaces the whole scope)
      for (const c of allConns) {
        if (scopeSet.has(c.from_block_id) || scopeSet.has(c.to_block_id)) deleteConnection(c.id)
      }
      for (const n of scopeNotes) deleteNote(n.id)

      // Centroid for auto-layout fallback
      const cx = scopeNotes.reduce((a, n) => a + n.x, 0) / scopeNotes.length
      const cy = scopeNotes.reduce((a, n) => a + n.y, 0) / scopeNotes.length

      // Auto-layout: 4-col grid around centroid if no x/y given
      const cols = 4
      const SP_X = 220, SP_Y = 130
      const newBlocks: { id: string; text: string; x: number; y: number }[] = []
      const idByIdx: string[] = []
      for (let i = 0; i < structured.blocks.length; i++) {
        const b = structured.blocks[i]
        const hasCoords = typeof b.x === "number" && typeof b.y === "number"
        const x = hasCoords ? b.x! : cx - (cols * SP_X) / 2 + (i % cols) * SP_X
        const y = hasCoords ? b.y! : cy + Math.floor(i / cols) * SP_Y
        const id = genId()
        const n = createNote({
          id,
          session_id: sessionId,
          text: b.text,
          x,
          y,
          is_ai_generated: true,
        })
        newBlocks.push({ id: n.id, text: n.text, x: n.x, y: n.y })
        idByIdx.push(id)
      }
      const newConns: { id: string; from: string; to: string }[] = []
      for (const c of structured.connections) {
        const fromId = idByIdx[c.from]
        const toId = idByIdx[c.to]
        if (!fromId || !toId || fromId === toId) continue
        const nc = createConnection({
          id: genId(),
          session_id: sessionId,
          from_block_id: fromId,
          to_block_id: toId,
        })
        newConns.push({ id: nc.id, from: nc.from_block_id, to: nc.to_block_id })
      }

      return NextResponse.json({
        mode: "structured",
        new_blocks: newBlocks,
        new_connections: newConns,
        snapshot,
      })
    }

    const newText = await callLLM(prompt, scopeNotes.map(n => n.text), settings)

    // Centroid position
    const cx = scopeNotes.reduce((a, n) => a + n.x, 0) / scopeNotes.length
    const cy = scopeNotes.reduce((a, n) => a + n.y, 0) / scopeNotes.length

    const newId = genId()
    const newNote = createNote({
      id: newId,
      session_id: sessionId,
      text: newText,
      x: cx,
      y: cy,
      is_ai_generated: true,
    })

    // Rewire external connections (one endpoint in scope, other outside) to newId
    // Drop internal connections (both endpoints in scope)
    // Snapshot all state first for undo
    const snapshot = {
      deleted_notes: scopeNotes,
      deleted_connections: allConns, // we'll recompute below into internal+external
      new_note_id: newId,
    }

    const rewiredConns: { id: string; from: string; to: string }[] = []

    for (const c of allConns) {
      const fromIn = scopeSet.has(c.from_block_id)
      const toIn = scopeSet.has(c.to_block_id)
      if (fromIn && toIn) {
        // internal — delete, no replacement
        deleteConnection(c.id)
      } else if (fromIn || toIn) {
        // external — delete then create a rewired version pointing at newId
        deleteConnection(c.id)
        const from = fromIn ? newId : c.from_block_id
        const to = toIn ? newId : c.to_block_id
        if (from !== to) {
          const nc = createConnection({
            id: genId(),
            session_id: sessionId,
            from_block_id: from,
            to_block_id: to,
          })
          rewiredConns.push({ id: nc.id, from: nc.from_block_id, to: nc.to_block_id })
        }
      }
    }

    // Delete the scope notes (cascades any remaining conns, should be none)
    for (const n of scopeNotes) deleteNote(n.id)

    return NextResponse.json({
      new_note: newNote,
      rewired_connections: rewiredConns,
      snapshot,
    })
  } catch (e: any) {
    console.error("augment failed:", e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
