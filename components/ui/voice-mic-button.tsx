"use client"

/**
 * Shared mic button for the two voice-input surfaces:
 *   - Entry bar (canvas bottom row) — part of the icon cluster, icon-only.
 *   - Augment dialog — bordered pill next to the prompt input.
 *
 * Both share the same three visual states driven by `useVoiceRecorder`:
 *   - idle:        neutral icon + hover lightens
 *   - recording:   pulsing red dot
 *   - transcribing: primary-colored pulse
 *
 * The two call sites previously duplicated ~30 lines each. They diverge only
 * in chrome (icon size, border, padding), which is what the `variant` prop
 * encodes. Add more variants here if a new surface needs it — don't inline a
 * new copy.
 */
type Variant =
  /** Icon-only cell inside the Entry bar icon cluster. Size adapts to mobile. */
  | "entry"
  /** Bordered pill alongside the augment dialog input. */
  | "augment"

export function VoiceMicButton({
  recording,
  transcribing,
  onToggle,
  disabled = false,
  variant = "entry",
  isMobile = false,
  testId,
}: {
  recording: boolean
  transcribing: boolean
  onToggle: () => void
  disabled?: boolean
  variant?: Variant
  /** Only consulted for variant="entry" — augment doesn't shrink the touch target. */
  isMobile?: boolean
  testId?: string
}) {
  if (variant === "augment") {
    return (
      <button
        type="button"
        data-testid={testId}
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={recording}
        aria-label={recording ? "Stop recording" : "Dictate prompt"}
        title={recording ? "Stop & transcribe" : "Dictate prompt"}
        className={`relative shrink-0 inline-flex items-center justify-center rounded-sm border px-3 transition-colors disabled:opacity-40 ${
          recording
            ? "border-red-500/40 bg-red-500/10 text-red-300"
            : transcribing
            ? "border-primary/40 bg-primary/10 text-primary animate-pulse"
            : "border-white/10 bg-white/[0.04] text-white/55 hover:bg-white/[0.08] hover:text-white/80"
        }`}
      >
        {recording ? (
          <span className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
          </span>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="3" width="6" height="12" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0" />
            <line x1="12" y1="18" x2="12" y2="22" />
          </svg>
        )}
      </button>
    )
  }

  // variant === "entry"
  return (
    <button
      data-testid={testId}
      onClick={onToggle}
      disabled={disabled}
      title={recording ? "Stop & transcribe" : transcribing ? "Transcribing…" : "Voice input"}
      aria-pressed={recording}
      aria-label="Voice input"
      className={`flex items-center justify-center transition-colors ${
        isMobile ? "h-11 w-11" : "h-7 w-8"
      } ${
        recording
          ? "text-red-400 hover:text-red-300"
          : transcribing
          ? "text-primary animate-pulse"
          : "text-white/55 hover:text-white/85 hover:bg-white/[0.06]"
      } disabled:opacity-30 disabled:hover:bg-transparent`}
    >
      {recording ? (
        <span className={`relative flex ${isMobile ? "h-3.5 w-3.5" : "h-2.5 w-2.5"}`}>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
          <span
            className={`relative inline-flex rounded-full bg-red-400 ${isMobile ? "h-3.5 w-3.5" : "h-2.5 w-2.5"}`}
          />
        </span>
      ) : (
        <svg
          width={isMobile ? "20" : "13"}
          height={isMobile ? "20" : "13"}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="9" y="3" width="6" height="12" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <line x1="12" y1="18" x2="12" y2="22" />
        </svg>
      )}
    </button>
  )
}
