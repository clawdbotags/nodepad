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

  // Same tab toggle that appears in the canvas sidebar — "Rooms" is active
  // here, "Nodes" routes back to /. Using <a> (full navigation) so page.tsx
  // can remount its state fresh each time.
  const sidebarTabs = (
    <div className="shrink-0 flex items-center gap-1 border-b border-white/10 bg-black/30 px-2 py-1.5">
      <a
        href="/"
        className="flex-1 text-center rounded-sm px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-white/55 hover:bg-white/[0.06] hover:text-primary hover:border-primary/35 border border-transparent transition-all"
      >
        Nodes
      </a>
      <button
        className="flex-1 rounded-sm px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider bg-primary/15 border border-primary/40 text-primary"
      >
        Rooms
      </button>
    </div>
  )

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-white">
      <div className="flex-1 min-h-0 overflow-hidden">
        <ChatView
          isMobile={isMobile}
          sidebarTabs={sidebarTabs}
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
