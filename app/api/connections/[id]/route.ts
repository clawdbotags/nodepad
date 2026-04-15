import { NextResponse } from "next/server"
import { deleteConnection, updateConnection } from "@/lib/server/db"

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  deleteConnection(id)
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const body = await req.json().catch(() => ({}))
  updateConnection(id, { label: body.label })
  return NextResponse.json({ ok: true })
}
