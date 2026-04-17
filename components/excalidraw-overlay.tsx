"use client"

import dynamic from "next/dynamic"
import { useCallback, useEffect, useRef, useState } from "react"
import { ToolbarPill } from "@/components/ui/toolbar-pill"
import "@excalidraw/excalidraw/index.css"

// Excalidraw uses window APIs at module load — must be client-only.
const Excalidraw = dynamic(
  async () => (await import("@excalidraw/excalidraw")).Excalidraw,
  { ssr: false, loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-black/80 font-mono text-[10px] uppercase tracking-[0.3em] text-white/40">
      loading editor…
    </div>
  ) }
)

export type ExcalidrawScene = {
  elements: any[]
  appState?: any
  files?: any
}

export function emptyScene(): ExcalidrawScene {
  return { elements: [], appState: { viewBackgroundColor: "transparent" }, files: {} }
}

export function parseScene(text: string): ExcalidrawScene {
  if (!text || !text.trim()) return emptyScene()
  try {
    const v = JSON.parse(text)
    if (v && typeof v === "object" && Array.isArray(v.elements)) {
      return {
        elements: v.elements,
        appState: v.appState ?? { viewBackgroundColor: "transparent" },
        files: v.files ?? {},
      }
    }
  } catch { /* ignore */ }
  return emptyScene()
}

export function serializeScene(s: ExcalidrawScene): string {
  // Drop volatile UI state from appState before persisting (selection, viewport pan,
  // collaborator info, etc.) — keeps the saved JSON compact and reproducible.
  const { collaborators: _c, ...persistableAppState } = (s.appState || {}) as any
  return JSON.stringify({
    elements: s.elements,
    appState: persistableAppState,
    files: s.files || {},
  })
}

/**
 * Fullscreen modal hosting the live Excalidraw editor for one drawing block.
 * - Closes (saving) on ✕ button, click-outside the editor frame, or Escape.
 * - Calls onSave with the latest serialized scene before closing.
 */
export function ExcalidrawOverlay({ initialScene, onSave, onClose }: {
  initialScene: ExcalidrawScene
  onSave: (scene: ExcalidrawScene) => void
  onClose: () => void
}) {
  const sceneRef = useRef<ExcalidrawScene>(initialScene)
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  const handleClose = useCallback(() => {
    onSave(sceneRef.current)
    onClose()
  }, [onSave, onClose])

  // Esc closes (saves)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        handleClose()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [handleClose])

  return (
    <div
      data-testid="excalidraw-overlay"
      className="fixed inset-0 z-[100] bg-black/85 backdrop-blur-sm flex flex-col"
      onMouseDown={e => {
        // Click on the dim outside the editor frame closes
        if ((e.target as HTMLElement).dataset.overlayBg === "true") handleClose()
      }}
    >
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 bg-black/40">
        <div className="font-mono text-[10px] font-bold uppercase tracking-[0.25em] text-white/60">
          drawing — sketch · ⎋ or ✕ to save & close
        </div>
        <ToolbarPill
          data-testid="excalidraw-close"
          onClick={handleClose}
          tone="ghost"
          size="sm"
          title="Save & close"
        >
          ✕
        </ToolbarPill>
      </div>
      <div className="flex-1 min-h-0 relative" data-overlay-bg="false">
        {mounted && (
          <Excalidraw
            initialData={initialScene as any}
            theme="dark"
            UIOptions={{ canvasActions: { saveToActiveFile: false, loadScene: false } }}
            onChange={(elements, appState, files) => {
              sceneRef.current = {
                elements: Array.isArray(elements) ? elements.slice() : [],
                appState,
                files,
              }
            }}
          />
        )}
      </div>
    </div>
  )
}

/**
 * Static SVG preview of an Excalidraw scene. Used inside drawing blocks
 * (canvas + tiled views) so we don't pay the cost of mounting the live editor
 * per block. Re-renders when the scene JSON changes.
 */
export function DrawingPreview({ scene, className }: {
  scene: ExcalidrawScene
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [empty, setEmpty] = useState(false)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const elements = scene.elements || []
        if (!ref.current) return
        if (elements.length === 0) {
          ref.current.innerHTML = ""
          setEmpty(true)
          return
        }
        setEmpty(false)
        const { exportToSvg } = await import("@excalidraw/excalidraw")
        const svg = await exportToSvg({
          elements: elements as any,
          appState: { ...(scene.appState || {}), exportBackground: false } as any,
          files: scene.files || null,
        })
        if (cancelled || !ref.current) return
        // Make the SVG fill its container responsively
        svg.setAttribute("width", "100%")
        svg.setAttribute("height", "100%")
        svg.style.display = "block"
        svg.style.maxWidth = "100%"
        svg.style.maxHeight = "100%"
        ref.current.innerHTML = ""
        ref.current.appendChild(svg)
      } catch (e) {
        // Non-fatal — preview just won't render
        // eslint-disable-next-line no-console
        console.warn("DrawingPreview render failed:", e)
      }
    }
    run()
    return () => { cancelled = true }
  }, [scene])

  return (
    <div ref={ref} className={`flex h-full w-full items-center justify-center overflow-hidden ${className || ""}`}>
      {empty && (
        <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-white/30">
          empty drawing — tap ⛶ to sketch
        </div>
      )}
    </div>
  )
}

/**
 * Render a scene to a PNG data URL — used when augment includes a drawing
 * block in scope (so the LLM literally sees the sketch).
 */
export async function renderSceneToPng(scene: ExcalidrawScene, opts?: { maxDim?: number }): Promise<string> {
  const elements = scene.elements || []
  if (elements.length === 0) return ""
  const { exportToBlob } = await import("@excalidraw/excalidraw")
  const blob = await exportToBlob({
    elements: elements as any,
    appState: { ...(scene.appState || {}), exportBackground: true, viewBackgroundColor: "#ffffff" } as any,
    files: scene.files || null,
    mimeType: "image/png",
    quality: 0.92,
    getDimensions: opts?.maxDim
      ? (w: number, h: number) => {
          const max = opts.maxDim!
          const scale = Math.min(1, max / Math.max(w, h))
          return { width: Math.round(w * scale), height: Math.round(h * scale), scale }
        }
      : undefined,
  })
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(reader.result as string)
    reader.readAsDataURL(blob)
  })
}
