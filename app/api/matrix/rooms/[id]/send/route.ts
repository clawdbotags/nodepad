import { NextResponse } from "next/server"
import { matrixFetch } from "@/lib/server/matrix"

/**
 * POST /api/matrix/rooms/:id/send
 * Body: { text: string, msgtype?: "m.text" | "m.notice" }
 *
 * Puts a message event with a client-generated transaction ID. Uses the
 * user's personal Matrix token so the message appears as them in Element,
 * and so agent bindings in OpenFang config.toml route replies correctly.
 *
 * Response: { event_id }
 */

export const dynamic = "force-dynamic"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const text = String(body?.text || "").trim()
    if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 })
    const msgtype = body?.msgtype === "m.notice" ? "m.notice" : "m.text"
    // Matrix requires a unique transaction ID per-send. Collision is
    // benign (server idempotently returns the original event_id) but
    // unique is still correct. Timestamp+random is plenty.
    const txn = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const res = await matrixFetch(
      `/_matrix/client/r0/rooms/${encodeURIComponent(id)}/send/m.room.message/${txn}`,
      {
        method: "PUT",
        body: JSON.stringify({ msgtype, body: text }),
      }
    )
    if (!res.ok) {
      const txt = await res.text().catch(() => "")
      return NextResponse.json({ error: `matrix ${res.status}: ${txt}` }, { status: 502 })
    }
    const data = await res.json()
    return NextResponse.json({ event_id: data.event_id })
  } catch (e: any) {
    console.error("POST /api/matrix/rooms/:id/send failed:", e)
    return NextResponse.json({ error: e.message || "send failed" }, { status: 500 })
  }
}
