"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ExcalidrawOverlay,
  DrawingPreview,
  parseScene,
  serializeScene,
  emptyScene,
  renderSceneToPng,
  type ExcalidrawScene,
} from "@/components/excalidraw-overlay"
import { AILogPanel } from "@/components/ai-log-panel"
import { useVoiceRecorder } from "@/lib/use-voice-recorder"
import { formatRundown, type AugmentDiff } from "@/lib/drive-mode-rundown"

// ── Types ────────────────────────────────────────────────────────────────────

interface Block {
  id: string
  text: string
  x: number
  y: number
  width?: number
  height?: number
  kind?: string  // 'text' (default) | 'drawing' (Excalidraw scene JSON in `text`)
  is_ai_generated: number | boolean
  session_id?: string
}

interface Connection {
  id: string
  from_block_id: string
  to_block_id: string
  label?: string
  session_id?: string
}

interface Session {
  id: string
  name: string
  created_at: number
  updated_at: number
}

// ── Undo snapshot shape ──────────────────────────────────────────────────────

type UndoEntry =
  | {
      kind: "augment"
      // Undo: recreate these notes + connections, delete the new note + rewired connections
      deleted_notes: Block[]
      deleted_connections: Connection[]
      new_note_id: string
      rewired_connection_ids: string[]
    }
  | {
      kind: "augment-structured"
      // Undo: delete all new blocks + connections, recreate deleted notes + connections
      deleted_notes: Block[]
      deleted_connections: Connection[]
      new_block_ids: string[]
      new_connection_ids: string[]
    }
  | {
      kind: "rearrange"
      // Undo: PATCH each block back to its prior x/y, DELETE each added connection,
      // POST each removed connection back into existence.
      prior_positions: { id: string; x: number; y: number }[]
      added_connection_ids: string[]
      removed_connections: { id: string; from_block_id: string; to_block_id: string; label?: string }[]
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

// ── Rearrange helpers (snapshot + collision resolver) ──────────────────────

type RearrangeFrame = { min_x: number; min_y: number; max_x: number; max_y: number }

interface BlockRect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/**
 * Render the canvas wrapper to a PNG data URL for the LLM.
 * Wrapper is the un-translated content layer (SVG + blocks). We temporarily
 * neutralise its transform so the snapshot covers the full content extent.
 */
async function snapshotCanvas(
  wrapper: HTMLElement,
  frame: RearrangeFrame,
  maxBytes = 700_000
): Promise<string> {
  const { toPng } = await import("html-to-image")
  const w = frame.max_x - frame.min_x
  const h = frame.max_y - frame.min_y
  const longest = Math.max(w, h)
  const targetEdge = 1024
  const pixelRatio = Math.max(0.4, Math.min(2, targetEdge / longest))

  // Save current transform; reset it so the snapshot uses content-space coords.
  const prev = wrapper.style.transform
  const prevOrigin = wrapper.style.transformOrigin
  wrapper.style.transform = "none"
  wrapper.style.transformOrigin = "0 0"
  let url = ""
  try {
    url = await toPng(wrapper, {
      cacheBust: true,
      pixelRatio,
      backgroundColor: "#020202",
      width: w,
      height: h,
      style: {
        transform: `translate(${-frame.min_x}px, ${-frame.min_y}px)`,
        transformOrigin: "0 0",
      },
    })
  } finally {
    wrapper.style.transform = prev
    wrapper.style.transformOrigin = prevOrigin
  }
  // Rough byte estimate from base64 length. data:image/png;base64,XXXX
  const b64 = url.split(",")[1] || ""
  const bytes = Math.floor((b64.length * 3) / 4)
  if (bytes > maxBytes) {
    throw new Error(
      `Canvas snapshot too large (${Math.round(bytes / 1024)} KB > ${Math.round(maxBytes / 1024)} KB). Zoom in or select a subset.`
    )
  }
  return url
}

/**
 * Snapshot the whole canvas content extent (bbox of all blocks + margin).
 * Used by the "Report to engineer" flow — wants the full picture, not a frame.
 * Returns "" if no blocks (caller should handle).
 */
async function snapshotCanvasFull(
  wrapper: HTMLElement,
  blocks: { x: number; y: number; width?: number; height?: number }[],
  maxBytes = 900_000
): Promise<string> {
  if (blocks.length === 0) return ""
  const margin = 80
  let min_x = Infinity, min_y = Infinity, max_x = -Infinity, max_y = -Infinity
  for (const b of blocks) {
    const w = b.width ?? 180
    const h = b.height && b.height > 0 ? b.height : 60
    if (b.x < min_x) min_x = b.x
    if (b.y < min_y) min_y = b.y
    if (b.x + w > max_x) max_x = b.x + w
    if (b.y + h > max_y) max_y = b.y + h
  }
  return snapshotCanvas(
    wrapper,
    {
      min_x: min_x - margin,
      min_y: min_y - margin,
      max_x: max_x + margin,
      max_y: max_y + margin,
    },
    maxBytes
  )
}

/**
 * Push-apart any overlapping rects in O(n²) per iteration. Pure function:
 * returns a new map of rect.id -> { x, y }. Mutates `out` internally for speed.
 */
function resolveCollisions(rects: BlockRect[], maxIters = 24): Record<string, { x: number; y: number }> {
  // PAD adds slack to each push so cascading pairs converge faster and small
  // fractional residue (e.g. h=152.5) can't leave a 1–4 px visible overlap
  // after final rounding.
  const PAD = 6
  const out = rects.map(r => ({ ...r }))
  for (let iter = 0; iter < maxIters; iter++) {
    let any = false
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j]
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        if (overlapX > 0 && overlapY > 0) {
          any = true
          // Push along shorter axis
          if (overlapX < overlapY) {
            const push = overlapX / 2 + PAD
            if (a.x < b.x) { a.x -= push; b.x += push } else { a.x += push; b.x -= push }
          } else {
            const push = overlapY / 2 + PAD
            if (a.y < b.y) { a.y -= push; b.y += push } else { a.y += push; b.y -= push }
          }
        }
      }
    }
    if (!any) break
  }
  const result: Record<string, { x: number; y: number }> = {}
  for (const r of out) result[r.id] = { x: Math.round(r.x), y: Math.round(r.y) }
  return result
}

// ── BSP Tiling Layout ───────────────────────────────────────────────────────

type BSPNode = { type: "leaf"; id: string } | { type: "split"; dir: "h" | "v"; left: BSPNode; right: BSPNode }

function buildBSP(ids: string[], depth = 0): BSPNode | null {
  if (ids.length === 0) return null
  if (ids.length === 1) return { type: "leaf", id: ids[0] }
  const mid = Math.ceil(ids.length / 2)
  return {
    type: "split",
    dir: depth % 2 === 0 ? "v" : "h",
    left: buildBSP(ids.slice(0, mid), depth + 1)!,
    right: buildBSP(ids.slice(mid), depth + 1)!,
  }
}

function bspWeight(n: BSPNode): number {
  return n.type === "leaf" ? 1 : bspWeight(n.left) + bspWeight(n.right)
}

