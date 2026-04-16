import { NextResponse } from "next/server"
import {
  getDb,
  listNotes,
  listConnections,
  createNote,
  createConnection,
  deleteNote,
  deleteConnection,
  updateNote,
  getSettings,
} from "@/lib/server/db"
import { decrypt, isSensitiveKey } from "@/lib/server/crypto"

const REARRANGE_DEFAULT_MODEL = "google/gemini-3-flash"

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

  const inputCount = blocks.length
  // Scale output target with input size. Default: preserve information — roughly half
  // the input count, never less than a third, never more than input count.
  // User instruction can override (e.g. "summarize to 5 blocks").
  const minBlocks = Math.max(3, Math.ceil(inputCount / 3))
  const maxBlocks = Math.max(minBlocks + 2, Math.ceil(inputCount * 1.2))
  const targetBlocks = Math.max(minBlocks, Math.ceil(inputCount / 2))

  const systemPrompt = `You are a structuring engine for a spatial thinking canvas. The user provides ${inputCount} source blocks and an instruction. You must return a JSON object that defines a graph of text blocks on a 2D canvas.

Return ONLY valid JSON. No markdown fences, no prose, no commentary. The exact shape is:

{
  "blocks": [
    { "text": "substantive sentence or phrase", "x": 100, "y": 100 }
  ],
  "connections": [
    { "from": 0, "to": 1 }
  ]
}

## Information preservation (critical)

- The source has ${inputCount} blocks. Your output should have approximately ${targetBlocks} blocks (minimum ${minBlocks}, maximum ${maxBlocks}) UNLESS the user's instruction explicitly asks for a different count ("summarize to 5", "expand into 40", etc.).
- Default behavior is to PRESERVE information, not to condense. A 60-block page becomes ~30 blocks, not 3. Think of it as re-organizing and reconnecting, not summarizing.
- Each block can be a full sentence or clause (up to ~25 words) when the source material is substantive. Don't compress to 4-word labels unless the source is already label-like. Only go very short when the user explicitly asks for a concept map, keyword graph, or label hierarchy.
- Preserve the source's original language. Preserve specific terms, names, numbers verbatim.

## Connections

- "connections.from" and "connections.to" are 0-based indices into the blocks array you return.
- Connections must express a real semantic relationship: causes, contains, leads-to, depends-on, contrasts-with, etc. Not merely "these were near each other in the source."
- Typical density: between 0.5× and 1.5× the block count. A graph of 30 blocks usually has 15–45 edges. Fewer is fine if content doesn't warrant more; do not invent edges.
- No self-loops, no duplicate edges. Indices must be valid.

## Layout

- "x"/"y" are optional. Provide them only when the user's instruction specifies a spatial arrangement (tree, flow, left-to-right, hierarchy, timeline). Use values in the 100–1800 range, roughly 200–300 apart. Otherwise omit x/y and let the canvas auto-layout.

## What NOT to do

- Do not restate the user's instruction as a block.
- Do not collapse many distinct ideas into one block just to make the graph "cleaner."
- Do not produce 3 blocks from 60 source blocks. That is information destruction, not structuring.
- Do not produce connections without a stated reason; every edge should correspond to something in the source.`

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

// Rearrange: vision-grounded freeform layout. The LLM gets an image of the
// canvas plus a JSON list of in-scope blocks (with text + (x, y, w, h) in a
// 0–1000 normalized frame matching the image) and returns new (x, y) positions
// for whichever blocks should move, plus optional connection edits.
type RearrangeResult = {
  moves: { block_id: string; x: number; y: number }[]
  new_connections: { from_id: string; to_id: string }[]
  removed_connection_ids: string[]
}

type FrameBlock = { id: string; text: string; x: number; y: number; w: number; h: number }
type FrameConn = { id: string; from_id: string; to_id: string }

