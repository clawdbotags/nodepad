import { NextResponse } from "next/server"
import { createConnection, listConnections } from "@/lib/server/db"

function genId() {
  return Math.random().toString(36).slice(2, 10)
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  return NextResponse.json(listConnections(id))
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const body = await req.json().catch(() => ({}))
  if (!body.from_block_id || !body.to_block_id) {
    return NextResponse.json({ error: "from_block_id and to_block_id required" }, { status: 400 })
  }
  const c = createConnection({
    id: body.id || genId(),
    session_id: id,
    from_block_id: body.from_block_id,
    to_block_id: body.to_block_id,
  })
  return NextResponse.json(c)
}
