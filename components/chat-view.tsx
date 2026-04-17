"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

/**
 * Matrix-backed chat view for nodepad. Shows rooms Albert's account has
 * joined (every OpenFang agent lives in a Matrix room, so this ends up
 * being "chat with every agent in one place"). Desktop: 2-pane (list +
 * timeline). Mobile: 1-pane with back button.
 *
 * Transport: /api/matrix/sync long-poll (30 s) keeps the timeline live.
 * On mount we kick off the loop with no `since`, get a full snapshot +
 * next_batch token, then re-poll with ?since=<token>&timeout=25000. On
 * abort (unmount / route change) the in-flight request is cancelled so
 * we never burn server sockets.
 */

type Message = {
  id: string
  sender: string
  body: string
  ts: number
  msgtype: string
  local?: boolean
}

type Room = {
  id: string
  name: string
  topic?: string
  lastMessage: { sender: string; body: string; ts: number } | null
  unread: number
  timeline: Message[]
  prevBatch?: string
}

type SyncResponse = {
  next_batch: string
  me: string | null
  rooms: Room[]
}

function formatTime(ts: number): string {
  if (!ts) return ""
  const d = new Date(ts)
  const now = Date.now()
  const sameDay = new Date(now).toDateString() === d.toDateString()
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
  const sameYear = new Date(now).getFullYear() === d.getFullYear()
  return d.toLocaleDateString([], sameYear ? { month: "short", day: "numeric" } : { year: "2-digit", month: "short", day: "numeric" })
}

function senderDisplay(mxid: string): string {
  // @engineer:ubuntu-4gb-hel1-1 → engineer
  const m = /^@([^:]+):/.exec(mxid)
  return m ? m[1] : mxid
}

function senderColor(mxid: string): string {
  // Deterministic hue per sender so the eye can skim the timeline.
  let h = 0
  for (let i = 0; i < mxid.length; i++) h = (h * 31 + mxid.charCodeAt(i)) >>> 0
  const hue = h % 360
  return `hsl(${hue}, 65%, 72%)`
}

