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
import { recordCall } from "@/lib/server/ai-log"
import { callClaudeCode, ClaudeCodeError } from "@/lib/server/claude-subprocess"

// Stringify a fetch body's `messages` array into a flat preview string so the
// AI-log panel can show what was actually sent. Image data URLs are stripped
// to size markers by recordCall itself.
/**
 * Wrap an OpenAI-compatible chat/completions fetch with AI-log capture.
 * Records the system prompt, user content (image-stripped), response, latency,
 * and error if any. Returns the parsed response body (re-fetched the raw text
 * once so we can both log it and parse it).
 */
async function fetchAndLog(
  label: string,
  url: string,
  body: any,
  apiKey: string
): Promise<{ ok: boolean; status: number; data: any; text: string }> {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : []
  const systemMsg = messages.find(m => m.role === "system")
  const otherMsgs = messages.filter(m => m.role !== "system")
  const t0 = Date.now()
  let status = 0
  let respText = ""
  let respData: any = null
  let assistantContent = ""
  let errorMsg: string | undefined

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://nodepad.local",
        "X-Title": "nodepad-v2",
      },
      body: JSON.stringify(body),
    })
    status = res.status
    respText = await res.text()
    if (respText) {
      try { respData = JSON.parse(respText) } catch { /* upstream returned non-JSON */ }
    }
    if (!res.ok) {
      errorMsg = `HTTP ${status}: ${respText.slice(0, 300)}`
    }
    assistantContent = respData?.choices?.[0]?.message?.content || ""
  } catch (e: any) {
    errorMsg = e?.message || String(e)
  }

  recordCall({
    label,
    model: String(body?.model || "unknown"),
    system_prompt: typeof systemMsg?.content === "string" ? systemMsg.content : JSON.stringify(systemMsg?.content || ""),
    user_content: previewMessages(otherMsgs),
    response_text: assistantContent || respText,
    response_status: status,
    latency_ms: Date.now() - t0,
    error: errorMsg,
  })

  return { ok: status >= 200 && status < 300, status, data: respData, text: respText }
}

function previewMessages(messages: Array<{ role: string; content: any }>): string {
  return messages
    .map(m => {
      if (typeof m.content === "string") return `[${m.role}]\n${m.content}`
      if (Array.isArray(m.content)) {
        const parts = m.content.map((p: any) => {
          if (p.type === "text") return p.text
          if (p.type === "image_url") return `[image_url: ${p.image_url?.url || ""}]`
          return JSON.stringify(p).slice(0, 200)
        })
        return `[${m.role}]\n${parts.join("\n---\n")}`
      }
      return `[${m.role}]\n${JSON.stringify(m.content).slice(0, 1000)}`
    })
    .join("\n\n========\n\n")
}

const REARRANGE_DEFAULT_MODEL = "google/gemini-3-flash"

// ── Self-hosted Qwen3.6 backend (Ollama, AI Server) ────────────────────────
// Used for default/structured augment when settings.augmentBackend === "qwen".
// Multimodal turns (drawings present) silently fall back to OpenRouter inside
// the dispatchers below. Rearrange always stays on OpenRouter — vision layout
// is the one job we've confirmed Gemini 3 Flash does well and Qwen is untested.
const OLLAMA_URL = process.env.OLLAMA_URL || "http://100.95.37.85:11434"
const OLLAMA_AUGMENT_MODEL = process.env.OLLAMA_AUGMENT_MODEL || "qwen3.6:35b-a3b-q4_K_M"

// ── Claude Code (CLI subprocess) backend ───────────────────────────────────
// Used when settings.augmentBackend === "claude-code". Stateless `claude -p`
// call — no session persistence, no Matrix streaming. Bypasses both OpenRouter
// billing and self-hosted Qwen; piggybacks on the CC subscription.
async function claudeChatPlain(opts: {
  label: string
  systemPrompt: string
  userPrompt: string
  model: string
  timeoutMs?: number
}): Promise<string> {
  const t0 = Date.now()
  let content = ""
  let errorMsg: string | undefined
  try {
    const res = await callClaudeCode({
      prompt: opts.userPrompt,
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      timeoutMs: opts.timeoutMs,
    })
    content = res.text
  } catch (e: any) {
    errorMsg = e instanceof ClaudeCodeError ? e.message : (e?.message || String(e))
    throw e
  } finally {
    recordCall({
      label: opts.label,
      model: `claude-code/${opts.model}`,
      system_prompt: opts.systemPrompt,
      user_content: `[user]\n${opts.userPrompt}`,
      response_text: content || (errorMsg || ""),
      response_status: errorMsg ? 500 : 200,
      latency_ms: Date.now() - t0,
      error: errorMsg,
    })
  }
  return content.trim()
}

