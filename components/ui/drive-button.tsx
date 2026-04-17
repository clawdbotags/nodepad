"use client"

/**
 * DriveButton — single affordance for entering Drive Mode. Before, the
 * canvas entry bar rendered a bare icon-only button while the chat-view
 * header rendered a bordered pill with "Drive" text — same function,
 * different logos, different padding, different colors. Now: one
 * component, two sizes.
 *
 * The steering-wheel glyph is the OpenFang/nodepad "drive" logo and is
 * the same SVG the Drive Mode overlay uses in its top-left corner. Keep
 * it in one place so we don't drift.
 *
 * Variants:
 *  - "icon" — bare icon cell, part of the canvas icon cluster (no border,
 *             hover tint). `size` controls tap-target (compact vs mobile).
 *  - "pill" — bordered primary-accent pill with "Drive" label, used in
 *             the chat room header and anywhere Drive is a headline action.
 */

type Variant = "icon" | "pill"

export function DriveButton({
  onClick,
  disabled = false,
  variant = "icon",
  size = "compact",
  testId,
  title = "Drive Mode — hands-off voice loop",
}: {
  onClick: () => void
  disabled?: boolean
  variant?: Variant
  /** Only consulted for variant="icon". */
  size?: "compact" | "mobile"
  testId?: string
  title?: string
}) {
  if (variant === "pill") {
    return (
      <button
        data-testid={testId}
        onClick={onClick}
        disabled={disabled}
        title={title}
        aria-label="Open Drive Mode"
        className="flex items-center gap-1.5 rounded-sm border border-primary/40 bg-primary/10 hover:bg-primary/20 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-primary transition-colors disabled:opacity-40"
      >
        <SteeringWheelIcon size={12} />
        Drive
      </button>
    )
  }
  // variant === "icon"
  const isMobile = size === "mobile"
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label="Open Drive Mode"
      className={`flex items-center justify-center text-white/55 hover:bg-white/[0.06] hover:text-white/85 disabled:opacity-30 disabled:hover:bg-transparent transition-colors ${
        isMobile ? "h-11 w-11" : "h-7 w-8"
      }`}
    >
      <SteeringWheelIcon size={isMobile ? 20 : 14} />
    </button>
  )
}

/** The steering-wheel glyph — shared by the canvas button, the chat pill,
 *  and the Drive Mode overlay top bar. Width === height. */
export function SteeringWheelIcon({ size = 14 }: { size?: number }) {
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
    >
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.5" />
      <line x1="12" y1="2.5" x2="12" y2="9.5" />
      <line x1="3" y1="12" x2="9.5" y2="12" />
      <line x1="14.5" y1="12" x2="21" y2="12" />
    </svg>
  )
}
