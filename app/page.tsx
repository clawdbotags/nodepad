"use client"

import { useState, useCallback, useEffect, useRef, useMemo } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { TilingArea } from "@/components/tiling-area"
import { KanbanArea } from "@/components/kanban-area"
import { GraphArea } from "@/components/graph-area"
import { ProjectSidebar } from "@/components/project-sidebar"
import { StatusBar } from "@/components/status-bar"
import { GhostPanel, type GhostNote } from "@/components/ghost-panel"
import { VimInput } from "@/components/vim-input"
import { IntroModal } from "@/components/intro-modal"
import type { TextBlock } from "@/components/tile-card"
import type { ContentType } from "@/lib/content-types"
import { INITIAL_PROJECTS } from "@/lib/initial-data"
import { useAISettings } from "@/lib/ai-settings"
import { enrichBlockClient } from "@/lib/ai-enrich"
import { generateGhostClient } from "@/lib/ai-ghost"
import { exportToMarkdown, downloadMarkdown, copyToClipboard } from "@/lib/export"
import { downloadNodepadFile, parseNodepadFile, NodepadParseError } from "@/lib/nodepad-format"
import { detectContentType } from "@/lib/detect-content-type"
import { splitTextClient } from "@/lib/ai-split"
import { SplitConfirm } from "@/components/split-confirm"

function generateId() {
  return Math.random().toString(36).substring(2, 10)
}

export interface Project {
  id: string
  name: string
  blocks: TextBlock[]
  collapsedIds: string[]
  ghostNotes: GhostNote[]
  lastGhostBlockCount?: number
  lastGhostTimestamp?: number
  /** Texts of recently generated ghost notes — passed back to the API to prevent near-duplicates */
  lastGhostTexts?: string[]
}

import { TileIndex } from "@/components/tile-index"

