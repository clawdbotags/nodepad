"use client"

/**
 * Top-level chat route. Deliberately separate from the canvas session page —
 * chat is its own thing, not a view-mode of a canvas. You should be able to
 * talk to agents without first picking a note, and not lose your train of
 * thought switching between them.
 *
 * Renders `<ChatView>` full-height with its own drive-mode overlay state.
 * Provides a back link to `/` so users can jump to the canvas.
 */

import { useEffect, useState } from "react"
import Link from "next/link"
import { ChatView } from "@/components/chat-view"
import { ChatDriveView } from "@/components/chat-drive-view"

export default function ChatPage() {
  const [isMobile, setIsMobile] = useState(false)
  const [chatDriveSession, setChatDriveSession] = useState<
    { roomId: string; roomName: string; me: string | null } | null
  >(null)

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)")
    const onChange = () => setIsMobile(mq.matches)
    onChange()
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-white">
      {/* Slim top bar — label + back-to-canvas link. Deliberately minimal so
          the chat UI itself owns the visual weight. */}
      <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 border-b border-white/10 bg-black/70 backdrop-blur-md">
        <span className="font-mono text-[11px] uppercase tracking-widest text-white/70">
          Chat
        </span>
        <Link
          href="/"
          className="ml-auto rounded-sm border border-white/15 bg-black/40 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-white/70 hover:border-primary/40 hover:text-primary transition-all"
        >
          → Canvas
        </Link>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <ChatView
          isMobile={isMobile}
          onStartDrive={(roomId, roomName, me) =>
            setChatDriveSession({ roomId, roomName, me })
          }
        />
      </div>

      {chatDriveSession && (
        <ChatDriveView
          roomId={chatDriveSession.roomId}
          roomName={chatDriveSession.roomName}
          me={chatDriveSession.me}
          onClose={() => setChatDriveSession(null)}
        />
      )}
    </div>
  )
}
