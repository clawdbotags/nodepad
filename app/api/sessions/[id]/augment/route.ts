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
Return ONE combined text block that satisfies the instruction.
Output ONLY the resulting text — no preamble, no commentary, no markdown fences.`

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

    if (!prompt.trim()) return NextResponse.json({ error: "prompt required" }, { status: 400 })

    const allNotes = listNotes(sessionId)
    const allConns = listConnections(sessionId)

    // Whole canvas is the scope if no selection
    const scopeIds = selectedIds.length > 0 ? selectedIds : allNotes.map(n => n.id)
    const scopeSet = new Set(scopeIds)
    const scopeNotes = allNotes.filter(n => scopeSet.has(n.id))
    if (scopeNotes.length === 0) return NextResponse.json({ error: "no blocks in scope" }, { status: 400 })

    const settings = loadSettings()
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
