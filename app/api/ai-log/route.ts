import { NextResponse } from "next/server"
import { getCalls, clearCalls } from "@/lib/server/ai-log"

export const runtime = "nodejs"

export async function GET() {
  return NextResponse.json({ calls: getCalls() })
}

export async function DELETE() {
  clearCalls()
  return NextResponse.json({ ok: true })
}
