"use client"

/**
 * ToolbarPill — the uppercase · tracking-wider · mono · rounded-sm button
 * that appears in 20+ places across nodepad (sidebar footer actions,
 * modal primary/cancel buttons, viewport reset, augment submit, etc.).
 *
 * Tones align with the existing palette — don't invent new ones:
 *  - primary : solid primary fill, white text          (submit CTAs)
 *  - accent  : primary-tinted bordered fill            (Drive, accents)
 *  - amber   : amber-tinted bordered fill              (Report action)
 *  - ghost   : transparent with hover-tint             (Cancel, tertiary)
 *  - danger  : destructive-tinted solid                (confirm deletes)
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react"

export type ToolbarPillTone =
  | "primary"
  | "accent"
  | "amber"
  | "ghost"
  | "danger"

const TONES: Record<ToolbarPillTone, string> = {
  primary:
    "bg-primary hover:bg-primary/90 text-primary-foreground disabled:opacity-30 active:scale-[0.98]",
  accent:
    "border border-primary/40 bg-primary/10 hover:bg-primary/20 text-primary disabled:opacity-40",
  amber:
    "bg-amber-500/80 hover:bg-amber-500 text-black disabled:opacity-30 active:scale-[0.98]",
  ghost:
    "text-white/55 hover:bg-white/[0.06] hover:text-white/85 disabled:opacity-40",
  danger:
    "bg-destructive/90 hover:bg-destructive text-white disabled:opacity-30 active:scale-[0.98]",
}

/** Padding scale. `base` = px-3 py-1.5 (the nodepad default, covers almost
 *  every site). `sm` = px-2 py-1 (used by the zoom-toolbar reset and a few
 *  other compact surfaces). `wide` = px-4 py-1.5 (primary CTAs that need
 *  more horizontal weight — Augment Submit, Report Send). */
export type ToolbarPillSize = "sm" | "base" | "wide"

const SIZES: Record<ToolbarPillSize, string> = {
  sm: "px-2 py-1",
  base: "px-3 py-1.5",
  wide: "px-4 py-1.5",
}

export type ToolbarPillProps = {
  tone?: ToolbarPillTone
  size?: ToolbarPillSize
  className?: string
  children: ReactNode
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">

export const ToolbarPill = forwardRef<HTMLButtonElement, ToolbarPillProps>(
  function ToolbarPill(
    { tone = "ghost", size = "base", className = "", children, ...rest },
    ref,
  ) {
    const cls = `rounded-sm ${SIZES[size]} font-mono text-[10px] font-bold uppercase tracking-wider transition-colors ${TONES[tone]} ${className}`
    return (
      <button ref={ref} className={cls} {...rest}>
        {children}
      </button>
    )
  },
)
