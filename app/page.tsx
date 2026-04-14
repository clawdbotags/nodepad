"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

// ── Types ────────────────────────────────────────────────────────────────────

interface Block {
  id: string
  text: string
  x: number
  y: number
  is_ai_generated: number | boolean
  session_id?: string
}

interface Connection {
  id: string
  from_block_id: string
  to_block_id: string
  session_id?: string
}

interface Session {
  id: string
  name: string
  created_at: number
  updated_at: number
}

// ── Undo snapshot shape ──────────────────────────────────────────────────────

type UndoEntry = {
  kind: "augment"
  // To undo: recreate these notes and connections, delete the new note and rewired connections
  deleted_notes: Block[]
  deleted_connections: Connection[]
  new_note_id: string
  rewired_connection_ids: string[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json()
}

// ── Component ────────────────────────────────────────────────────────────────

export default function Page() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string>("")
  const [blocks, setBlocks] = useState<Block[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [inputText, setInputText] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState("")
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null)
  const [augmentOpen, setAugmentOpen] = useState(false)
  const [augmentPrompt, setAugmentPrompt] = useState("")
  const [augmentBusy, setAugmentBusy] = useState(false)
  const [augmentError, setAugmentError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const canvasInputRef = useRef<HTMLInputElement>(null)
  const augmentInputRef = useRef<HTMLInputElement>(null)

  const undoStackRef = useRef<UndoEntry[]>([])

  // Drag state
  const dragStateRef = useRef<{
    blockId: string | null
    offsetX: number
    offsetY: number
    startX: number
    startY: number
    moved: boolean
  }>({ blockId: null, offsetX: 0, offsetY: 0, startX: 0, startY: 0, moved: false })

  // Connection drag state
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null)
  const [connectEndPos, setConnectEndPos] = useState<{ x: number; y: number } | null>(null)

  const canvasRef = useRef<HTMLDivElement>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2200)
  }, [])

  // ── Load sessions on mount ────────────────────────────────────────────────
  useEffect(() => {
    ;(async () => {
      const list: Session[] = await api("/api/sessions")
      setSessions(list)
      if (list.length > 0) {
        setActiveSessionId(list[0].id)
      } else {
        // auto-create first session
        const s: Session = await api("/api/sessions", { method: "POST", body: JSON.stringify({}) })
        setSessions([s])
        setActiveSessionId(s.id)
      }
    })().catch(e => showToast(`Load error: ${e.message}`))
  }, [showToast])

  // ── Load session contents when active changes ────────────────────────────
  useEffect(() => {
    if (!activeSessionId) return
    ;(async () => {
      const data = await api(`/api/sessions/${activeSessionId}`)
      setBlocks(data.notes || [])
      setConnections(data.connections || [])
      setSelectedIds(new Set())
      undoStackRef.current = []
    })().catch(e => showToast(`Session load error: ${e.message}`))
  }, [activeSessionId, showToast])

  // ── Create session ───────────────────────────────────────────────────────
  const newSession = useCallback(async () => {
    const s: Session = await api("/api/sessions", { method: "POST", body: JSON.stringify({}) })
    setSessions(prev => [s, ...prev])
    setActiveSessionId(s.id)
  }, [])

  // ── Create block via bottom input ────────────────────────────────────────
  const createBlock = useCallback(async (text: string) => {
    if (!activeSessionId || !text.trim()) return
    // Position: random-ish spread in visible area
    const x = 100 + Math.random() * 500
    const y = 100 + Math.random() * 300
    const n: Block = await api(`/api/sessions/${activeSessionId}/notes`, {
      method: "POST",
      body: JSON.stringify({ text, x, y }),
    })
    setBlocks(prev => [...prev, n])
  }, [activeSessionId])

  // ── Delete selected blocks ───────────────────────────────────────────────
  const deleteSelected = useCallback(async () => {
    if (selectedIds.size === 0) return
    const ids = Array.from(selectedIds)
    for (const id of ids) {
      await api(`/api/notes/${id}`, { method: "DELETE" })
    }
    setBlocks(prev => prev.filter(b => !selectedIds.has(b.id)))
    setConnections(prev => prev.filter(c => !selectedIds.has(c.from_block_id) && !selectedIds.has(c.to_block_id)))
    setSelectedIds(new Set())
  }, [selectedIds])

  // ── Update block position (after drag) ───────────────────────────────────
  const persistBlockPos = useCallback(async (id: string, x: number, y: number) => {
    try {
      await api(`/api/notes/${id}`, { method: "PATCH", body: JSON.stringify({ x, y }) })
    } catch (e: any) {
      showToast(`Save error: ${e.message}`)
    }
  }, [showToast])

  // ── Save edited text ─────────────────────────────────────────────────────
  const saveEdit = useCallback(async () => {
    if (!editingId) return
    const id = editingId
    const text = editingText
    setEditingId(null)
    setEditingText("")
    try {
      // When user edits, clear the AI accent
      const updated: Block = await api(`/api/notes/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ text, is_ai_generated: false }),
      })
      setBlocks(prev => prev.map(b => (b.id === id ? updated : b)))
    } catch (e: any) {
      showToast(`Edit save error: ${e.message}`)
    }
  }, [editingId, editingText, showToast])

  // ── Block mouse handlers ─────────────────────────────────────────────────
  const onBlockMouseDown = (e: React.MouseEvent, block: Block) => {
    if (editingId === block.id) return
    e.stopPropagation()
    dragStateRef.current = {
      blockId: block.id,
      offsetX: e.clientX - block.x,
      offsetY: e.clientY - block.y,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    }
  }

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const ds = dragStateRef.current
    if (ds.blockId) {
      const dx = e.clientX - ds.startX
      const dy = e.clientY - ds.startY
      if (!ds.moved && Math.abs(dx) + Math.abs(dy) > 3) ds.moved = true
      if (ds.moved) {
        const newX = e.clientX - ds.offsetX
        const newY = e.clientY - ds.offsetY
        setBlocks(prev => prev.map(b => (b.id === ds.blockId ? { ...b, x: newX, y: newY } : b)))
      }
    } else if (connectingFrom) {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (rect) setConnectEndPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    }
  }, [connectingFrom])

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    const ds = dragStateRef.current
    if (ds.blockId && ds.moved) {
      const b = blocks.find(x => x.id === ds.blockId)
      if (b) persistBlockPos(b.id, b.x, b.y)
    }
    // Handle click (non-drag) selection
    if (ds.blockId && !ds.moved) {
      const id = ds.blockId
      setSelectedIds(prev => {
        const next = new Set(prev)
        if (e.ctrlKey || e.metaKey) {
          if (next.has(id)) next.delete(id)
          else next.add(id)
        } else {
          next.clear()
          next.add(id)
        }
        return next
      })
    }
    dragStateRef.current = { blockId: null, offsetX: 0, offsetY: 0, startX: 0, startY: 0, moved: false }

    if (connectingFrom) {
      // drop target: find block under cursor
      const target = (e.target as HTMLElement).closest("[data-block-id]") as HTMLElement | null
      const targetId = target?.getAttribute("data-block-id")
      if (targetId && targetId !== connectingFrom && activeSessionId) {
        api(`/api/sessions/${activeSessionId}/connections`, {
          method: "POST",
          body: JSON.stringify({ from_block_id: connectingFrom, to_block_id: targetId }),
        }).then((c: Connection) => setConnections(prev => [...prev, c]))
          .catch(err => showToast(`Connect error: ${err.message}`))
      }
      setConnectingFrom(null)
      setConnectEndPos(null)
    }
  }, [blocks, persistBlockPos, connectingFrom, activeSessionId, showToast])

  // ── Canvas background click: deselect ────────────────────────────────────
  const onCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.target === canvasRef.current || (e.target as HTMLElement).dataset.canvasBg === "true") {
      setSelectedIds(new Set())
      canvasInputRef.current?.blur()
    }
  }

  // ── Double click block: edit ─────────────────────────────────────────────
  const onBlockDoubleClick = (e: React.MouseEvent, block: Block) => {
    e.stopPropagation()
    setEditingId(block.id)
    setEditingText(block.text)
  }

  // ── Key handlers ─────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      const isInput = tag === "INPUT" || tag === "TEXTAREA"

      // Ctrl+Z undo
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        if (!isInput) {
          e.preventDefault()
          doUndo()
          return
        }
      }

      // Delete key
      if ((e.key === "Delete" || e.key === "Backspace") && !isInput && selectedIds.size > 0) {
        e.preventDefault()
        deleteSelected()
        return
      }

      // Enter on canvas when not in input => open augment
      if (e.key === "Enter" && !isInput && !augmentOpen && activeSessionId) {
        e.preventDefault()
        setAugmentOpen(true)
        setAugmentError(null)
        setTimeout(() => augmentInputRef.current?.focus(), 10)
      }

      if (e.key === "Escape") {
        if (augmentOpen) {
          setAugmentOpen(false)
          setAugmentPrompt("")
        } else if (editingId) {
          setEditingId(null)
          setEditingText("")
        } else {
          setSelectedIds(new Set())
        }
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, augmentOpen, activeSessionId, editingId, deleteSelected])

  // ── Undo ─────────────────────────────────────────────────────────────────
  const doUndo = useCallback(async () => {
    const entry = undoStackRef.current.pop()
    if (!entry) {
      showToast("Nothing to undo")
      return
    }
    if (entry.kind === "augment" && activeSessionId) {
      try {
        // Delete the new note (cascades some)
        await api(`/api/notes/${entry.new_note_id}`, { method: "DELETE" })
        // Delete rewired connections explicitly in case they're not all cascaded
        for (const cid of entry.rewired_connection_ids) {
          await api(`/api/connections/${cid}`, { method: "DELETE" }).catch(() => {})
        }
        // Recreate old notes
        for (const n of entry.deleted_notes) {
          await api(`/api/sessions/${activeSessionId}/notes`, {
            method: "POST",
            body: JSON.stringify({
              id: n.id,
              text: n.text,
              x: n.x,
              y: n.y,
              is_ai_generated: !!n.is_ai_generated,
            }),
          })
        }
        // Recreate old connections
        for (const c of entry.deleted_connections) {
          await api(`/api/sessions/${activeSessionId}/connections`, {
            method: "POST",
            body: JSON.stringify({
              id: c.id,
              from_block_id: c.from_block_id,
              to_block_id: c.to_block_id,
            }),
          }).catch(() => {})
        }
        // Reload session to sync
        const data = await api(`/api/sessions/${activeSessionId}`)
        setBlocks(data.notes || [])
        setConnections(data.connections || [])
        showToast("Undone")
      } catch (e: any) {
        showToast(`Undo failed: ${e.message}`)
      }
    }
  }, [activeSessionId, showToast])

  // ── Augment submit ───────────────────────────────────────────────────────
  const submitAugment = useCallback(async () => {
    if (!activeSessionId || !augmentPrompt.trim()) return
    setAugmentBusy(true)
    setAugmentError(null)
    try {
      const scopeIds = selectedIds.size > 0 ? Array.from(selectedIds) : blocks.map(b => b.id)
      const res = await api(`/api/sessions/${activeSessionId}/augment`, {
        method: "POST",
        body: JSON.stringify({ prompt: augmentPrompt, block_ids: scopeIds }),
      })
      const snap = res.snapshot
      undoStackRef.current.push({
        kind: "augment",
        deleted_notes: snap.deleted_notes,
        deleted_connections: (snap.deleted_connections || []).filter(
          (c: Connection) =>
            scopeIds.includes(c.from_block_id) || scopeIds.includes(c.to_block_id)
        ),
        new_note_id: res.new_note.id,
        rewired_connection_ids: (res.rewired_connections || []).map((c: any) => c.id),
      })
      // Refresh
      const data = await api(`/api/sessions/${activeSessionId}`)
      setBlocks(data.notes || [])
      setConnections(data.connections || [])
      setSelectedIds(new Set([res.new_note.id]))
      setAugmentOpen(false)
      setAugmentPrompt("")
      showToast("Augmented")
    } catch (e: any) {
      setAugmentError(e.message)
    } finally {
      setAugmentBusy(false)
    }
  }, [activeSessionId, augmentPrompt, selectedIds, blocks, showToast])

  // ── Export to markdown ───────────────────────────────────────────────────
  const doExport = useCallback(() => {
    const scope = selectedIds.size > 0 ? blocks.filter(b => selectedIds.has(b.id)) : blocks
    if (scope.length === 0) {
      showToast("Nothing to export")
      return
    }
    const scopeIds = new Set(scope.map(b => b.id))
    const lines: string[] = []
    const session = sessions.find(s => s.id === activeSessionId)
    lines.push(`# ${session?.name || "nodepad session"}`)
    lines.push("")
    for (const b of scope) {
      const marker = b.is_ai_generated ? " _(AI-generated)_" : ""
      lines.push(`- ${b.text.replace(/\n/g, "\n  ")}${marker}`)
    }
    const scopeConns = connections.filter(
      c => scopeIds.has(c.from_block_id) && scopeIds.has(c.to_block_id)
    )
    if (scopeConns.length > 0) {
      lines.push("")
      lines.push("## Connections")
      lines.push("")
      for (const c of scopeConns) {
        const f = blocks.find(b => b.id === c.from_block_id)?.text.slice(0, 40) || c.from_block_id
        const t = blocks.find(b => b.id === c.to_block_id)?.text.slice(0, 40) || c.to_block_id
        lines.push(`- ${f} → ${t}`)
      }
    }
    const md = lines.join("\n")
    const blob = new Blob([md], { type: "text/markdown" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `nodepad-${session?.name || "export"}-${Date.now()}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    showToast("Exported")
  }, [blocks, connections, selectedIds, sessions, activeSessionId, showToast])

  // ── Render ───────────────────────────────────────────────────────────────
  const blocksById = useMemo(() => {
    const m: Record<string, Block> = {}
    for (const b of blocks) m[b.id] = b
    return m
  }, [blocks])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-neutral-50 text-neutral-900">
      {/* Left Sidebar */}
      <aside className="flex h-full w-60 flex-col border-r border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 p-3">
          <button
            data-testid="new-session"
            onClick={newSession}
            className="w-full rounded-md bg-neutral-900 px-3 py-2 text-sm text-white hover:bg-neutral-700"
          >
            + New canvas
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {sessions.map(s => (
            <button
              key={s.id}
              data-testid={`session-item-${s.id}`}
              onClick={() => setActiveSessionId(s.id)}
              className={`mb-1 block w-full truncate rounded px-2 py-1.5 text-left text-sm ${
                s.id === activeSessionId ? "bg-neutral-200" : "hover:bg-neutral-100"
              }`}
              title={s.name}
            >
              {s.name}
            </button>
          ))}
        </div>
        <div className="border-t border-neutral-200 p-3">
          <button
            data-testid="export-btn"
            onClick={doExport}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm hover:bg-neutral-100"
          >
            Export Markdown
          </button>
          <div className="mt-2 text-[10px] text-neutral-500">
            Selection: {selectedIds.size} / {blocks.length}
          </div>
        </div>
      </aside>

      {/* Main canvas area */}
      <main className="relative flex-1 overflow-hidden">
        <div
          ref={canvasRef}
          data-testid="canvas"
          data-canvas-bg="true"
          onMouseDown={onCanvasMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          className="relative h-full w-full select-none"
          style={{ cursor: connectingFrom ? "crosshair" : "default" }}
        >
          {/* SVG for connections */}
          <svg className="pointer-events-none absolute inset-0 h-full w-full" style={{ zIndex: 1 }}>
            {connections.map(c => {
              const from = blocksById[c.from_block_id]
              const to = blocksById[c.to_block_id]
              if (!from || !to) return null
              return (
                <line
                  key={c.id}
                  x1={from.x + 90}
                  y1={from.y + 30}
                  x2={to.x + 90}
                  y2={to.y + 30}
                  stroke="#999"
                  strokeWidth={1.5}
                />
              )
            })}
            {connectingFrom && connectEndPos && (() => {
              const from = blocksById[connectingFrom]
              if (!from) return null
              return (
                <line
                  x1={from.x + 90}
                  y1={from.y + 30}
                  x2={connectEndPos.x}
                  y2={connectEndPos.y}
                  stroke="#555"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                />
              )
            })()}
          </svg>

          {/* Blocks */}
          {blocks.map(b => {
            const isSelected = selectedIds.has(b.id)
            const isAI = !!b.is_ai_generated
            const isHovered = hoveredBlockId === b.id
            const isEditing = editingId === b.id
            return (
              <div
                key={b.id}
                data-block-id={b.id}
                data-testid={`block-${b.id}`}
                onMouseDown={e => onBlockMouseDown(e, b)}
                onDoubleClick={e => onBlockDoubleClick(e, b)}
                onMouseEnter={() => setHoveredBlockId(b.id)}
                onMouseLeave={() => setHoveredBlockId(null)}
                style={{ left: b.x, top: b.y, zIndex: 2 }}
                className={`absolute min-h-[60px] w-[180px] cursor-move rounded-md bg-white px-3 py-2 text-sm shadow ${
                  isSelected ? "ring-2 ring-blue-500" : "ring-1 ring-neutral-200"
                } ${isAI ? "border-l-4 border-l-indigo-500" : ""}`}
              >
                {isEditing ? (
                  <textarea
                    data-testid={`block-edit-${b.id}`}
                    autoFocus
                    value={editingText}
                    onChange={e => setEditingText(e.target.value)}
                    onBlur={saveEdit}
                    onKeyDown={e => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault()
                        saveEdit()
                      }
                    }}
                    className="w-full resize-none bg-transparent outline-none"
                    rows={3}
                  />
                ) : (
                  <div className="whitespace-pre-wrap break-words">{b.text}</div>
                )}
                {/* Connect handle on hover */}
                {isHovered && !isEditing && !connectingFrom && (
                  <button
                    data-testid={`connect-handle-${b.id}`}
                    onMouseDown={e => {
                      e.stopPropagation()
                      setConnectingFrom(b.id)
                      const rect = canvasRef.current?.getBoundingClientRect()
                      if (rect) setConnectEndPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
                    }}
                    className="absolute -right-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-blue-500 text-xs text-white hover:bg-blue-600"
                    title="Drag to connect"
                  >
                    ·
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {/* Augment prompt */}
        {augmentOpen && (
          <div className="absolute inset-x-0 bottom-20 z-40 flex justify-center">
            <div className="flex w-[600px] max-w-[90%] flex-col gap-2 rounded-lg border border-neutral-300 bg-white p-3 shadow-lg">
              <div className="text-xs text-neutral-500">
                {selectedIds.size > 0
                  ? `Augment ${selectedIds.size} selected block${selectedIds.size === 1 ? "" : "s"}`
                  : `Augment whole canvas (${blocks.length} block${blocks.length === 1 ? "" : "s"})`}
              </div>
              <input
                ref={augmentInputRef}
                data-testid="augment-input"
                value={augmentPrompt}
                onChange={e => setAugmentPrompt(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    submitAugment()
                  }
                }}
                disabled={augmentBusy}
                placeholder="Instruction (e.g. reformat as checklist)"
                className="rounded border border-neutral-300 px-2 py-1.5 outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <div className="flex items-center justify-between">
                <div className="text-xs text-red-600">{augmentError}</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setAugmentOpen(false)
                      setAugmentPrompt("")
                    }}
                    className="rounded px-2 py-1 text-sm hover:bg-neutral-100"
                  >
                    Cancel
                  </button>
                  <button
                    data-testid="augment-submit"
                    disabled={augmentBusy || !augmentPrompt.trim()}
                    onClick={submitAugment}
                    className="rounded bg-indigo-600 px-3 py-1 text-sm text-white disabled:opacity-50 hover:bg-indigo-700"
                  >
                    {augmentBusy ? "Augmenting…" : "Augment"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Bottom text input */}
        <div className="absolute inset-x-0 bottom-0 z-30 flex justify-center border-t border-neutral-200 bg-white p-3">
          <input
            ref={canvasInputRef}
            data-testid="canvas-input"
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                if (inputText.trim()) {
                  createBlock(inputText)
                  setInputText("")
                }
              }
            }}
            placeholder="Type and press Enter to add a block…"
            className="w-[600px] max-w-[90%] rounded-lg border border-neutral-300 bg-white px-3 py-2 outline-none focus:ring-2 focus:ring-neutral-400"
          />
        </div>

        {/* Toast */}
        {toast && (
          <div
            data-testid="toast"
            className="absolute right-4 top-4 z-50 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white shadow"
          >
            {toast}
          </div>
        )}
      </main>
    </div>
  )
}
