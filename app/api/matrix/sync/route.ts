import { NextResponse } from "next/server"
import { matrixFetch, getMatrixUserId, SYNC_FILTER } from "@/lib/server/matrix"

/**
 * GET /api/matrix/sync?since=<token>&timeout=<ms>
 *
 * Proxies Matrix client-server /sync with a minimal filter and distills
 * the response into exactly what the in-app chat view needs. Frontend
 * long-polls this endpoint with ?since=<next_batch> to stream new events.
 *
 * Response:
 *   { next_batch: string, me: string, rooms: Room[] }
 *
 * Room = {
 *   id, name, topic?, lastMessage?: { sender, body, ts },
 *   unread: number,
 *   timeline: Message[],
 *   prevBatch?: string,
 * }
 */

export const dynamic = "force-dynamic"

type RoomOut = {
  id: string
  name: string
  topic?: string
  lastMessage: { sender: string; body: string; ts: number } | null
  unread: number
  timeline: Array<{ id: string; sender: string; body: string; ts: number; msgtype: string }>
  prevBatch?: string
}

function flattenEventText(content: any): string {
  if (!content) return ""
  // Strip Matrix HTML fallback if present — just take plaintext body.
  if (typeof content.body === "string") return content.body
  return ""
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const since = url.searchParams.get("since")
    // On first call (no since) Matrix would otherwise return the ENTIRE
    // history. Force timeout=0 and rely on the filter's timeline.limit=30.
    const timeout = url.searchParams.get("timeout") || (since ? "25000" : "0")
    const q = new URLSearchParams({
      filter: JSON.stringify(SYNC_FILTER),
      timeout,
    })
    if (since) q.set("since", since)

    const res = await matrixFetch(`/_matrix/client/r0/sync?${q.toString()}`)
    if (!res.ok) {
      const txt = await res.text().catch(() => "")
      return NextResponse.json({ error: `matrix sync ${res.status}: ${txt}` }, { status: 502 })
    }
    const data = await res.json()

    const joined = data?.rooms?.join || {}
    const rooms: RoomOut[] = []
    for (const [id, raw] of Object.entries<any>(joined)) {
      const stateEvents = raw?.state?.events || []
      const timelineEvents = raw?.timeline?.events || []
      let name: string | undefined
      let topic: string | undefined
      // Name can come from state OR timeline (state change pushes into timeline).
      for (const e of [...stateEvents, ...timelineEvents]) {
        if (e.type === "m.room.name" && typeof e.content?.name === "string") name = e.content.name
        if (e.type === "m.room.topic" && typeof e.content?.topic === "string") topic = e.content.topic
      }
      const messages = timelineEvents
        .filter((e: any) => e.type === "m.room.message")
        .map((e: any) => ({
          id: e.event_id,
          sender: e.sender,
          body: flattenEventText(e.content),
          ts: e.origin_server_ts,
          msgtype: e.content?.msgtype || "m.text",
        }))
      const last = messages[messages.length - 1]
      rooms.push({
        id,
        name: name || id,
        topic,
        lastMessage: last ? { sender: last.sender, body: last.body, ts: last.ts } : null,
        unread: raw?.unread_notifications?.notification_count || 0,
        timeline: messages,
        prevBatch: raw?.timeline?.prev_batch,
      })
    }

    // Sort newest-activity-first. Rooms with no lastMessage sink to the
    // bottom — this keeps the agent room with a pending reply at the top.
    rooms.sort((a, b) => (b.lastMessage?.ts || 0) - (a.lastMessage?.ts || 0))

    const me = await getMatrixUserId()
    return NextResponse.json({ next_batch: data.next_batch, me, rooms })
  } catch (e: any) {
    console.error("GET /api/matrix/sync failed:", e)
    return NextResponse.json({ error: e.message || "sync failed" }, { status: 500 })
  }
}
