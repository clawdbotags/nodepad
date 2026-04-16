// In-memory ring buffer of recent LLM calls. Used by the right-side debug
// panel to show what's actually being sent to and received from the model.
// Resets on server rebuild; that's fine — this is debug telemetry, not state.

export type AILogEntry = {
  id: string
  timestamp: number       // ms since epoch
  label: string           // "augment.default" | "augment.structured" | "rearrange" | "rearrange-refine" | etc
  model: string
  system_prompt: string
  user_content: string    // text + image data URLs replaced with size markers
  response_text: string   // raw assistant content (or "" on error)
  response_status: number // HTTP status from the LLM provider
  latency_ms: number
  error?: string
}

const RING_SIZE = 50
const ring: AILogEntry[] = []

let nextSeq = 1

function nextId(): string {
  // Sortable, distinct enough — combination of seq + ms timestamp
  const id = `${Date.now().toString(36)}-${nextSeq.toString(36)}`
  nextSeq++
  return id
}

/**
 * Strip large data: URLs from a string so the log panel stays readable.
 * Replaces each occurrence with `[image: NN KB]` markers.
 */
function summarizeImages(text: string): string {
  return text.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g, match => {
    const sizeKb = Math.round((match.length * 3) / 4 / 1024)
    return `[image: ${sizeKb} KB]`
  })
}

export function recordCall(entry: Omit<AILogEntry, "id" | "timestamp"> & { user_content: string }): AILogEntry {
  const full: AILogEntry = {
    id: nextId(),
    timestamp: Date.now(),
    ...entry,
    system_prompt: entry.system_prompt.length > 8000 ? entry.system_prompt.slice(0, 8000) + "...[truncated]" : entry.system_prompt,
    user_content: summarizeImages(entry.user_content).slice(0, 16_000),
    response_text: entry.response_text.slice(0, 8_000),
  }
  ring.push(full)
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE)
  return full
}

export function getCalls(): AILogEntry[] {
  // Newest-first
  return ring.slice().reverse()
}

export function clearCalls(): void {
  ring.length = 0
}