async function ollamaChatPlain(opts: {
  label: string
  systemPrompt: string
  userPrompt: string
  jsonMode?: boolean
  numPredict?: number
  temperature?: number
}): Promise<string> {
  const t0 = Date.now()
  const body: any = {
    model: OLLAMA_AUGMENT_MODEL,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userPrompt },
    ],
    stream: false,
    // CRITICAL: Qwen3 thinking mode is on by default and burns through
    // num_predict on internal CoT before emitting content. Disable it.
    // Augment is one-shot text generation — no chain-of-thought needed.
    think: false,
    options: {
      temperature: opts.temperature ?? 0.4,
      num_predict: opts.numPredict ?? 2048,
    },
  }
  if (opts.jsonMode) body.format = "json"

  let status = 0
  let content = ""
  let errorMsg: string | undefined
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    status = res.status
    const text = await res.text()
    if (!res.ok) {
      errorMsg = `HTTP ${status}: ${text.slice(0, 300)}`
      throw new Error(errorMsg)
    }
    const parsed = JSON.parse(text)
    content = String(parsed?.message?.content || "")
  } catch (e: any) {
    errorMsg = errorMsg || e?.message || String(e)
    throw e
  } finally {
    recordCall({
      label: opts.label,
      model: OLLAMA_AUGMENT_MODEL,
      system_prompt: opts.systemPrompt,
      user_content: `[user]\n${opts.userPrompt}`,
      response_text: content || (errorMsg || ""),
      response_status: status,
      latency_ms: Date.now() - t0,
      error: errorMsg,
    })
  }
  return content.trim()
}

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

// A "source block" passed into the LLM. When `image_data_url` is set, it is a
// drawing/sketch and the textual rendering is just a placeholder; the actual
// content is attached as an image_url content part.
type SourceBlock = { text: string; image_data_url?: string }

