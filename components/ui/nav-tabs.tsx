"use client"

/**
 * NavTabs — the `[Nodes | Rooms]` tab bar that appears at the top of both
 * sidebars (canvas sidebar on `/`, rooms sidebar on `/chat`). Also the
 * shape of the floating view-toggle and the mobile top-bar view-toggle.
 *
 * Two visual variants:
 *  - "bar"   — full-width divider row (tabs stretch flex-1). Used at top of
 *              sidebars.
 *  - "group" — compact bordered pill group. Used for view-toggle floats.
 *
 * Each item is either a plain button (onClick) or an anchor (href) so routes
 * can force full navigation when state should remount (e.g. Rooms → /chat).
 * Items render with the same mono · uppercase · tracking-wider accent that
 * every toolbar pill in nodepad uses — change once, everywhere reflects.
 */

type NavTabItem = {
  key: string
  label: string
  active?: boolean
  href?: string
  onClick?: () => void
  testId?: string
}

export function NavTabs({
  items,
  variant = "bar",
  testId,
}: {
  items: NavTabItem[]
  variant?: "bar" | "group"
  testId?: string
}) {
  if (variant === "group") {
    return (
      <div
        data-testid={testId}
        className="flex items-center gap-1 rounded-sm border border-white/10 bg-black/60 backdrop-blur-md px-1.5 py-1"
      >
        {items.map(it => (
          <NavTabButton key={it.key} item={it} variant="group" />
        ))}
      </div>
    )
  }
  return (
    <div
      data-testid={testId}
      className="shrink-0 flex items-center gap-1 border-b border-white/10 bg-black/30 px-2 py-1.5"
    >
      {items.map(it => (
        <NavTabButton key={it.key} item={it} variant="bar" />
      ))}
    </div>
  )
}

function NavTabButton({
  item,
  variant,
}: {
  item: NavTabItem
  variant: "bar" | "group"
}) {
  const flex = variant === "bar" ? "flex-1 text-center" : ""
  const padding = variant === "bar" ? "px-2 py-1" : "px-3 py-2"
  const cls = `${flex} ${padding} rounded-sm font-mono text-[10px] font-bold uppercase tracking-wider transition-all ${
    item.active
      ? "bg-primary/15 border border-primary/40 text-primary"
      : "text-white/55 hover:bg-white/[0.06] hover:text-primary hover:border-primary/35 border border-transparent"
  }`
  if (item.href && !item.active) {
    return (
      <a
        data-testid={item.testId}
        href={item.href}
        className={cls}
      >
        {item.label}
      </a>
    )
  }
  return (
    <button
      data-testid={item.testId}
      onClick={item.onClick}
      className={cls}
    >
      {item.label}
    </button>
  )
}
