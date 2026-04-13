"use client"

import { useState, useEffect, useCallback } from "react"

export interface AIModel {
  id: string
  label: string
  shortLabel: string
  description: string
  supportsGrounding: boolean
  /** For OpenAI models: the search-preview variant to use when grounding is enabled */
  groundingModelId?: string
}

export type AIProvider = "openrouter" | "openai" | "zai"

export interface AIProviderPreset {
  id: AIProvider
  label: string
  baseUrl: string
  keyUrl: string
  keyPlaceholder: string
}

export const AI_PROVIDER_PRESETS: AIProviderPreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyPlaceholder: "sk-or-v1-...",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-...",
  },
  {
    id: "zai",
    label: "Z.ai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    keyPlaceholder: "Your Z.ai API key",
  },
]

export function getPreset(provider: AIProvider): AIProviderPreset {
  return AI_PROVIDER_PRESETS.find(p => p.id === provider) || AI_PROVIDER_PRESETS[0]
}

export const AI_MODELS: AIModel[] = [
  {
    id: "anthropic/claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    shortLabel: "Claude",
    description: "Best reasoning & annotation quality",
    supportsGrounding: false,
  },
  {
    id: "openai/gpt-4o",
    label: "GPT-4o",
    shortLabel: "GPT-4o",
    description: "Strong structured output, broad knowledge",
    supportsGrounding: true,
  },
  {
    id: "google/gemini-2.5-pro-preview-03-25",
    label: "Gemini 2.5 Pro",
    shortLabel: "Gemini",
    description: "Long-context, web grounding available",
    supportsGrounding: true,
  },
  {
    id: "deepseek/deepseek-chat",
    label: "DeepSeek V3",
    shortLabel: "DeepSeek",
    description: "Cost-efficient frontier model",
    supportsGrounding: false,
  },
  {
    id: "mistralai/mistral-small-3.2-24b-instruct",
    label: "Mistral Small 3.2",
    shortLabel: "Mistral",
    description: "Fast, excellent structured outputs",
    supportsGrounding: false,
  },
  // -- Free tier (no credits required, ~200 req/day limit) --------------------
  {
    id: "nvidia/nemotron-3-nano-30b-a3b:free",
    label: "Nemotron 30B - Free",
    shortLabel: "Nemotron",
    description: "Free - no credits - ~200 req/day - Nvidia-hosted",
    supportsGrounding: false,
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    label: "Nemotron 120B - Free",
    shortLabel: "Nemotron",
    description: "Free - no credits - ~200 req/day - Nvidia-hosted - MoE",
    supportsGrounding: false,
  },
]

export const OPENAI_MODELS: AIModel[] = [
  {
    id: "gpt-4o",
    label: "GPT-4o",
    shortLabel: "GPT-4o",
    description: "Strong structured output, broad knowledge",
    supportsGrounding: true,
    groundingModelId: "gpt-4o-search-preview",
  },
  {
    id: "gpt-4o-mini",
    label: "GPT-4o Mini",
    shortLabel: "GPT-4o Mini",
    description: "Fast and capable, web grounding available",
    supportsGrounding: true,
    groundingModelId: "gpt-4o-mini-search-preview",
  },
  {
    id: "gpt-4.1",
    label: "GPT-4.1",
    shortLabel: "GPT-4.1",
    description: "Latest GPT-4, improved instruction following",
    supportsGrounding: false,
  },
  {
    id: "gpt-4.1-mini",
    label: "GPT-4.1 Mini",
    shortLabel: "GPT-4.1 Mini",
    description: "Fast and capable, good balance",
    supportsGrounding: false,
  },
  {
    id: "o4-mini",
    label: "o4-mini",
    shortLabel: "o4-mini",
    description: "Fast reasoning model",
    supportsGrounding: false,
  },
]

export const ZAI_MODELS: AIModel[] = [
  {
    id: "glm-4.5",
    label: "GLM-4.5",
    shortLabel: "GLM-4.5",
    description: "Fast, cost-efficient Z.ai model",
    supportsGrounding: false,
  },
  {
    id: "glm-4.7",
    label: "GLM-4.7",
    shortLabel: "GLM-4.7",
    description: "Strong reasoning, 200K context",
    supportsGrounding: false,
  },
  {
    id: "glm-5",
    label: "GLM-5",
    shortLabel: "GLM-5",
    description: "Z.ai flagship model",
    supportsGrounding: false,
  },
  {
    id: "glm-5-turbo",
    label: "GLM-5 Turbo",
    shortLabel: "GLM-5 Turbo",
    description: "Fast, capable, community tested",
    supportsGrounding: false,
  },
]

export function getModelsForProvider(provider: AIProvider): AIModel[] {
  if (provider === "openai") return OPENAI_MODELS
  if (provider === "zai")    return ZAI_MODELS
  return AI_MODELS // openrouter + safe fallback for any stale localStorage value
}

export const DEFAULT_MODEL_ID = "openai/gpt-4o"
export const DEFAULT_PROVIDER: AIProvider = "openrouter"

export interface AISettings {
  apiKey: string
  modelId: string
  webGrounding: boolean
  provider: AIProvider
  customBaseUrl: string
  /** Per-provider key store so switching back to a provider restores its key */
  providerKeys?: Partial<Record<AIProvider, string>>
}

// ── Module-level cache for synchronous access (populated by useAISettings hook) ──

