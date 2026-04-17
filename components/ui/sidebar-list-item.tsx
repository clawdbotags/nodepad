"use client"

/**
 * SidebarListItem — single row in the left-column lists that appear on both
 * the canvas route (session list) and the chat route (rooms list). Before
 * this, the two had drifted in padding / active-state treatment / border
 * handling and looked nothing like each other even though they serve the
 * same job: "vertical list of tappable rows with active-highlight".
 *
 * Layout (each piece optional except `label`):
 *   ┌───────────────────────────────────────┐
 *   │ label ............... badge · delete  │  ← top row
 *   │ subtitle                              │  ← for rooms (last message)
 *   │ meta                                  │  ← for rooms (timestamp)
 *   └───────────────────────────────────────┘
 *
 * Active state: bg-primary/10 + left border accent + label recolored to
 * primary. The left-border slot is always 2px so inactive rows stay
 * visually aligned with active rows — no content jiggle on selection.
 *
 * `onDelete` adds a hover-revealed × button (nodes list). `badge` is any
 * node (unread count for rooms, pin icon for pinned nodes, etc.).
 */

import type { ReactNode } from "react"

export function SidebarListItem({
  label,
  subtitle,
  meta,
  badge,
  active = false,
  onClick,
  onDelete,
  deleteLabel = "Delete",
  testId,
  deleteTestId,
}: {
  label: ReactNode
  subtitle?: ReactNode
  meta?: ReactNode
  badge?: ReactNode
  active?: boolean
  onClick?: () => void
  onDelete?: () => void
  deleteLabel?: string
  testId?: string
  deleteTestId?: string
}) {
  return (
    <div
      className={`group relative w-full border-b border-white/5 border-l-2 transition-colors ${
        active
          ? "bg-primary/10 border-l-primary"
          : "hover:bg-white/[0.04] border-l-transparent"
      }`}
    >
      <button
        data-testid={testId}
        onClick={onClick}
        className="w-full text-left px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <span
            className={`truncate text-[13px] font-bold ${
              active ? "text-primary" : "text-foreground/85"
            }`}
          >
            {label}
          </span>
          {badge && <span className="ml-auto shrink-0">{badge}</span>}
        </div>
        {subtitle && (
          <div className="text-[11px] text-white/45 truncate mt-0.5">
            {subtitle}
          </div>
        )}
        {meta && (
          <div className="text-[9px] text-white/25 mt-0.5 uppercase tracking-wider">
            {meta}
          </div>
        )}
      </button>
      {onDelete && (
        <button
          data-testid={deleteTestId}
          onClick={e => {
            e.stopPropagation()
            onDelete()
          }}
          className="absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100 p-1 hover:bg-destructive/20 rounded-sm text-muted-foreground hover:text-destructive transition-all"
          title={deleteLabel}
          aria-label={deleteLabel}
        >
          <span className="text-xs">×</span>
        </button>
      )}
    </div>
  )
}
