"use client"

import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react"

/**
 * Inline-edit textarea used by the canvas + tiled views when a block is
 * double-clicked into edit mode. Each of the three call sites previously
 * wired up its own `onChange`, `onBlur`, `onKeyDown` and styling block —
 * nearly identical code, easy to drift out of sync.
 *
 * The two keyboard regimes we support:
 *   - "enter"     : Enter (no shift) saves. Used on the canvas, where Shift+Enter
 *                   is the newline escape hatch.
 *   - "cmd-enter" : ⌘/Ctrl+Enter saves, Esc cancels. Used in tiled views where
 *                   longer prose is common and plain Enter should insert a newline.
 *
 * Behaviour kept 1:1 with the originals so existing tests (block-edit-*,
 * tile-edit-*) don't break.
 */
export type BlockEditShortcut = "enter" | "cmd-enter"

export function BlockEditTextarea({
  testId,
  value,
  onChange,
  onSave,
  onCancel,
  shortcut,
  className,
  style,
  onClick,
  onMouseDown,
  autoFocus = true,
}: {
  testId?: string
  value: string
  onChange: (next: string) => void
  onSave: () => void
  /** Only invoked when `shortcut === "cmd-enter"` (Esc cancel). Optional
   *  because the canvas variant doesn't cancel-on-Esc — it relies on blur
   *  to save the current text. */
  onCancel?: () => void
  shortcut: BlockEditShortcut
  className?: string
  style?: CSSProperties
  /** Tiled views stop click bubbling so the wrapping tile doesn't re-select. */
  onClick?: (e: ReactMouseEvent<HTMLTextAreaElement>) => void
  /** Tiled desktop view also stops mousedown bubbling to avoid the tile's
   *  multi-select path. */
  onMouseDown?: (e: ReactMouseEvent<HTMLTextAreaElement>) => void
  autoFocus?: boolean
}) {
  return (
    <textarea
      data-testid={testId}
      autoFocus={autoFocus}
      value={value}
      onChange={e => onChange(e.target.value)}
      onBlur={onSave}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onKeyDown={e => {
        if (shortcut === "enter") {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            onSave()
          }
          return
        }
        // shortcut === "cmd-enter"
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          onSave()
        } else if (e.key === "Escape") {
          e.preventDefault()
          onCancel?.()
        }
      }}
      className={className}
      style={style}
    />
  )
}
