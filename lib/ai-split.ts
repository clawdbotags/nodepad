"use client"

import { loadAIConfig, getBaseUrl, getProviderHeaders } from "@/lib/ai-settings"
import { parseProviderError } from "@/lib/ai-enrich"

export interface SplitResult {
  items: string[]
}

const SPLIT_SYSTEM_PROMPT = `You are a text splitter for a spatial thinking tool called nodepad.

## Your Job
The user will paste a block of text that contains multiple discrete items (e.g. grading criteria, a list of requirements, multiple ideas, bullet points, numbered lists, or mixed content). Your job is to split it into individual, self-contained items.

## Rules
- Each item should be a single, complete thought or requirement.
- Preserve the original language — do not translate, rephrase, or summarize.
- Remove list markers (bullets, numbers, dashes) but keep the content intact.
- If an item has a label/heading and description, keep them together as one item.
- If the text is already a single item with no logical splits, return it as-is in a one-element array.
- Do NOT add any content that wasn't in the original text.
- Return valid JSON only.`

const SPLIT_JSON_SCHEMA = {
  name: "split_result",
  strict: true,
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "string" },
        description: "Array of individual text items extracted from the input",
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
}

export async function splitTextClient(text: string): Promise<string[]> {
  const config = loadAIConfig()
  if (!config) throw new Error("No API key configured")

  const model = config.modelId
  const supportsJsonSchema = config.provider === "openrouter" || config.provider === "openai"

  const schemaHint = !supportsJsonSchema
    ? `\n\n## Output Format — CRITICAL\nYou MUST respond with a single JSON object (no markdown, no explanation). Schema:\n${JSON.stringify(SPLIT_JSON_SCHEMA.schema, null, 2)}`
    : ""

  const systemPrompt = SPLIT_SYSTEM_PROMPT + schemaHint

  const baseUrl = getBaseUrl(config)
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: getProviderHeaders(config),
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Split this text into individual items:\n\n${text}` },
      ],
      response_format: supportsJsonSchema
        ? { type: "json_schema", json_schema: SPLIT_JSON_SCHEMA }
        : { type: "json_object" },
      temperature: 0.0,
    }),
  })

  if (!response.ok) {
    throw new Error(await parseProviderError(response))
  }

  let data: Record<string, unknown>
  try {
    data = await response.json()
  } catch {
    throw new Error("AI split error: response was not valid JSON.")
  }

  const content = (data.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content
  if (!content) throw new Error("No content in AI split response")

  try {
    const parsed = JSON.parse(content) as SplitResult
    return parsed.items.filter(item => item.trim().length > 0)
  } catch {
    // Try regex fallback
    const itemsMatch = content.match(/"items"\s*:\s*\[([\s\S]*?)\]/)
    if (itemsMatch) {
      const items = itemsMatch[1].match(/"((?:[^"\\]|\\.)*)"/g)
      if (items) {
        return items
          .map(s => s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n").trim())
          .filter(s => s.length > 0)
      }
    }
    throw new Error("Could not parse split response")
  }
}
