"use client"

/**
 * EntryBar — shared bottom input dock that appears at the bottom of every
 * surface that takes text (canvas, chat room, …). Before this, the canvas
 * had its own entry bar (thick padding, backdrop-blur, focus-animated
 * border, gradient top line, "Entry" label, icon cluster with mic/drawing/
 * drive) and the chat had a stripped-down composer (no label, no blur,
 * no icon cluster, no drive button — drive sat in the room header
 * instead). Completely different compositions.
 *
 * Now: both use <EntryBar>, passing:
 *  - `children`          the text field (TextField, single or multiline)
 *  - `actions`           icon cluster on the right (mic + drive + …), or null
 *  - `submit`            the final submit pill on the right-most edge
 *  - `label`             optional desktop-only left label ("Entry", "Chat", …)
 *  - `alignItems`        "center" for single-line input, "end" for multiline
 *  - `isMobile`          trims label, chrome, and padding
 *
 * The chrome — border, bg, backdrop-blur, focus-within border, gradient top
 * line — is baked in here, so both surfaces look identical without the
 * callers having to repeat those classes.
 */

import type { ReactNode } from "react"

export function EntryBar({
  children,
  actions,
  submit,
  label,
  alignItems = "center",
  isMobile = false,
  testId = "entry-bar",
}: {
  children: ReactNode
  actions?: ReactNode
  submit?: ReactNode
  label?: string
  alignItems?: "center" | "end"
  isMobile?: boolean
  testId?: string
}) {
  const align = alignItems === "end" ? "items-end" : "items-center"
  return (
    <div
      data-testid={testId}
      className={`relative shrink-0 z-30 w-full border-t border-white/20 bg-black/80 backdrop-blur-3xl flex ${align} transition-all duration-300 focus-within:border-primary/40 ${
        isMobile ? "px-2 py-2 gap-2" : "px-6 py-5 gap-4"
      }`}
    >
      {/* Gradient accent line across the top edge — signals this is an
          active input surface, not just a footer. */}
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent" />

      <div className={`flex ${align} flex-1 min-w-0 ${isMobile ? "gap-2" : "gap-3"}`}>
        {label && !isMobile && (
          <div className="font-mono text-[10px] font-bold text-white/60 uppercase tracking-[0.2em] select-none shrink-0">
            {label}
          </div>
        )}
        {children}
      </div>

      {(actions || submit) && (
        <div className={`flex items-center shrink-0 ${isMobile ? "gap-1.5" : "gap-3"}`}>
          {actions}
          {submit}
        </div>
      )}
    </div>
  )
}

/** Pre-styled bordered icon cluster for the right side of an EntryBar
 *  (mic + drive + …). The canvas entry bar groups icons in a single
 *  bordered pill; reuse that shape on chat so drive looks the same. */
export function EntryBarIconCluster({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center rounded-sm border border-white/10 bg-white/[0.03]">
      {children}
    </div>
  )
}

/** 1px vertical divider used between icons in an EntryBarIconCluster.
 *  Height flexes for mobile's bigger tap targets. */
export function EntryBarIconDivider({ isMobile = false }: { isMobile?: boolean }) {
  return <div className={`w-px bg-white/10 ${isMobile ? "h-6" : "h-4"}`} />
}
