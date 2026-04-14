import { NextResponse } from "next/server"
import { deleteConnection } from "@/lib/server/db"

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  deleteConnection(id)
  return NextResponse.json({ ok: true })
}
