/**
 * Shared block → markdown rendering.
 *
 * Used by:
 *   - Sidebar "Export MD" download (includes title + date)
 *   - Ctrl/Cmd+C clipboard copy (bare, no title/date)
 *
 * Format (see nodepad-v2-state.md for spec):
 *   {title + date, optional}
 *
 *   {block 1 text verbatim}
 *
 *   ---
 *
 *   {block 2 text verbatim}
 *
 *   ---
 *
 *   ...
 *
 *   ## Connections
 *   - {from 40ch} → {to 40ch}
 *   - {from 40ch} **—{label}→** {to 40ch}   (when labeled)
 *
 * Block text passes through verbatim — no escape, no re-indent. Users put
 * what they put. Drawing blocks (kind === "drawing") emit a placeholder
 * rather than dumping raw Excalidraw JSON.
 */

export type MdBlock = {
  id: string
  text: string
  kind?: string
  is_ai_generated?: boolean | number
}

export type MdConnection = {
  id: string
  from_block_id: string
  to_block_id: string
  label?: string | null
}

function snippet(text: string, n = 40): string {
  const first = text.split("\n")[0] || ""
  return first.length > n ? first.slice(0, n) + "…" : first
}

function renderBlock(b: MdBlock): string {
  if (b.kind === "drawing") {
    return "_(sketch — open in nodepad)_"
  }
  return b.text
}

export function blocksToMarkdown(
  blocks: MdBlock[],
  connections: MdConnection[],
  opts: { title?: string; date?: string } = {}
): string {
  const parts: string[] = []

  if (opts.title) {
    parts.push(`# ${opts.title}`)
    if (opts.date) {
      parts.push("")
      parts.push(`_Exported ${opts.date}_`)
    }
    parts.push("")
    parts.push("---")
    parts.push("")
  }

  const renderedBlocks = blocks.map(renderBlock)
  parts.push(renderedBlocks.join("\n\n---\n\n"))

  const ids = new Set(blocks.map(b => b.id))
  const scoped = connections.filter(
    c => ids.has(c.from_block_id) && ids.has(c.to_block_id)
  )

  if (scoped.length > 0) {
    const byId: Record<string, MdBlock> = {}
    for (const b of blocks) byId[b.id] = b
    parts.push("")
    parts.push("## Connections")
    parts.push("")
    for (const c of scoped) {
      const f = byId[c.from_block_id]
      const t = byId[c.to_block_id]
      const ft = f ? snippet(renderBlock(f)) : c.from_block_id
      const tt = t ? snippet(renderBlock(t)) : c.to_block_id
      if (c.label && c.label.trim()) {
        parts.push(`- ${ft} **—${c.label.trim()}→** ${tt}`)
      } else {
        parts.push(`- ${ft} → ${tt}`)
      }
    }
  }

  // Final newline
  return parts.join("\n") + "\n"
}

export function slugForFilename(s: string, max = 60): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, max) || "canvas"
  )
}
