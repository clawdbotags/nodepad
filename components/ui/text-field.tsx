"use client"

/**
 * TextField — single shared primitive for every text-entry surface in
 * nodepad. Replaces four near-duplicate <input>/<textarea> blocks (canvas
 * Entry bar, Augment dialog, chat composer, report-to-engineer note) that
 * had drifted in padding / border / keyboard behavior.
 *
 * Design constraints baked in:
 *  - Mono font, primary focus border, white/35 placeholder — the existing
 *    nodepad look. Change once, everywhere reflects.
 *  - `submitKey` ∈ {"enter", "cmd-enter"} covers every callsite. Shift+Enter
 *    always produces a newline when multiline; never-submits.
 *  - `bordered=false` strips the self-border so the Entry bar (which has a
 *    border on its container) keeps its existing look.
 *  - Ref forwarding for focus management. Accepts both HTMLInputElement and
 *    HTMLTextAreaElement refs — caller picks based on `multiline`.
 */

import {
  forwardRef,
  useCallback,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type TextareaHTMLAttributes,
} from "react"

export type TextFieldSubmitKey = "enter" | "cmd-enter"

type CommonProps = {
  /** Fires when the user submits via `submitKey`. */
  onSubmit?: () => void
  /** Which keystroke submits. Default "enter". */
  submitKey?: TextFieldSubmitKey
  /** Render with a bordered rounded pill. Default true. Set false for the
   *  Entry bar where the parent provides the border. */
  bordered?: boolean
  /** Scale text-sm (default) or text-base. Used for mobile readability. */
  size?: "sm" | "base"
  /** Default false. Pass true to render a <textarea>. */
  multiline?: boolean
}

type InputOnlyProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "size" | "onKeyDown"
> & {
  onKeyDown?: (e: ReactKeyboardEvent<HTMLInputElement>) => void
}
type TextareaOnlyProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "onKeyDown"
> & {
  onKeyDown?: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void
}

export type TextFieldProps =
  | (CommonProps & { multiline?: false } & InputOnlyProps)
  | (CommonProps & { multiline: true } & TextareaOnlyProps)

function baseClasses({
  bordered,
  size,
  multiline,
}: {
  bordered: boolean
  size: "sm" | "base"
  multiline: boolean
}) {
  const text = size === "base" ? "text-base" : "text-sm"
  const pad = bordered ? "px-3 py-2" : ""
  const border = bordered
    ? "rounded-sm border border-white/10 bg-white/[0.04] focus:border-primary/50 transition-colors"
    : "bg-transparent"
  const resize = multiline ? "resize-none" : ""
  return `flex-1 min-w-0 font-mono ${text} text-foreground outline-none placeholder:text-white/35 ${pad} ${border} ${resize}`
}

/** Shared Enter-key handler. Returns true if the event was consumed. */
function handleSubmitKey<E extends HTMLInputElement | HTMLTextAreaElement>(
  e: ReactKeyboardEvent<E>,
  submitKey: TextFieldSubmitKey,
  multiline: boolean,
  onSubmit?: () => void,
): boolean {
  if (e.key !== "Enter") return false
  if (submitKey === "cmd-enter") {
    if (!(e.metaKey || e.ctrlKey)) return false
  } else {
    // submitKey === "enter": Shift+Enter = newline in multiline, otherwise
    // no-op (still submits on plain Enter).
    if (e.shiftKey && multiline) return false
  }
  if (!onSubmit) return false
  e.preventDefault()
  onSubmit()
  return true
}

export const TextField = forwardRef<
  HTMLInputElement | HTMLTextAreaElement,
  TextFieldProps
>(function TextField(props, ref) {
  const {
    onSubmit,
    submitKey = "enter",
    bordered = true,
    size = "sm",
    multiline = false,
    className,
    onKeyDown,
    ...rest
  } = props as CommonProps & {
    className?: string
    onKeyDown?: (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void
  } & Record<string, unknown>

  const cls = `${baseClasses({ bordered, size, multiline })}${className ? ` ${className}` : ""}`

  const onKey = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (handleSubmitKey(e, submitKey, multiline, onSubmit)) return
      onKeyDown?.(e)
    },
    [submitKey, multiline, onSubmit, onKeyDown],
  )

  if (multiline) {
    return (
      <textarea
        ref={ref as React.Ref<HTMLTextAreaElement>}
        className={cls}
        onKeyDown={onKey as (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void}
        {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)}
      />
    )
  }
  return (
    <input
      ref={ref as React.Ref<HTMLInputElement>}
      className={cls}
      onKeyDown={onKey as (e: ReactKeyboardEvent<HTMLInputElement>) => void}
      {...(rest as InputHTMLAttributes<HTMLInputElement>)}
    />
  )
})
