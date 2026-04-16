import { NextResponse } from "next/server"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { getSession } from "@/lib/server/db"

// POST /api/report-issue
// Body:
// {
//   session_id: string
//   note?: string                 // user's description of what's wrong
//   prompt?: string               // augment prompt (if reporting an augment)
//   mode?: string                 // augment mode (default | structured | rearrange | connect | label)
//   before_png?: string           // data:image/png;base64,...
//   after_png?: string            // data:image/png;base64,...
//   before_state?: any            // {blocks, connections} snapshot
//   after_state?: any             // {blocks, connections} snapshot
// }
// Writes to ~/.openfang/workspaces/engineer/incoming/report-<slug>-<ts>/
// containing before.png, after.png, before.json, after.json, meta.json (whichever provided).

const INCOMING_ROOT = path.join(
  os.homedir(),
  ".openfang",
  "workspaces",
  "engineer",
  "incoming"
)

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40) || "canvas"
}

function dataUrlToBuffer(dataUrl: string): Buffer | null {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl)
  if (!m) return null
  return Buffer.from(m[1], "base64")
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const sessionId: string = body.session_id
    if (!sessionId) {
      return NextResponse.json({ error: "session_id required" }, { status: 400 })
    }

    const session = getSession(sessionId)
    if (!session) {
      return NextResponse.json({ error: "session not found" }, { status: 404 })
    }

    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .slice(0, 19)
    const dirName = `report-${slug(session.name)}-${ts}`
    const dirPath = path.join(INCOMING_ROOT, dirName)
    await fs.mkdir(dirPath, { recursive: true })

    const writes: Promise<unknown>[] = []

    if (typeof body.before_png === "string") {
      const buf = dataUrlToBuffer(body.before_png)
      if (buf) writes.push(fs.writeFile(path.join(dirPath, "before.png"), buf))
    }
    if (typeof body.after_png === "string") {
      const buf = dataUrlToBuffer(body.after_png)
      if (buf) writes.push(fs.writeFile(path.join(dirPath, "after.png"), buf))
    }
    if (body.before_state) {
      writes.push(
        fs.writeFile(
          path.join(dirPath, "before.json"),
          JSON.stringify(body.before_state, null, 2)
        )
      )
    }
    if (body.after_state) {
      writes.push(
        fs.writeFile(
          path.join(dirPath, "after.json"),
          JSON.stringify(body.after_state, null, 2)
        )
      )
    }

    const meta = {
      session_id: session.id,
      session_name: session.name,
      timestamp: ts,
      note: typeof body.note === "string" ? body.note : "",
      prompt: typeof body.prompt === "string" ? body.prompt : null,
      mode: typeof body.mode === "string" ? body.mode : null,
      url: `http://localhost:3034/?session=${session.id}`,
    }
    writes.push(
      fs.writeFile(path.join(dirPath, "meta.json"), JSON.stringify(meta, null, 2))
    )

    await Promise.all(writes)

    // Brief human-readable summary file the agent can grep for
    const summary = [
      `# Report: ${session.name}`,
      `Timestamp: ${ts}`,
      `Session: ${session.id}`,
      meta.mode ? `Augment mode: ${meta.mode}` : null,
      meta.prompt ? `Augment prompt: ${meta.prompt}` : null,
      "",
      "## Note from user",
      meta.note || "(no note)",
      "",
      `Files:`,
      ...(await fs.readdir(dirPath)).map(f => `- ${f}`),
    ]
      .filter(Boolean)
      .join("\n")
    await fs.writeFile(path.join(dirPath, "README.md"), summary)

    return NextResponse.json({
      ok: true,
      path: dirPath,
      relative: `incoming/${dirName}`,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
