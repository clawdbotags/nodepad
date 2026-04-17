import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Compact relative timestamp for list-item meta rows. Same rules in both the
 * rooms pane and the nodes pane so the visual language lines up:
 *   - today           → "14:03"
 *   - this year       → "APR 14"
 *   - previous years  → "APR 14, 25"
 * Uppercased by the `meta` slot in SidebarListItem via tracking-wider.
 */
export function formatRelativeTime(ts: number): string {
  if (!ts) return ""
  const d = new Date(ts)
  const now = Date.now()
  const sameDay = new Date(now).toDateString() === d.toDateString()
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
  const sameYear = new Date(now).getFullYear() === d.getFullYear()
  return d.toLocaleDateString([], sameYear ? { month: "short", day: "numeric" } : { year: "2-digit", month: "short", day: "numeric" })
}
