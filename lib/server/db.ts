import Database from "better-sqlite3"
import path from "path"
import fs from "fs"
import os from "os"

const DB_PATH =
  process.env.NODEPAD_DB_PATH ||
  path.join(os.homedir(), ".openfang", "apps", "nodepad-v2", "data", "nodepad.db")

const V1_DB_PATH = path.join(os.homedir(), ".openfang", "apps", "nodepad", "data", "nodepad.db")

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db

  const dir = path.dirname(DB_PATH)
  fs.mkdirSync(dir, { recursive: true })

  db = new Database(DB_PATH)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id               TEXT PRIMARY KEY,
      session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      text             TEXT NOT NULL,
      x                REAL NOT NULL DEFAULT 0,
      y                REAL NOT NULL DEFAULT 0,
      is_ai_generated  INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connections (
      id             TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      from_block_id  TEXT NOT NULL,
      to_block_id    TEXT NOT NULL,
      created_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(session_id);
    CREATE INDEX IF NOT EXISTS idx_connections_session ON connections(session_id);
  `)

  // One-time import of settings from v1 DB (so augment works out of the box)
  try {
    const row = db.prepare("SELECT COUNT(*) as c FROM settings").get() as any
    if (row && row.c === 0 && fs.existsSync(V1_DB_PATH)) {
      const v1 = new Database(V1_DB_PATH, { readonly: true })
      const settings = v1.prepare("SELECT key, value FROM settings").all() as any[]
      const ins = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
      for (const s of settings) ins.run(s.key, s.value)
      v1.close()
    }
  } catch (e) {
    // non-fatal
    console.warn("v1 settings import skipped:", (e as Error).message)
  }

  return db
}

// ── Sessions ────────────────────────────────────────────────────────────────

export interface SessionRow {
  id: string
  name: string
  created_at: number
  updated_at: number
}

export function listSessions(): SessionRow[] {
  return getDb().prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as SessionRow[]
}

export function createSession(id: string, name: string): SessionRow {
  const now = Date.now()
  getDb()
    .prepare("INSERT INTO sessions (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(id, name, now, now)
  return { id, name, created_at: now, updated_at: now }
}

export function getSession(id: string) {
  return getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined
}

export function updateSession(id: string, name?: string) {
  const now = Date.now()
  if (name !== undefined) {
    getDb().prepare("UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?").run(name, now, id)
  } else {
    getDb().prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, id)
  }
  return getSession(id)
}

export function deleteSession(id: string) {
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id)
}

export function cleanupOldSessions(ageMs: number = 2 * 24 * 60 * 60 * 1000): number {
  const threshold = Date.now() - ageMs
  const res = getDb().prepare("DELETE FROM sessions WHERE updated_at < ?").run(threshold)
  return res.changes || 0
}

// ── Notes ───────────────────────────────────────────────────────────────────

export interface NoteRow {
  id: string
  session_id: string
  text: string
  x: number
  y: number
  is_ai_generated: number
  created_at: number
  updated_at: number
}

export function listNotes(sessionId: string): NoteRow[] {
  return getDb()
    .prepare("SELECT * FROM notes WHERE session_id = ? ORDER BY created_at ASC")
    .all(sessionId) as NoteRow[]
}

export function createNote(note: {
  id: string
  session_id: string
  text: string
  x?: number
  y?: number
  is_ai_generated?: boolean
}): NoteRow {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO notes (id, session_id, text, x, y, is_ai_generated, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      note.id,
      note.session_id,
      note.text,
      note.x ?? 0,
      note.y ?? 0,
      note.is_ai_generated ? 1 : 0,
      now,
      now
    )
  updateSession(note.session_id)
  return getDb().prepare("SELECT * FROM notes WHERE id = ?").get(note.id) as NoteRow
}

export function updateNote(
  id: string,
  fields: Partial<{ text: string; x: number; y: number; is_ai_generated: boolean }>
): NoteRow | undefined {
  const sets: string[] = []
  const values: any[] = []
  if (fields.text !== undefined) { sets.push("text = ?"); values.push(fields.text) }
  if (fields.x !== undefined) { sets.push("x = ?"); values.push(fields.x) }
  if (fields.y !== undefined) { sets.push("y = ?"); values.push(fields.y) }
  if (fields.is_ai_generated !== undefined) { sets.push("is_ai_generated = ?"); values.push(fields.is_ai_generated ? 1 : 0) }
  sets.push("updated_at = ?"); values.push(Date.now())

  values.push(id)
  getDb().prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`).run(...values)
  const row = getDb().prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined
  if (row) updateSession(row.session_id)
  return row
}

export function deleteNote(id: string) {
  const row = getDb().prepare("SELECT session_id FROM notes WHERE id = ?").get(id) as any
  getDb().prepare("DELETE FROM notes WHERE id = ?").run(id)
  // Remove any connections involving this note
  getDb().prepare("DELETE FROM connections WHERE from_block_id = ? OR to_block_id = ?").run(id, id)
  if (row) updateSession(row.session_id)
}

// ── Connections ─────────────────────────────────────────────────────────────

export interface ConnectionRow {
  id: string
  session_id: string
  from_block_id: string
  to_block_id: string
  created_at: number
}

export function listConnections(sessionId: string): ConnectionRow[] {
  return getDb()
    .prepare("SELECT * FROM connections WHERE session_id = ? ORDER BY created_at ASC")
    .all(sessionId) as ConnectionRow[]
}

export function createConnection(conn: {
  id: string
  session_id: string
  from_block_id: string
  to_block_id: string
}): ConnectionRow {
  const now = Date.now()
  getDb()
    .prepare("INSERT INTO connections (id, session_id, from_block_id, to_block_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(conn.id, conn.session_id, conn.from_block_id, conn.to_block_id, now)
  updateSession(conn.session_id)
  return getDb().prepare("SELECT * FROM connections WHERE id = ?").get(conn.id) as ConnectionRow
}

export function deleteConnection(id: string) {
  const row = getDb().prepare("SELECT session_id FROM connections WHERE id = ?").get(id) as any
  getDb().prepare("DELETE FROM connections WHERE id = ?").run(id)
  if (row) updateSession(row.session_id)
}

export function deleteConnectionsForSession(sessionId: string, ids: string[]) {
  if (ids.length === 0) return
  const placeholders = ids.map(() => "?").join(",")
  getDb().prepare(`DELETE FROM connections WHERE session_id = ? AND id IN (${placeholders})`).run(sessionId, ...ids)
  updateSession(sessionId)
}

// ── Settings ────────────────────────────────────────────────────────────────

export function getSettings(): { key: string; value: string }[] {
  return getDb().prepare("SELECT * FROM settings").all() as { key: string; value: string }[]
}

export function upsertSetting(key: string, value: string) {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value)
}
