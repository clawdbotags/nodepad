import { NextResponse } from "next/server"
import { updateNote, deleteNote } from "@/lib/server/db"

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const body = await req.json().catch(() => ({}))
  const n = updateNote(id, body)
  return NextResponse.json(n)
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  deleteNote(id)
  return NextResponse.json({ ok: true })
}
