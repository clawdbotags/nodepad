"use client"

import { useEffect, useState, useCallback } from "react"

type AILogEntry = {
  id: string
  timestamp: number
  label: string
  model: string
  system_prompt: string
  user_content: string
  response_text: string
  response_status: number
  latency_ms: number
  error?: string
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function statusBadge(s: number): { label: string; className: string } {
  if (s >= 200 && s < 300) return { label: `${s}`, className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" }
  if (s === 0) return { label: "ERR", className: "bg-red-500/15 text-red-300 border-red-500/30" }
  return { label: `${s}`, className: "bg-amber-500/15 text-amber-300 border-amber-500/30" }
}

export function AILogPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [calls, setCalls] = useState<AILogEntry[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/ai-log")
      if (res.ok) {
        const data = await res.json()
        setCalls(data.calls || [])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    load()
    // Poll every 2s while open
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [open, load])

  const clearAll = useCallback(async () => {
    await fetch("/api/ai-log", { method: "DELETE" })
    setCalls([])
    setExpanded({})
  }, [])

  if (!open) return null

  return (
    <div
      data-testid="ai-log-panel"
      className="fixed top-0 right-0 z-40 h-screen w-[440px] max-w-[90vw] flex flex-col bg-card/95 backdrop-blur-xl border-l border-white/10 shadow-2xl"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
        <div className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
          AI Log
        </div>
        <span className="font-mono text-[10px] text-muted-foreground/70">{calls.length}/50</span>
        {loading && <span className="font-mono text-[9px] text-muted-foreground/50">···</span>}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={load}
            className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-white/5"
            title="Refresh"
          >
            Refresh
          </button>
          <button
            onClick={clearAll}
            className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground hover:text-red-300 px-2 py-1 rounded hover:bg-white/5"
          >
            Clear
          </button>
          <button
            onClick={onClose}
            className="font-mono text-[12px] text-muted-foreground hover:text-foreground px-2 rounded hover:bg-white/5"
            title="Close (the panel)"
          >
            ×
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {calls.length === 0 ? (
          <div className="p-6 font-mono text-[10px] text-muted-foreground/50">
            No calls yet. Run an augment to see what's sent to the model.
          </div>
        ) : (
          <ul className="divide-y divide-white/5">
            {calls.map(c => {
              const isOpen = !!expanded[c.id]
              const badge = statusBadge(c.response_status)
              return (
                <li key={c.id} className="text-[11px]">
                  <button
                    onClick={() => setExpanded(p => ({ ...p, [c.id]: !p[c.id] }))}
                    className="w-full text-left px-3 py-2 hover:bg-white/5 flex items-start gap-2"
                  >
                    <span className={`font-mono text-[9px] px-1.5 py-0.5 rounded border ${badge.className} shrink-0`}>
                      {badge.label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-foreground font-bold">{c.label}</span>
                        <span className="font-mono text-[9px] text-muted-foreground/70">
                          {c.latency_ms}ms
                        </span>
                        <span className="font-mono text-[9px] text-muted-foreground/50 ml-auto">
                          {fmtTime(c.timestamp)}
                        </span>
                      </div>
                      <div className="font-mono text-[9px] text-muted-foreground/70 truncate">
                        {c.model}
                      </div>
                      {c.error && (
                        <div className="font-mono text-[10px] text-red-300 mt-1 truncate">
                          {c.error}
                        </div>
                      )}
                    </div>
                    <span className="font-mono text-[10px] text-muted-foreground/50 shrink-0">
                      {isOpen ? "▾" : "▸"}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-3 space-y-2">
                      <details className="border border-white/5 rounded">
                        <summary className="cursor-pointer px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground hover:text-foreground">
                          system prompt ({c.system_prompt.length} chars)
                        </summary>
                        <pre className="px-2 py-2 font-mono text-[10px] text-foreground/80 whitespace-pre-wrap break-words overflow-x-auto max-h-64 overflow-y-auto bg-black/40 rounded-b">
                          {c.system_prompt}
                        </pre>
                      </details>
                      <details className="border border-white/5 rounded" open>
                        <summary className="cursor-pointer px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground hover:text-foreground">
                          user content ({c.user_content.length} chars)
                        </summary>
                        <pre className="px-2 py-2 font-mono text-[10px] text-foreground/80 whitespace-pre-wrap break-words overflow-x-auto max-h-80 overflow-y-auto bg-black/40 rounded-b">
                          {c.user_content}
                        </pre>
                      </details>
                      <details className="border border-white/5 rounded" open>
                        <summary className="cursor-pointer px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground hover:text-foreground">
                          response ({c.response_text.length} chars)
                        </summary>
                        <pre className="px-2 py-2 font-mono text-[10px] text-emerald-200/90 whitespace-pre-wrap break-words overflow-x-auto max-h-80 overflow-y-auto bg-black/40 rounded-b">
                          {c.response_text || "(empty)"}
                        </pre>
                      </details>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
