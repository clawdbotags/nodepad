/**
 * Format a structured-augment response as a short utility-speech rundown.
 * No LLM in the loop — pure templating, so it speaks fast and matches what
 * actually happened on the canvas.
 *
 * Examples:
 *   "Added 3 blocks: caching strategy, latency budget, cost ceiling.
 *    Linked caching strategy to latency budget."
 *
 *   "Added one block: meeting notes."
 *
 *   "Nothing changed."
 */

export type AugmentDiff = {
  new_blocks?: { id: string; text: string }[]
  new_connections?: { id: string; from: string; to: string }[]
  // For default-mode augment, only one new note.
  new_note_id?: string
  new_note_text?: string
}

const MAX_TITLE_CHARS = 60
const MAX_LIST_ITEMS = 6

function snippet(text: string, max = MAX_TITLE_CHARS): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim()
  if (!flat) return "untitled"
  // Take the first sentence or a clean prefix.
  const m = flat.match(/^[^.!?\n]+/)
  const first = (m ? m[0] : flat).trim()
  if (first.length <= max) return first
  return first.slice(0, max - 1).trimEnd() + "…"
}

function nounWithCount(n: number, singular: string, plural: string): string {
  if (n === 1) return `one ${singular}`
  return `${n} ${plural}`
}

export function formatRundown(diff: AugmentDiff): string {
  const blocks = (diff.new_blocks || []).filter(b => b && b.text)
  const conns = diff.new_connections || []

  // Default-mode augment: one block synthesized from the scope.
  if ((!blocks.length) && diff.new_note_text) {
    return `Replaced with one block: ${snippet(diff.new_note_text)}.`
  }

  if (!blocks.length) {
    return "Nothing changed."
  }

  // Build block list — first N titles, separated by commas, last by " and ".
  const titles = blocks.slice(0, MAX_LIST_ITEMS).map(b => snippet(b.text, 50))
  let titleList: string
  if (titles.length === 1) {
    titleList = titles[0]
  } else {
    titleList = `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`
  }

  let parts: string[] = []
  parts.push(`Added ${nounWithCount(blocks.length, "block", "blocks")}: ${titleList}.`)
  if (blocks.length > MAX_LIST_ITEMS) {
    parts.push(`Plus ${blocks.length - MAX_LIST_ITEMS} more.`)
  }

  // Connections — only mention if there are any. Resolve from/to ids back to
  // titles via the new_blocks list (and skip if either side is missing).
  if (conns.length) {
    const titleById: Record<string, string> = {}
    for (const b of blocks) titleById[b.id] = snippet(b.text, 40)
    const named = conns
      .map(c => {
        const f = titleById[c.from]
        const t = titleById[c.to]
        return f && t ? { f, t } : null
      })
      .filter(Boolean) as { f: string; t: string }[]
    if (named.length === 1) {
      parts.push(`Linked ${named[0].f} to ${named[0].t}.`)
    } else if (named.length > 1) {
      // Don't enumerate all — just say how many.
      parts.push(`Made ${named.length} links.`)
    }
  }

  return parts.join(" ")
}