async function callLLMStructured(prompt: string, blocks: SourceBlock[], settings: Record<string, string>): Promise<StructuredResult> {
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
    .map((b, i) => {
      if (b.image_data_url) {
        return `--- Block ${i + 1} (sketch — see attached image #${i + 1}) ---\n${b.text || "(visual sketch)"}`
      }
      return `--- Block ${i + 1} ---\n${b.text}`
    })
    .join("\n\n")}`

  const hasImages = blocks.some(b => b.image_data_url)

  // Self-hosted Qwen path. Falls back to OpenRouter for multimodal turns.
  let content: string
  if (settings.augmentBackend === "qwen" && !hasImages) {
    content = await ollamaChatPlain({
      label: "augment.structured.qwen",
      systemPrompt,
      userPrompt,
      jsonMode: true,
      temperature: 0.3,
      numPredict: 4096, // structured graphs can be long
    })
  } else if (settings.augmentBackend === "claude-code" && !hasImages) {
    // Claude Code subprocess. Vision falls through to OpenRouter path below
    // because `claude -p` image support requires a tempfile dance we haven't
    // plumbed yet.
    const ccModel = settings.claudeCodeModel || "claude-opus-4-7"
    content = await claudeChatPlain({
      label: "augment.structured.claude-code",
      systemPrompt,
      userPrompt,
      model: ccModel,
    })
  } else {
    const provider = settings.provider || "openrouter"
    const apiKey = settings.apiKey || ""
    const modelId = settings.modelId || "anthropic/claude-3.5-sonnet"
    const baseUrl =
      settings.customBaseUrl ||
      (provider === "openai" ? "https://api.openai.com/v1" : "https://openrouter.ai/api/v1")
    if (!apiKey) throw new Error("No API key configured. Set it via /api/settings.")

    // Multimodal user content: text first, then any drawing images in source order.
    const userContent: any[] = [{ type: "text", text: userPrompt }]
    for (const b of blocks) {
      if (b.image_data_url) userContent.push({ type: "image_url", image_url: { url: b.image_data_url } })
    }
    const useMultimodal = userContent.length > 1

    const res = await fetchAndLog("augment.structured", `${baseUrl}/chat/completions`, {
      model: modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: useMultimodal ? userContent : userPrompt },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    }, apiKey)
    if (!res.ok) {
      throw new Error(`LLM call failed (${res.status}): ${res.text.slice(0, 300)}`)
    }
    const data = res.data
    const c = data?.choices?.[0]?.message?.content
    if (typeof c !== "string") throw new Error("LLM returned no content")
    content = c
  }

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
1. An image of the current canvas. Each text block is visible at its actual
   position. Some blocks may be DRAWINGS / DIAGRAMS — visible as embedded
   sketches, shapes, arrows. Treat their internal visual structure as
   meaningful, not as decoration.
2. A JSON list of the in-scope blocks with their text and their (x, y, w, h) in
   the image's coordinate frame, where the image spans [0, 1000] on both axes.
3. The user's instruction describing how they want the blocks rearranged.

Your job: decide a new (x, y) for each in-scope block so the resulting layout
matches the user's instruction, using the image to ground your spatial sense.
You may also propose new connections between in-scope blocks, or removals of
existing within-scope connections, when the instruction implies it.

## Layout philosophy (read carefully)

DO NOT default to a uniform grid. A spatial canvas is not a spreadsheet. If you
arrange every block on a regular column/row pitch you are wasting the medium.

Use the canvas like a designer would:
- VARY y positions to express hierarchy, depth, sequence. Create visible
  "levels" rather than rows of identical height.
- VARY x positions to express grouping, branching, parallel paths. A hub block
  with three children should look like a hub with three children — children
  fanned out at different x, joined by lines that all meet at one point.
- LEAVE GENEROUS WHITESPACE. Use the full [0, 1000]×[0, 1000] frame. Don't
  cluster everything into a single quadrant.
- When the user's instruction names a SHAPE or PATTERN ("tree", "timeline",
  "pyramid", "flow", "vertical", "left-to-right", "below the diagram"),
  produce that shape literally and recognizably. Not an approximation that
  collapses back into a grid.

## Diagrams as layout templates (very important)

When the in-scope (or visible-in-image) blocks include a drawing/diagram, the
diagram's INTERNAL structure is the strongest signal you have for how the
text blocks relate. Mirror it.

- If the diagram shows a vertical pyramid (top → middle → bottom), arrange the
  related text blocks in matching vertical bands at matching x ranges.
- If the diagram has 2 branches at the top and 1 trunk at the bottom, place
  the corresponding text blocks in 2 columns up top and merge them into 1
  column at the bottom.
- If the diagram has a hub with spokes, place text blocks at spoke endpoints.
- Use semantic matching: a text block that mentions "Server" sits near the
  Server icon's vertical band; a text block about "Database" sits near the
  database element. Do NOT just rank-order text blocks alphabetically into a
  grid below the diagram.

If the user says "arrange the text blocks like the diagram below it" / "mirror
the diagram structure" / similar — take that LITERALLY. Read the diagram, find
its branches and hubs, and reproduce that spatial topology with the text
blocks. Do NOT fall back to a 4×N grid because grids are easier.

## Constraints

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

  const res = await fetchAndLog("augment.rearrange", `${baseUrl}/chat/completions`, {
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
  }, apiKey)

  if (!res.ok) {
    // Detect the common "model doesn't accept images" failure shape and rewrite.
    if (/image|multimodal|vision|content type/i.test(res.text)) {
      throw new Error(
        `Model "${modelId}" doesn't accept images. Switch to a vision-capable model (e.g. ${REARRANGE_DEFAULT_MODEL}) in settings.`
      )
    }
    throw new Error(`LLM call failed (${res.status}): ${res.text.slice(0, 300)}`)
  }
  const data = res.data
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

