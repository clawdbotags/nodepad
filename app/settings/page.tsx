"use client"

/**
 * /settings — nodepad-v2 settings panel.
 *
 * The only reason this exists as a separate route is that app/page.tsx is
 * 3500 lines and I don't want to thread another modal through it. Kept
 * deliberately small; only what's needed to pick an LLM backend + stash
 * an API key.
 *
 * Persistence: /api/settings GET/PUT (key-value store in SQLite).
 * API keys are transparently encrypted server-side via isSensitiveKey.
 */

import { useEffect, useState, useCallback } from "react"
import { ToolbarPill } from "@/components/ui/toolbar-pill"

type SettingsMap = Record<string, string>

// Backend option constants — single source of truth for the dropdowns.
const AUGMENT_BACKENDS = [
  { value: "",            label: "OpenRouter / OpenAI", hint: "Cloud API; uses the key below" },
  { value: "qwen",        label: "Local Qwen (aiserver)", hint: "Free, self-hosted on aiserver01; vision falls back to cloud" },
  { value: "claude-code", label: "Claude Code (CLI)", hint: "Uses logged-in `claude -p` subprocess; stateless, no API key; vision falls back to cloud" },
] as const

const DRIVE_BACKENDS = [
  { value: "",            label: "OpenRouter / OpenAI", hint: "Fast cloud classifier + responder" },
  { value: "qwen-tools",  label: "Local Qwen (tools)", hint: "Tool-calling on aiserver01" },
  { value: "claude-code", label: "Claude Code (CLI)", hint: "Routes both classifier + responder through `claude -p`" },
] as const

const CLAUDE_MODELS = [
  { value: "claude-opus-4-7", label: "claude-opus-4-7 (smart, slower)" },
  { value: "sonnet",          label: "sonnet (balanced)" },
  { value: "haiku",           label: "haiku (fast, cheapest)" },
] as const

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsMap>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/settings")
      const data = await res.json()
      setSettings(data || {})
    } catch (e: any) {
      setError(e?.message || "failed to load settings")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function saveKey(key: string, value: string) {
    setSaving(key); setError(null); setSaved(null)
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSettings(s => ({ ...s, [key]: value }))
      setSaved(key)
      setTimeout(() => setSaved(cur => (cur === key ? null : cur)), 1500)
    } catch (e: any) {
      setError(`save ${key}: ${e?.message || "failed"}`)
    } finally {
      setSaving(null)
    }
  }

  const get = (k: string, fallback = "") => settings[k] ?? fallback

  return (
    <div className="min-h-screen bg-black text-white/85 font-sans">
      <div className="mx-auto max-w-2xl px-5 py-8 space-y-8">

        <header className="flex items-center justify-between border-b border-white/10 pb-3">
          <h1 className="text-lg font-bold uppercase tracking-[0.25em] text-white/85">
            Settings
          </h1>
          <a
            href="/"
            className="text-[10px] font-bold uppercase tracking-wider text-white/55 hover:text-white/90"
          >
            ← Back to canvas
          </a>
        </header>

        {loading && (
          <p className="text-[11px] text-white/50">Loading…</p>
        )}

        {error && (
          <p className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            {error}
          </p>
        )}

        {!loading && (
          <>

            {/* ─── LLM Backend per-mode ─────────────────────────────────────── */}
            <section className="space-y-5">
              <SectionHeader title="LLM Backend" hint="Pick the provider per mode. Each saves on change." />

              <BackendPicker
                label="Augment mode"
                description="Used when you run Augment (structured / plain) on the canvas."
                current={get("augmentBackend")}
                options={AUGMENT_BACKENDS as unknown as BackendOption[]}
                saving={saving === "augmentBackend"}
                saved={saved === "augmentBackend"}
                onChange={v => saveKey("augmentBackend", v)}
              />

              <BackendPicker
                label="Drive Mode"
                description="Used by voice / drive-turn classifier + drive-respond narrator."
                current={get("driveBackend")}
                options={DRIVE_BACKENDS as unknown as BackendOption[]}
                saving={saving === "driveBackend"}
                saved={saved === "driveBackend"}
                onChange={v => saveKey("driveBackend", v)}
              />
            </section>

            {/* ─── Claude Code settings ──────────────────────────────────── */}
            <section className="space-y-3">
              <SectionHeader
                title="Claude Code"
                hint="Applies only when a mode above is set to Claude Code. Stateless `claude -p` subprocess — no session persistence."
              />

              <LabeledField label="Model">
                <select
                  className="w-full rounded-sm bg-white/[0.06] border border-white/10 px-2 py-1.5 text-[12px] text-white/85 focus:outline-none focus:border-white/30"
                  value={get("claudeCodeModel", "claude-opus-4-7")}
                  onChange={e => saveKey("claudeCodeModel", e.target.value)}
                  disabled={saving === "claudeCodeModel"}
                >
                  {CLAUDE_MODELS.map(m => (
                    <option key={m.value} value={m.value} className="bg-black">{m.label}</option>
                  ))}
                </select>
              </LabeledField>

              <LabeledField label="Claude binary (optional)" hint="Default: 'claude' on PATH. Override here if needed.">
                <TextInput
                  value={get("claudeCodePath")}
                  placeholder="claude"
                  onBlur={v => { if (v !== get("claudeCodePath")) saveKey("claudeCodePath", v) }}
                />
              </LabeledField>
            </section>

            {/* ─── API keys / cloud config ─────────────────────────────── */}
            <section className="space-y-3">
              <SectionHeader title="Cloud API (OpenRouter / OpenAI)" hint="Needed when Augment or Drive is set to OpenRouter/OpenAI." />

              <LabeledField label="Provider">
                <select
                  className="w-full rounded-sm bg-white/[0.06] border border-white/10 px-2 py-1.5 text-[12px] text-white/85 focus:outline-none focus:border-white/30"
                  value={get("provider", "openrouter")}
                  onChange={e => saveKey("provider", e.target.value)}
                  disabled={saving === "provider"}
                >
                  <option value="openrouter" className="bg-black">OpenRouter</option>
                  <option value="openai" className="bg-black">OpenAI</option>
                </select>
              </LabeledField>

              <LabeledField label="API Key" hint="Stored encrypted server-side.">
                <TextInput
                  value={get("apiKey")}
                  placeholder="sk-…"
                  type="password"
                  onBlur={v => { if (v !== get("apiKey")) saveKey("apiKey", v) }}
                />
              </LabeledField>

              <LabeledField label="Default model ID">
                <TextInput
                  value={get("modelId")}
                  placeholder="anthropic/claude-3.5-sonnet"
                  onBlur={v => { if (v !== get("modelId")) saveKey("modelId", v) }}
                />
              </LabeledField>

              <LabeledField label="Rearrange model (vision)" hint="Vision-capable model for canvas rearrange. Default: google/gemini-3-flash.">
                <TextInput
                  value={get("rearrangeModelId")}
                  placeholder="google/gemini-3-flash"
                  onBlur={v => { if (v !== get("rearrangeModelId")) saveKey("rearrangeModelId", v) }}
                />
              </LabeledField>
            </section>

          </>
        )}

        <footer className="pt-6 text-[10px] text-white/30">
          nodepad-v2 · settings stored in ~/.openfang/apps/nodepad-v2/data/nodepad.db
        </footer>
      </div>
    </div>
  )
}

