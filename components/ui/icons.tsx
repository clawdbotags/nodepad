"use client"

/**
 * Shared SVG icons. Before this, the same `<svg>` blocks (close ×, mic,
 * speaker waveform, spinner) were hand-pasted in 2–4 places each and had
 * begun drifting (different stroke widths, different sizes per surface).
 * One copy per icon here; callers pick a size.
 *
 * Everything is stroke="currentColor" so the parent's `text-*` class wins.
 * Sizes are pixel numbers, not Tailwind classes, because call sites pass
 * raw numbers for their surface (e.g. 14 in the entry bar, 56 in Drive).
 *
 * The steering wheel lives in drive-button.tsx next to its main consumer
 * and is re-exported from there — don't duplicate it here.
 */

type IconProps = {
  size?: number
  className?: string
}

/** Two-line × — used for modal close, Drive overlay close, Chat Drive close. */
export function CloseIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

/** Classic microphone — capsule + arc stand. Used in the giant Drive/Chat
 *  Drive buttons (not the small voice-mic-button, which has its own copy
 *  with a slightly different rect because it's intentionally smaller). */
export function MicIcon({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="9" y="2" width="6" height="13" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  )
}

/** Speaker with two sound arcs — used in Drive / Chat Drive "speaking" phase. */
export function SpeakerIcon({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M11 5L6 9H2v6h4l5 4V5z" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  )
}

/** Animated spinner arc — used for "thinking" / "processing" phases.
 *  Already includes `animate-spin`; don't wrap in another. */
export function SpinnerIcon({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`animate-spin ${className ?? ""}`}
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.55" />
    </svg>
  )
}
