import { NextResponse } from "next/server"
import { createNote, listNotes } from "@/lib/server/db"

function genId() {
  return Math.random().toString(36).slice(2, 10)
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  return NextResponse.json(listNotes(id))
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const body = await req.json().catch(() => ({}))
  const n = createNote({
    id: body.id || genId(),
    session_id: id,
    text: body.text || "",
    x: body.x ?? 0,
    y: body.y ?? 0,
    width: body.width,
    height: body.height,
    kind: body.kind,
    is_ai_generated: !!body.is_ai_generated,
  })
  return NextResponse.json(n)
}
