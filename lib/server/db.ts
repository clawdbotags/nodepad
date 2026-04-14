import Database from "better-sqlite3"
import path from "path"
import fs from "fs"
import os from "os"

const DB_PATH =
  process.env.NODEPAD_DB_PATH ||
  path.join(os.homedir(), ".openfang", "apps", "nodepad", "data", "nodepad.db")

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db

  // Ensure parent directory exists
  const dir = path.dirname(DB_PATH)
  fs.mkdirSync(dir, { recursive: true })

  db = new Database(DB_PATH)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      text          TEXT NOT NULL,
      content_type  TEXT NOT NULL DEFAULT 'general',
      category      TEXT,
      annotation    TEXT,
      influenced_by TEXT,
      is_unrelated  INTEGER NOT NULL DEFAULT 0,
      merge_with    TEXT,
      sources       TEXT,
      is_enriching  INTEGER NOT NULL DEFAULT 0,
      is_ghost      INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id);
  `)

  return db
}

// ── Projects ────────────────────────────────────────────────────────────────

export function listProjects() {
  const rows = getDb().prepare("SELECT * FROM projects ORDER BY created_at ASC").all() as any[]
  return rows
}

export function createProject(id: string, name: string) {
  const now = Date.now()
  getDb()
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(id, name, now, now)
  return { id, name, created_at: now, updated_at: now }
}

export function getProject(id: string) {
  return getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as any | undefined
}

export function updateProject(id: string, name: string) {
  const now = Date.now()
  getDb()
    .prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
    .run(name, now, id)
  return getProject(id)
}

export function deleteProject(id: string) {
  getDb().prepare("DELETE FROM projects WHERE id = ?").run(id)
}

// ── Notes ───────────────────────────────────────────────────────────────────

export interface NoteRow {
  id: string
  project_id: string
  text: string
  content_type: string
  category: string | null
  annotation: string | null
  influenced_by: string | null
  is_unrelated: number
  merge_with: string | null
  sources: string | null
  is_enriching: number
  is_ghost: number
  created_at: number
}

export function listNotes(projectId: string): NoteRow[] {
  return getDb()
    .prepare("SELECT * FROM notes WHERE project_id = ? ORDER BY created_at ASC")
    .all(projectId) as NoteRow[]
}

export function createNote(note: {
  id: string
  project_id: string
  text: string
  content_type?: string
  category?: string | null
  annotation?: string | null
  influenced_by?: string[] | null
  is_unrelated?: boolean
  sources?: any[] | null
  is_enriching?: boolean
  is_ghost?: boolean
  created_at?: number
}) {
  const now = note.created_at ?? Date.now()
  getDb()
    .prepare(
      `INSERT INTO notes (id, project_id, text, content_type, category, annotation, influenced_by, is_unrelated, sources, is_enriching, is_ghost, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      note.id,
      note.project_id,
      note.text,
      note.content_type ?? "general",
      note.category ?? null,
      note.annotation ?? null,
      note.influenced_by ? JSON.stringify(note.influenced_by) : null,
      note.is_unrelated ? 1 : 0,
      note.sources ? JSON.stringify(note.sources) : null,
      note.is_enriching ? 1 : 0,
      note.is_ghost ? 1 : 0,
      now
    )
  return getDb().prepare("SELECT * FROM notes WHERE id = ?").get(note.id) as NoteRow
}

export function updateNote(
  id: string,
  fields: Partial<{
    text: string
    content_type: string
    category: string | null
    annotation: string | null
    influenced_by: string[] | null
    is_unrelated: boolean
    merge_with: string | null
    sources: any[] | null
    is_enriching: boolean
    is_ghost: boolean
  }>
) {
  const sets: string[] = []
  const values: any[] = []

  if (fields.text !== undefined) {
    sets.push("text = ?")
    values.push(fields.text)
  }
  if (fields.content_type !== undefined) {
    sets.push("content_type = ?")
    values.push(fields.content_type)
  }
  if (fields.category !== undefined) {
    sets.push("category = ?")
    values.push(fields.category)
  }
  if (fields.annotation !== undefined) {
    sets.push("annotation = ?")
    values.push(fields.annotation)
  }
  if (fields.influenced_by !== undefined) {
    sets.push("influenced_by = ?")
    values.push(fields.influenced_by ? JSON.stringify(fields.influenced_by) : null)
  }
  if (fields.is_unrelated !== undefined) {
    sets.push("is_unrelated = ?")
    values.push(fields.is_unrelated ? 1 : 0)
  }
  if (fields.merge_with !== undefined) {
    sets.push("merge_with = ?")
    values.push(fields.merge_with)
  }
  if (fields.sources !== undefined) {
    sets.push("sources = ?")
    values.push(fields.sources ? JSON.stringify(fields.sources) : null)
  }
  if (fields.is_enriching !== undefined) {
    sets.push("is_enriching = ?")
    values.push(fields.is_enriching ? 1 : 0)
  }
  if (fields.is_ghost !== undefined) {
    sets.push("is_ghost = ?")
    values.push(fields.is_ghost ? 1 : 0)
  }

  if (sets.length === 0) return getDb().prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow

  values.push(id)
  getDb()
    .prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values)
  return getDb().prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow
}

export function deleteNote(id: string) {
  getDb().prepare("DELETE FROM notes WHERE id = ?").run(id)
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