async function callLLMRearrange(
  prompt: string,
  blocksInFrame: FrameBlock[],
  existingConns: FrameConn[],
  imageDataUrl: string,
  settings: Record<string, string>
): Promise<RearrangeResult> {
  const provider = settings.provider || "openrouter"
  const apiKey = settings.apiKey || ""
  // Allow per-mode override via `rearrangeModelId`, else fall back to global modelId,
  // else the spec-mandated default (Gemini 3 Flash).
  const modelId = settings.rearrangeModelId || settings.modelId || REARRANGE_DEFAULT_MODEL
  const baseUrl =
    settings.customBaseUrl ||
    (provider === "openai" ? "https://api.openai.com/v1" : "https://openrouter.ai/api/v1")
  if (!apiKey) throw new Error("No API key configured. Set it via /api/settings.")

  const allowedIds = new Set(blocksInFrame.map(b => b.id))
  const allowedConnIds = new Set(existingConns.map(c => c.id))

  const systemPrompt = `You are a spatial layout assistant for a thinking canvas.

You will receive:
1. An image of the current canvas. Each text block is visible at its actual position.
2. A JSON list of the in-scope blocks with their text and their (x, y, w, h) in
   the image's coordinate frame, where the image spans [0, 1000] on both axes.
3. The user's instruction describing how they want the blocks rearranged.

Your job: decide a new (x, y) for each in-scope block so the resulting layout
matches the user's instruction, using the image to ground your spatial sense.
You may also propose new connections between in-scope blocks, or removals of
existing within-scope connections, when the instruction implies it.

Constraints:
- Coordinates are in the same 0–1000 frame. Stay within [0, 1000] on both axes.
- Do not change block text. Do not add or delete blocks. Do not change block
  sizes — w and h are given so you can avoid overlaps; you do not output them.
- Avoid heavy overlaps. The client will nudge tiny overlaps apart, but two
  blocks should not be assigned the same point.
- Only include blocks whose position should change in "moves". Omitting a block
  means "leave it where it is."
- Connection ids in "removed_connection_ids" must come from the supplied
  existing_connections list.

Return ONLY valid JSON, no markdown, no commentary, in this exact shape:

{
  "moves": [{ "block_id": "abc123", "x": 240, "y": 600 }],
  "new_connections": [{ "from_id": "abc123", "to_id": "def456" }],
  "removed_connection_ids": []
}`

  const userText = `Instruction: ${prompt}

In-scope blocks (coords already in 0–1000 frame):
${JSON.stringify(blocksInFrame, null, 2)}

Existing within-scope connections:
${JSON.stringify(existingConns, null, 2)}`

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
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    // Detect the common "model doesn't accept images" failure shape and rewrite.
    if (/image|multimodal|vision|content type/i.test(text)) {
      throw new Error(
        `Model "${modelId}" doesn't accept images. Switch to a vision-capable model (e.g. ${REARRANGE_DEFAULT_MODEL}) in settings.`
      )
    }
    throw new Error(`LLM call failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== "string") throw new Error("LLM returned no content")

  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim()
  let parsed: any
  try { parsed = JSON.parse(cleaned) } catch (e: any) {
    throw new Error(`LLM returned invalid JSON: ${e.message}; got: ${cleaned.slice(0, 200)}`)
  }

  const clamp = (v: number) => Math.max(0, Math.min(1000, v))
  const moves = Array.isArray(parsed.moves)
    ? parsed.moves
        .filter((m: any) =>
          m && typeof m.block_id === "string" && allowedIds.has(m.block_id)
          && typeof m.x === "number" && typeof m.y === "number"
          && Number.isFinite(m.x) && Number.isFinite(m.y))
        .map((m: any) => ({ block_id: m.block_id as string, x: clamp(m.x), y: clamp(m.y) }))
    : []
  const newConns = Array.isArray(parsed.new_connections)
    ? parsed.new_connections
        .filter((c: any) =>
          c && typeof c.from_id === "string" && typeof c.to_id === "string"
          && c.from_id !== c.to_id
          && allowedIds.has(c.from_id) && allowedIds.has(c.to_id))
        .map((c: any) => ({ from_id: c.from_id as string, to_id: c.to_id as string }))
    : []
  const removed = Array.isArray(parsed.removed_connection_ids)
    ? parsed.removed_connection_ids.filter((id: any) => typeof id === "string" && allowedConnIds.has(id))
    : []

  return { moves, new_connections: newConns, removed_connection_ids: removed }
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
    const mode: string =
      body.mode === "structured" ? "structured"
      : body.mode === "rearrange" ? "rearrange"
      : "default"

    if (!prompt.trim()) return NextResponse.json({ error: "prompt required" }, { status: 400 })

    const allNotes = listNotes(sessionId)
    const allConns = listConnections(sessionId)

    // Whole canvas is the scope if no selection
    const scopeIds = selectedIds.length > 0 ? selectedIds : allNotes.map(n => n.id)
    const scopeSet = new Set(scopeIds)
    const scopeNotes = allNotes.filter(n => scopeSet.has(n.id))
    if (scopeNotes.length === 0) return NextResponse.json({ error: "no blocks in scope" }, { status: 400 })

    const settings = loadSettings()

    // ── Rearrange mode: vision-grounded, freeform spatial layout ──────────────
    if (mode === "rearrange") {
      const imageDataUrl: string = body.image_data_url || ""
      const blocksInFrame: FrameBlock[] = Array.isArray(body.blocks_in_frame) ? body.blocks_in_frame : []
      if (!imageDataUrl.startsWith("data:image/")) {
        return NextResponse.json({ error: "image_data_url required (canvas snapshot)" }, { status: 400 })
      }
      if (blocksInFrame.length === 0) {
        return NextResponse.json({ error: "blocks_in_frame required" }, { status: 400 })
      }
      // Reject grossly oversized images (~700KB base64 ≈ 512KB binary)
      if (imageDataUrl.length > 700_000) {
        return NextResponse.json({ error: "snapshot too large; zoom in or select a subset" }, { status: 413 })
      }

      // Within-scope existing connections — these are the only ones the LLM may remove.
      const withinScopeConns: FrameConn[] = allConns
        .filter(c => scopeSet.has(c.from_block_id) && scopeSet.has(c.to_block_id))
        .map(c => ({ id: c.id, from_id: c.from_block_id, to_id: c.to_block_id }))

      const result = await callLLMRearrange(prompt, blocksInFrame, withinScopeConns, imageDataUrl, settings)

      // Snapshot for undo: prior positions of every scope block (regardless of whether it moves —
      // so a redo of the rearrange replays the same diff), plus the full set of within-scope
      // connections (so we can restore those deleted by the LLM) and which connection IDs we
      // create now (so undo deletes them).
      const priorPositions = scopeNotes.map(n => ({ id: n.id, x: n.x, y: n.y }))
      const removedConnObjs = allConns.filter(c => result.removed_connection_ids.includes(c.id))

      // CRITICAL: do NOT write the LLM's positions to DB here. They're in the
      // client's 0–1000 normalized frame; the client converts back to canvas
      // pixels, runs the collision resolver, and PATCHes positions itself.
      // Only the connection diff is applied server-side.
      const db = getDb()
      const addedConnIds: string[] = []
      const newConnRecords: { id: string; from_id: string; to_id: string }[] = []
      const tx = db.transaction(() => {
        for (const id of result.removed_connection_ids) {
          deleteConnection(id)
        }
        for (const c of result.new_connections) {
          // Skip duplicate edges (same pair already exists, or we're re-creating one we just removed)
          const dupe = allConns.some(
            ec => !result.removed_connection_ids.includes(ec.id) &&
                  ((ec.from_block_id === c.from_id && ec.to_block_id === c.to_id) ||
                   (ec.from_block_id === c.to_id && ec.to_block_id === c.from_id))
          )
          if (dupe) continue
          const newId = genId()
          createConnection({ id: newId, session_id: sessionId, from_block_id: c.from_id, to_block_id: c.to_id })
          addedConnIds.push(newId)
          newConnRecords.push({ id: newId, from_id: c.from_id, to_id: c.to_id })
        }
      })
      tx()

      return NextResponse.json({
        mode: "rearrange",
        // Moves are returned in the same 0–1000 frame the client sent; client
        // converts them back to canvas pixels.
        moves: result.moves,
        new_connections: newConnRecords,
        removed_connection_ids: result.removed_connection_ids,
        snapshot: {
          mode: "rearrange" as const,
          prior_positions: priorPositions,
          added_connection_ids: addedConnIds,
          removed_connections: removedConnObjs.map(c => ({
            id: c.id, from_block_id: c.from_block_id, to_block_id: c.to_block_id, label: c.label,
          })),
        },
      })
    }

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