// Refinement pass for rearrange. The LLM gets:
//   1. Original canvas image (state before the first rearrange pass)
//   2. Proposed canvas image (what the canvas WILL look like if we accept the
//      first-pass positions — the client renders it client-side and ships it)
//   3. The proposed positions of every in-scope block in the 0–1000 frame
//   4. The user's original instruction
// Output is the same `moves` shape as the first pass — only positions to change.
// The model is instructed to return [] when the proposed layout already
// satisfies the instruction (no thrash).
async function callLLMRearrangeRefine(
  prompt: string,
  proposedBlocksInFrame: FrameBlock[],
  originalImageDataUrl: string,
  proposedImageDataUrl: string,
  settings: Record<string, string>
): Promise<{ moves: { block_id: string; x: number; y: number }[] }> {
  const provider = settings.provider || "openrouter"
  const apiKey = settings.apiKey || ""
  const modelId = settings.rearrangeModelId || settings.modelId || REARRANGE_DEFAULT_MODEL
  const baseUrl =
    settings.customBaseUrl ||
    (provider === "openai" ? "https://api.openai.com/v1" : "https://openrouter.ai/api/v1")
  if (!apiKey) throw new Error("No API key configured.")

  const allowedIds = new Set(proposedBlocksInFrame.map(b => b.id))

  const systemPrompt = `You are doing a REFINEMENT pass on a spatial canvas layout.

A previous pass already produced positions for the blocks. You are now seeing
the actual rendered result of that pass. Your job is to look at the rendered
output and decide whether it actually satisfies the user's instruction — and
if not, make targeted corrections.

You will receive:
1. ORIGINAL image: what the canvas looked like BEFORE the first rearrange.
2. PROPOSED image: what the canvas will look like if we accept the first-pass
   positions as-is. This is the actual rendered DOM, including any drawing
   blocks, connections, and text wrapping.
3. JSON list of in-scope blocks at their PROPOSED positions in the 0–1000
   frame (so you can refer to coordinates).
4. The user's original instruction.

## What to do

- LOOK AT THE PROPOSED IMAGE. Be critical. The first pass was BLIND — it
  output coordinates without ever seeing the rendered DOM, including text
  wrap, drawings, and connection lines. Most first-pass results need at
  least some refinement. Default to refining unless it is genuinely good.
- Specifically critique:
  * Did blocks land where the user actually wants them given the
    instruction? (Read the instruction literally.)
  * Is there a clear visual hierarchy / branching / shape, or did it
    collapse into rows and columns?
  * If a drawing/diagram is in scope, do the text blocks visually mirror
    its structure (branches, hubs, vertical bands) or are they just stuck
    in a grid below it?
  * Are blocks using the full 0–1000 frame in BOTH dimensions, or
    clustered in one quadrant?
- If everything is GENUINELY perfect, return { "moves": [] } — but do not
  return [] just to be polite. Only return [] when the proposed image
  actually shows the layout the instruction asked for.
- Output corrected positions for every block that should move. Omit any
  block that is already in the right place.

## Common failure modes to watch for

- 4-column or N-row uniform grid when the user asked for any other shape.
- All blocks clustered into one quadrant (top-left, etc) instead of using
  the full 0–1000 × 0–1000 frame.
- Text blocks ignoring an in-scope diagram's branching/hierarchy and lined
  up in alphabetical or arbitrary order instead.
- Blocks visibly overlapping in the proposed image (the client's collision
  resolver only handles tiny overlaps).
- Blocks drifting off-frame (x or y near 0 or near 1000).

## Constraints

- Coordinates stay in [0, 1000].
- Do not change block text, do not add or delete blocks, do not output sizes.
- Only move blocks that need it. Empty moves array is a valid and preferred
  output when the proposal is good enough.

Return ONLY valid JSON in this exact shape:

{ "moves": [{ "block_id": "abc123", "x": 240, "y": 600 }] }`

  const userText = `Original instruction: ${prompt}

Proposed in-scope blocks (in 0–1000 frame):
${JSON.stringify(proposedBlocksInFrame, null, 2)}

Image 1 (ORIGINAL): the canvas before any rearrange.
Image 2 (PROPOSED): the canvas after the first rearrange pass — this is what the user will see if you return an empty moves array. Refine only if it doesn't match the instruction.`

  const res = await fetchAndLog("augment.rearrange-refine", `${baseUrl}/chat/completions`, {
    model: modelId,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: originalImageDataUrl } },
          { type: "image_url", image_url: { url: proposedImageDataUrl } },
        ],
      },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" },
  }, apiKey)

  if (!res.ok) {
    throw new Error(`Refine LLM call failed (${res.status}): ${res.text.slice(0, 300)}`)
  }
  const data = res.data
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== "string") throw new Error("Refine LLM returned no content")

  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim()
  let parsed: any
  try { parsed = JSON.parse(cleaned) } catch (e: any) {
    throw new Error(`Refine LLM returned invalid JSON: ${e.message}; got: ${cleaned.slice(0, 200)}`)
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

  return { moves }
}