function TiledView({ blocks, connections, selectedIds, onSelect,
  editingId, editingText, onStartEdit, onChangeEdit, onSaveEdit, onCancelEdit,
  onOpenDrawing, isMobile }: {
  blocks: Block[]
  connections: Connection[]
  selectedIds: Set<string>
  onSelect: (id: string, multi: boolean) => void
  editingId: string | null
  editingText: string
  onStartEdit: (id: string, text: string) => void
  onChangeEdit: (text: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onOpenDrawing: (id: string) => void
  isMobile?: boolean
}) {
  const tree = useMemo(() => buildBSP(blocks.map(b => b.id)), [blocks])
  const byId = useMemo(() => { const m: Record<string, Block> = {}; for (const b of blocks) m[b.id] = b; return m }, [blocks])

  const renderNode = (node: BSPNode | null): React.ReactNode => {
    if (!node) return null
    if (node.type === "leaf") {
      const b = byId[node.id]
      if (!b) return null
      const isSel = selectedIds.has(b.id)
      const isAI = !!b.is_ai_generated
      const isEditing = editingId === b.id
      const isDrawing = b.kind === "drawing"
      // Connection count for this block
      const connCount = connections.filter(c => c.from_block_id === b.id || c.to_block_id === b.id).length
      return (
        <div
          key={b.id}
          className="flex flex-1 p-0.5 overflow-hidden min-w-0 min-h-0"
        >
          <div
            data-testid={`tile-${b.id}`}
            data-block-kind={b.kind || "text"}
            onClick={e => { if (isEditing) return; onSelect(b.id, e.ctrlKey || e.metaKey) }}
            onDoubleClick={e => {
              e.stopPropagation()
              if (isDrawing) { onOpenDrawing(b.id); return }
              onStartEdit(b.id, b.text)
            }}
            className={`relative flex flex-col flex-1 overflow-hidden bg-card/80 transition-all hover:bg-card ${
              isEditing ? "cursor-text" : "cursor-pointer"
            } ${isSel ? "ring-1 ring-primary shadow-[0_0_0_1px_var(--primary)]" : ""}`}
            style={{
              borderLeft: `3px solid ${isAI ? "var(--primary)" : "rgba(255,255,255,0.08)"}`,
            }}
          >
            {isDrawing ? (
              <div className="flex-1 overflow-hidden bg-white/[0.02] relative">
                <DrawingPreview scene={parseScene(b.text)} />
                <button
                  data-testid={`tile-drawing-expand-${b.id}`}
                  onClick={e => { e.stopPropagation(); onOpenDrawing(b.id) }}
                  className="absolute right-1 top-1 z-10 rounded-sm bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white/70 hover:bg-black/80 hover:text-white transition-colors"
                  title="Open editor"
                >
                  ⛶
                </button>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
                {isEditing ? (
                  <textarea
                    data-testid={`tile-edit-${b.id}`}
                    autoFocus
                    value={editingText}
                    onChange={e => onChangeEdit(e.target.value)}
                    onBlur={onSaveEdit}
                    onClick={e => e.stopPropagation()}
                    onMouseDown={e => e.stopPropagation()}
                    onKeyDown={e => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        onSaveEdit()
                      } else if (e.key === "Escape") {
                        e.preventDefault()
                        onCancelEdit()
                      }
                    }}
                    className="w-full h-full min-h-[80px] resize-none bg-transparent outline-none text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap break-words"
                  />
                ) : (
                  <div className="whitespace-pre-wrap break-words text-sm text-foreground/90 leading-relaxed">
                    {b.text}
                  </div>
                )}
              </div>
            )}
            <div className="flex items-center justify-between px-3 py-1.5 border-t border-white/5 font-mono text-[8px] font-bold uppercase tracking-wider text-muted-foreground/40">
              <span>
                {isEditing
                  ? "editing — ⌘↵ save · esc cancel"
                  : isDrawing
                    ? (isAI ? "ai · sketch" : "sketch")
                    : (isAI ? "ai" : "user")}
              </span>
              {connCount > 0 && <span>{connCount} link{connCount !== 1 ? "s" : ""}</span>}
            </div>
          </div>
        </div>
      )
    }
    const lw = bspWeight(node.left)
    const rw = bspWeight(node.right)
    return (
      <div className={`flex flex-1 min-h-0 min-w-0 ${node.dir === "v" ? "flex-row" : "flex-col"}`}>
        <div style={{ flex: lw }} className="flex min-h-0 min-w-0">{renderNode(node.left)}</div>
        <div style={{ flex: rw }} className="flex min-h-0 min-w-0">{renderNode(node.right)}</div>
      </div>
    )
  }

  if (blocks.length === 0) {
    return <div className="flex items-center justify-center h-full font-mono text-[10px] uppercase tracking-[0.35em] text-muted-foreground/35">No blocks</div>
  }

  // Mobile: single-column scroll list. BSP gives nice mosaics on wide screens
  // but at <400px each cell collapses to ~95px wide and text wraps to one
  // word per line. Vertical scroll is the only sane phone layout.
  if (isMobile) {
    return (
      <div className="h-full w-full overflow-y-auto overflow-x-hidden bg-[#020202] custom-scrollbar">
        <ul className="flex flex-col gap-1.5 p-2">
          {blocks.map(b => {
            const isSel = selectedIds.has(b.id)
            const isAI = !!b.is_ai_generated
            const isEditing = editingId === b.id
            const isDrawing = b.kind === "drawing"
            const connCount = connections.filter(c => c.from_block_id === b.id || c.to_block_id === b.id).length
            return (
              <li
                key={b.id}
                data-testid={`tile-${b.id}`}
                data-block-kind={b.kind || "text"}
                onClick={e => { if (isEditing) return; onSelect(b.id, e.ctrlKey || e.metaKey) }}
                onDoubleClick={e => {
                  e.stopPropagation()
                  if (isDrawing) { onOpenDrawing(b.id); return }
                  onStartEdit(b.id, b.text)
                }}
                className={`relative flex flex-col rounded-md bg-card/80 transition-all hover:bg-card overflow-hidden ${
                  isSel ? "ring-1 ring-primary shadow-[0_0_0_1px_var(--primary)]" : ""
                }`}
                style={{
                  borderLeft: `3px solid ${isAI ? "var(--primary)" : "rgba(255,255,255,0.08)"}`,
                  minHeight: isDrawing ? 220 : 96,
                }}
              >
                {isDrawing ? (
                  <div className="relative" style={{ minHeight: 220 }}>
                    <DrawingPreview scene={parseScene(b.text)} />
                    <button
                      data-testid={`tile-drawing-expand-${b.id}`}
                      onClick={e => { e.stopPropagation(); onOpenDrawing(b.id) }}
                      className="absolute right-1.5 top-1.5 z-10 rounded-sm bg-black/70 px-2 py-1 font-mono text-[11px] text-white/80 hover:bg-black/90 hover:text-white transition-colors"
                      title="Open editor"
                    >
                      ⛶
                    </button>
                  </div>
                ) : (
                  <div className="px-3 py-3">
                    {isEditing ? (
                      <textarea
                        data-testid={`tile-edit-${b.id}`}
                        autoFocus
                        value={editingText}
                        onChange={e => onChangeEdit(e.target.value)}
                        onBlur={onSaveEdit}
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault(); onSaveEdit()
                          } else if (e.key === "Escape") {
                            e.preventDefault(); onCancelEdit()
                          }
                        }}
                        className="w-full min-h-[80px] resize-y bg-transparent outline-none text-[15px] text-foreground/90 leading-relaxed whitespace-pre-wrap break-words"
                      />
                    ) : (
                      <div className="whitespace-pre-wrap break-words text-[15px] text-foreground/90 leading-relaxed">
                        {b.text}
                      </div>
                    )}
                  </div>
                )}
                <div className="flex items-center justify-between px-3 py-1.5 border-t border-white/5 font-mono text-[9px] font-bold uppercase tracking-wider text-muted-foreground/50">
                  <span>
                    {isEditing
                      ? "editing — ⌘↵ save · esc cancel"
                      : isDrawing
                        ? (isAI ? "ai · sketch" : "sketch")
                        : (isAI ? "ai" : "user")}
                  </span>
                  {connCount > 0 && <span>{connCount} link{connCount !== 1 ? "s" : ""}</span>}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  return <div className="flex h-full w-full overflow-hidden bg-[#020202]">{renderNode(tree)}</div>
}

// ── Graph View (force-directed) ─────────────────────────────────────────────

function GraphView({ blocks, connections, selectedIds, onSelect }: {
  blocks: Block[]
  connections: Connection[]
  selectedIds: Set<string>
  onSelect: (id: string, multi: boolean) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map())
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  // Simple force simulation on mount
  useEffect(() => {
    if (blocks.length === 0) return
    const w = 800, h = 600
    const cx = w / 2, cy = h / 2

    // Degree for sizing
    const deg = new Map<string, number>()
    for (const b of blocks) deg.set(b.id, 0)
    for (const c of connections) {
      deg.set(c.from_block_id, (deg.get(c.from_block_id) || 0) + 1)
      deg.set(c.to_block_id, (deg.get(c.to_block_id) || 0) + 1)
    }

    // Initial positions: circle layout
    const nodes = blocks.map((b, i) => {
      const angle = (2 * Math.PI * i) / blocks.length
      const r = Math.min(w, h) * 0.35
      return {
        id: b.id,
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
        vx: 0, vy: 0,
        degree: deg.get(b.id) || 0,
      }
    })
    const nodeMap = new Map(nodes.map(n => [n.id, n]))

    // Simple spring sim (60 iterations)
    for (let iter = 0; iter < 80; iter++) {
      const alpha = 1 - iter / 80
      // Repulsion between all nodes
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          let dx = nodes[j].x - nodes[i].x
          let dy = nodes[j].y - nodes[i].y
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          const force = (120 * alpha) / dist
          dx = (dx / dist) * force
          dy = (dy / dist) * force
          nodes[i].x -= dx; nodes[i].y -= dy
          nodes[j].x += dx; nodes[j].y += dy
        }
      }
      // Attraction along edges
      for (const c of connections) {
        const a = nodeMap.get(c.from_block_id)
        const b = nodeMap.get(c.to_block_id)
        if (!a || !b) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const force = (dist - 120) * 0.04 * alpha
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        a.x += fx; a.y += fy
        b.x -= fx; b.y -= fy
      }
      // Center gravity
      for (const n of nodes) {
        n.x += (cx - n.x) * 0.01
        n.y += (cy - n.y) * 0.01
      }
    }

    const pos = new Map<string, { x: number; y: number }>()
    for (const n of nodes) pos.set(n.id, { x: n.x, y: n.y })
    setPositions(pos)
  }, [blocks, connections])

  const byId = useMemo(() => { const m: Record<string, Block> = {}; for (const b of blocks) m[b.id] = b; return m }, [blocks])
  const maxDeg = useMemo(() => {
    const deg = new Map<string, number>()
    for (const c of connections) {
      deg.set(c.from_block_id, (deg.get(c.from_block_id) || 0) + 1)
      deg.set(c.to_block_id, (deg.get(c.to_block_id) || 0) + 1)
    }
    let max = 0; deg.forEach(v => { if (v > max) max = v }); return max
  }, [connections])

  // Connected to hovered
  const hoveredConns = useMemo(() => {
    if (!hoveredId) return new Set<string>()
    const s = new Set<string>([hoveredId])
    for (const c of connections) {
      if (c.from_block_id === hoveredId) s.add(c.to_block_id)
      if (c.to_block_id === hoveredId) s.add(c.from_block_id)
    }
    return s
  }, [hoveredId, connections])

  if (blocks.length === 0) {
    return <div className="flex items-center justify-center h-full font-mono text-[10px] uppercase tracking-[0.35em] text-muted-foreground/35">No blocks</div>
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#020202]">
      <svg ref={svgRef} viewBox="0 0 800 600" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
        {/* Edges */}
        {connections.map(c => {
          const from = positions.get(c.from_block_id)
          const to = positions.get(c.to_block_id)
          if (!from || !to) return null
          const dimmed = hoveredId && (!hoveredConns.has(c.from_block_id) || !hoveredConns.has(c.to_block_id))
          return (
            <g key={c.id}>
              <line
                x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                stroke="white"
                strokeWidth={1.2}
                opacity={dimmed ? 0.04 : 0.22}
                style={{ transition: "opacity 0.15s" }}
              />
              {c.label && (
                <text
                  x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 8}
                  textAnchor="middle" fontSize={9} fontFamily="var(--font-mono)" fill={dimmed ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.45)"}
                  style={{ transition: "fill 0.15s" }}
                >
                  {c.label}
                </text>
              )}
            </g>
          )
        })}
        {/* Nodes */}
        {blocks.map(b => {
          const pos = positions.get(b.id)
          if (!pos) return null
          const deg = connections.filter(c => c.from_block_id === b.id || c.to_block_id === b.id).length
          const r = maxDeg > 0 ? 18 + 14 * Math.sqrt(deg / maxDeg) : 22
          const isSel = selectedIds.has(b.id)
          const isAI = !!b.is_ai_generated
          const dimmed = hoveredId && !hoveredConns.has(b.id)
          const label = b.text.length > 35 ? b.text.slice(0, 32) + "..." : b.text
          return (
            <g
              key={b.id}
              onClick={e => onSelect(b.id, e.ctrlKey || e.metaKey)}
              onMouseEnter={() => setHoveredId(b.id)}
              onMouseLeave={() => setHoveredId(null)}
              style={{ cursor: "pointer" }}
              opacity={dimmed ? 0.15 : 1}
            >
              <circle
                cx={pos.x} cy={pos.y} r={r}
                fill={isAI ? "var(--primary)" : "var(--card)"}
                fillOpacity={0.9}
                stroke={isSel ? "var(--primary)" : "rgba(255,255,255,0.15)"}
                strokeWidth={isSel ? 2 : 1}
              />
              <text
                x={pos.x} y={pos.y + r + 14}
                textAnchor="middle" fontSize={10} fontFamily="var(--font-mono)"
                fill={dimmed ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.55)"}
                style={{ pointerEvents: "none", userSelect: "none", transition: "fill 0.15s" }}
              >
                {label}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ── Component ────────────────────────────────────────────────────────────────

type ViewMode = "canvas" | "tiled" | "graph"

export default function Page() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string>("")
  const [blocks, setBlocks] = useState<Block[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [inputText, setInputText] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState("")
  const [selectedConnIds, setSelectedConnIds] = useState<Set<string>>(new Set())
  const [editingConnId, setEditingConnId] = useState<string | null>(null)
  const [editingConnLabel, setEditingConnLabel] = useState("")
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null)
  const [augmentOpen, setAugmentOpen] = useState(false)
  const [augmentPrompt, setAugmentPrompt] = useState("")
  const [augmentBusy, setAugmentBusy] = useState(false)
  const [augmentError, setAugmentError] = useState<string | null>(null)
  const [augmentStructured, setAugmentStructured] = useState(false)
  const [augmentRearrange, setAugmentRearrange] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const canvasInputRef = useRef<HTMLInputElement>(null)
  const augmentInputRef = useRef<HTMLInputElement>(null)

  // ── Report to engineer ──────────────────────────────────────────────────
  // Tracks before/after state of the most recent augment so the user can
  // one-click "Report issue to engineer" without re-snapshotting.
  type ReportContext = {
    before_png: string
    before_state: { blocks: Block[]; connections: Connection[] }
    after_png?: string
    after_state?: { blocks: Block[]; connections: Connection[] }
    prompt?: string
    mode?: string
    ts: number
  }
  const lastAugmentContextRef = useRef<ReportContext | null>(null)
  const [hasReportContext, setHasReportContext] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [reportNote, setReportNote] = useState("")
  const [reportBusy, setReportBusy] = useState(false)

  const undoStackRef = useRef<UndoEntry[]>([])

  // Drag state (client-space delta based, so panning doesn't break drag)
  const dragStateRef = useRef<{
    blockId: string | null
    startBlockX: number
    startBlockY: number
    startClientX: number
    startClientY: number
    moved: boolean
  }>({ blockId: null, startBlockX: 0, startBlockY: 0, startClientX: 0, startClientY: 0, moved: false })

  // Connection drag state
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null)
  const [connectEndPos, setConnectEndPos] = useState<{ x: number; y: number } | null>(null)

  // Viewport pan + zoom (transform: translate(tx,ty) scale(s))
  const [viewport, setViewport] = useState<{ tx: number; ty: number; scale: number }>({ tx: 0, ty: 0, scale: 1 })
  const MIN_SCALE = 0.2
  const MAX_SCALE = 3
  const panStateRef = useRef<{
    active: boolean
    startClientX: number
    startClientY: number
    startTx: number
    startTy: number
    moved: boolean
  }>({ active: false, startClientX: 0, startClientY: 0, startTx: 0, startTy: 0, moved: false })

  // Mobile detection — drives view defaults and sidebar drawer behavior.
  // The canvas view (drag/pan/zoom with multi-touch + small targets) doesn't
  // work well on phone-sized screens; we default mobile users into Tiled.
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    if (typeof window === "undefined") return
    const mq = window.matchMedia("(max-width: 767px)")
    const update = () => setIsMobile(mq.matches)
    update()
    mq.addEventListener("change", update)
    return () => mq.removeEventListener("change", update)
  }, [])

  // View mode — defaults to tiled on mobile (canvas needs precise pan/zoom).
  const [viewMode, setViewMode] = useState<ViewMode>("canvas")
  const didMobileInitRef = useRef(false)
  useEffect(() => {
    if (didMobileInitRef.current) return
    if (isMobile) {
      setViewMode("tiled")
      didMobileInitRef.current = true
    }
  }, [isMobile])

  // If a user is on mobile and somehow lands on canvas, bounce them to tiled.
  // (e.g. they switched device size mid-session). Only auto-correct once.
  useEffect(() => {
    if (isMobile && viewMode === "canvas") {
      setViewMode("tiled")
    }
  }, [isMobile, viewMode])

  // Sidebar collapse — closed by default on mobile (becomes a drawer overlay).
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const didMobileSidebarInitRef = useRef(false)
  useEffect(() => {
    if (didMobileSidebarInitRef.current) return
    if (isMobile) {
      setSidebarOpen(false)
      didMobileSidebarInitRef.current = true
    }
  }, [isMobile])

  // AI call/response debug log (right-side panel)
  const [aiLogOpen, setAiLogOpen] = useState(false)

  // Custom confirm dialog
  const [confirmState, setConfirmState] = useState<{
    open: boolean
    message: string
    onConfirm: () => void
  }>({ open: false, message: "", onConfirm: () => {} })
  const confirmBtnRef = useRef<HTMLButtonElement>(null)
  const askConfirm = useCallback((message: string, onConfirm: () => void) => {
    setConfirmState({ open: true, message, onConfirm })
    setTimeout(() => confirmBtnRef.current?.focus(), 20)
  }, [])
  const closeConfirm = useCallback(() => setConfirmState(s => ({ ...s, open: false })), [])

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
      // Deep link: ?session=<id> — load that session if it exists
      const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null
      const urlSession = params?.get("session") || null
      const urlAugment = params?.get("augment") || null
      if (urlSession && list.some(s => s.id === urlSession)) {
        setActiveSessionId(urlSession)
      } else if (list.length > 0) {
        setActiveSessionId(list[0].id)
      } else {
        // auto-create first session
        const s: Session = await api("/api/sessions", { method: "POST", body: JSON.stringify({}) })
        setSessions([s])
        setActiveSessionId(s.id)
      }
      // Auto-open augment if ?augment=1 or ?augment=structured
      if (urlAugment) {
        setAugmentOpen(true)
        setAugmentError(null)
        if (urlAugment === "structured") setAugmentStructured(true)
        setTimeout(() => augmentInputRef.current?.focus(), 80)
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
    // Stagger positions so new blocks don't overlap
    const idx = blocks.length
    const cols = 4
    const x = 100 + (idx % cols) * 220
    const y = 100 + Math.floor(idx / cols) * 120
    const n: Block = await api(`/api/sessions/${activeSessionId}/notes`, {
      method: "POST",
      body: JSON.stringify({ text, x, y }),
    })
    setBlocks(prev => [...prev, n])
  }, [activeSessionId, blocks.length])

  // ── Drawing-block creation + fullscreen editor state ─────────────────────
  // Creates a kind='drawing' block, opens it immediately in the overlay so
  // the user can sketch right away. Empty scene initially.
  const createDrawingBlock = useCallback(async () => {
    if (!activeSessionId) return
    const idx = blocks.length
    const cols = 4
    const x = 100 + (idx % cols) * 220
    const y = 100 + Math.floor(idx / cols) * 120
    const n: Block = await api(`/api/sessions/${activeSessionId}/notes`, {
      method: "POST",
      body: JSON.stringify({
        text: serializeScene(emptyScene()),
        x, y,
        width: 360,
        height: 280,
        kind: "drawing",
      }),
    })
    setBlocks(prev => [...prev, n])
    setDrawingOverlayId(n.id)
  }, [activeSessionId, blocks.length])

  const [drawingOverlayId, setDrawingOverlayId] = useState<string | null>(null)
  const drawingOverlayBlock = useMemo(
    () => (drawingOverlayId ? blocks.find(b => b.id === drawingOverlayId) || null : null),
    [drawingOverlayId, blocks]
  )

  const saveDrawingScene = useCallback(async (id: string, scene: ExcalidrawScene) => {
    const text = serializeScene(scene)
    try {
      const updated: Block = await api(`/api/notes/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ text }),
      })
      setBlocks(prev => prev.map(b => (b.id === id ? updated : b)))
    } catch (e: any) {
      showToast(`Drawing save error: ${e.message}`)
    }
  }, [showToast])

  // ── Voice input (mic in Entry bar → Whisper transcription) ───────────────
  // Tap mic to start recording, tap again to stop. On stop, the audio is
  // POSTed to /api/transcribe (which forwards to the same Whisper endpoint
  // the Matrix transcription Hand uses). The transcript is appended to the
  // input field — user reviews + hits Enter / Submit to actually create the
  // block, so we never auto-submit unverified speech.
  // Entry-bar voice recorder — appends transcript to the new-block input.
  const entryVoice = useVoiceRecorder({
    onTranscript: text => {
      setInputText(prev => {
        const sep = prev && !prev.endsWith(" ") ? " " : ""
        return prev + sep + text
      })
      canvasInputRef.current?.focus()
    },
    onError: showToast,
  })
  const recording = entryVoice.recording
  const transcribing = entryVoice.transcribing
  const toggleRecording = entryVoice.toggle

  // Augment-dialog voice recorder — appends transcript to the augment prompt.
  const augmentVoice = useVoiceRecorder({
    onTranscript: text => {
      setAugmentPrompt(prev => {
        const sep = prev && !prev.endsWith(" ") ? " " : ""
        return prev + sep + text
      })
      augmentInputRef.current?.focus()
    },
    onError: showToast,
  })

  // ── Drive Mode (turn-based voice ↔ canvas, no LLM rundown) ───────────────
  // Designed for hands-on-the-wheel use: tap once to enter, then it's a loop:
  //   listening → (you stop talking + tap, or auto via VAD) → thinking →
  //   speaking → listening (auto-armed)
  // The "speaking" voice is Kokoro (self-hosted), the words are templated
  // from the actual augment diff — no LLM in the response loop.
  const [driveOpen, setDriveOpen] = useState(false)
  type DriveStatus = "idle" | "listening" | "thinking" | "speaking" | "error"
  const [driveStatus, setDriveStatus] = useState<DriveStatus>("idle")
  const [driveLastRundown, setDriveLastRundown] = useState<string>("")
  const [driveTurnCount, setDriveTurnCount] = useState(0)
  const driveAudioRef = useRef<HTMLAudioElement | null>(null)
  const driveAutoArmRef = useRef<boolean>(false)
  // Refs to break the circular dep between runDriveTurn and driveVoice.
  // Both are defined below; the recorder's callbacks read these refs at
  // call-time so they always see the latest function reference.
  const runDriveTurnRef = useRef<((text: string) => void) | null>(null)
  const driveVoiceRef = useRef<{
    start: () => Promise<void> | void
    stop: () => void
    recording: boolean
  } | null>(null)
  // Guard so rearm can only fire once per turn even if multiple paths
  // (onended + fallback timer + onerror) all race to call it.
  const driveRearmedRef = useRef<boolean>(true)
  const safeRearm = useCallback(() => {
    if (driveRearmedRef.current) {
      console.log("[drive] safeRearm: already rearmed, skip")
      return
    }
    driveRearmedRef.current = true
    if (!driveAutoArmRef.current) {
      console.log("[drive] safeRearm: auto-arm off → idle")
      setDriveStatus("idle")
      return
    }
    console.log("[drive] safeRearm: → listening")
    setDriveStatus("listening")
    setTimeout(() => {
      console.log("[drive] safeRearm: starting recorder")
      driveVoiceRef.current?.start()
    }, 80)
  }, [])

  // Drive Mode voice recorder — on transcript, calls the latest runDriveTurn.
  const driveVoice = useVoiceRecorder({
    onTranscript: text => {
      // If we're not in drive mode anymore (user closed it mid-recording), ignore.
      if (!driveAutoArmRef.current) return
      runDriveTurnRef.current?.(text)
    },
    onError: msg => {
      console.warn("drive voice error:", msg)
      setDriveLastRundown(msg)
      safeRearm()
    },
  })
  // Keep the ref pointing at the latest recorder API.
  useEffect(() => {
    driveVoiceRef.current = {
      start: driveVoice.start,
      stop: driveVoice.stop,
      recording: driveVoice.recording,
    }
  }, [driveVoice.start, driveVoice.stop, driveVoice.recording])

  // Run one Drive Mode turn: transcript → structured augment → rundown → TTS.
  const runDriveTurn = useCallback(async (transcript: string) => {
    if (!activeSessionId) return
    console.log("[drive] turn start, transcript len:", transcript.length)
    // Mark this turn as not-yet-rearmed; safeRearm() flips it back to true.
    driveRearmedRef.current = false
    setDriveStatus("thinking")
    try {
      // Always use structured mode in Drive Mode — it adds new blocks +
      // connections rather than replacing existing content. This matches
      // "creates and links the thoughts I have" from the user spec.
      const res = await api(`/api/sessions/${activeSessionId}/augment`, {
        method: "POST",
        body: JSON.stringify({
          prompt: transcript,
          block_ids: [], // Empty scope — let the LLM operate on whole session
          mode: "structured",
        }),
      })
      // Refresh canvas state so the user sees the new blocks/connections
      // when they look at the screen later.
      const data = await api(`/api/sessions/${activeSessionId}`)
      setBlocks(data.notes || [])
      setConnections(data.connections || [])

      // Push undo entry so user can undo Drive Mode turns from the canvas.
      if (res.mode === "structured") {
        const newBlockIds: string[] = (res.new_blocks || []).map((b: any) => b.id)
        const newConnIds: string[] = (res.new_connections || []).map((c: any) => c.id)
        const snap = res.snapshot || {}
        undoStackRef.current.push({
          kind: "augment-structured",
          deleted_notes: snap.deleted_notes || [],
          deleted_connections: snap.deleted_connections || [],
          new_block_ids: newBlockIds,
          new_connection_ids: newConnIds,
        })
      }

      // Build the rundown text from whatever the server actually did.
      const diff: AugmentDiff = {
        new_blocks: (res.new_blocks || []).map((b: any) => ({ id: b.id, text: b.text })),
        new_connections: (res.new_connections || []).map((c: any) => ({
          id: c.id, from: c.from_block_id, to: c.to_block_id,
        })),
        new_note_id: res.new_note?.id,
        new_note_text: res.new_note?.text,
      }
      const rundown = formatRundown(diff)
      setDriveLastRundown(rundown)
      setDriveTurnCount(c => c + 1)

      // TTS — Kokoro via /api/speak. If TTS fails, just go back to listening.
      setDriveStatus("speaking")
      try {
        const speakRes = await fetch("/api/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: rundown, format: "mp3" }),
        })
        if (!speakRes.ok) throw new Error(`speak ${speakRes.status}`)
        const audioBuf = await speakRes.arrayBuffer()
        const blob = new Blob([audioBuf], { type: "audio/mpeg" })
        const url = URL.createObjectURL(blob)
        // Reuse the same Audio element so iOS keeps the play permission.
        let audio = driveAudioRef.current
        if (!audio) {
          audio = new Audio()
          driveAudioRef.current = audio
        }
        // Defensive reset — clear any prior handlers so a stale onended can't
        // double-fire and a previous fallback timer can't clobber this turn.
        audio.onended = null
        audio.onerror = null
        audio.onloadedmetadata = null
        audio.loop = false
        try { audio.pause() } catch {}
        audio.src = url

        // Fallback rearm: iOS Safari sometimes silently drops `audio.onended`
        // events on a reused HTMLAudioElement. Schedule a max-duration timer
        // and clear it from onended/onerror. Default to 30s if metadata never
        // arrives; bump to actual duration + 1.5s buffer once we know it.
        let rearmTimer: ReturnType<typeof setTimeout> | null = null
        const armFallback = (ms: number) => {
          if (rearmTimer) clearTimeout(rearmTimer)
          console.log(`[drive] arming fallback rearm timer: ${ms}ms`)
          rearmTimer = setTimeout(() => {
            console.warn("[drive] fallback rearm fired (audio.onended likely never came)")
            safeRearm()
          }, ms)
        }
        const clearFallback = () => {
          if (rearmTimer) { clearTimeout(rearmTimer); rearmTimer = null }
        }
        audio.onloadedmetadata = () => {
          if (Number.isFinite(audio!.duration) && audio!.duration > 0) {
            armFallback(Math.ceil(audio!.duration * 1000) + 1500)
          }
        }
        audio.onended = () => {
          console.log("[drive] audio.onended")
          clearFallback()
          URL.revokeObjectURL(url)
          safeRearm()
        }
        audio.onerror = (e) => {
          console.warn("[drive] audio.onerror", e)
          clearFallback()
          URL.revokeObjectURL(url)
          safeRearm()
        }
        // Initial 30s ceiling — replaced once metadata loads.
        armFallback(30000)

        try {
          await audio.play()
          console.log("[drive] audio.play() resolved, duration:", audio.duration)
        } catch (err) {
          console.warn("[drive] audio play failed:", err)
          clearFallback()
          safeRearm()
        }
      } catch (e: any) {
        console.warn("[drive] TTS failed:", e?.message || e)
        safeRearm()
      }
    } catch (e: any) {
      console.error("drive augment failed:", e)
      setDriveLastRundown(`Error: ${e?.message || "augment failed"}`)
      setDriveStatus("error")
      // Recover: re-arm after a moment so a single bad turn doesn't kill the session.
      if (driveAutoArmRef.current) {
        setTimeout(safeRearm, 1200)
      }
    }
  }, [activeSessionId, safeRearm])
  useEffect(() => { runDriveTurnRef.current = runDriveTurn }, [runDriveTurn])

  // Open Drive Mode — flip auto-arm flag and start the first listen.
  const openDriveMode = useCallback(() => {
    if (!activeSessionId) {
      showToast("Pick a canvas first")
      return
    }
    driveAutoArmRef.current = true
    setDriveOpen(true)
    setDriveLastRundown("")
    setDriveTurnCount(0)
    setDriveStatus("listening")
    setTimeout(() => { driveVoiceRef.current?.start() }, 120)
  }, [activeSessionId, showToast])

  // Close Drive Mode — stop everything cleanly.
  const closeDriveMode = useCallback(() => {
    driveAutoArmRef.current = false
    driveRearmedRef.current = true // suppress any in-flight onended → rearm
    if (driveVoiceRef.current?.recording) driveVoiceRef.current.stop()
    const a = driveAudioRef.current
    if (a) {
      try { a.pause(); a.src = ""; a.onended = null; a.onerror = null } catch {}
    }
    setDriveOpen(false)
    setDriveStatus("idle")
  }, [])

  // Big-button handler in the overlay — meaning depends on current state.
  const handleDriveTap = useCallback(() => {
    if (driveStatus === "listening") {
      // Stop & process this turn
      driveVoiceRef.current?.stop()
      // useVoiceRecorder will fire onTranscript → runDriveTurnRef.current(...)
    } else if (driveStatus === "speaking") {
      // Skip the rundown — go straight back to listening.
      const a = driveAudioRef.current
      if (a) { try { a.pause() } catch {} }
      safeRearm()
    } else if (driveStatus === "idle" || driveStatus === "error") {
      // Re-arm
      driveAutoArmRef.current = true
      safeRearm()
    }
    // thinking → tap is no-op (waiting on server)
  }, [driveStatus, safeRearm])

  // ── Delete selected blocks (with in-app confirm) ─────────────────────────
  const performDeleteSelected = useCallback(async () => {
    if (selectedIds.size === 0) return
    const ids = Array.from(selectedIds)
    for (const id of ids) {
      await api(`/api/notes/${id}`, { method: "DELETE" })
    }
    setBlocks(prev => prev.filter(b => !selectedIds.has(b.id)))
    setConnections(prev => prev.filter(c => !selectedIds.has(c.from_block_id) && !selectedIds.has(c.to_block_id)))
    setSelectedIds(new Set())
  }, [selectedIds])

  const deleteSelected = useCallback(async (skipConfirm = false) => {
    if (selectedIds.size === 0) return
    const n = selectedIds.size
    if (skipConfirm) {
      performDeleteSelected()
      return
    }
    askConfirm(`Delete ${n} selected block${n === 1 ? "" : "s"}?`, () => performDeleteSelected())
  }, [selectedIds, performDeleteSelected, askConfirm])

  // ── Delete session ──────────────────────────────────────────────────────
  const deleteSession = useCallback(async (id: string) => {
    const s = sessions.find(x => x.id === id)
    const label = s?.name || id
    askConfirm(
      `Delete canvas "${label}" and all its blocks? This cannot be undone.`,
      async () => {
        try {
          await api(`/api/sessions/${id}`, { method: "DELETE" })
          setSessions(prev => {
            const next = prev.filter(x => x.id !== id)
            if (id === activeSessionId) {
              setActiveSessionId(next[0]?.id || "")
              setBlocks([])
              setConnections([])
              setSelectedIds(new Set())
            }
            return next
          })
          showToast("Canvas deleted")
        } catch (e: any) {
          showToast(`Delete failed: ${e.message}`)
        }
      }
    )
  }, [sessions, activeSessionId, showToast, askConfirm])

  // ── Update block position (after drag) ───────────────────────────────────
  const persistBlockPos = useCallback(async (id: string, x: number, y: number) => {
    try {
      await api(`/api/notes/${id}`, { method: "PATCH", body: JSON.stringify({ x, y }) })
    } catch (e: any) {
      showToast(`Save error: ${e.message}`)
    }
  }, [showToast])

  // ── Update block size (after resize) ─────────────────────────────────────
  const persistBlockSize = useCallback(async (id: string, width: number, height: number) => {
    try {
      await api(`/api/notes/${id}`, { method: "PATCH", body: JSON.stringify({ width, height }) })
    } catch (e: any) {
      showToast(`Save error: ${e.message}`)
    }
  }, [showToast])

  // Resize state
  const resizingRef = useRef<{ id: string; startX: number; startY: number; startW: number; startH: number } | null>(null)
  const onResizeStart = useCallback((e: React.PointerEvent, block: Block) => {
    e.stopPropagation()
    e.preventDefault()
    const el = document.querySelector(`[data-block-id="${block.id}"]`) as HTMLElement | null
    const rect = el?.getBoundingClientRect()
    resizingRef.current = {
      id: block.id,
      startX: e.clientX,
      startY: e.clientY,
      startW: block.width ?? rect?.width ?? 180,
      startH: block.height || rect?.height || 60,
    }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }, [])
  const onResizeMove = useCallback((e: React.PointerEvent) => {
    const r = resizingRef.current
    if (!r) return
    const dx = (e.clientX - r.startX) / viewport.scale
    const dy = (e.clientY - r.startY) / viewport.scale
    const newW = Math.max(100, r.startW + dx)
    const newH = Math.max(40, r.startH + dy)
    setBlocks(prev => prev.map(b => b.id === r.id ? { ...b, width: newW, height: newH } : b))
  }, [viewport.scale])
  const onResizeEnd = useCallback((e: React.PointerEvent) => {
    const r = resizingRef.current
    resizingRef.current = null
    if (!r) return
    ;(e.target as Element).releasePointerCapture?.(e.pointerId)
    const b = blocks.find(x => x.id === r.id)
    if (b) persistBlockSize(r.id, b.width ?? 180, b.height ?? 60)
  }, [blocks, persistBlockSize])

  // ── Save connection label ────────────────────────────────────────────────
  const saveConnLabel = useCallback(async () => {
    if (!editingConnId) return
    const id = editingConnId
    const label = editingConnLabel
    setEditingConnId(null)
    setEditingConnLabel("")
    try {
      await api(`/api/connections/${id}`, { method: "PATCH", body: JSON.stringify({ label }) })
      setConnections(prev => prev.map(c => c.id === id ? { ...c, label } : c))
    } catch (e: any) {
      showToast(`Label save error: ${e.message}`)
    }
  }, [editingConnId, editingConnLabel, showToast])

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
      startBlockX: block.x,
      startBlockY: block.y,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
    }
  }

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const ds = dragStateRef.current
    const ps = panStateRef.current
    if (ds.blockId) {
      const dx = e.clientX - ds.startClientX
      const dy = e.clientY - ds.startClientY
      if (!ds.moved && Math.abs(dx) + Math.abs(dy) > 3) ds.moved = true
      if (ds.moved) {
        // divide by scale so block moves 1:1 with pointer on screen
        const newX = ds.startBlockX + dx / viewport.scale
        const newY = ds.startBlockY + dy / viewport.scale
        setBlocks(prev => prev.map(b => (b.id === ds.blockId ? { ...b, x: newX, y: newY } : b)))
      }
    } else if (ps.active) {
      const dx = e.clientX - ps.startClientX
      const dy = e.clientY - ps.startClientY
      if (!ps.moved && Math.abs(dx) + Math.abs(dy) > 3) ps.moved = true
      if (ps.moved) {
        setViewport(v => ({ ...v, tx: ps.startTx + dx, ty: ps.startTy + dy }))
      }
    } else if (connectingFrom) {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (rect) {
        setConnectEndPos({
          x: (e.clientX - rect.left - viewport.tx) / viewport.scale,
          y: (e.clientY - rect.top - viewport.ty) / viewport.scale,
        })
      }
    }
  }, [connectingFrom, viewport.tx, viewport.ty, viewport.scale])

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    const ds = dragStateRef.current
    const ps = panStateRef.current
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
    dragStateRef.current = { blockId: null, startBlockX: 0, startBlockY: 0, startClientX: 0, startClientY: 0, moved: false }

    // End pan — if no move, treat as background click (deselect)
    if (ps.active) {
      if (!ps.moved) {
        setSelectedIds(new Set())
        setSelectedConnIds(new Set())
        canvasInputRef.current?.blur()
      }
      panStateRef.current = { active: false, startClientX: 0, startClientY: 0, startTx: 0, startTy: 0, moved: false }
    }

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

  // ── Canvas background: start pan (also deselects if no movement) ─────────
  const onCanvasMouseDown = (e: React.MouseEvent) => {
    const isBg =
      e.target === canvasRef.current ||
      (e.target as HTMLElement).dataset.canvasBg === "true"
    if (!isBg) return
    panStateRef.current = {
      active: true,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startTx: viewport.tx,
      startTy: viewport.ty,
      moved: false,
    }
  }

  const recenterViewport = useCallback(() => {
    setViewport({ tx: 0, ty: 0, scale: 1 })
    showToast("Recentered")
  }, [showToast])

  // Zoom around a specific screen point (cx,cy relative to canvas element)
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setViewport(v => {
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor))
      const k = newScale / v.scale
      return {
        scale: newScale,
        tx: cx - (cx - v.tx) * k,
        ty: cy - (cy - v.ty) * k,
      }
    })
  }, [])

  const zoomIn = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    zoomAt(1.2, rect.width / 2, rect.height / 2)
  }, [zoomAt])

  const zoomOut = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    zoomAt(1 / 1.2, rect.width / 2, rect.height / 2)
  }, [zoomAt])

  // Wheel zoom + pan — attached as native non-passive listener so preventDefault()
  // actually blocks page scroll on iPad Safari (React's onWheel is passive by default).
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        const cx = e.clientX - rect.left
        const cy = e.clientY - rect.top
        const factor = Math.exp(-e.deltaY * 0.01)
        setViewport(v => {
          const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor))
          const k = newScale / v.scale
          return { scale: newScale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k }
        })
      } else {
        setViewport(v => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }))
      }
    }
    el.addEventListener("wheel", handler, { passive: false })
    return () => el.removeEventListener("wheel", handler)
  }, [])

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

      // Ctrl/Cmd+A — select all blocks
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        if (!isInput) {
          e.preventDefault()
          setSelectedIds(new Set(blocks.map(b => b.id)))
          return
        }
      }

      // Delete key
      if ((e.key === "Delete" || e.key === "Backspace") && !isInput) {
        if (selectedIds.size > 0) {
          e.preventDefault()
          deleteSelected()
          return
        }
        if (selectedConnIds.size > 0) {
          e.preventDefault()
          const count = selectedConnIds.size
          askConfirm(`Delete ${count} selected connection${count === 1 ? "" : "s"}?`, async () => {
            for (const cid of selectedConnIds) {
              await api(`/api/connections/${cid}`, { method: "DELETE" }).catch(() => {})
            }
            setConnections(prev => prev.filter(c => !selectedConnIds.has(c.id)))
            setSelectedConnIds(new Set())
          })
          return
        }
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
          setSelectedConnIds(new Set())
        }
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, augmentOpen, activeSessionId, editingId, deleteSelected, blocks])

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
    } else if (entry.kind === "augment-structured" && activeSessionId) {
      try {
        // Delete all new blocks (cascades their connections on the server)
        for (const bid of entry.new_block_ids) {
          await api(`/api/notes/${bid}`, { method: "DELETE" }).catch(() => {})
        }
        // Explicitly delete any remaining new connections just in case
        for (const cid of entry.new_connection_ids) {
          await api(`/api/connections/${cid}`, { method: "DELETE" }).catch(() => {})
        }
        // Recreate the deleted blocks
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
          }).catch(() => {})
        }
        // Recreate the deleted connections
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
        const data = await api(`/api/sessions/${activeSessionId}`)
        setBlocks(data.notes || [])
        setConnections(data.connections || [])
        showToast(`Undone structured (${entry.deleted_notes.length} restored)`)
      } catch (e: any) {
        showToast(`Undo failed: ${e.message}`)
      }
    } else if (entry.kind === "rearrange" && activeSessionId) {
      try {
        // Restore prior positions
        for (const p of entry.prior_positions) {
          await api(`/api/notes/${p.id}`, {
            method: "PATCH",
            body: JSON.stringify({ x: p.x, y: p.y }),
          }).catch(() => {})
        }
        // Delete connections the rearrange added
        for (const cid of entry.added_connection_ids) {
          await api(`/api/connections/${cid}`, { method: "DELETE" }).catch(() => {})
        }
        // Recreate connections the rearrange removed
        for (const c of entry.removed_connections) {
          await api(`/api/sessions/${activeSessionId}/connections`, {
            method: "POST",
            body: JSON.stringify({
              id: c.id,
              from_block_id: c.from_block_id,
              to_block_id: c.to_block_id,
              label: c.label,
            }),
          }).catch(() => {})
        }
        const data = await api(`/api/sessions/${activeSessionId}`)
        setBlocks(data.notes || [])
        setConnections(data.connections || [])
        showToast(`Undone rearrange (${entry.prior_positions.length} positions restored)`)
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

    // Try to capture a "before" snapshot for the Report-to-engineer flow.
    // Best-effort — if html-to-image fails or we're not in canvas view, skip.
    let beforeReport: ReportContext | null = null
    try {
      const wrapperEl = canvasRef.current?.querySelector(":scope > div") as HTMLElement | null
      if (wrapperEl && blocks.length > 0) {
        const before_png = await snapshotCanvasFull(wrapperEl, blocks)
        if (before_png) {
          beforeReport = {
            before_png,
            before_state: { blocks: [...blocks], connections: [...connections] },
            prompt: augmentPrompt,
            mode: augmentRearrange ? "rearrange" : augmentStructured ? "structured" : "default",
            ts: Date.now(),
          }
        }
      }
    } catch {
      // Best-effort; silently skip
    }

    try {
      const scopeIds = selectedIds.size > 0 ? Array.from(selectedIds) : blocks.map(b => b.id)

      // ── Rearrange mode: vision-grounded, returns moves + connection diff ──
      if (augmentRearrange) {
        const inScope = blocks.filter(b => scopeIds.includes(b.id))
        if (inScope.length < 2) {
          throw new Error("Rearrange needs at least 2 blocks in scope.")
        }
        // Find the inner transformed wrapper (first child of canvasRef)
        const wrapperEl = canvasRef.current?.querySelector(":scope > div") as HTMLElement | null
        if (!wrapperEl) throw new Error("Canvas not visible — switch to Canvas view first.")

        // Compute content-space frame: bbox of in-scope blocks + 80px margin
        const margin = 80
        let min_x = Infinity, min_y = Infinity, max_x = -Infinity, max_y = -Infinity
        for (const b of inScope) {
          const w = b.width ?? 180
          const h = b.height && b.height > 0 ? b.height : 60
          if (b.x < min_x) min_x = b.x
          if (b.y < min_y) min_y = b.y
          if (b.x + w > max_x) max_x = b.x + w
          if (b.y + h > max_y) max_y = b.y + h
        }
        min_x -= margin; min_y -= margin; max_x += margin; max_y += margin
        const fw = max_x - min_x, fh = max_y - min_y
        if (fw <= 0 || fh <= 0) throw new Error("Invalid frame.")

        // Snapshot the canvas (content-space, frame-cropped)
        const image_data_url = await snapshotCanvas(wrapperEl, { min_x, min_y, max_x, max_y })

        // Normalize blocks to 0–1000 frame
        const SPAN = 1000
        const sx = SPAN / fw, sy = SPAN / fh
        const blocks_in_frame = inScope.map(b => {
          const w = b.width ?? 180
          const h = b.height && b.height > 0 ? b.height : 60
          return {
            id: b.id,
            text: b.text,
            x: Math.round((b.x - min_x) * sx),
            y: Math.round((b.y - min_y) * sy),
            w: Math.round(w * sx),
            h: Math.round(h * sy),
          }
        })

        const res = await api(`/api/sessions/${activeSessionId}/augment`, {
          method: "POST",
          body: JSON.stringify({
            mode: "rearrange",
            prompt: augmentPrompt,
            block_ids: scopeIds,
            image_data_url,
            frame: { min_x, min_y, max_x, max_y },
            blocks_in_frame,
          }),
        })

        // Convert returned moves (0–1000) back to content pixels
        const movesById: Record<string, { x: number; y: number }> = {}
        for (const m of (res.moves || []) as Array<{ block_id: string; x: number; y: number }>) {
          movesById[m.block_id] = {
            x: Math.round(min_x + m.x / sx),
            y: Math.round(min_y + m.y / sy),
          }
        }
        // Build proposed rect set: moved blocks at new pos, others at current pos.
        // Only in-scope blocks get pushed around — out-of-scope blocks keep their pos.
        // CRITICAL: measure REAL rendered heights from DOM, because DB stores
        // height=0 for auto-sized blocks and a long wrapping-text block can be
        // 120–200 px tall — using a default 60 lets blocks visibly overlap.
        const scale = viewport.scale || 1
        const measureHeight = (id: string, fallback: number): number => {
          const el = document.querySelector(`[data-block-id="${id}"]`) as HTMLElement | null
          if (!el) return fallback
          const r = el.getBoundingClientRect()
          // r is in screen pixels (post-scale). Convert back to canvas coords.
          const h = r.height / scale
          return h > 0 ? h : fallback
        }
        const proposed: BlockRect[] = inScope.map(b => {
          const w = b.width ?? 180
          const dbH = b.height && b.height > 0 ? b.height : 0
          const h = dbH || measureHeight(b.id, 60)
          const target = movesById[b.id]
          return {
            id: b.id,
            x: target ? target.x : b.x,
            y: target ? target.y : b.y,
            w, h,
          }
        })
        let resolved = resolveCollisions(proposed)

        // ── Two-pass refinement: project the proposed layout visually back to
        // the LLM and let it correct itself. The first pass is "blind" — it
        // emits coordinates without seeing the rendered result. The second
        // pass shows the actual rendered DOM (post-resolver, post-text-wrap,
        // including any in-scope drawings) so the model can fix gridded /
        // overlapping / off-template results.
        try {
          // 1. Apply proposed positions to LOCAL state only (no PATCH yet).
          const previewBlocks = blocks.map(b => {
            const np = resolved[b.id]
            return np ? { ...b, x: np.x, y: np.y } : b
          })
          setBlocks(previewBlocks)
          // 2. Wait for two paints — first to commit the React state, second
          //    to ensure layout/text-wrap is fully measured before snapshot.
          await new Promise<void>(r =>
            requestAnimationFrame(() => requestAnimationFrame(() => r()))
          )
          // 3. Snapshot the proposed canvas using the same frame as before.
          const proposed_image_data_url = await snapshotCanvas(wrapperEl, { min_x, min_y, max_x, max_y })
          // 4. Build proposed_blocks_in_frame at the new positions.
          const proposed_blocks_in_frame = inScope.map(b => {
            const np = resolved[b.id] || { x: b.x, y: b.y }
            const w = b.width ?? 180
            const h = b.height && b.height > 0 ? b.height : measureHeight(b.id, 60)
            return {
              id: b.id,
              text: b.text,
              x: Math.round((np.x - min_x) * sx),
              y: Math.round((np.y - min_y) * sy),
              w: Math.round(w * sx),
              h: Math.round(h * sy),
            }
          })
          // 5. Call refine — gets back ONLY the moves that should change.
          const refineRes = await api(`/api/sessions/${activeSessionId}/augment`, {
            method: "POST",
            body: JSON.stringify({
              mode: "rearrange-refine",
              prompt: augmentPrompt,
              block_ids: scopeIds,
              original_image_data_url: image_data_url,
              proposed_image_data_url,
              proposed_blocks_in_frame,
            }),
          })
          const refineMoves = (refineRes.moves || []) as Array<{ block_id: string; x: number; y: number }>
          if (refineMoves.length > 0) {
            // Convert refine moves to content pixels and merge into the proposed rects
            const refinedRects: BlockRect[] = inScope.map(b => {
              const cur = resolved[b.id] || { x: b.x, y: b.y }
              const m = refineMoves.find(rm => rm.block_id === b.id)
              const w = b.width ?? 180
              const h = b.height && b.height > 0 ? b.height : measureHeight(b.id, 60)
              if (m) {
                return {
                  id: b.id,
                  x: Math.round(min_x + m.x / sx),
                  y: Math.round(min_y + m.y / sy),
                  w, h,
                }
              }
              return { id: b.id, x: cur.x, y: cur.y, w, h }
            })
            resolved = resolveCollisions(refinedRects)
          }
        } catch (refineErr) {
          // Refinement is best-effort — if it fails, fall back to first-pass positions.
          console.warn("rearrange refine failed; using first-pass positions:", refineErr)
        }

        // Apply: PATCH every block whose final pos differs by > 1px from its prior DB pos.
        // Using the (possibly refined) `resolved` rects.
        const priorPositions = inScope.map(b => ({ id: b.id, x: b.x, y: b.y }))
        for (const b of inScope) {
          const np = resolved[b.id]
          if (!np) continue
          if (Math.abs(np.x - b.x) > 1 || Math.abs(np.y - b.y) > 1) {
            await api(`/api/notes/${b.id}`, {
              method: "PATCH",
              body: JSON.stringify({ x: np.x, y: np.y }),
            }).catch(() => {})
          }
        }

        // Refresh
        const data = await api(`/api/sessions/${activeSessionId}`)
        setBlocks(data.notes || [])
        setConnections(data.connections || [])

        // Server already applied connection diff atomically; pull the undo info
        // from `res.snapshot` (server-authoritative shape).
        const snap = res.snapshot || {}
        const addedConnIds: string[] = Array.isArray(snap.added_connection_ids)
          ? snap.added_connection_ids
          : []
        const removedConns: { id: string; from_block_id: string; to_block_id: string; label?: string }[] =
          (snap.removed_connections || []).map((c: any) => ({
            id: c.id,
            from_block_id: c.from_block_id,
            to_block_id: c.to_block_id,
            label: c.label,
          }))

        undoStackRef.current.push({
          kind: "rearrange",
          prior_positions: priorPositions,
          added_connection_ids: addedConnIds,
          removed_connections: removedConns,
        })
        showToast(
          `Rearranged ${Object.keys(movesById).length} block${Object.keys(movesById).length === 1 ? "" : "s"}` +
          (addedConnIds.length || removedConns.length
            ? ` · +${addedConnIds.length}/-${removedConns.length} conns`
            : "")
        )
        setAugmentOpen(false)
        setAugmentPrompt("")
        setAugmentRearrange(false)

        // After-snapshot for Report-to-engineer (rearrange branch)
        if (beforeReport) {
          try {
            await new Promise(r => setTimeout(r, 80))
            const afterBlocks: Block[] = data.notes || []
            const afterConns: Connection[] = data.connections || []
            const after_png = wrapperEl && afterBlocks.length > 0
              ? await snapshotCanvasFull(wrapperEl, afterBlocks)
              : ""
            lastAugmentContextRef.current = {
              ...beforeReport,
              after_png: after_png || undefined,
              after_state: { blocks: afterBlocks, connections: afterConns },
            }
            setHasReportContext(true)
          } catch {
            lastAugmentContextRef.current = beforeReport
            setHasReportContext(true)
          }
        }
        return
      }

      // If any in-scope blocks are drawings, render them to PNG so the LLM can
      // actually see the sketch. Skip empty drawings; cap at maxDim=1024 to
      // keep payload under the per-image budget.
      const drawing_images: Record<string, string> = {}
      const inScopeDrawings = blocks.filter(b => scopeIds.includes(b.id) && b.kind === "drawing")
      for (const b of inScopeDrawings) {
        try {
          const url = await renderSceneToPng(parseScene(b.text), { maxDim: 1024 })
          if (url) drawing_images[b.id] = url
        } catch (e) {
          // Non-fatal; LLM will see the placeholder text only
          console.warn("renderSceneToPng failed for", b.id, e)
        }
      }

      const res = await api(`/api/sessions/${activeSessionId}/augment`, {
        method: "POST",
        body: JSON.stringify({
          prompt: augmentPrompt,
          block_ids: scopeIds,
          mode: augmentStructured ? "structured" : "default",
          drawing_images: Object.keys(drawing_images).length > 0 ? drawing_images : undefined,
        }),
      })
      // Refresh first (so UI reflects whatever the server did)
      const data = await api(`/api/sessions/${activeSessionId}`)
      setBlocks(data.notes || [])
      setConnections(data.connections || [])

      if (res.mode === "structured") {
        const newBlockIds: string[] = (res.new_blocks || []).map((b: any) => b.id)
        const newConnIds: string[] = (res.new_connections || []).map((c: any) => c.id)
        const snap = res.snapshot || {}
        undoStackRef.current.push({
          kind: "augment-structured",
          deleted_notes: snap.deleted_notes || [],
          deleted_connections: snap.deleted_connections || [],
          new_block_ids: newBlockIds,
          new_connection_ids: newConnIds,
        })
        setSelectedIds(new Set(newBlockIds))
        showToast(`Structured: ${newBlockIds.length} blocks, ${newConnIds.length} connections`)
      } else {
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
        setSelectedIds(new Set([res.new_note.id]))
        showToast("Augmented")
      }
      setAugmentOpen(false)
      setAugmentPrompt("")

      // Capture "after" snapshot for the Report-to-engineer flow.
      if (beforeReport) {
        try {
          const wrapperEl = canvasRef.current?.querySelector(":scope > div") as HTMLElement | null
          const afterBlocks: Block[] = data.notes || []
          const afterConns: Connection[] = data.connections || []
          // Tiny delay so React commits the new layout before we snapshot.
          await new Promise(r => setTimeout(r, 80))
          const after_png = wrapperEl && afterBlocks.length > 0
            ? await snapshotCanvasFull(wrapperEl, afterBlocks)
            : ""
          lastAugmentContextRef.current = {
            ...beforeReport,
            after_png: after_png || undefined,
            after_state: { blocks: afterBlocks, connections: afterConns },
          }
          setHasReportContext(true)
        } catch {
          // Best-effort; still set the before-only context so Report still works
          lastAugmentContextRef.current = beforeReport
          setHasReportContext(true)
        }
      }
    } catch (e: any) {
      setAugmentError(e.message)
    } finally {
      setAugmentBusy(false)
    }
  }, [activeSessionId, augmentPrompt, selectedIds, blocks, showToast, augmentStructured, augmentRearrange])

  // ── Export to wiki (writes to ~/.openfang/wikis/<agent>/pages/) ──────────
  const [wikiBusy, setWikiBusy] = useState(false)
  const exportToWiki = useCallback(async (agent: string) => {
    if (!activeSessionId || wikiBusy) return
    setWikiBusy(true)
    try {
      const res = await api(`/api/wiki/export`, {
        method: "POST",
        body: JSON.stringify({ session_id: activeSessionId, agent }),
      })
      showToast(`Saved to wiki: ${res.relative}${res.committed ? " (committed)" : ""}`)
    } catch (e: any) {
      showToast(`Wiki export failed: ${e.message}`)
    } finally {
      setWikiBusy(false)
    }
  }, [activeSessionId, wikiBusy, showToast])

  // ── Report to engineer ─────────────────────────────────────────────────
  const submitReport = useCallback(async () => {
    if (!activeSessionId || reportBusy) return
    setReportBusy(true)
    try {
      const ctx = lastAugmentContextRef.current
      const wrapperEl = canvasRef.current?.querySelector(":scope > div") as HTMLElement | null

      // If we have augment context, send before+after. Otherwise send just current.
      let before_png: string | undefined
      let before_state: any
      let after_png: string | undefined
      let after_state: any
      let prompt: string | undefined
      let mode: string | undefined

      if (ctx) {
        before_png = ctx.before_png
        before_state = ctx.before_state
        after_png = ctx.after_png
        after_state = ctx.after_state
        prompt = ctx.prompt
        mode = ctx.mode
      } else if (wrapperEl && blocks.length > 0) {
        // Manual share: snapshot current state as "after" only
        const png = await snapshotCanvasFull(wrapperEl, blocks).catch(() => "")
        if (png) after_png = png
        after_state = { blocks: [...blocks], connections: [...connections] }
        mode = "manual"
      } else {
        after_state = { blocks: [...blocks], connections: [...connections] }
        mode = "manual"
      }

      const res = await api(`/api/report-issue`, {
        method: "POST",
        body: JSON.stringify({
          session_id: activeSessionId,
          note: reportNote,
          prompt,
          mode,
          before_png,
          after_png,
          before_state,
          after_state,
        }),
      })
      showToast(`Reported: ${res.relative}`)
      setReportOpen(false)
      setReportNote("")
      // Clear the augment context after report — one report per augment
      lastAugmentContextRef.current = null
      setHasReportContext(false)
    } catch (e: any) {
      showToast(`Report failed: ${e.message}`)
    } finally {
      setReportBusy(false)
    }
  }, [activeSessionId, reportBusy, reportNote, blocks, connections, showToast])

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
    <div className="relative flex w-full overflow-hidden bg-[#020202] text-foreground" style={{ height: "var(--app-height, 100dvh)" }}>
      {/* Mobile sidebar backdrop — taps outside the drawer close it */}
      {isMobile && sidebarOpen && (
        <div
          data-testid="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        />
      )}
      {/* Left Sidebar — fixed overlay drawer on mobile, inline on desktop */}
      <aside
        style={
          isMobile
            ? { width: sidebarOpen ? 240 : 0, opacity: sidebarOpen ? 1 : 0, visibility: sidebarOpen ? "visible" : "hidden" }
            : { width: sidebarOpen ? 240 : 0, opacity: sidebarOpen ? 1 : 0, visibility: sidebarOpen ? "visible" : "hidden" }
        }
        className={`${
          isMobile ? "fixed inset-y-0 left-0" : "relative"
        } z-50 transition-all duration-200 ease-in-out overflow-hidden border-r border-border bg-black/95 md:bg-black/20 backdrop-blur-3xl flex flex-col h-full`}
      >
        <div className="w-[240px] flex flex-col h-full">
          {/* Sidebar Header */}
          <div className="flex h-10 items-center justify-between border-b border-border bg-card/5 backdrop-blur-md px-3 py-1.5 shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="flex items-center gap-0.5">
                <span className="inline-block h-2 w-2 rounded-sm bg-primary" />
                <span className="inline-block h-2 w-2 rounded-sm bg-primary/60" />
                <span className="inline-block h-2 w-2 rounded-sm bg-primary/30" />
              </div>
              <h2 className="font-mono text-xs font-bold uppercase tracking-tight text-foreground/80 select-none">
                nodepad
              </h2>
            </div>
            <button
              data-testid="sidebar-close"
              onClick={() => setSidebarOpen(false)}
              className="p-2 hover:bg-white/5 rounded-sm transition-colors text-muted-foreground hover:text-foreground font-mono text-sm"
            >
              ‹
            </button>
          </div>

          {/* Session list */}
          <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5 custom-scrollbar">
            {sessions.map(s => (
              <div
                key={s.id}
                className={`group relative rounded-sm transition-all duration-150 ${
                  s.id === activeSessionId
                    ? "bg-primary/10 shadow-[inset_0_1px_0px_rgba(255,255,255,0.05)]"
                    : "hover:bg-white/5"
                }`}
              >
                <div className="flex items-center p-2 px-2.5">
                  <button
                    data-testid={`session-item-${s.id}`}
                    onClick={() => setActiveSessionId(s.id)}
                    className="flex-1 text-left overflow-hidden"
                  >
                    <span className={`font-mono text-[12px] font-bold truncate block ${
                      s.id === activeSessionId ? "text-primary" : "text-foreground/80 group-hover:text-foreground"
                    }`}>
                      {s.name}
                    </span>
                  </button>
                  <button
                    data-testid={`session-delete-${s.id}`}
                    onClick={e => { e.stopPropagation(); deleteSession(s.id) }}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-destructive/20 rounded-sm text-muted-foreground hover:text-destructive transition-all"
                    title="Delete canvas"
                  >
                    <span className="text-xs">×</span>
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Sidebar Footer */}
          <div className="p-3 border-t border-white/5 bg-black/10 shrink-0 flex flex-col gap-1.5">
            <button
              data-testid="new-session"
              onClick={newSession}
              className="flex items-center justify-between w-full h-8 px-2.5 rounded-sm bg-primary hover:bg-primary/90 text-primary-foreground font-mono text-[9px] font-bold uppercase tracking-[0.1em] transition-all active:scale-[0.98] shadow-sm"
            >
              <span>New Canvas</span>
              <span className="text-sm">+</span>
            </button>
            <button
              data-testid="augment-btn"
              disabled={!activeSessionId || blocks.length === 0 || augmentOpen}
              onClick={() => {
                if (isMobile) setSidebarOpen(false)
                setAugmentOpen(true)
                setAugmentError(null)
                setTimeout(() => augmentInputRef.current?.focus(), 10)
              }}
              className="flex items-center justify-between w-full h-8 px-2.5 rounded-sm bg-white/5 hover:bg-white/10 text-muted-foreground hover:text-foreground font-mono text-[9px] font-bold uppercase tracking-[0.1em] transition-all active:scale-[0.98] border border-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <span>{selectedIds.size > 0 ? `Augment ${selectedIds.size}` : "Augment"}</span>
              <span className="text-[10px]">⌘↵</span>
            </button>
            <button
              data-testid="export-btn"
              onClick={doExport}
              className="flex items-center justify-between w-full h-8 px-2.5 rounded-sm bg-white/5 hover:bg-white/10 text-muted-foreground hover:text-foreground font-mono text-[9px] font-bold uppercase tracking-[0.1em] transition-all active:scale-[0.98] border border-white/5"
            >
              <span>Export MD</span>
              <span className="text-[10px]">↓</span>
            </button>
            <button
              data-testid="report-sidebar"
              disabled={!activeSessionId || reportBusy}
              onClick={() => setReportOpen(true)}
              title="Send canvas snapshot + note to engineer"
              className="flex items-center justify-between w-full h-8 px-2.5 rounded-sm bg-amber-500/10 hover:bg-amber-500/20 text-amber-200 font-mono text-[9px] font-bold uppercase tracking-[0.1em] disabled:opacity-30 transition-all active:scale-[0.98] border border-amber-500/30"
            >
              <span>{hasReportContext ? "Report augment" : "Share to engineer"}</span>
              <span className="text-[10px]">→</span>
            </button>
            <div className="flex items-center gap-1 pt-1">
              <span className="font-mono text-[8px] text-muted-foreground/40 uppercase tracking-wider">wiki:</span>
              {["atlas", "coach", "engineer", "vault"].map(a => (
                <button
                  key={a}
                  data-testid={`wiki-export-${a}`}
                  disabled={!activeSessionId || wikiBusy}
                  onClick={() => exportToWiki(a)}
                  className="rounded-sm border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[8px] font-bold text-muted-foreground hover:bg-white/[0.08] hover:text-foreground disabled:opacity-30 transition-colors"
                  title={`Export to ${a} wiki`}
                >
                  {a}
                </button>
              ))}
            </div>
            <div className="font-mono text-[8px] text-muted-foreground/30 uppercase tracking-wider pt-0.5">
              {selectedIds.size > 0 ? `${selectedIds.size} selected` : `${blocks.length} nodes`}
            </div>
          </div>
        </div>
      </aside>

      {/* Sidebar open button (visible when collapsed). Bigger tap target on
          mobile so it sits comfortably in the top bar's left padding slot. */}
      {!sidebarOpen && (
        <button
          data-testid="sidebar-toggle"
          onClick={() => setSidebarOpen(true)}
          className={`absolute z-50 rounded-sm bg-white/5 hover:bg-white/10 border border-white/10 text-muted-foreground hover:text-foreground transition-all ${
            isMobile ? "left-2 top-1.5 h-9 w-9 flex items-center justify-center" : "left-2 top-2 p-1.5"
          }`}
          title="Show sidebar"
        >
          <span className={`font-mono ${isMobile ? "text-base" : "text-xs"}`}>›</span>
        </button>
      )}

      {/* Main canvas area — flex column so the bottom Entry input bar is a
          real sibling (shrink-0) and not an absolute overlay. Otherwise it
          crops the bottom of tiled/graph/canvas views behind it. */}
      <main className="relative flex-1 h-full overflow-hidden flex flex-col min-h-0">
        {/* Mobile top bar — proper layout slot, not floating. Holds view
            toggle + active session pill. Floating bottom-left pill on
            desktop is unusable on phones (overlaps tiles). */}
        {isMobile && (
          <div
            data-testid="mobile-top-bar"
            className="shrink-0 flex items-center gap-2 px-2 pl-12 pr-2 py-1.5 border-b border-white/10 bg-black/70 backdrop-blur-md"
          >
            <div data-testid="view-toggle" className="flex items-center gap-1 rounded-sm border border-white/10 bg-black/40 px-1 py-1">
              {(["tiled", "graph"] as ViewMode[]).map(m => (
                <button
                  key={m}
                  onClick={() => setViewMode(m)}
                  className={`rounded-sm px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider transition-all ${
                    viewMode === m
                      ? "bg-primary/15 border border-primary/40 text-primary"
                      : "text-white/60 hover:bg-white/[0.06] hover:text-white/85 border border-transparent"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            <div className="ml-auto font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70 truncate max-w-[120px]">
              {sessions.find(s => s.id === activeSessionId)?.name || ""}
            </div>
          </div>
        )}
        {/* Content area (views + their overlays) */}
        <div className="relative flex-1 min-h-0 overflow-hidden">
        {/* Desktop view toggle — drops Canvas on mobile (drag/pan/zoom is
            unusable on phones; mobile users get tiled + graph in top bar). */}
        {!isMobile && (
          <div data-testid="view-toggle" className="absolute left-3 bottom-3 z-30 flex items-center gap-1 rounded-sm border border-white/10 bg-black/60 backdrop-blur-md px-1.5 py-1">
            {(["canvas", "tiled", "graph"] as ViewMode[]).map(m => (
              <button
                key={m}
                onClick={() => setViewMode(m)}
                className={`rounded-sm px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-wider transition-all ${
                  viewMode === m
                    ? "bg-primary/12 border border-primary/35 text-primary shadow-[0_0_0_1px_var(--primary)]"
                    : "text-white/55 hover:bg-white/[0.06] hover:text-white/80 border border-transparent"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        )}

        {/* Tiled view */}
        {viewMode === "tiled" && (
          <TiledView
            blocks={blocks}
            connections={connections}
            selectedIds={selectedIds}
            onSelect={(id, multi) => {
              setSelectedIds(prev => {
                const next = new Set(multi ? prev : [])
                if (next.has(id)) next.delete(id); else next.add(id)
                return next
              })
            }}
            editingId={editingId}
            editingText={editingText}
            onStartEdit={(id, text) => { setEditingId(id); setEditingText(text) }}
            onChangeEdit={setEditingText}
            onSaveEdit={saveEdit}
            onCancelEdit={() => { setEditingId(null); setEditingText("") }}
            onOpenDrawing={id => setDrawingOverlayId(id)}
            isMobile={isMobile}
          />
        )}

        {/* Graph view */}
        {viewMode === "graph" && (
          <GraphView
            blocks={blocks}
            connections={connections}
            selectedIds={selectedIds}
            onSelect={(id, multi) => {
              setSelectedIds(prev => {
                const next = new Set(multi ? prev : [])
                if (next.has(id)) next.delete(id); else next.add(id)
                return next
              })
            }}
          />
        )}

        {/* Canvas (free-form) view */}
        {viewMode === "canvas" && <div
          ref={canvasRef}
          data-testid="canvas"
          data-canvas-bg="true"
          onMouseDown={onCanvasMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          className="relative h-full w-full select-none touch-none bg-[#020202]"
          style={{ cursor: connectingFrom ? "crosshair" : panStateRef.current.active ? "grabbing" : "grab" }}
        >
          <div
            data-canvas-bg="true"
            style={{
              position: "absolute",
              inset: 0,
              transform: `translate(${viewport.tx}px, ${viewport.ty}px) scale(${viewport.scale})`,
              transformOrigin: "0 0",
            }}
          >
          {/* SVG for connections */}
          <svg className="pointer-events-none absolute inset-0 h-full w-full" style={{ zIndex: 1, overflow: "visible" }}>
            {connections.map(c => {
              const from = blocksById[c.from_block_id]
              const to = blocksById[c.to_block_id]
              if (!from || !to) return null
              const fromW = from.width ?? 180, fromH = from.height && from.height > 0 ? from.height : 60
              const toW = to.width ?? 180, toH = to.height && to.height > 0 ? to.height : 60
              const x1 = from.x + fromW / 2, y1 = from.y + fromH / 2
              const x2 = to.x + toW / 2, y2 = to.y + toH / 2
              const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
              const isSel = selectedConnIds.has(c.id)
              const isEditingConn = editingConnId === c.id
              return (
                <g key={c.id}>
                  {/* Fat invisible hit-area for click/touch */}
                  <line
                    x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke="transparent" strokeWidth={14}
                    style={{ cursor: "pointer", pointerEvents: "stroke" }}
                    onClick={e => {
                      e.stopPropagation()
                      if (e.ctrlKey || e.metaKey) {
                        setSelectedConnIds(prev => { const n = new Set(prev); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n })
                      } else {
                        setSelectedConnIds(new Set([c.id]))
                        setSelectedIds(new Set())
                      }
                    }}
                    onDoubleClick={e => {
                      e.stopPropagation()
                      setEditingConnId(c.id)
                      setEditingConnLabel(c.label || "")
                    }}
                  />
                  {/* Visible line */}
                  <line
                    x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke={isSel ? "var(--primary)" : "rgba(255,255,255,0.22)"}
                    strokeWidth={isSel ? 2.5 : 1.2}
                    style={{ pointerEvents: "none", transition: "stroke-opacity 0.15s" }}
                  />
                  {/* Label at midpoint */}
                  {isEditingConn ? (
                    <foreignObject x={mx - 80} y={my - 14} width={160} height={28} style={{ overflow: "visible" }}>
                      <input
                        autoFocus
                        value={editingConnLabel}
                        onChange={e => setEditingConnLabel(e.target.value)}
                        onBlur={saveConnLabel}
                        onKeyDown={e => {
                          if (e.key === "Enter") { e.preventDefault(); saveConnLabel() }
                          if (e.key === "Escape") { setEditingConnId(null); setEditingConnLabel("") }
                        }}
                        className="w-full rounded-sm border border-primary/50 bg-card/95 backdrop-blur-sm px-1 text-xs text-center text-foreground outline-none shadow font-mono"
                        style={{ fontSize: 11, lineHeight: "24px" }}
                        placeholder="label..."
                      />
                    </foreignObject>
                  ) : c.label ? (
                    <text
                      x={mx} y={my - 6}
                      textAnchor="middle"
                      fontSize={10}
                      fontFamily="var(--font-mono)"
                      fill={isSel ? "var(--primary)" : "rgba(255,255,255,0.45)"}
                      style={{ pointerEvents: "none", userSelect: "none" }}
                    >
                      {c.label}
                    </text>
                  ) : null}
                </g>
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
                  stroke="var(--primary)"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  strokeOpacity={0.5}
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
            const isDrawing = b.kind === "drawing"
            return (
              <div
                key={b.id}
                data-block-id={b.id}
                data-testid={`block-${b.id}`}
                data-block-kind={b.kind || "text"}
                onMouseDown={e => onBlockMouseDown(e, b)}
                onDoubleClick={e => {
                  if (isDrawing) {
                    e.stopPropagation()
                    setDrawingOverlayId(b.id)
                    return
                  }
                  onBlockDoubleClick(e, b)
                }}
                onMouseEnter={() => setHoveredBlockId(b.id)}
                onMouseLeave={() => setHoveredBlockId(null)}
                style={{
                  left: b.x,
                  top: b.y,
                  width: b.width ?? 180,
                  height: b.height && b.height > 0 ? b.height : undefined,
                  minHeight: isDrawing ? 160 : 60,
                  zIndex: 2,
                  borderLeft: isAI ? "3px solid var(--primary)" : "3px solid rgba(255,255,255,0.08)",
                }}
                className={`absolute cursor-move rounded-sm bg-card/90 backdrop-blur-sm ${isDrawing ? "p-1" : "px-3 py-2"} text-sm text-foreground overflow-hidden transition-[box-shadow,ring-color,background-color] duration-150 ${
                  isSelected
                    ? "ring-1 ring-primary shadow-[0_0_0_1px_var(--primary)]"
                    : "ring-1 ring-white/[0.07] hover:ring-white/15"
                }`}
              >
                {isDrawing ? (
                  <DrawingPreview scene={parseScene(b.text)} className="bg-white/[0.02]" />
                ) : isEditing ? (
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
                    className="w-full h-full min-h-[56px] resize-none bg-transparent outline-none text-foreground font-mono text-sm"
                    style={{ height: b.height && b.height > 40 ? b.height - 16 : undefined }}
                  />
                ) : (
                  <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">{b.text}</div>
                )}
                {/* Drawing fullscreen button */}
                {isDrawing && (
                  <button
                    data-testid={`drawing-expand-${b.id}`}
                    onMouseDown={e => e.stopPropagation()}
                    onClick={e => {
                      e.stopPropagation()
                      setDrawingOverlayId(b.id)
                    }}
                    className="absolute right-1 top-1 z-10 rounded-sm bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white/70 hover:bg-black/80 hover:text-white transition-colors"
                    title="Open editor"
                  >
                    ⛶
                  </button>
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
                    className="absolute -right-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-primary text-xs text-primary-foreground hover:brightness-125 transition-all"
                    title="Drag to connect"
                  >
                    ·
                  </button>
                )}
                {/* Resize handle */}
                {!isEditing && (
                  <div
                    data-testid={`resize-handle-${b.id}`}
                    onPointerDown={e => onResizeStart(e, b)}
                    onPointerMove={onResizeMove}
                    onPointerUp={onResizeEnd}
                    onPointerCancel={onResizeEnd}
                    onMouseDown={e => e.stopPropagation()}
                    onDoubleClick={e => e.stopPropagation()}
                    style={{ touchAction: "none" }}
                    className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize"
                    title="Drag to resize"
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" className="text-white/15">
                      <path d="M 14 6 L 6 14 M 14 10 L 10 14 M 14 14 L 14 14" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
                    </svg>
                  </div>
                )}
              </div>
            )
          })}
          </div>
          {/* Viewport controls */}
          <div className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-sm border border-white/10 bg-black/60 backdrop-blur-md px-1 py-1">
            <button
              data-testid="zoom-out-btn"
              onClick={zoomOut}
              className="h-7 w-7 rounded-sm text-lg leading-none text-white/55 hover:bg-white/[0.06] hover:text-white/80 transition-colors"
              title="Zoom out"
            >
              −
            </button>
            <div className="min-w-[3ch] text-center font-mono text-[10px] text-white/40 tabular-nums">
              {Math.round(viewport.scale * 100)}%
            </div>
            <button
              data-testid="zoom-in-btn"
              onClick={zoomIn}
              className="h-7 w-7 rounded-sm text-lg leading-none text-white/55 hover:bg-white/[0.06] hover:text-white/80 transition-colors"
              title="Zoom in"
            >
              +
            </button>
            <div className="mx-1 h-5 w-px bg-white/10" />
            <button
              data-testid="recenter-btn"
              onClick={recenterViewport}
              className="h-7 rounded-sm px-2 font-mono text-[9px] font-bold uppercase tracking-wider text-white/55 hover:bg-white/[0.06] hover:text-white/80 transition-colors"
              title="Reset view"
            >
              Reset
            </button>
          </div>
        </div>}

        {/* Report-to-engineer entry point lives in the sidebar only —
            the floating overlay was blocking the view-mode toggle when
            the sidebar was collapsed. */}

        {/* Report-to-engineer dialog */}
        {reportOpen && (
          <div className="absolute inset-x-0 bottom-4 z-50 flex justify-center">
            <div className="flex w-[600px] max-w-[90%] flex-col gap-3 rounded-sm border border-amber-500/30 bg-black/90 backdrop-blur-3xl p-4 shadow-[0_-24px_60px_-12px_rgba(0,0,0,0.6)]">
              <div className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-amber-300/70">
                {hasReportContext
                  ? "Report this augment to engineer"
                  : "Share canvas with engineer"}
              </div>
              <textarea
                data-testid="report-note"
                value={reportNote}
                onChange={e => setReportNote(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    submitReport()
                  }
                }}
                disabled={reportBusy}
                placeholder={hasReportContext
                  ? "What's wrong with this result? (e.g. hierarchy went flat, labels lost meaning)"
                  : "What should engineer look at? (optional)"}
                rows={3}
                className="rounded-sm border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-sm text-foreground outline-none placeholder:text-white/30 focus:border-amber-500/50 transition-colors resize-none"
              />
              <div className="flex items-center justify-between">
                <div className="font-mono text-[10px] text-white/40">
                  {hasReportContext ? "Sends before/after PNG + state + your note" : "Sends current canvas PNG + state"}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setReportOpen(false)
                      setReportNote("")
                    }}
                    className="rounded-sm px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-white/55 hover:bg-white/[0.06] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    data-testid="report-submit"
                    disabled={reportBusy}
                    onClick={submitReport}
                    className="rounded-sm bg-amber-500/80 hover:bg-amber-500 px-4 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-black disabled:opacity-30 transition-all active:scale-[0.98]"
                  >
                    {reportBusy ? "Sending..." : "Send"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Drive Mode overlay — hands-off voice loop. Big tap-targets,
            high-contrast colors so it's readable from a phone mounted on a
            dashboard at arm's length. Backdrop covers EVERYTHING (z-[80]) so
            no canvas tap-throughs while driving. */}
        {driveOpen && (
          <div
            data-testid="drive-mode-overlay"
            className="fixed inset-0 z-[80] flex flex-col items-center justify-between bg-black/95 backdrop-blur-2xl px-4 py-8 select-none"
          >
            {/* Top bar — title + close */}
            <div className="w-full flex items-center justify-between">
              <div className="flex items-center gap-2">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/85">
                  <circle cx="12" cy="12" r="9" />
                  <circle cx="12" cy="12" r="2.5" />
                  <line x1="12" y1="2.5" x2="12" y2="9.5" />
                  <line x1="3" y1="12" x2="9.5" y2="12" />
                  <line x1="14.5" y1="12" x2="21" y2="12" />
                </svg>
                <span className="font-mono text-xs font-bold uppercase tracking-[0.25em] text-white/85">Drive Mode</span>
              </div>
              <button
                data-testid="drive-mode-close"
                onClick={closeDriveMode}
                className="flex items-center justify-center h-11 w-11 rounded-sm border border-white/15 bg-white/[0.05] hover:bg-white/[0.1] text-white/85 transition-colors"
                aria-label="Exit Drive Mode"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Center — status text + giant button */}
            <div className="flex flex-1 flex-col items-center justify-center gap-8 w-full">
              <div className="font-mono text-[11px] font-bold uppercase tracking-[0.4em] text-white/55">
                {driveStatus === "listening" && "Listening"}
                {driveStatus === "thinking" && "Processing"}
                {driveStatus === "speaking" && "Speaking"}
                {driveStatus === "idle" && "Tap to talk"}
                {driveStatus === "error" && "Error · tap to retry"}
              </div>
              <button
                data-testid="drive-mode-button"
                onClick={handleDriveTap}
                disabled={driveStatus === "thinking"}
                className={`relative flex items-center justify-center rounded-full transition-all active:scale-[0.96] ${
                  driveStatus === "listening"
                    ? "bg-red-500/90 hover:bg-red-500 shadow-[0_0_60px_-10px_rgba(239,68,68,0.85)]"
                    : driveStatus === "thinking"
                      ? "bg-amber-500/80 cursor-wait"
                      : driveStatus === "speaking"
                        ? "bg-emerald-500/90 hover:bg-emerald-500 shadow-[0_0_60px_-10px_rgba(16,185,129,0.85)]"
                        : driveStatus === "error"
                          ? "bg-orange-500/90 hover:bg-orange-500"
                          : "bg-primary/80 hover:bg-primary shadow-[0_0_40px_-10px_rgba(255,255,255,0.4)]"
                }`}
                style={{ width: "min(72vw, 240px)", height: "min(72vw, 240px)" }}
                aria-label="Drive Mode action button"
              >
                {/* Pulsing ring while listening */}
                {driveStatus === "listening" && (
                  <span className="absolute inset-0 rounded-full bg-red-400/40 animate-ping" />
                )}
                {driveStatus === "speaking" && (
                  <span className="absolute inset-0 rounded-full bg-emerald-400/40 animate-ping" />
                )}
                {/* Icon — mic for listen/idle, hourglass for thinking, waveform for speaking */}
                {driveStatus === "thinking" ? (
                  <svg className="animate-spin" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12a9 9 0 1 1-6.2-8.55" />
                  </svg>
                ) : driveStatus === "speaking" ? (
                  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 5L6 9H2v6h4l5 4V5z" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
                ) : (
                  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="2" width="6" height="13" rx="3" />
                    <path d="M5 11a7 7 0 0 0 14 0" />
                    <line x1="12" y1="18" x2="12" y2="22" />
                  </svg>
                )}
              </button>
              <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-white/40">
                {driveStatus === "listening" && "Tap when done"}
                {driveStatus === "speaking" && "Tap to skip"}
                {driveStatus === "thinking" && "Hold on…"}
                {(driveStatus === "idle" || driveStatus === "error") && "Tap the mic"}
              </div>
            </div>

            {/* Bottom — last rundown text + turn count */}
            <div className="w-full flex flex-col items-center gap-2">
              <div
                data-testid="drive-mode-rundown"
                className="min-h-[64px] w-full max-w-[600px] rounded-sm border border-white/10 bg-white/[0.03] px-4 py-3 font-mono text-[14px] leading-snug text-white/85 text-center"
              >
                {driveLastRundown || (driveStatus === "listening" ? "Speak now…" : "")}
              </div>
              <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/35">
                {driveTurnCount > 0 ? `${driveTurnCount} turn${driveTurnCount === 1 ? "" : "s"} this session` : "First turn"}
              </div>
            </div>
          </div>
        )}

        {/* Augment prompt */}
        {augmentOpen && (
          <>
            {/* Modal backdrop — clicking it closes the dialog. Above sidebar
                so the dialog isn't covered when both happen to be open. */}
            <div
              data-testid="augment-backdrop"
              className="fixed inset-0 z-[55] bg-black/60 backdrop-blur-sm"
              onClick={() => setAugmentOpen(false)}
            />
          <div className="fixed inset-x-0 bottom-4 z-[60] flex justify-center px-2">
            <div className="flex w-[600px] max-w-full flex-col gap-3 rounded-sm border border-white/10 bg-black/90 backdrop-blur-3xl p-4 shadow-[0_-24px_60px_-12px_rgba(0,0,0,0.6)]">
              <div className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-white/45">
                {(() => {
                  const verb = augmentRearrange ? "Rearrange" : "Augment"
                  return selectedIds.size > 0
                    ? `${verb} ${selectedIds.size} selected block${selectedIds.size === 1 ? "" : "s"}`
                    : `${verb} whole canvas · ${blocks.length} block${blocks.length === 1 ? "" : "s"}`
                })()}
              </div>
              <div className="flex items-stretch gap-2">
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
                  disabled={augmentBusy || augmentVoice.transcribing}
                  placeholder={augmentRearrange
                    ? "How should the layout change? (e.g. spread as a left-to-right timeline)"
                    : augmentStructured
                    ? "Describe the structure (e.g. concept map with causal arrows)"
                    : "Instruction (e.g. reformat as checklist)"}
                  className="flex-1 min-w-0 rounded-sm border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-sm text-foreground outline-none placeholder:text-white/30 focus:border-primary/50 transition-colors"
                />
                <button
                  type="button"
                  data-testid="augment-voice-btn"
                  onClick={augmentVoice.toggle}
                  disabled={augmentBusy || augmentVoice.transcribing}
                  aria-pressed={augmentVoice.recording}
                  aria-label={augmentVoice.recording ? "Stop recording" : "Dictate prompt"}
                  title={augmentVoice.recording ? "Stop & transcribe" : "Dictate prompt"}
                  className={`relative shrink-0 inline-flex items-center justify-center rounded-sm border px-3 transition-colors disabled:opacity-40 ${
                    augmentVoice.recording
                      ? "border-red-500/40 bg-red-500/10 text-red-300"
                      : augmentVoice.transcribing
                      ? "border-primary/40 bg-primary/10 text-primary animate-pulse"
                      : "border-white/10 bg-white/[0.04] text-white/55 hover:bg-white/[0.08] hover:text-white/80"
                  }`}
                >
                  {augmentVoice.recording ? (
                    <span className="relative flex h-3 w-3">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                      <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
                    </span>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="3" width="6" height="12" rx="3" />
                      <path d="M5 11a7 7 0 0 0 14 0" />
                      <line x1="12" y1="18" x2="12" y2="22" />
                    </svg>
                  )}
                </button>
              </div>
              <label className="flex items-center gap-2 font-mono text-[10px] text-white/55 cursor-pointer select-none">
                <input
                  type="checkbox"
                  data-testid="augment-structured"
                  checked={augmentStructured}
                  onChange={e => {
                    const v = e.target.checked
                    setAugmentStructured(v)
                    if (v) setAugmentRearrange(false)
                  }}
                  disabled={augmentBusy}
                  className="accent-primary"
                />
                <span>
                  <b className="text-foreground">Structured output</b> — multiple blocks + connections
                </span>
              </label>
              <label className="flex items-center gap-2 font-mono text-[10px] text-white/55 cursor-pointer select-none">
                <input
                  type="checkbox"
                  data-testid="augment-rearrange"
                  checked={augmentRearrange}
                  onChange={e => {
                    const v = e.target.checked
                    setAugmentRearrange(v)
                    if (v) setAugmentStructured(false)
                  }}
                  disabled={augmentBusy}
                  className="accent-primary"
                />
                <span>
                  <b className="text-foreground">Rearrange</b> — let AI move blocks into a new layout (vision)
                </span>
              </label>
              {augmentRearrange && viewMode !== "canvas" && (
                <div className="font-mono text-[10px] text-amber-400/80">
                  Switch to Canvas view to use Rearrange (we snapshot the canvas for the model).
                </div>
              )}
              <div className="flex items-center justify-between">
                <div className="font-mono text-[10px] text-destructive">{augmentError}</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setAugmentOpen(false)
                      setAugmentPrompt("")
                    }}
                    className="rounded-sm px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-white/55 hover:bg-white/[0.06] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    data-testid="augment-submit"
                    disabled={augmentBusy || !augmentPrompt.trim() || (augmentRearrange && viewMode !== "canvas")}
                    onClick={submitAugment}
                    className="rounded-sm bg-primary hover:bg-primary/90 px-4 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-primary-foreground disabled:opacity-30 transition-all active:scale-[0.98]"
                  >
                    {augmentBusy
                      ? (augmentRearrange ? "Rearranging..." : "Augmenting...")
                      : (augmentRearrange ? "Rearrange" : "Augment")}
                  </button>
                </div>
              </div>
            </div>
          </div>
          </>
        )}
        </div>
        {/* /Content area */}

        {/* Bottom text input (v1 VimInput style) — shrink-0 sibling of the
            content wrapper so it never overlays the views. On mobile we trim
            chrome (no "Entry" label, no ⌘Z hint, tighter padding) so the
            input + mic + Submit all fit in 390px. */}
        <div data-testid="entry-bar" className={`relative shrink-0 z-30 w-full border-t border-white/20 bg-black/80 backdrop-blur-3xl flex items-center transition-all duration-300 focus-within:border-primary/40 ${
          isMobile ? "px-2 py-2 gap-2" : "px-6 py-5 gap-4"
        }`}>
          <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent" />
          <div className={`flex items-center flex-1 min-w-0 ${isMobile ? "gap-2" : "gap-3"}`}>
            {!isMobile && (
              <div className="font-mono text-[10px] font-bold text-white/60 uppercase tracking-[0.2em] select-none">
                Entry
              </div>
            )}
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
              placeholder={isMobile ? "Capture…" : "Capture something..."}
              className={`flex-1 min-w-0 bg-transparent font-mono tracking-tight text-white outline-none placeholder:text-white/35 ${isMobile ? "text-base" : "text-sm"}`}
              autoFocus={!isMobile}
            />
          </div>
          <div className={`flex items-center shrink-0 ${isMobile ? "gap-1.5" : "gap-3"}`}>
            {/* Icon cluster — same minimal-pill treatment as the zoom toolbar.
                Mic toggles voice input → /api/transcribe (Whisper). Sketch creates
                a new drawing block + opens the editor. Both are intentionally
                icon-only so they read as utilities, not actions. Bigger tap
                targets on mobile (h-11 = 44px Apple HIG minimum). */}
            <div className="flex items-center rounded-sm border border-white/10 bg-white/[0.03]">
              <button
                data-testid="voice-input-btn"
                onClick={toggleRecording}
                disabled={transcribing || !activeSessionId}
                title={recording ? "Stop & transcribe" : (transcribing ? "Transcribing…" : "Voice input")}
                aria-pressed={recording}
                aria-label="Voice input"
                className={`flex items-center justify-center transition-colors ${
                  isMobile ? "h-11 w-11" : "h-7 w-8"
                } ${
                  recording
                    ? "text-red-400 hover:text-red-300"
                    : transcribing
                      ? "text-primary animate-pulse"
                      : "text-white/55 hover:text-white/85 hover:bg-white/[0.06]"
                } disabled:opacity-30 disabled:hover:bg-transparent`}
              >
                {recording ? (
                  <span className={`relative flex ${isMobile ? "h-3.5 w-3.5" : "h-2.5 w-2.5"}`}>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                    <span className={`relative inline-flex rounded-full bg-red-400 ${isMobile ? "h-3.5 w-3.5" : "h-2.5 w-2.5"}`} />
                  </span>
                ) : (
                  <svg width={isMobile ? "20" : "13"} height={isMobile ? "20" : "13"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="3" width="6" height="12" rx="3" />
                    <path d="M5 11a7 7 0 0 0 14 0" />
                    <line x1="12" y1="18" x2="12" y2="22" />
                  </svg>
                )}
              </button>
              <div className={`w-px bg-white/10 ${isMobile ? "h-6" : "h-4"}`} />
              <button
                data-testid="new-drawing-btn"
                onClick={createDrawingBlock}
                disabled={!activeSessionId}
                title="New drawing block"
                aria-label="New drawing block"
                className={`flex items-center justify-center text-white/55 hover:bg-white/[0.06] hover:text-white/85 disabled:opacity-30 disabled:hover:bg-transparent transition-colors ${
                  isMobile ? "h-11 w-11" : "h-7 w-8"
                }`}
              >
                <svg width={isMobile ? "18" : "13"} height={isMobile ? "18" : "13"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19l7-7 3 3-7 7-3-3z" />
                  <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
                  <path d="M2 2l7.586 7.586" />
                  <circle cx="11" cy="11" r="2" />
                </svg>
              </button>
              <div className={`w-px bg-white/10 ${isMobile ? "h-6" : "h-4"}`} />
              <button
                data-testid="drive-mode-btn"
                onClick={openDriveMode}
                disabled={!activeSessionId}
                title="Drive Mode — hands-off voice loop"
                aria-label="Open Drive Mode"
                className={`flex items-center justify-center text-white/55 hover:bg-white/[0.06] hover:text-white/85 disabled:opacity-30 disabled:hover:bg-transparent transition-colors ${
                  isMobile ? "h-11 w-11" : "h-7 w-8"
                }`}
              >
                <svg width={isMobile ? "20" : "14"} height={isMobile ? "20" : "14"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {/* steering wheel icon — circle with cross-spokes */}
                  <circle cx="12" cy="12" r="9" />
                  <circle cx="12" cy="12" r="2.5" />
                  <line x1="12" y1="2.5" x2="12" y2="9.5" />
                  <line x1="3" y1="12" x2="9.5" y2="12" />
                  <line x1="14.5" y1="12" x2="21" y2="12" />
                </svg>
              </button>
            </div>
            {!isMobile && (
              <>
                <div className="h-4 w-px bg-white/10" />
                <div className="flex items-center gap-2">
                  <kbd className="flex h-5 items-center rounded border border-white/10 bg-white/5 px-1.5 font-mono text-[9px] text-white/60">
                    <span className="text-[11px] mr-1">⌘</span><span>Z</span>
                  </kbd>
                  <span className="text-[9px] font-mono font-bold text-white/55 uppercase tracking-tighter">Undo</span>
                </div>
                <div className="h-4 w-px bg-white/10" />
              </>
            )}
            <button
              data-testid="entry-submit"
              onClick={() => {
                if (inputText.trim()) {
                  createBlock(inputText)
                  setInputText("")
                }
              }}
              className={`font-mono font-bold text-primary uppercase tracking-widest hover:brightness-125 transition-all active:scale-95 disabled:opacity-20 ${
                isMobile ? "text-[12px] px-3 h-11 rounded-sm border border-primary/40 bg-primary/10" : "text-[10px]"
              }`}
              disabled={!inputText.trim()}
            >
              {isMobile ? "Send" : "Submit"}
            </button>
          </div>
        </div>

        {/* Confirm dialog */}
        {confirmState.open && (
          <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onMouseDown={e => { if (e.target === e.currentTarget) closeConfirm() }}
            onKeyDown={e => {
              if (e.key === "Escape") closeConfirm()
              if (e.key === "Enter") { e.preventDefault(); confirmState.onConfirm(); closeConfirm() }
            }}
          >
            <div className="w-80 rounded-sm border border-white/10 bg-card/95 backdrop-blur-md p-4 shadow-xl">
              <p className="mb-4 font-mono text-sm text-foreground/80">{confirmState.message}</p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={closeConfirm}
                  className="rounded-sm px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-white/55 hover:bg-white/[0.06] transition-colors"
                >Cancel</button>
                <button
                  ref={confirmBtnRef}
                  autoFocus
                  onClick={() => { confirmState.onConfirm(); closeConfirm() }}
                  className="rounded-sm bg-destructive/90 hover:bg-destructive px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-white transition-all active:scale-[0.98]"
                >Delete</button>
              </div>
            </div>
          </div>
        )}

        {/* Toast */}
        {toast && (
          <div
            data-testid="toast"
            className="absolute right-4 top-4 z-[70] rounded-sm border border-white/10 bg-card/95 backdrop-blur-md px-3 py-1.5 font-mono text-[11px] text-foreground shadow-lg"
          >
            {toast}
          </div>
        )}

        {/* Excalidraw fullscreen overlay — single instance, scene swapped per block */}
        {drawingOverlayBlock && (
          <ExcalidrawOverlay
            key={drawingOverlayBlock.id}
            initialScene={parseScene(drawingOverlayBlock.text)}
            onSave={scene => saveDrawingScene(drawingOverlayBlock.id, scene)}
            onClose={() => setDrawingOverlayId(null)}
          />
        )}

        {/* AI call/response debug log — right-side panel. Desktop only;
            phones are not for debugging LLM calls. */}
        {!isMobile && (
          <>
            <AILogPanel open={aiLogOpen} onClose={() => setAiLogOpen(false)} />
            <button
              data-testid="ai-log-toggle"
              onClick={() => setAiLogOpen(o => !o)}
              className={`fixed top-1/2 -translate-y-1/2 z-40 px-1.5 py-3 rounded-l-sm border border-r-0 border-white/10 bg-card/90 backdrop-blur-md font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground hover:bg-white/5 transition-all ${
                aiLogOpen ? "right-[440px]" : "right-0"
              }`}
              style={{ writingMode: "vertical-rl" }}
              title={aiLogOpen ? "Close AI log" : "Open AI log"}
            >
              AI Log
            </button>
          </>
        )}
      </main>
    </div>
  )
}
