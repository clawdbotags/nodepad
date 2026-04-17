import { promises as fs } from "fs"
import path from "path"
import os from "os"

/**
 * Thin Matrix client-server wrapper for the in-app chat view.
 *
 * Talks to the local homeserver at ubuntu-4gb-hel1-1:30008 using Albert's
 * personal user token (MATRIX_USER_TOKEN, read from env or ~/.openfang/.env).
 * This is the SAME token used by /api/report-issue — sending "as Albert"
 * is what routes messages through the agent binding rules in config.toml.
 *
 * Intentionally minimal: no SDK dep, no retry logic, no E2E crypto (the
 * local homeserver doesn't require it on these rooms). Timeouts / aborts
 * are handled by the caller (the sync long-poll is aborted client-side
 * when the chat view unmounts).
 */

export const MATRIX_HOMESERVER = "http://ubuntu-4gb-hel1-1:30008"
const ENV_FILE = path.join(os.homedir(), ".openfang", ".env")

let _tokenCache: string | null = null
let _userIdCache: string | null = null

export async function getMatrixUserToken(): Promise<string | null> {
  if (_tokenCache) return _tokenCache
  if (process.env.MATRIX_USER_TOKEN) {
    _tokenCache = process.env.MATRIX_USER_TOKEN
    return _tokenCache
  }
  try {
    const text = await fs.readFile(ENV_FILE, "utf8")
    for (const line of text.split("\n")) {
      const m = /^\s*MATRIX_USER_TOKEN\s*=\s*(.+?)\s*$/.exec(line)
      if (m) {
        _tokenCache = m[1].replace(/^['"]|['"]$/g, "")
        return _tokenCache
      }
    }
  } catch {
    // .env not readable
  }
  return null
}

export async function matrixFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  const token = await getMatrixUserToken()
  if (!token) throw new Error("MATRIX_USER_TOKEN not configured")
  const url = `${MATRIX_HOMESERVER}${pathname}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(init.headers as Record<string, string> | undefined),
  }
  if (init.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json"
  return fetch(url, { ...init, headers })
}

export async function getMatrixUserId(): Promise<string | null> {
  if (_userIdCache) return _userIdCache
  try {
    const res = await matrixFetch("/_matrix/client/r0/account/whoami")
    if (!res.ok) return null
    const data = await res.json()
    _userIdCache = data.user_id || null
    return _userIdCache
  } catch {
    return null
  }
}

// Filter passed to /sync so we only get what we render — no presence, no
// typing, no receipts, no account_data. Cuts payload by ~80% on a busy
// account. timeline.limit is how many history events to hydrate on first
// sync; subsequent syncs only carry new events.
export const SYNC_FILTER = {
  room: {
    timeline: {
      limit: 30,
      types: ["m.room.message", "m.room.encrypted"],
    },
    state: {
      types: ["m.room.name", "m.room.canonical_alias", "m.room.avatar", "m.room.topic"],
    },
    ephemeral: { not_types: ["*"] },
    account_data: { not_types: ["*"] },
  },
  presence: { not_types: ["*"] },
  account_data: { not_types: ["*"] },
}
