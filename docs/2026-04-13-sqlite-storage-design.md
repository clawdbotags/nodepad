# Nodepad SQLite Storage Migration — Design Spec

**Date:** 2026-04-13
**Author:** engineer (OpenFang platform agent)
**Status:** Approved
**Branch:** feature/smart-split (clawdbotags/nodepad)

## Summary

Replace nodepad's browser localStorage persistence with a server-side SQLite database. This enables multi-device access (phone + laptop hit the same server), data durability across browser clears, and programmatic agent access to notes via direct DB queries.

## Goals

1. **Multi-device access** — any browser connecting to the nodepad server sees the same data
2. **Durability** — data survives browser clears, incognito mode, different browsers
3. **Agent access** — OpenFang agents can read/write nodepad data via sqlite3 CLI or the REST API

## Non-Goals

- Offline-first / WASM SQLite in the browser
- User authentication (single-user, local deployment)
- Migration of existing localStorage data (clean slate)

## Architecture

### Database

- **Engine:** SQLite via `better-sqlite3` npm package
- **Location:** `~/.openfang/apps/nodepad/data/nodepad.db`
- **Journal mode:** WAL (Write-Ahead Logging) for concurrent read/write safety
- **Env override:** `NODEPAD_DB_PATH` environment variable

### Schema

```sql
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
  influenced_by TEXT,          -- JSON array of note IDs
  is_unrelated  INTEGER NOT NULL DEFAULT 0,
  merge_with    TEXT,
  sources       TEXT,          -- JSON array of {url, title, siteName}
  is_enriching  INTEGER NOT NULL DEFAULT 0,
  is_ghost      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL           -- encrypted for sensitive keys
);

CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id);
```

### API Routes

All Next.js API routes under `/api/`. JSON request/response bodies.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List all projects |
| POST | `/api/projects` | Create project `{name}` |
| GET | `/api/projects/[id]` | Get project with all notes |
| PUT | `/api/projects/[id]` | Update project `{name}` |
| DELETE | `/api/projects/[id]` | Delete project + cascade notes |
| GET | `/api/projects/[id]/notes` | List notes for project |
| POST | `/api/projects/[id]/notes` | Create note `{text, content_type?, ...}` |
| PUT | `/api/notes/[id]` | Update note (enrichment, edits) |
| DELETE | `/api/notes/[id]` | Delete note |
| GET | `/api/settings` | Get all settings (decrypts sensitive) |
| PUT | `/api/settings` | Upsert setting `{key, value}` |

### Encryption

Server-only module `lib/server/crypto.ts`:

- **Algorithm:** AES-256-GCM
- **Key storage:** `~/.openfang/apps/nodepad/data/.keyfile` (32 random bytes, `0600` permissions)
- **Auto-generated** on first API call if missing
- **Format:** `iv:ciphertext:authTag` (hex-encoded, `:` delimited)
- **Scope:** Only applied to settings where `key` contains `apiKey`, `token`, or `key` (case-insensitive)
- **Non-sensitive settings** (model ID, provider, webGrounding) stored plaintext

### Client-Side Changes

**Removed:**
- All `localStorage.getItem/setItem` calls for `nodepad-projects`, `nodepad-active-project`, `nodepad-backup`
- Rolling backup logic (SQLite + WAL is the durability layer)

**Replaced with:**
- `GET /api/projects` on mount for initial load
- `POST /api/projects/[id]/notes` from `addBlock`
- `PUT /api/notes/[id]` from `editBlock` and enrichment completion
- `DELETE /api/notes/[id]` from `deleteBlock`
- Project CRUD calls for create/rename/delete
- `GET/PUT /api/settings` from the settings panel

**Kept in localStorage:**
- `nodepad-intro-seen` (one-off UI flag)
- Collapsed note IDs (view state, per-browser)

**State management:** React useState still holds projects/notes for rendering. API calls are fire-and-forget side effects alongside state updates (optimistic UI).

### Server DB Module

`lib/server/db.ts` — singleton pattern:

- Lazy-initialized on first call
- Auto-creates `~/.openfang/apps/nodepad/data/` directory if missing
- Runs `CREATE TABLE IF NOT EXISTS` on init
- Enables WAL mode and foreign keys
- Exports prepared-statement wrapper functions for all CRUD operations
- Server-only (never bundled to client)

### Agent Access

Agents can query the database directly:

```bash
sqlite3 ~/.openfang/apps/nodepad/data/nodepad.db "SELECT text, content_type, category FROM notes WHERE project_id = 'xxx'"
```

Or use the REST API:

```bash
curl http://localhost:3033/api/projects
curl http://localhost:3033/api/projects/<id>/notes
```

Settings with encrypted values require the API (which handles decryption). Direct DB reads of settings return encrypted blobs for sensitive keys.

### Error Handling

- API routes return appropriate HTTP status codes (400, 404, 500)
- DB initialization failures log to stderr and return 500
- Missing keyfile is auto-generated (not an error)
- Client fetch failures are caught and logged to console (UI continues with stale state)

### File Structure (new files)

```
lib/server/db.ts          — SQLite singleton, schema, CRUD functions
lib/server/crypto.ts      — AES-256-GCM encrypt/decrypt, keyfile management
app/api/projects/route.ts — GET (list), POST (create)
app/api/projects/[id]/route.ts — GET, PUT, DELETE
app/api/projects/[id]/notes/route.ts — GET (list), POST (create)
app/api/notes/[id]/route.ts — PUT, DELETE
app/api/settings/route.ts — GET, PUT
```

### Testing

- Build verification: `npm run build` must pass
- Manual testing: create project, add notes, refresh browser, verify persistence
- Agent access: `sqlite3` query against the DB file
- Encryption: verify settings API returns decrypted values, raw DB shows encrypted blobs
