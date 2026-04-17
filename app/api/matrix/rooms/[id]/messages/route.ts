import { NextResponse } from "next/server"
import { matrixFetch } from "@/lib/server/matrix"

/**
 * GET /api/matrix/rooms/:id/messages?from=<token>&limit=<n>
 *
 * Backward-paginates a room's timeline. Used when the user scrolls up
 * in a chat to load older history that wasn't in the /sync snapshot.
 * `from` is a prev_batch token (from /sync or a previous page response).
 *
 * Response:
 *   { events: Message[], start: string, end: string }
 *
 * end is the next-page token (older than the oldest returned event).
 */

export const dynamic = "force-dynamic"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const url = new URL(request.url)
    const from = url.searchParams.get("from")
    const limit = url.searchParams.get("limit") || "30"
    const q = new URLSearchParams({ dir: "b", limit })
    if (from) q.set("from", from)
    const res = await matrixFetch(
      `/_matrix/client/r0/rooms/${encodeURIComponent(id)}/messages?${q.toString()}`
    )
    if (!res.ok) {
      const txt = await res.text().catch(() => "")
      return NextResponse.json({ error: `matrix ${res.status}: ${txt}` }, { status: 502 })
    }
    const data = await res.json()
    const events = (data.chunk || [])
      .filter((e: any) => e.type === "m.room.message")
      .map((e: any) => ({
        id: e.event_id,
        sender: e.sender,
        body: e.content?.body || "",
        ts: e.origin_server_ts,
        msgtype: e.content?.msgtype || "m.text",
      }))
    // chunk is returned newest-first when dir=b. Reverse so the client
    // can splice-prepend chronologically without re-sorting.
    events.reverse()
    return NextResponse.json({ events, start: data.start, end: data.end })
  } catch (e: any) {
    console.error("GET /api/matrix/rooms/:id/messages failed:", e)
    return NextResponse.json({ error: e.message || "messages failed" }, { status: 500 })
  }
}