export function ChatView({
  isMobile = false,
  onStartDrive,
  sidebarTabs,
}: {
  isMobile?: boolean
  onStartDrive?: (roomId: string, roomName: string, me: string | null) => void
  /** Slot rendered above the rooms list (desktop) / at the top of the list
   *  view (mobile). Used by the /chat page to render the same Nodes|Rooms
   *  toggle that appears in the canvas sidebar. */
  sidebarTabs?: React.ReactNode
}) {
  const [rooms, setRooms] = useState<Room[]>([])
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null)
  const [composer, setComposer] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [initialLoaded, setInitialLoaded] = useState(false)
  const [me, setMe] = useState<string | null>(null)

  // sinceToken lives in a ref so the long-poll loop doesn't restart
  // on each update — the `useEffect([])` runs once, reads the latest
  // token from the ref, stays in its while-loop forever.
  const sinceRef = useRef<string | null>(null)
  const cancelledRef = useRef<boolean>(false)
  const controllerRef = useRef<AbortController | null>(null)
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const pinToBottomRef = useRef<boolean>(true)

  // ── Sync loop (mount only) ──────────────────────────────────────────────
  useEffect(() => {
    cancelledRef.current = false

    const mergeSync = (data: SyncResponse) => {
      setMe(prev => data.me || prev)
      setRooms(prev => {
        const map = new Map(prev.map(r => [r.id, r]))
        for (const r of data.rooms) {
          const existing = map.get(r.id)
          if (existing) {
            // Merge: keep existing timeline, append new events (sync
            // returns only NEW events after the first call), update
            // room metadata.
            const seen = new Set(existing.timeline.map(m => m.id))
            const merged = [
              ...existing.timeline,
              ...r.timeline.filter(m => !seen.has(m.id)),
            ]
            map.set(r.id, {
              ...existing,
              name: r.name || existing.name,
              topic: r.topic ?? existing.topic,
              lastMessage: r.lastMessage || existing.lastMessage,
              unread: r.unread,
              timeline: merged,
              prevBatch: existing.prevBatch || r.prevBatch,
            })
          } else {
            map.set(r.id, r)
          }
        }
        return Array.from(map.values()).sort(
          (a, b) => (b.lastMessage?.ts || 0) - (a.lastMessage?.ts || 0)
        )
      })
    }

    ;(async () => {
      // First sync — full snapshot.
      try {
        controllerRef.current = new AbortController()
        const res = await fetch("/api/matrix/sync", { signal: controllerRef.current.signal })
        if (cancelledRef.current) return
        const data = (await res.json()) as SyncResponse & { error?: string }
        if (data.error) {
          setError(data.error)
          setInitialLoaded(true)
          return
        }
        mergeSync(data)
        sinceRef.current = data.next_batch
        setInitialLoaded(true)
      } catch (e: any) {
        if (e.name !== "AbortError") {
          setError(e.message || "initial sync failed")
          setInitialLoaded(true)
        }
      }

      // Long-poll loop — incremental sync.
      while (!cancelledRef.current) {
        const since = sinceRef.current
        if (!since) {
          await new Promise(r => setTimeout(r, 2000))
          continue
        }
        controllerRef.current = new AbortController()
        try {
          const q = new URLSearchParams({ since, timeout: "25000" })
          const res = await fetch(`/api/matrix/sync?${q}`, {
            signal: controllerRef.current.signal,
          })
          if (cancelledRef.current) break
          const data = (await res.json()) as SyncResponse & { error?: string }
          if (data.error) {
            // Non-fatal — brief backoff then keep trying.
            await new Promise(r => setTimeout(r, 3000))
            continue
          }
          mergeSync(data)
          sinceRef.current = data.next_batch
        } catch (e: any) {
          if (e.name === "AbortError") break
          await new Promise(r => setTimeout(r, 3000))
        }
      }
    })()

    return () => {
      cancelledRef.current = true
      controllerRef.current?.abort()
    }
  }, [])

  const activeRoom = useMemo(
    () => rooms.find(r => r.id === activeRoomId) || null,
    [rooms, activeRoomId]
  )

  // Autoscroll on new messages — but only if user was already at the bottom.
  useEffect(() => {
    if (!activeRoom) return
    if (!pinToBottomRef.current) return
    const el = timelineRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeRoom?.timeline.length, activeRoomId])

  const onTimelineScroll = useCallback(() => {
    const el = timelineRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    pinToBottomRef.current = dist < 40
  }, [])

  // ── Send handler ────────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const roomId = activeRoomId
    const text = composer.trim()
    if (!roomId || !text || sending) return
    setSending(true)
    setComposer("")
    // Optimistic echo so the UI feels instant. Will be superseded by the
    // real event when /sync streams it back (matched by sender+body+ts
    // window — we just leave both for simplicity and rely on dedup via id).
    const localId = `local_${Date.now()}`
    setRooms(prev =>
      prev.map(r =>
        r.id === roomId
          ? {
              ...r,
              timeline: [
                ...r.timeline,
                {
                  id: localId,
                  sender: me || "@me:local",
                  body: text,
                  ts: Date.now(),
                  msgtype: "m.text",
                  local: true,
                },
              ],
              lastMessage: { sender: me || "@me:local", body: text, ts: Date.now() },
            }
          : r
      )
    )
    pinToBottomRef.current = true
    try {
      const res = await fetch(`/api/matrix/rooms/${encodeURIComponent(roomId)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `send ${res.status}`)
      // Replace the local echo with the real event id so the next sync
      // doesn't double-insert. If sync has already streamed the real
      // event, the dedup in mergeSync handled it; leave the local to be
      // harmlessly overwritten on next sync.
      setRooms(prev =>
        prev.map(r =>
          r.id === roomId
            ? {
                ...r,
                timeline: r.timeline.map(m =>
                  m.id === localId ? { ...m, id: data.event_id, local: false } : m
                ),
              }
            : r
        )
      )
    } catch (e: any) {
      setError(`Send failed: ${e.message || e}`)
      // Restore what the user typed so they don't lose it.
      setComposer(text)
      // Remove the failed local echo.
      setRooms(prev =>
        prev.map(r =>
          r.id === roomId ? { ...r, timeline: r.timeline.filter(m => m.id !== localId) } : r
        )
      )
    } finally {
      setSending(false)
    }
  }, [activeRoomId, composer, sending, me])

  const onComposerKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter → send, Shift+Enter → newline. Standard chat UX.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        send()
      }
    },
    [send]
  )

  // ── Layout ──────────────────────────────────────────────────────────────
  const showTimeline = isMobile ? !!activeRoomId : true
  const showList = isMobile ? !activeRoomId : true

  return (
    <div className="absolute inset-0 flex bg-black text-white/90 font-mono text-sm">
      {/* Room list pane */}
      {showList && (
        <div
          className={`flex flex-col border-r border-white/10 bg-white/[0.02] ${
            isMobile ? "w-full" : "w-[240px] shrink-0"
          }`}
        >
          {sidebarTabs}
          <div className="shrink-0 border-b border-white/10 px-3 py-2 flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-white/55">
              Rooms
            </span>
            {me && (
              <span className="ml-auto text-[10px] text-white/40 truncate" title={me}>
                {senderDisplay(me)}
              </span>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {!initialLoaded && (
              <div className="px-3 py-4 text-[11px] text-white/40">Loading rooms…</div>
            )}
            {initialLoaded && error && (
              <div className="px-3 py-4 text-[11px] text-red-300/80">{error}</div>
            )}
            {initialLoaded && !error && rooms.length === 0 && (
              <div className="px-3 py-4 text-[11px] text-white/40">No rooms</div>
            )}
            {rooms.map(r => {
              const isActive = r.id === activeRoomId
              return (
                <button
                  key={r.id}
                  onClick={() => setActiveRoomId(r.id)}
                  className={`w-full text-left px-3 py-2 border-b border-white/5 transition-colors ${
                    isActive
                      ? "bg-primary/10 border-l-2 border-l-primary"
                      : "hover:bg-white/[0.04] border-l-2 border-l-transparent"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`truncate text-[13px] ${isActive ? "text-primary" : "text-white/85"}`}>
                      {r.name}
                    </span>
                    {r.unread > 0 && (
                      <span className="ml-auto inline-flex items-center justify-center rounded-full bg-red-500/90 px-1.5 min-w-[18px] h-[18px] text-[10px] font-bold text-white">
                        {r.unread}
                      </span>
                    )}
                  </div>
                  {r.lastMessage && (
                    <div className="text-[11px] text-white/45 truncate mt-0.5">
                      <span style={{ color: senderColor(r.lastMessage.sender) }}>
                        {senderDisplay(r.lastMessage.sender)}
                      </span>
                      <span className="text-white/30"> · </span>
                      <span className="text-white/55">{r.lastMessage.body}</span>
                    </div>
                  )}
                  <div className="text-[9px] text-white/25 mt-0.5 uppercase tracking-wider">
                    {r.lastMessage ? formatTime(r.lastMessage.ts) : ""}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Timeline pane */}
      {showTimeline && (
        <div className="flex-1 min-w-0 flex flex-col">
          {!activeRoom ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-white/30 uppercase tracking-[0.3em]">
              {isMobile ? "Pick a room" : "Select a room to start chatting"}
            </div>
          ) : (
            <>
              {/* Header */}
              <div className="shrink-0 border-b border-white/10 px-3 py-2 flex items-center gap-2">
                {isMobile && (
                  <button
                    onClick={() => setActiveRoomId(null)}
                    className="flex items-center justify-center h-8 w-8 rounded-sm hover:bg-white/[0.06] text-white/70"
                    aria-label="Back to rooms"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="19" y1="12" x2="5" y2="12" />
                      <polyline points="12 19 5 12 12 5" />
                    </svg>
                  </button>
                )}
                <div className="flex flex-col min-w-0">
                  <span className="text-[13px] font-bold text-white/90 truncate">{activeRoom.name}</span>
                  {activeRoom.topic && (
                    <span className="text-[10px] text-white/40 truncate">{activeRoom.topic}</span>
                  )}
                </div>
                {onStartDrive && (
                  <button
                    data-testid="chat-drive-start"
                    onClick={() => onStartDrive(activeRoom.id, activeRoom.name, me)}
                    title="Drive this chat — voice-first for the car"
                    className="ml-auto flex items-center gap-1.5 rounded-sm border border-primary/40 bg-primary/10 hover:bg-primary/20 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-primary transition-colors"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9" />
                      <circle cx="12" cy="12" r="2.5" />
                    </svg>
                    Drive
                  </button>
                )}
              </div>

              {/* Messages */}
              <div
                ref={timelineRef}
                onScroll={onTimelineScroll}
                className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2"
              >
                {activeRoom.timeline.length === 0 && (
                  <div className="text-[11px] text-white/30 text-center py-4">
                    No messages yet. Say hi.
                  </div>
                )}
                {activeRoom.timeline.map((m, i) => {
                  const prev = activeRoom.timeline[i - 1]
                  const firstOfBurst = !prev || prev.sender !== m.sender || m.ts - prev.ts > 5 * 60 * 1000
                  const isMe = me && m.sender === me
                  return (
                    <div key={m.id} className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}>
                      {firstOfBurst && (
                        <div className={`flex items-center gap-2 mb-0.5 ${isMe ? "flex-row-reverse" : ""}`}>
                          <span
                            className="text-[11px] font-bold"
                            style={{ color: isMe ? "#fff" : senderColor(m.sender) }}
                          >
                            {isMe ? "you" : senderDisplay(m.sender)}
                          </span>
                          <span className="text-[9px] text-white/35 uppercase tracking-wider">
                            {formatTime(m.ts)}
                          </span>
                        </div>
                      )}
                      <div
                        className={`max-w-[75%] rounded-sm px-3 py-2 text-[13px] leading-snug whitespace-pre-wrap break-words ${
                          isMe
                            ? "bg-primary/15 border border-primary/30 text-white"
                            : "bg-white/[0.04] border border-white/10 text-white/90"
                        } ${m.local ? "opacity-60" : ""}`}
                      >
                        {m.body || <span className="italic text-white/40">[unsupported: {m.msgtype}]</span>}
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Composer */}
              <div className="shrink-0 border-t border-white/10 bg-black/70 px-2 py-2 flex items-end gap-2">
                <textarea
                  value={composer}
                  onChange={e => setComposer(e.target.value)}
                  onKeyDown={onComposerKey}
                  placeholder={`Message ${activeRoom.name}…`}
                  rows={1}
                  className="flex-1 resize-none rounded-sm border border-white/15 bg-white/[0.05] px-3 py-2 text-[13px] text-white/90 placeholder-white/35 focus:outline-none focus:border-primary/60 max-h-40"
                  style={{ minHeight: 40 }}
                />
                <button
                  onClick={send}
                  disabled={sending || !composer.trim()}
                  className="shrink-0 rounded-sm border border-primary/40 bg-primary/15 hover:bg-primary/25 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-primary transition-colors"
                >
                  {sending ? "…" : "Send"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {error && initialLoaded && activeRoom && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 rounded-sm border border-red-400/40 bg-red-500/15 px-3 py-1.5 text-[11px] text-red-200 max-w-[80%] truncate">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-300/70 hover:text-red-200">×</button>
        </div>
      )}
    </div>
  )
}