async function callLLM(prompt: string, blocks: SourceBlock[], settings: Record<string, string>): Promise<string> {
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
    .map((b, i) => {
      if (b.image_data_url) {
        return `--- Block ${i + 1} (sketch — see attached image #${i + 1}) ---\n${b.text || "(visual sketch)"}`
      }
      return `--- Block ${i + 1} ---\n${b.text}`
    })
    .join("\n\n")}`

  const hasImages = blocks.some(b => b.image_data_url)

  // Self-hosted Qwen path. Falls back to OpenRouter if any drawing/image is in
  // scope (Qwen vision is not exercised here yet).
  if (settings.augmentBackend === "qwen" && !hasImages) {
    return ollamaChatPlain({
      label: "augment.default.qwen",
      systemPrompt,
      userPrompt,
      temperature: 0.4,
      numPredict: 1024,
    })
  }

  // Claude Code subprocess path. Images fall through to OpenRouter.
  if (settings.augmentBackend === "claude-code" && !hasImages) {
    const ccModel = settings.claudeCodeModel || "claude-opus-4-7"
    return claudeChatPlain({
      label: "augment.default.claude-code",
      systemPrompt,
      userPrompt,
      model: ccModel,
    })
  }

  const provider = settings.provider || "openrouter"
  const apiKey = settings.apiKey || ""
  const modelId = settings.modelId || "anthropic/claude-3.5-sonnet"
  const baseUrl =
    settings.customBaseUrl ||
    (provider === "openai" ? "https://api.openai.com/v1" : "https://openrouter.ai/api/v1")

  if (!apiKey) throw new Error("No API key configured. Set it via /api/settings.")

  const userContent: any[] = [{ type: "text", text: userPrompt }]
  for (const b of blocks) {
    if (b.image_data_url) userContent.push({ type: "image_url", image_url: { url: b.image_data_url } })
  }
  const useMultimodal = userContent.length > 1

  const res = await fetchAndLog("augment.default", `${baseUrl}/chat/completions`, {
    model: modelId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: useMultimodal ? userContent : userPrompt },
    ],
    temperature: 0.4,
  }, apiKey)

  if (!res.ok) {
    throw new Error(`LLM call failed (${res.status}): ${res.text.slice(0, 300)}`)
  }
  const data = res.data
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
      : body.mode === "rearrange-refine" ? "rearrange-refine"
      : "default"

    if (!prompt.trim()) return NextResponse.json({ error: "prompt required" }, { status: 400 })

    // Refine mode is stateless w.r.t. the DB — it just calls the LLM with two
    // images and returns moves. No DB writes here; the client does the PATCH
    // after both passes complete.
    if (mode === "rearrange-refine") {
      const originalImageDataUrl: string = body.original_image_data_url || ""
      const proposedImageDataUrl: string = body.proposed_image_data_url || ""
      const proposedBlocksInFrame: FrameBlock[] = Array.isArray(body.proposed_blocks_in_frame)
        ? body.proposed_blocks_in_frame
        : []
      if (!originalImageDataUrl.startsWith("data:image/") || !proposedImageDataUrl.startsWith("data:image/")) {
        return NextResponse.json({ error: "original_image_data_url and proposed_image_data_url required" }, { status: 400 })
      }
      if (proposedBlocksInFrame.length === 0) {
        return NextResponse.json({ error: "proposed_blocks_in_frame required" }, { status: 400 })
      }
      if (originalImageDataUrl.length > 700_000 || proposedImageDataUrl.length > 700_000) {
        return NextResponse.json({ error: "snapshot too large; zoom in or select a subset" }, { status: 413 })
      }
      const settings = loadSettings()
      const result = await callLLMRearrangeRefine(
        prompt,
        proposedBlocksInFrame,
        originalImageDataUrl,
        proposedImageDataUrl,
        settings
      )
      return NextResponse.json({ mode: "rearrange-refine", moves: result.moves })
    }

    const allNotes = listNotes(sessionId)
    const allConns = listConnections(sessionId)

    // Whole canvas is the scope if no selection
    const scopeIds = selectedIds.length > 0 ? selectedIds : allNotes.map(n => n.id)
    const scopeSet = new Set(scopeIds)
    const scopeNotes = allNotes.filter(n => scopeSet.has(n.id))
    // Empty scope is OK for structured mode — it's purely additive (the user just
    // wants new blocks created from the prompt, no existing source). Default and
    // rearrange need at least one block to operate on.
    if (scopeNotes.length === 0 && mode !== "structured") {
      return NextResponse.json({ error: "no blocks in scope" }, { status: 400 })
    }

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

    // Drawing PNGs the client may have rendered for any in-scope drawing blocks.
    // Shape: { [block_id]: "data:image/png;base64,..." }
    const drawingImages: Record<string, string> = (body && typeof body.drawing_images === "object" && body.drawing_images) || {}

    // Build SourceBlock list once, in scope order. For drawing kind, the text
    // field stores the Excalidraw scene JSON which is huge and useless to the
    // LLM; replace with a placeholder and attach the PNG.
    const sourceBlocks: SourceBlock[] = scopeNotes.map(n => {
      if (n.kind === "drawing") {
        const url = drawingImages[n.id]
        return { text: "(visual sketch)", image_data_url: typeof url === "string" && url.startsWith("data:image/") ? url : undefined }
      }
      return { text: n.text }
    })

    // ── Structured mode: LLM returns {blocks, connections} → create many notes + connections ──
    if (mode === "structured") {
      const structured = await callLLMStructured(prompt, sourceBlocks, settings)

      // Drawings in scope stay put — they're authored visual content, not text
      // the LLM can regenerate. They still participate as multimodal context
      // (handled in sourceBlocks above), and their connections to the outside
      // world (and to surviving drawings) are preserved.
      const deletableNotes = scopeNotes.filter(n => n.kind !== "drawing")
      const deletableSet = new Set(deletableNotes.map(n => n.id))

      // Snapshot for undo — only what we actually delete
      const snapshot = {
        mode: "structured" as const,
        deleted_notes: deletableNotes,
        deleted_connections: allConns.filter(c => deletableSet.has(c.from_block_id) || deletableSet.has(c.to_block_id)),
      }

      // Delete scope notes (excluding drawings) + their connections.
      // A connection only gets deleted if it touches a deletable block — so an
      // arrow from a drawing to a surviving-outside-scope block stays intact.
      for (const c of allConns) {
        if (deletableSet.has(c.from_block_id) || deletableSet.has(c.to_block_id)) deleteConnection(c.id)
      }
      for (const n of deletableNotes) deleteNote(n.id)

      // Centroid for auto-layout fallback. Use the full scope (including drawings)
      // so new blocks land in the visual middle of what the user selected. For
      // an empty canvas (Drive Mode first turn), fall back to a sensible spot.
      const cx = scopeNotes.length > 0
        ? scopeNotes.reduce((a, n) => a + n.x, 0) / scopeNotes.length
        : 400
      const cy = scopeNotes.length > 0
        ? scopeNotes.reduce((a, n) => a + n.y, 0) / scopeNotes.length
        : 200

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

    const newText = await callLLM(prompt, sourceBlocks, settings)

    // Same drawing-preservation rule as structured: drawings in scope stay put.
    // They served as visual context for the LLM (via sourceBlocks) but never
    // get destroyed. Connection rewiring + deletion only operates on the
    // text/task blocks the LLM is actually replacing.
    const deletableNotes = scopeNotes.filter(n => n.kind !== "drawing")
    const deletableSet = new Set(deletableNotes.map(n => n.id))

    // Centroid position — placed at the center of the deletable blocks (the
    // ones being replaced). If the only thing in scope is a drawing, fall back
    // to the full-scope centroid so the new block lands near the drawing.
    const centroidNotes = deletableNotes.length > 0 ? deletableNotes : scopeNotes
    const cx = centroidNotes.reduce((a, n) => a + n.x, 0) / centroidNotes.length
    const cy = centroidNotes.reduce((a, n) => a + n.y, 0) / centroidNotes.length

    const newId = genId()
    const newNote = createNote({
      id: newId,
      session_id: sessionId,
      text: newText,
      x: cx,
      y: cy,
      is_ai_generated: true,
    })

    // Rewire external connections (one endpoint deletable, other surviving) to newId.
    // Drop internal connections (both endpoints deletable). Connections to/from
    // surviving drawings are left untouched.
    // Snapshot all state first for undo
    const snapshot = {
      deleted_notes: deletableNotes,
      deleted_connections: allConns, // we'll recompute below into internal+external
      new_note_id: newId,
    }

    const rewiredConns: { id: string; from: string; to: string }[] = []

    for (const c of allConns) {
      const fromIn = deletableSet.has(c.from_block_id)
      const toIn = deletableSet.has(c.to_block_id)
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

    // Delete the deletable scope notes (cascades any remaining conns, should be none).
    // Drawings stay.
    for (const n of deletableNotes) deleteNote(n.id)

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