// ─── small presentational helpers ──────────────────────────────────────────

type BackendOption = { value: string; label: string; hint?: string }

function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="border-b border-white/10 pb-2">
      <h2 className="text-[11px] font-bold uppercase tracking-[0.25em] text-white/70">{title}</h2>
      {hint && <p className="mt-1 text-[11px] leading-snug text-white/45">{hint}</p>}
    </div>
  )
}

function LabeledField({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] font-bold uppercase tracking-wider text-white/55">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-white/35">{hint}</p>}
    </div>
  )
}

function TextInput({
  value,
  placeholder,
  type,
  onBlur,
}: {
  value: string
  placeholder?: string
  type?: "text" | "password"
  onBlur: (v: string) => void
}) {
  const [local, setLocal] = useState(value)
  useEffect(() => { setLocal(value) }, [value])
  return (
    <input
      type={type || "text"}
      className="w-full rounded-sm bg-white/[0.06] border border-white/10 px-2 py-1.5 text-[12px] text-white/85 placeholder-white/25 focus:outline-none focus:border-white/30"
      value={local}
      placeholder={placeholder}
      onChange={e => setLocal(e.target.value)}
      onBlur={e => onBlur(e.target.value)}
    />
  )
}

function BackendPicker({
  label,
  description,
  current,
  options,
  saving,
  saved,
  onChange,
}: {
  label: string
  description?: string
  current: string
  options: BackendOption[]
  saving: boolean
  saved: boolean
  onChange: (v: string) => void
}) {
  const selected = options.find(o => o.value === current) || options[0]
  return (
    <div className="rounded-sm border border-white/10 bg-white/[0.02] p-3 space-y-2">
      <div className="flex items-center gap-2">
        <div className="text-[11px] font-bold uppercase tracking-wider text-white/80">{label}</div>
        {saving && <span className="text-[10px] text-white/40">saving…</span>}
        {saved && <span className="text-[10px] text-emerald-400/80">saved</span>}
      </div>
      {description && <p className="text-[10px] leading-snug text-white/40">{description}</p>}
      <div className="flex flex-col gap-1.5 pt-1">
        {options.map(opt => {
          const active = opt.value === selected.value
          return (
            <button
              key={opt.value || "default"}
              onClick={() => onChange(opt.value)}
              disabled={saving}
              className={`rounded-sm border px-2.5 py-2 text-left transition-colors ${
                active
                  ? "border-primary/60 bg-primary/15"
                  : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    active ? "bg-primary" : "bg-white/20"
                  }`}
                />
                <span className="text-[11px] font-bold uppercase tracking-wider text-white/85">
                  {opt.label}
                </span>
              </div>
              {opt.hint && (
                <p className="mt-1 text-[10px] leading-snug text-white/40 pl-3.5">{opt.hint}</p>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// silence unused-import warning in case the caller never uses ToolbarPill
export const _unused = ToolbarPill