export default function Page() {
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string>("")
  const [highlightedBlockId, setHighlightedBlockId] = useState<string | null>(null)
  const [isLoaded, setIsLoaded] = useState(false)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [isIndexOpen, setIsIndexOpen] = useState(false)
  const [isGhostPanelOpen, setIsGhostPanelOpen] = useState(false)
  const [viewMode, setViewMode] = useState<"tiling" | "kanban" | "graph">("tiling")
  const [isCommandKOpen, setIsCommandKOpen] = useState(false)
  const [jumpToSettings, setJumpToSettings] = useState(false)
  const [isIntroOpen, setIsIntroOpen] = useState(false)
  const [showHelpTooltip, setShowHelpTooltip] = useState(false)
  const helpTooltipTimer = useRef<NodeJS.Timeout | null>(null)

  // ── Smart split state ──────────────────────────────────────────────────────
  const [splitPendingText, setSplitPendingText] = useState<string | null>(null)
  const [isSplitting, setIsSplitting] = useState(false)
  const { settings, updateSettings, resolvedModelId, currentModel, isHydrated } = useAISettings()
  const debounceTimers = useRef<Record<string, Record<string, NodeJS.Timeout>>>({})

  // ── Undo history ring (max 20 block snapshots per project) ───────────────
  const blockHistoryRef = useRef<Record<string, TextBlock[][]>>({})
  const [undoToast, setUndoToast] = useState<string | null>(null)
  const undoToastTimer = useRef<NodeJS.Timeout | null>(null)

  const pushHistory = useCallback((projectId: string, currentBlocks: TextBlock[]) => {
    if (!blockHistoryRef.current[projectId]) blockHistoryRef.current[projectId] = []
    const stack = blockHistoryRef.current[projectId]
    stack.push(currentBlocks.map(b => ({ ...b })))
    if (stack.length > 20) stack.shift()
  }, [])

  const showUndoToast = useCallback((msg: string) => {
    if (undoToastTimer.current) clearTimeout(undoToastTimer.current)
    setUndoToast(msg)
    undoToastTimer.current = setTimeout(() => setUndoToast(null), 2200)
  }, [])

  // Clean up undo toast timer on unmount
  useEffect(() => () => {
    if (undoToastTimer.current) clearTimeout(undoToastTimer.current)
  }, [])

  // ── Intro modal ──────────────────────────────────────────────────────────
  const handleIntroClose = useCallback(() => {
    setIsIntroOpen(false)
    localStorage.setItem("nodepad-intro-seen", "true")
    // Show the help tooltip for 6 seconds pointing to the ? button
    setShowHelpTooltip(true)
    if (helpTooltipTimer.current) clearTimeout(helpTooltipTimer.current)
    helpTooltipTimer.current = setTimeout(() => setShowHelpTooltip(false), 6000)
  }, [])

  useEffect(() => () => {
    if (helpTooltipTimer.current) clearTimeout(helpTooltipTimer.current)
  }, [])

  const undo = useCallback(() => {
    const stack = blockHistoryRef.current[activeProjectId]
    if (!stack || stack.length === 0) {
      showUndoToast("Nothing to undo")
      return
    }
    const previousBlocks = stack.pop()!
    setProjects(prev => prev.map(p => p.id === activeProjectId
      ? { ...p, blocks: previousBlocks }
      : p
    ))
    showUndoToast("↩ Undone")
  }, [activeProjectId, showUndoToast])

  const activeProject = useMemo(() =>
    projects.find(p => p.id === activeProjectId) || projects[0],
  [projects, activeProjectId])

  const blocks = activeProject?.blocks || []
  const ghostNotes = activeProject?.ghostNotes || []

  const updateActiveProject = useCallback((updater: (p: Project) => Project) => {
    setProjects(prev => prev.map(p => p.id === activeProjectId ? updater(p) : p))
  }, [activeProjectId])

  // Clear debounce timers for the previous project when switching
  const prevActiveProjectId = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevActiveProjectId.current
    if (prev && prev !== activeProjectId && debounceTimers.current[prev]) {
      Object.values(debounceTimers.current[prev]).forEach(clearTimeout)
      delete debounceTimers.current[prev]
    }
    prevActiveProjectId.current = activeProjectId
  }, [activeProjectId])

  // ── Helper: convert DB note row to client TextBlock ─────────────────────
  const noteRowToBlock = useCallback((row: any): TextBlock => ({
    id: row.id,
    text: row.text,
    timestamp: row.created_at,
    contentType: row.content_type as ContentType,
    category: row.category ?? undefined,
    annotation: row.annotation ?? undefined,
    influencedBy: row.influenced_by ? JSON.parse(row.influenced_by) : undefined,
    isUnrelated: row.is_unrelated === 1,
    sources: row.sources ? JSON.parse(row.sources) : undefined,
    isEnriching: row.is_enriching === 1,
  }), [])

  // 1. Persistence: Initial Load from SQLite API
  useEffect(() => {
    async function loadFromAPI() {
      try {
        const res = await fetch("/api/projects")
        if (!res.ok) throw new Error(`Projects API returned ${res.status}`)
        const dbProjects = await res.json()

        if (dbProjects.length === 0) {
          // No projects in DB — create a default one
          const defaultId = generateId()
          await fetch("/api/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: defaultId, name: "Default Space" }),
          })
          const defaultProject: Project = {
            id: defaultId,
            name: "Default Space",
            blocks: [],
            collapsedIds: [],
            ghostNotes: [],
          }
          setProjects([defaultProject])
          setActiveProjectId(defaultId)
        } else {
          // Load first project with its notes
          const firstProject = dbProjects[0]
          const detailRes = await fetch(`/api/projects/${firstProject.id}`)
          const detail = await detailRes.json()
          const notes = (detail.notes || [])
            .filter((n: any) => n.is_ghost === 0)
          const ghostRows = (detail.notes || [])
            .filter((n: any) => n.is_ghost === 1)

          const loadedProjects: Project[] = dbProjects.map((p: any) => ({
            id: p.id,
            name: p.name,
            blocks: p.id === firstProject.id ? notes.map(noteRowToBlock) : [],
            collapsedIds: [],
            ghostNotes: p.id === firstProject.id
              ? ghostRows.map((r: any) => ({ id: r.id, text: r.text, category: r.category || "thesis", isGenerating: false }))
              : [],
          }))

          setProjects(loadedProjects)
          setActiveProjectId(firstProject.id)

          // Load notes for remaining projects in background
          for (const p of dbProjects.slice(1)) {
            fetch(`/api/projects/${p.id}`)
              .then(r => r.json())
              .then(d => {
                const pNotes = (d.notes || []).filter((n: any) => n.is_ghost === 0)
                const pGhosts = (d.notes || []).filter((n: any) => n.is_ghost === 1)
                setProjects(prev => prev.map(proj =>
                  proj.id === p.id
                    ? {
                        ...proj,
                        blocks: pNotes.map(noteRowToBlock),
                        ghostNotes: pGhosts.map((r: any) => ({ id: r.id, text: r.text, category: r.category || "thesis", isGenerating: false })),
                      }
                    : proj
                ))
              })
              .catch(e => console.error(`Failed to load notes for project ${p.id}:`, e))
          }
        }
      } catch (e) {
        console.error("Failed to load from API, using defaults:", e)
        setProjects(INITIAL_PROJECTS)
        setActiveProjectId(INITIAL_PROJECTS[0].id)
      }

      setIsLoaded(true)

      // Show intro modal on first visit (kept in localStorage — view state)
      if (!localStorage.getItem("nodepad-intro-seen")) {
        setIsIntroOpen(true)
      }
    }
    loadFromAPI()
  }, [noteRowToBlock])

  // Hidden file input for .nodepad import — triggered from sidebar or ⌘K
  const importInputRef = useRef<HTMLInputElement>(null)

  const handleImportFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const raw = ev.target?.result as string
        const names = projectsRef.current.map(p => p.name)
        const imported = parseNodepadFile(raw, names) as Project
        setProjects(prev => [...prev, imported])
        setActiveProjectId(imported.id)
        setIsSidebarOpen(false)

        // Persist imported project and notes to SQLite
        fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: imported.id, name: imported.name }),
        }).then(() => {
          // Persist all notes
          for (const block of imported.blocks) {
            fetch(`/api/projects/${imported.id}/notes`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                id: block.id,
                text: block.text,
                content_type: block.contentType,
                category: block.category,
                annotation: block.annotation,
                influenced_by: block.influencedBy,
                is_unrelated: block.isUnrelated,
                sources: block.sources,
                created_at: block.timestamp,
              }),
            }).catch(e => console.error("Failed to persist imported note:", e))
          }
        }).catch(e => console.error("Failed to persist imported project:", e))
      } catch (err) {
        if (err instanceof NodepadParseError) {
          alert(err.message)
        } else {
          alert("Could not import file — make sure it's a valid .nodepad file.")
        }
      }
    }
    reader.readAsText(file)
    // Reset input so the same file can be re-imported if needed
    e.target.value = ""
  }, [])

  // A ref to read current projects without causing re-renders or stale closures
  const projectsRef = useRef(projects)
  useEffect(() => { projectsRef.current = projects }, [projects])

  // Stable ref to active blocks — lets useCallbacks read current blocks without
  // listing `blocks` in their deps (which would recreate them on every state change
  // and cause all memo-ized TileCards to re-render unnecessarily).
  const blocksRef = useRef<TextBlock[]>([])
  useEffect(() => { blocksRef.current = blocks }, [blocks])

  // Tracks which project IDs currently have a ghost generation in-flight
  const generatingRef = useRef<Set<string>>(new Set())

  /**
   * Builds a recency-biased, category-diverse context window for ghost generation.
   * Strategy:
   *   1. Always include the 4 most recently added blocks (freshest thinking).
   *   2. Then add the single most-recent block from every category not yet represented.
   *   3. Fill remaining slots (up to 10 total) with the next most-recent blocks.
   * This forces the model to see cross-category material rather than a wall of the
   * dominant theme.
   */
  function buildGhostContext(enrichedBlocks: TextBlock[]) {
    if (enrichedBlocks.length <= 8) return enrichedBlocks

    const sorted = [...enrichedBlocks].sort((a, b) => b.timestamp - a.timestamp)
    const selected = new Set<string>()
    const result: TextBlock[] = []

    // Step 1 — most recent 4
    sorted.slice(0, 4).forEach(b => { selected.add(b.id); result.push(b) })

    // Step 2 — one representative per missing category
    const representedCats = new Set(result.map(b => b.category))
    const byCat = new Map<string, TextBlock>()
    sorted.forEach(b => {
      if (b.category && !byCat.has(b.category)) byCat.set(b.category, b)
    })
    for (const [cat, block] of byCat) {
      if (result.length >= 10) break
      if (!representedCats.has(cat) && !selected.has(block.id)) {
        selected.add(block.id)
        result.push(block)
        representedCats.add(cat)
      }
    }

    // Step 3 — fill to 10 with remaining recent blocks
    for (const b of sorted) {
      if (result.length >= 10) break
      if (!selected.has(b.id)) { selected.add(b.id); result.push(b) }
    }

    return result
  }

  const generateGhostNote = useCallback(async (projectId: string) => {
    const targetProject = projectsRef.current.find(p => p.id === projectId)

    if (!targetProject) return

    // Require at least 5 enriched blocks
    const enrichedBlocks = targetProject.blocks.filter(b => !b.isEnriching && b.category)
    if (enrichedBlocks.length < 5) return

    // Cap panel at 5 ghost notes
    if ((targetProject.ghostNotes || []).length >= 5) return

    // No concurrent generation for this project
    if (generatingRef.current.has(projectId)) return

    // Require at least 5 new blocks since last generation
    const lastCount = targetProject.lastGhostBlockCount || 0
    if (enrichedBlocks.length < lastCount + 5) return

    // Require at least 5 minutes since last generation
    const lastTime = targetProject.lastGhostTimestamp || 0
    const fiveMinutes = 5 * 60 * 1000
    if (Date.now() - lastTime < fiveMinutes) return

    // Require at least 2 distinct categories (meaningful diversity)
    const categories = new Set(enrichedBlocks.map(b => b.category).filter(Boolean))
    if (categories.size < 2) return

    generatingRef.current.add(projectId)
    const ghostId = "ghost-" + generateId()

    setProjects(prev => prev.map(p => p.id === projectId ? {
      ...p,
      ghostNotes: [...(p.ghostNotes || []), { id: ghostId, text: "", category: "thesis", isGenerating: true }],
      lastGhostBlockCount: enrichedBlocks.length,
      lastGhostTimestamp: Date.now()
    } : p))

    try {
      const curated = buildGhostContext(enrichedBlocks)
      const context = curated.map(b => ({
        text: b.text,
        category: b.category,
        contentType: b.contentType,
      }))

      // Pass the last 5 generated ghost texts so the model can avoid near-duplicates
      const previousSyntheses = (targetProject.lastGhostTexts || []).slice(-5)

      const data = await generateGhostClient(context, previousSyntheses)
      setProjects(prev => prev.map(p => {
        if (p.id !== projectId) return p
        return {
          ...p,
          ghostNotes: (p.ghostNotes || []).map(n =>
            n.id === ghostId ? { ...n, text: data.text, category: data.category, isGenerating: false } : n
          ),
          // Accumulate ghost texts for dedup (keep last 10)
          lastGhostTexts: [...(p.lastGhostTexts || []), data.text].slice(-10),
        }
      }))

      // Persist ghost note to SQLite
      fetch(`/api/projects/${projectId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: ghostId,
          text: data.text,
          content_type: "thesis",
          category: data.category,
          is_ghost: true,
          created_at: Date.now(),
        }),
      }).catch(e => console.error("Failed to persist ghost note:", e))
    } catch (e) {
      console.error("Ghost note generation failed", e)
      setProjects(prev => prev.map(p => p.id === projectId
        ? { ...p, ghostNotes: (p.ghostNotes || []).filter(n => n.id !== ghostId) }
        : p
      ))
    } finally {
      generatingRef.current.delete(projectId)
    }
  }, [])

  const enrichBlock = useCallback(async (projectId: string, id: string, text: string, category?: string, forcedType?: string) => {
    // Read context directly from the ref — avoids wrapping in setProjects() which
    // React StrictMode double-invokes in development, causing two concurrent
    // enrichment requests and a visible category flicker.
    const targetProject = projectsRef.current.find(p => p.id === projectId)
    if (!targetProject) return

    const context = targetProject.blocks
      .filter((b) => b.id !== id && !b.isEnriching)
      .map((b) => ({
        id: b.id,
        text: b.text,
        category: b.category,
        annotation: b.annotation,
      }))
      .slice(-15)

    try {
      const data = await enrichBlockClient(
        text,
        context.map(({ id, ...rest }) => ({ id, ...rest })),
        forcedType,
        category,
      )

      // Map indices back to stable block IDs — the context array carries
      // the original block IDs so we get exact, rename-proof references.
      const influencedBy = data.influencedByIndices
        ? (data.influencedByIndices as number[])
            .map((idx) => context[idx]?.id)
            .filter(Boolean) as string[]
        : []

      setProjects((current: Project[]) => {
        const mergeTargetIdx = data.mergeWithIndex
        const mergeTargetId = mergeTargetIdx !== null && context[mergeTargetIdx] ? context[mergeTargetIdx].id : null

        return current.map(proj => {
          if (proj.id !== projectId) return proj

          if (mergeTargetId) {
            return {
              ...proj,
              blocks: proj.blocks
                .filter(b => b.id !== id)
                .map(b => b.id === mergeTargetId ? {
                  ...b,
                  text: b.text + "\n\n" + text,
                  contentType: data.contentType,
                  category: data.category,
                  annotation: data.annotation,
                  confidence: data.confidence,
                  influencedBy,
                  isUnrelated: data.isUnrelated,
                  sources: data.sources ?? undefined,
                  isEnriching: false,
                  statusText: undefined,
                  isError: false,
                } : b)
            }
          }
          if (data.contentType === "task") {
            const existingTaskIndex = proj.blocks.findIndex(b => b.contentType === "task" && b.id !== id)
            if (existingTaskIndex !== -1) {
              const existingTask = proj.blocks[existingTaskIndex]
              const newSubTask = {
                id: Math.random().toString(36).substring(2, 9),
                text: text,
                isDone: false,
                timestamp: Date.now()
              }
              return {
                ...proj,
                blocks: proj.blocks
                  .filter(b => b.id !== id)
                  .map(b => b.id === existingTask.id ? {
                    ...b,
                    subTasks: [...(b.subTasks || []), newSubTask],
                    isEnriching: false,
                    statusText: undefined
                  } : b)
              }
            } else {
              return {
                ...proj,
                blocks: proj.blocks.map(b => b.id === id ? {
                  ...b,
                  contentType: "task",
                  category: "Tasks",
                  subTasks: [{
                    id: Math.random().toString(36).substring(2, 9),
                    text: text,
                    isDone: false,
                    timestamp: Date.now()
                  }],
                  isEnriching: false,
                  statusText: undefined,
                  isError: false
                } : b)
              }
            }
          }

          return {
            ...proj,
            blocks: proj.blocks.map(b => b.id === id ? {
              ...b,
              contentType: data.contentType,
              category: data.category,
              annotation: data.annotation,
              confidence: data.confidence,
              influencedBy,
              isUnrelated: data.isUnrelated,
              sources: data.sources ?? undefined,
              isEnriching: false,
              statusText: undefined,
              isError: false,
            } : b)
          }
        })
      })

      // Persist enrichment results to SQLite
      const enrichmentFields: any = {
        content_type: data.contentType,
        category: data.category,
        annotation: data.annotation,
        influenced_by: influencedBy.length > 0 ? influencedBy : null,
        is_unrelated: data.isUnrelated,
        sources: data.sources ?? null,
        is_enriching: false,
      }
      const mergeTargetIdx2 = data.mergeWithIndex
      const mergeTargetId2 = mergeTargetIdx2 !== null && context[mergeTargetIdx2] ? context[mergeTargetIdx2].id : null
      if (mergeTargetId2) {
        // Note was merged — delete the original, update the target
        fetch(`/api/notes/${id}`, { method: "DELETE" }).catch(e => console.error("Failed to delete merged note:", e))
        fetch(`/api/notes/${mergeTargetId2}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...enrichmentFields, text: text }),
        }).catch(e => console.error("Failed to persist merge target:", e))
      } else if (data.contentType === "task") {
        // Task merging — the original note may be deleted
        const targetProject2 = projectsRef.current.find(p => p.id === projectId)
        const existingTask2 = targetProject2?.blocks.find(b => b.contentType === "task" && b.id !== id)
        if (existingTask2) {
          fetch(`/api/notes/${id}`, { method: "DELETE" }).catch(e => console.error("Failed to delete task-merged note:", e))
        } else {
          fetch(`/api/notes/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(enrichmentFields),
          }).catch(e => console.error("Failed to persist enrichment:", e))
        }
      } else {
        fetch(`/api/notes/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(enrichmentFields),
        }).catch(e => console.error("Failed to persist enrichment:", e))
      }

      setTimeout(() => generateGhostNote(projectId), 2500)
    } catch (e: any) {
      console.warn(e)
      const isNoKey = e?.message?.includes("No API key") || e?.message?.includes("Invalid or missing API key") || false
      const errorStatus = isNoKey ? "no-api-key" : (e instanceof Error ? e.message : undefined)
      setProjects((current: Project[]) => current.map(proj => proj.id === projectId ? {
        ...proj,
        blocks: proj.blocks.map(b => b.id === id ? { ...b, isEnriching: false, isError: true, statusText: errorStatus } : b)
      } : proj))
    }
  }, [generateGhostNote])

  const claimGhostNote = useCallback((id: string) => {
    const note = (activeProject?.ghostNotes || []).find(n => n.id === id)
    if (!note || note.isGenerating) return
    const newId = generateId()
    const { text, category } = note
    const timestamp = Date.now()

    updateActiveProject(p => {
      const updatedProject = {
        ...p,
        blocks: [...p.blocks, {
          id: newId,
          text,
          timestamp,
          contentType: "thesis" as ContentType,
          category,
          isEnriching: true
        }],
        ghostNotes: (p.ghostNotes || []).filter(n => n.id !== id),
      }
      enrichBlock(p.id, newId, text, category, "thesis")
      return updatedProject
    })

    // Persist: delete ghost from DB, create solidified note
    fetch(`/api/notes/${id}`, { method: "DELETE" }).catch(e => console.error("Failed to delete ghost:", e))
    fetch(`/api/projects/${activeProjectId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: newId,
        text,
        content_type: "thesis",
        category,
        is_enriching: true,
        is_ghost: false,
        created_at: timestamp,
      }),
    }).catch(e => console.error("Failed to persist claimed ghost:", e))
  }, [activeProject, activeProjectId, updateActiveProject, enrichBlock])

  const dismissGhostNote = useCallback((id: string) => {
    updateActiveProject(p => ({
      ...p,
      ghostNotes: (p.ghostNotes || []).filter(n => n.id !== id),
    }))
    // Delete ghost from DB
    fetch(`/api/notes/${id}`, { method: "DELETE" }).catch(e => console.error("Failed to delete dismissed ghost:", e))
  }, [updateActiveProject])

  useEffect(() => {
    const handleKeys = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setIsCommandKOpen(prev => !prev)
      }
      if (e.key === "z" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        // Don't intercept while typing in an input/textarea
        const tag = (e.target as HTMLElement).tagName
        if (tag !== "INPUT" && tag !== "TEXTAREA") {
          e.preventDefault()
          undo()
        }
      }
      if (e.key === "Escape") {
        if (isCommandKOpen) {
          setIsCommandKOpen(false)
        } else if (isGhostPanelOpen) {
          setIsGhostPanelOpen(false)
        }
      }
    }
    window.addEventListener("keydown", handleKeys)
    return () => window.removeEventListener("keydown", handleKeys)
  }, [isCommandKOpen, isGhostPanelOpen, undo])

  const addBlock = useCallback(
    (text: string, forcedType?: ContentType) => {
      // Parse inline #type tag  e.g. "#claim The earth is 4.5 billion years old"
      let resolvedText = text
      let resolvedType = forcedType

      if (!resolvedType) {
        const tagMatch = text.match(/^#([a-z]+)\s+(.+)/i)
        if (tagMatch) {
          const tag = tagMatch[1].toLowerCase() as ContentType
          const ALL_TYPES: ContentType[] = [
            "entity", "claim", "question", "task", "idea", "reference",
            "quote", "definition", "opinion", "reflection", "narrative",
            "comparison", "thesis", "general"
          ]
          if (ALL_TYPES.includes(tag)) {
            resolvedType = tag
            resolvedText = tagMatch[2].trim()
          }
        }
      }

      const newId = generateId()

      // Types where the heuristic is syntactically unambiguous — the AI is also
      // sent forcedType so it won't reclassify them.  We can show these types
      // immediately because they will never change after enrichment.
      const heuristicType = resolvedType ?? detectContentType(resolvedText)
      const HIGH_CONFIDENCE_TYPES = new Set<ContentType>(["question", "reference", "quote", "task"])
      const enrichForcedType = resolvedType
        ?? (HIGH_CONFIDENCE_TYPES.has(heuristicType) ? heuristicType : undefined)

      // For ambiguous types (claim, idea, reflection, …) the AI may return a
      // different classification, so start as "general" during enrichment to
      // avoid a jarring double-classification jump in the UI.
      const initialDisplayType: ContentType = resolvedType
        ?? (HIGH_CONFIDENCE_TYPES.has(heuristicType) ? heuristicType : "general")

      const timestamp = Date.now()
      pushHistory(activeProjectId, blocksRef.current)
      updateActiveProject(p => ({
        ...p,
        blocks: [...p.blocks, {
          id: newId,
          text: resolvedText,
          timestamp,
          contentType: initialDisplayType,
          isEnriching: true,
        }]
      }))

      // Persist to SQLite (fire-and-forget)
      fetch(`/api/projects/${activeProjectId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: newId,
          text: resolvedText,
          content_type: initialDisplayType,
          is_enriching: true,
          created_at: timestamp,
        }),
      }).catch(e => console.error("Failed to persist new note:", e))

      setIsCommandKOpen(false)
      enrichBlock(activeProjectId, newId, resolvedText, undefined, enrichForcedType).catch(console.error)
    },
    [activeProjectId, pushHistory, updateActiveProject, enrichBlock, setIsCommandKOpen]
  )

  // ── Smart split: detect multi-item input and offer to split ───────────────

  const looksLikeMultiItem = useCallback((text: string): boolean => {
    const lines = text.split("\n").filter(l => l.trim().length > 0)
    if (lines.length >= 3) return true
    // Bullet/numbered list patterns
    const listPattern = /^[\s]*[-•*·]\s|^[\s]*\d+[.)]\s/m
    const listMatches = text.match(new RegExp(listPattern.source, "gm"))
    if (listMatches && listMatches.length >= 2) return true
    // Very long single-line text with semicolons or multiple sentences
    if (text.length > 300 && (text.split(/[;.]/).length >= 3)) return true
    return false
  }, [])

  const handleSubmit = useCallback(
    (text: string, forcedType?: ContentType) => {
      if (!settings.apiKey) {
        // No API key — skip split detection, just add normally
        addBlock(text, forcedType)
        return
      }
      if (looksLikeMultiItem(text)) {
        setSplitPendingText(text)
      } else {
        addBlock(text, forcedType)
      }
    },
    [addBlock, looksLikeMultiItem, settings.apiKey]
  )

  const handleSplitConfirm = useCallback(async () => {
    if (!splitPendingText) return
    setIsSplitting(true)
    try {
      const items = await splitTextClient(splitPendingText)
      for (const item of items) {
        addBlock(item)
      }
    } catch (err) {
      console.error("Split failed, adding as single block:", err)
      addBlock(splitPendingText)
    } finally {
      setIsSplitting(false)
      setSplitPendingText(null)
    }
  }, [splitPendingText, addBlock])

  const handleSplitKeepSingle = useCallback(() => {
    if (splitPendingText) {
      addBlock(splitPendingText)
    }
    setSplitPendingText(null)
  }, [splitPendingText, addBlock])

  const handleSplitCancel = useCallback(() => {
    setSplitPendingText(null)
  }, [])

  const deleteBlock = useCallback((id: string) => {
    pushHistory(activeProjectId, blocksRef.current)
    updateActiveProject(p => ({
      ...p,
      blocks: p.blocks.filter(b => b.id !== id)
    }))
    // Persist to SQLite
    fetch(`/api/notes/${id}`, { method: "DELETE" }).catch(e => console.error("Failed to delete note:", e))
  }, [activeProjectId, pushHistory, updateActiveProject])

  const editBlock = useCallback((id: string, newText: string) => {
    // Snapshot before the edit so Cmd+Z restores the original text
    const currentProj = projectsRef.current.find(p => p.id === activeProjectId)
    if (currentProj) {
      const currentBlock = currentProj.blocks.find(b => b.id === id)
      if (currentBlock && currentBlock.text !== newText) {
        pushHistory(activeProjectId, currentProj.blocks)
      }
    }

    setProjects(prev => {
      const proj = prev.find(p => p.id === activeProjectId)
      if (!proj) return prev
      const block = proj.blocks.find(b => b.id === id)
      if (!block || block.text === newText) return prev

      if (!debounceTimers.current[activeProjectId]) {
        debounceTimers.current[activeProjectId] = {}
      }

      if (debounceTimers.current[activeProjectId][id]) {
        clearTimeout(debounceTimers.current[activeProjectId][id])
      }

      debounceTimers.current[activeProjectId][id] = setTimeout(() => {
        enrichBlock(activeProjectId, id, newText, block.category).catch(console.error)
        delete debounceTimers.current[activeProjectId][id]
      }, 800)

      // Persist text change to SQLite
      fetch(`/api/notes/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: newText, is_enriching: true }),
      }).catch(e => console.error("Failed to persist note edit:", e))

      return prev.map(p => p.id === activeProjectId ? {
        ...p,
        blocks: p.blocks.map(b => b.id === id ? { ...b, text: newText, isEnriching: true, isError: false } : b)
      } : p)
    })
  }, [activeProjectId, enrichBlock, pushHistory])

  const reEnrichBlock = useCallback((id: string, newCategory?: string) => {
    const block = blocksRef.current.find(b => b.id === id)
    if (!block) return

    updateActiveProject(p => ({
      ...p,
      blocks: p.blocks.map(b => b.id === id ? { ...b, category: newCategory, isEnriching: true } : b)
    }))

    enrichBlock(activeProjectId, id, block.text, newCategory || block.category, block.contentType).catch(console.error)
  }, [activeProjectId, updateActiveProject, enrichBlock])

  const editAnnotation = useCallback((id: string, newAnnotation: string) => {
    updateActiveProject(p => ({
      ...p,
      blocks: p.blocks.map(b => b.id === id ? { ...b, annotation: newAnnotation } : b)
    }))
    // Persist to SQLite
    fetch(`/api/notes/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ annotation: newAnnotation }),
    }).catch(e => console.error("Failed to persist annotation:", e))
  }, [updateActiveProject])

  const toggleCollapse = useCallback((id: string) => {
    updateActiveProject(p => {
      const next = new Set(p.collapsedIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { ...p, collapsedIds: [...next] }
    })
  }, [updateActiveProject])

  const handleTogglePin = useCallback((id: string) => {
    setProjects((current) => current.map(p => p.id === activeProjectId ? {
      ...p,
      blocks: p.blocks.map(b => b.id === id ? { ...b, isPinned: !b.isPinned } : b)
    } : p))
    // Note: isPinned is not in DB schema (view state), no API call needed
  }, [activeProjectId])

  const handleToggleSubTask = useCallback((blockId: string, subTaskId: string) => {
    setProjects((current) => current.map(p => p.id === activeProjectId ? {
      ...p,
      blocks: p.blocks.map(b => b.id === blockId ? {
        ...b,
        subTasks: b.subTasks?.map(st => st.id === subTaskId ? { ...st, isDone: !st.isDone } : st)
      } : b)
    } : p))
  }, [activeProjectId])

  const handleDeleteSubTask = useCallback((blockId: string, subTaskId: string) => {
    setProjects((current) => current.map(p => p.id === activeProjectId ? {
      ...p,
      blocks: p.blocks.map(b => b.id === blockId ? {
        ...b,
        subTasks: b.subTasks?.filter(st => st.id !== subTaskId)
      } : b)
    } : p))
  }, [activeProjectId])

  const handleChangeType = useCallback((id: string, newType: ContentType) => {
    const block = blocksRef.current.find(b => b.id === id)
    if (!block) return
    pushHistory(activeProjectId, blocksRef.current)
    updateActiveProject(p => ({
      ...p,
      blocks: p.blocks.map(b => b.id === id ? { ...b, contentType: newType, isEnriching: true } : b)
    }))
    enrichBlock(activeProjectId, id, block.text, block.category, newType).catch(console.error)
  }, [activeProjectId, pushHistory, updateActiveProject, enrichBlock])

  const clearBlocks = useCallback(() => {
    pushHistory(activeProjectId, blocksRef.current)
    updateActiveProject(p => ({ ...p, blocks: [], collapsedIds: [] }))
  }, [activeProjectId, pushHistory, updateActiveProject])

  const createProject = useCallback(() => {
    const newProject: Project = {
      id: generateId(),
      name: "New Space",
      blocks: [],
      collapsedIds: [],
      ghostNotes: [],
    }
    setProjects(prev => [...prev, newProject])
    setActiveProjectId(newProject.id)
    // Persist to SQLite
    fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: newProject.id, name: newProject.name }),
    }).catch(e => console.error("Failed to persist project:", e))
  }, [])

  const renameProject = useCallback((id: string, newName: string) => {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, name: newName } : p))
    // Persist to SQLite
    fetch(`/api/projects/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    }).catch(e => console.error("Failed to rename project:", e))
  }, [])

  const deleteProject = useCallback((id: string) => {
    setProjects(prev => {
      if (prev.length <= 1) return prev
      const nextProjects = prev.filter(p => p.id !== id)
      if (activeProjectId === id) {
        setActiveProjectId(nextProjects[0].id)
      }
      // Persist to SQLite (cascade deletes notes)
      fetch(`/api/projects/${id}`, { method: "DELETE" }).catch(e => console.error("Failed to delete project:", e))
      return nextProjects
    })
  }, [activeProjectId])

  const handleCommand = useCallback((cmd: string, text?: string) => {
    setIsCommandKOpen(false)
    
    // Handle view switches
    if (cmd === "kanban") {
      setViewMode("kanban")
    } else if (cmd === "tiling") {
      setViewMode("tiling")
    } else if (cmd === "graph") {
      setViewMode("graph")
    } else if (cmd === "open-projects") {
      setIsGhostPanelOpen(false)
      setIsIndexOpen(false)
      setIsSidebarOpen(prev => !prev)
    } else if (cmd === "new-project") {
      setIsGhostPanelOpen(false)
      setIsIndexOpen(false)
      setIsSidebarOpen(true)
      createProject()
    } else if (cmd === "open-index") {
      setIsSidebarOpen(false)
      setIsGhostPanelOpen(false)
      setIsIndexOpen(prev => !prev)
    } else if (cmd === "open-synthesis") {
      setIsSidebarOpen(false)
      setIsIndexOpen(false)
      setIsGhostPanelOpen(prev => !prev)
    } else if (cmd === "clear") clearBlocks()
    else if (cmd === "help") window.open("https://github.com/albingroen/react-cmdk", "_blank")
    
    // .nodepad export / import
    else if (cmd === "export-nodepad") {
      setProjects(prev => {
        const proj = prev.find(p => p.id === activeProjectId)
        if (proj) downloadNodepadFile(proj)
        return prev
      })
    } else if (cmd === "import-nodepad") {
      importInputRef.current?.click()
    }

    // Export commands — read project from state snapshot via ref to avoid stale closure
    else if (cmd === "export-md") {
      setProjects(prev => {
        const proj = prev.find(p => p.id === activeProjectId)
        if (proj) {
          const md = exportToMarkdown(proj.name, proj.blocks)
          const slug = proj.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
          downloadMarkdown(`${slug}.md`, md)
        }
        return prev
      })
    } else if (cmd === "copy-md") {
      setProjects(prev => {
        const proj = prev.find(p => p.id === activeProjectId)
        if (proj) {
          const md = exportToMarkdown(proj.name, proj.blocks)
          copyToClipboard(md)
        }
        return prev
      })
    }
    
    // Handle type overrides
    else if (cmd === "task" && text) addBlock(text, "task")
    else if (cmd === "thesis" && text) addBlock(text, "thesis")
    
    setIsCommandKOpen(false)
  }, [clearBlocks, addBlock, activeProjectId])

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {/* Hidden file input for .nodepad import */}
      <input
        ref={importInputRef}
        type="file"
        accept=".nodepad,.json"
        className="hidden"
        onChange={handleImportFile}
      />

      <ProjectSidebar
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        projects={projects}
        activeProjectId={activeProjectId}
        onSelectProject={setActiveProjectId}
        onCreateProject={createProject}
        onRenameProject={renameProject}
        onDeleteProject={deleteProject}
        onImportProject={() => importInputRef.current?.click()}
        aiSettings={settings}
        onUpdateAISettings={updateSettings}
        openToSettings={jumpToSettings}
        onSettingsOpened={() => setJumpToSettings(false)}
      />

      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        <StatusBar
          blockCount={blocks.length}
          blocks={blocks}
          isSidebarOpen={isSidebarOpen}
          isIndexOpen={isIndexOpen}
          isGhostPanelOpen={isGhostPanelOpen}
          ghostNoteCount={ghostNotes.filter(n => !n.isGenerating).length}
          activeProjectName={activeProject?.name || ""}
          onMenuClick={() => setIsSidebarOpen(!isSidebarOpen)}
          onIndexToggle={() => setIsIndexOpen(!isIndexOpen)}
          onGhostPanelToggle={() => setIsGhostPanelOpen(prev => !prev)}
          modelLabel={isHydrated && settings.apiKey ? currentModel.shortLabel : undefined}
          showHelpTooltip={showHelpTooltip}
          onHelpTooltipDismiss={() => {
            setShowHelpTooltip(false)
            if (helpTooltipTimer.current) clearTimeout(helpTooltipTimer.current)
          }}
        />

        {isHydrated && !settings.apiKey && (
          <div className="flex items-center justify-center gap-3 px-4 py-2 bg-amber-950/80 border-b border-amber-800/60 text-amber-200 text-xs shrink-0">
            <span className="opacity-80">⚡ AI enrichment requires an <strong className="text-amber-200">OpenRouter API key</strong> — use a free model (no credits needed) or add credits for GPT-4o, Claude, and more. Configure in the <strong className="text-amber-200">☰ left panel</strong>.</span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => { setIsSidebarOpen(true); setJumpToSettings(true) }}
                className="px-2.5 py-1 rounded bg-amber-700/60 hover:bg-amber-600/70 text-amber-100 font-medium transition-colors cursor-pointer border border-amber-600/50"
              >
                Add API key →
              </button>
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="opacity-60 hover:opacity-90 transition-opacity underline underline-offset-2"
              >
                Get a free key ↗
              </a>
            </div>
          </div>
        )}

        <div className="flex flex-1 overflow-hidden relative">
          <main className="relative flex-1 overflow-hidden">
            {isLoaded ? (
              viewMode === "tiling" ? (
                <TilingArea
                  key={`tiling-${activeProjectId}`}
                  blocks={activeProject.blocks}
                  collapsedIds={new Set(activeProject.collapsedIds)}
                  onDelete={deleteBlock}
                  onEdit={editBlock}
                  onEditAnnotation={editAnnotation}
                  onReEnrich={reEnrichBlock}
                  onChangeType={handleChangeType}
                  onToggleCollapse={toggleCollapse}
                  onTogglePin={handleTogglePin}
                  onToggleSubTask={handleToggleSubTask}
                  onDeleteSubTask={handleDeleteSubTask}
                  highlightedBlockId={highlightedBlockId}
                  onHighlight={setHighlightedBlockId}
                />
              ) : viewMode === "kanban" ? (
                <KanbanArea
                  key={`kanban-${activeProjectId}`}
                  blocks={activeProject.blocks}
                  onDelete={deleteBlock}
                  onEdit={editBlock}
                  onEditAnnotation={editAnnotation}
                  onReEnrich={reEnrichBlock}
                  onChangeType={handleChangeType}
                  onToggleCollapse={toggleCollapse}
                  onTogglePin={handleTogglePin}
                  onToggleSubTask={handleToggleSubTask}
                  onDeleteSubTask={handleDeleteSubTask}
                  collapsedIds={new Set(activeProject.collapsedIds)}
                />
              ) : (
                <GraphArea
                  key={`graph-${activeProjectId}`}
                  blocks={activeProject.blocks}
                  ghostNote={ghostNotes[ghostNotes.length - 1]}
                  projectName={activeProject.name}
                  onReEnrich={reEnrichBlock}
                  onChangeType={handleChangeType}
                  onTogglePin={handleTogglePin}
                  onEdit={editBlock}
                  onEditAnnotation={editAnnotation}
                  highlightedBlockId={highlightedBlockId}
                  onHighlight={setHighlightedBlockId}
                />
              )
            ) : (
              <div className="h-full w-full" />
            )}
          </main>

          <GhostPanel
            ghostNotes={ghostNotes}
            isOpen={isGhostPanelOpen}
            onClose={() => setIsGhostPanelOpen(false)}
            onClaim={claimGhostNote}
            onDismiss={dismissGhostNote}
          />
        </div>

        {/* Undo toast */}
        <AnimatePresence>
          {undoToast && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="absolute bottom-[72px] left-1/2 -translate-x-1/2 z-[130] pointer-events-none"
            >
              <div className="px-3 py-1.5 rounded-sm bg-black/90 border border-white/15 backdrop-blur-md shadow-xl">
                <span className="font-mono text-[10px] text-white/70 tracking-tight whitespace-nowrap">{undoToast}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <VimInput
          onSubmit={handleSubmit}
          onCommand={handleCommand}
          isCommandKOpen={isCommandKOpen}
          setIsCommandKOpen={setIsCommandKOpen}
        />

        {/* Smart split confirmation modal */}
        <SplitConfirm
          open={splitPendingText !== null}
          text={splitPendingText ?? ""}
          isSplitting={isSplitting}
          onSplit={handleSplitConfirm}
          onKeepSingle={handleSplitKeepSingle}
          onCancel={handleSplitCancel}
        />
      </div>

      <TileIndex 
        blocks={blocks} 
        onHighlight={setHighlightedBlockId} 
        highlightedId={highlightedBlockId}
        onClose={() => setIsIndexOpen(false)}
        isOpen={isIndexOpen}
        viewMode={viewMode}
      />

      {/* First-visit intro video modal */}
      <IntroModal open={isIntroOpen} onClose={handleIntroClose} />
    </div>
  )
}
