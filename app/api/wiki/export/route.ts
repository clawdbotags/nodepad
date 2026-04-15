import { NextResponse } from "next/server"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { execFile } from "child_process"
import { promisify } from "util"
import { getSession, listNotes, listConnections } from "@/lib/server/db"

const execFileP = promisify(execFile)

// POST /api/wiki/export
// body: { session_id: string, agent: "atlas"|"coach"|"engineer"|"vault", commit?: boolean }
// Writes markdown to ~/.openfang/wikis/<agent>/pages/nodepad-<slug>.md and (optionally) git-commits.

const ALLOWED_AGENTS = new Set(["atlas", "coach", "engineer", "vault"])
const WIKI_ROOT = path.join(os.homedir(), ".openfang", "wikis")

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60) || "canvas"
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const sessionId: string = body.session_id
    const agent: string = body.agent
    const commit: boolean = body.commit !== false

    if (!sessionId) {
      return NextResponse.json({ error: "session_id required" }, { status: 400 })
    }
    if (!ALLOWED_AGENTS.has(agent)) {
      return NextResponse.json({ error: `agent must be one of ${[...ALLOWED_AGENTS].join(", ")}` }, { status: 400 })
    }

    const session = getSession(sessionId)
    if (!session) {
      return NextResponse.json({ error: "session not found" }, { status: 404 })
    }
    const notes = listNotes(sessionId)
    const connections = listConnections(sessionId)

    const pagesDir = path.join(WIKI_ROOT, agent, "pages")
    await fs.mkdir(pagesDir, { recursive: true })

    const base = `nodepad-${slug(session.name)}`
    const filename = `${base}.md`
    const filepath = path.join(pagesDir, filename)

    const lines: string[] = []
    lines.push(`# ${session.name}`)
    lines.push("")
    lines.push(`> Exported from nodepad-v2 session \`${session.id}\` on ${new Date().toISOString().slice(0, 10)}.`)
    lines.push(`> Live canvas: http://localhost:3034/?session=${session.id}`)
    lines.push("")
    for (const n of notes) {
      const marker = n.is_ai_generated ? " _(AI-generated)_" : ""
      lines.push(`- ${String(n.text).replace(/\n/g, "\n  ")}${marker}`)
    }
    if (connections.length > 0) {
      lines.push("")
      lines.push("## Connections")
      lines.push("")
      for (const c of connections) {
        const f = notes.find((n: any) => n.id === c.from_block_id)?.text?.slice(0, 40) || c.from_block_id
        const t = notes.find((n: any) => n.id === c.to_block_id)?.text?.slice(0, 40) || c.to_block_id
        lines.push(`- ${f} → ${t}`)
      }
    }
    lines.push("")
    lines.push("## Embed")
    lines.push("")
    lines.push("```canvas")
    lines.push(`session: ${session.id}`)
    lines.push("height: 500")
    lines.push("```")

    await fs.writeFile(filepath, lines.join("\n"), "utf8")

    let committed = false
    if (commit) {
      try {
        await execFileP("git", ["-C", WIKI_ROOT, "add", filepath])
        await execFileP("git", ["-C", WIKI_ROOT, "commit", "-m", `nodepad export: ${agent}/${filename}`])
        committed = true
      } catch {
        // non-fatal: maybe nothing to commit or git unavailable
      }
    }

    return NextResponse.json({
      ok: true,
      path: filepath,
      relative: `${agent}/pages/${filename}`,
      committed,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
