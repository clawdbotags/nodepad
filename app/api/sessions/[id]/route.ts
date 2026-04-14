import { NextResponse } from "next/server"
import { getSession, updateSession, deleteSession, listNotes, listConnections } from "@/lib/server/db"

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const s = getSession(id)
  if (!s) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const notes = listNotes(id)
  const connections = listConnections(id)
  return NextResponse.json({ ...s, notes, connections })
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const body = await req.json().catch(() => ({}))
  const s = updateSession(id, body.name)
  return NextResponse.json(s)
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  deleteSession(id)
  return NextResponse.json({ ok: true })
}