let _settingsCache: AISettings = {
  apiKey: "",
  modelId: DEFAULT_MODEL_ID,
  webGrounding: false,
  provider: DEFAULT_PROVIDER,
  customBaseUrl: "",
}

/** Synchronous settings read from module cache. Returns defaults until first fetch completes. */
function loadSettings(): AISettings {
  return { ..._settingsCache }
}

export interface AIConfig {
  apiKey: string
  modelId: string
  supportsGrounding: boolean
  provider: AIProvider
  customBaseUrl: string
}

export function loadAIConfig(): AIConfig | null {
  const s = loadSettings()
  if (!s.apiKey) return null
  const models = getModelsForProvider(s.provider)
  const model = models.find(m => m.id === s.modelId)
  const modelId = model?.id ?? models[0]?.id ?? s.modelId ?? DEFAULT_MODEL_ID
  const supportsGrounding =
    (s.provider === "openrouter" || s.provider === "openai") &&
    s.webGrounding &&
    (model?.supportsGrounding ?? false)
  return { apiKey: s.apiKey, modelId, supportsGrounding, provider: s.provider, customBaseUrl: s.customBaseUrl }
}

export function getBaseUrl(config: AIConfig): string {
  return getPreset(config.provider).baseUrl
}

export function getProviderHeaders(config: AIConfig): Record<string, string> {
  const base: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${config.apiKey}`,
  }
  if (config.provider === "openrouter") {
    base["HTTP-Referer"] = "https://nodepad.space"
    base["X-Title"] = "nodepad"
  }
  return base
}

/** @deprecated Use loadAIConfig() for direct browser -> provider calls.
 *  Kept for any remaining server-route usage during transition. */
export function getAIHeaders(): Record<string, string> {
  const config = loadAIConfig()
  if (!config) return {}
  const models = getModelsForProvider(config.provider)
  const model = models.find(m => m.id === config.modelId) || AI_MODELS.find(m => m.id === DEFAULT_MODEL_ID)!
  return {
    "x-or-key": config.apiKey,
    "x-or-model": config.modelId,
    "x-or-supports-grounding": model.supportsGrounding ? "true" : "false",
  }
}

// ── Helper: fetch settings from API and populate module cache ────────────────

async function fetchSettingsFromAPI(): Promise<AISettings> {
  try {
    const res = await fetch("/api/settings")
    if (!res.ok) throw new Error(`Settings API returned ${res.status}`)
    const data = await res.json()

    const settings: AISettings = {
      apiKey: data.apiKey ?? "",
      modelId: data.modelId ?? DEFAULT_MODEL_ID,
      webGrounding: data.webGrounding === "true" || data.webGrounding === true,
      provider: (data.provider as AIProvider) ?? DEFAULT_PROVIDER,
      customBaseUrl: data.customBaseUrl ?? "",
      providerKeys: data.providerKeys ? JSON.parse(data.providerKeys) : undefined,
    }

    // Update module-level cache so synchronous loadAIConfig() stays fresh
    _settingsCache = settings
    return settings
  } catch (e) {
    console.error("Failed to fetch settings from API:", e)
    return { ..._settingsCache }
  }
}

async function saveSettingToAPI(key: string, value: string): Promise<void> {
  try {
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    })
  } catch (e) {
    console.error("Failed to save setting:", key, e)
  }
}

async function persistAllSettings(settings: AISettings): Promise<void> {
  const entries: [string, string][] = [
    ["apiKey", settings.apiKey],
    ["modelId", settings.modelId],
    ["webGrounding", String(settings.webGrounding)],
    ["provider", settings.provider],
    ["customBaseUrl", settings.customBaseUrl],
  ]
  if (settings.providerKeys) {
    entries.push(["providerKeys", JSON.stringify(settings.providerKeys)])
  }
  await Promise.all(entries.map(([k, v]) => saveSettingToAPI(k, v)))
}

export function useAISettings() {
  const [settings, setSettings] = useState<AISettings>({
    apiKey: "", modelId: DEFAULT_MODEL_ID, webGrounding: false,
    provider: DEFAULT_PROVIDER, customBaseUrl: "",
  })
  const [isHydrated, setIsHydrated] = useState(false)

  useEffect(() => {
    fetchSettingsFromAPI().then(s => {
      setSettings(s)
      setIsHydrated(true)
    })
  }, [])

  const updateSettings = useCallback((patch: Partial<AISettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch }
      // Update module-level cache immediately for synchronous consumers
      _settingsCache = next
      // Persist to API (fire-and-forget)
      persistAllSettings(next)
      return next
    })
  }, [])

  const models = getModelsForProvider(settings.provider)

  const resolvedModelId = (() => {
    const model = models.find(m => m.id === settings.modelId) || models[0]
    if (!model) return settings.modelId
    if (settings.provider === "openrouter" && settings.webGrounding && model.supportsGrounding) {
      return `${model.id}:online`
    }
    return model.id
  })()

  const currentModel: AIModel = models.find(m => m.id === settings.modelId) || models[0] || {
    id: settings.modelId,
    label: settings.modelId,
    shortLabel: settings.modelId.split("/").pop() || settings.modelId,
    description: "Custom model",
    supportsGrounding: false,
  }

  return { settings, updateSettings, resolvedModelId, currentModel, models, isHydrated }
}
