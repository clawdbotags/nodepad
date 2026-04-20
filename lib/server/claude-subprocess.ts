import { spawn } from "child_process"

/**
 * Stateless one-shot invocation of Claude Code via `claude -p`.
 *
 * No --resume flag, no session file, no Matrix tool streaming — just a
 * subprocess that takes a prompt, returns the final text. Intended as a
 * third backend option for nodepad-v2 alongside Ollama/Qwen and
 * OpenRouter/OpenAI.
 *
 * Why not the Anthropic SDK? The user (Albert) explicitly wants the
 * CC subscription routed through the CLI, not a separate API key. The
 * CLI is already configured and authenticated on the host.
 *
 * Prompt is passed as the final positional arg (not via stdin) because
 * the CLI is documented for `claude -p "<prompt>"`. Arg size on Linux
 * is bounded by ARG_MAX (typically ≥ 2 MB) which is more than enough
 * for augment/drive prompts (tens of KB at worst).
 */

export interface ClaudeCodeCallOpts {
  /** Full user prompt. Stateless — no memory of prior calls. */
  prompt: string
  /** Optional system prompt injected via `--system-prompt`. */
  systemPrompt?: string
  /**
   * Model id understood by the claude CLI. Common: "sonnet", "opus",
   * "haiku", or full version like "claude-opus-4-7". Defaults to
   * whatever the settings layer passes, usually "claude-opus-4-7".
   */
  model?: string
  /** Subprocess hard timeout in ms. Default 180_000 (3 min). */
  timeoutMs?: number
  /** Override the `claude` binary path. Default $CLAUDE_CLI or "claude". */
  claudeBin?: string
}

export interface ClaudeCodeCallResult {
  /** The model's final text output (from JSON `.result`). */
  text: string
  /** Input/output token counts, when the CLI exposes them. */
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  /** Session id minted by the CLI for this one-shot. Ignored by caller. */
  sessionId?: string
  /** Raw parsed JSON, for callers that want to dig. */
  raw?: unknown
}

export class ClaudeCodeError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null = null,
    public readonly stderr: string = ""
  ) {
    super(message)
    this.name = "ClaudeCodeError"
  }
}

/**
 * Spawn `claude -p --output-format json [...] <prompt>`, wait for it to
 * exit, return the parsed `result` text.
 *
 * Always resolves via a JSON envelope (we pass `--output-format json`), so
 * any upstream auth / quota / network failure surfaces as either a non-zero
 * exit code (rejected with ClaudeCodeError) or a malformed JSON payload
 * (also rejected).
 */
export async function callClaudeCode(opts: ClaudeCodeCallOpts): Promise<ClaudeCodeCallResult> {
  const {
    prompt,
    systemPrompt,
    model = "claude-opus-4-7",
    timeoutMs = 180_000,
    claudeBin = process.env.CLAUDE_CLI || "claude",
  } = opts

  if (!prompt || typeof prompt !== "string") {
    throw new ClaudeCodeError("callClaudeCode: prompt is required")
  }

  const args: string[] = ["-p", "--output-format", "json", "--model", model]
  if (systemPrompt && systemPrompt.trim()) {
    args.push("--system-prompt", systemPrompt)
  }
  args.push(prompt)

  return new Promise<ClaudeCodeCallResult>((resolve, reject) => {
    let proc
    try {
      proc = spawn(claudeBin, args, { stdio: ["ignore", "pipe", "pipe"] })
    } catch (e: any) {
      reject(new ClaudeCodeError(`Failed to spawn ${claudeBin}: ${e?.message || e}`))
      return
    }

    let stdout = ""
    let stderr = ""
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { proc.kill("SIGKILL") } catch { /* ignore */ }
      reject(new ClaudeCodeError(`Claude Code subprocess timed out after ${timeoutMs}ms`, null, stderr))
    }, timeoutMs)

    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8") })
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8") })

    proc.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new ClaudeCodeError(`Failed to spawn ${claudeBin}: ${err.message}`, null, stderr))
    })

    proc.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (code !== 0) {
        reject(new ClaudeCodeError(
          `Claude Code exited with code ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`,
          code,
          stderr
        ))
        return
      }

      let parsed: any
      try {
        parsed = JSON.parse(stdout)
      } catch (e: any) {
        reject(new ClaudeCodeError(
          `Failed to parse Claude Code JSON output: ${e.message}\nstdout: ${stdout.slice(0, 500)}`,
          code,
          stderr
        ))
        return
      }

      const resultText = typeof parsed?.result === "string" ? parsed.result : ""
      if (!resultText && parsed?.is_error) {
        reject(new ClaudeCodeError(
          `Claude Code reported error: ${JSON.stringify(parsed).slice(0, 500)}`,
          code,
          stderr
        ))
        return
      }

      resolve({
        text: resultText,
        usage: parsed?.usage,
        sessionId: parsed?.session_id,
        raw: parsed,
      })
    })
  })
}
