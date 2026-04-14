import { NextResponse } from "next/server"
import { listSessions, createSession, cleanupOldSessions } from "@/lib/server/db"

function genId() {
  return Math.random().toString(36).slice(2, 10)
}

export async function GET() {
  try {
    cleanupOldSessions()
    return NextResponse.json(listSessions())
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const id = body.id || genId()
    const name = body.name || new Date().toISOString().slice(0, 16).replace("T", " ")
    const s = createSession(id, name)
    return NextResponse.json(s)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
