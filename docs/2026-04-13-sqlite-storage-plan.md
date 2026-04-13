# Nodepad SQLite Storage — Implementation Plan

**Date:** 2026-04-13
**Spec:** `docs/2026-04-13-sqlite-storage-design.md`
**Branch:** feature/smart-split (clawdbotags/nodepad)

## Step 1: Add Dependencies

Install `better-sqlite3` and its TypeScript types.

```bash
cd /tmp/nodepad-fork && npm install better-sqlite3 && npm install -D @types/better-sqlite3
```

**Verification:** `npm ls better-sqlite3` shows the package.

---

## Step 2: Create Server DB Module

File: `lib/server/db.ts`

- Import `better-sqlite3`
- Resolve DB path from `NODEPAD_DB_PATH` env or default `~/.openfang/apps/nodepad/data/nodepad.db`
- Auto-create parent directory
- Open DB, enable WAL mode, enable foreign keys
- Run CREATE TABLE IF NOT EXISTS for all three tables (projects, notes, settings) + index
- Export singleton `getDb()` function
- Export CRUD helper functions:
  - `listProjects()`, `createProject(id, name)`, `getProject(id)`, `updateProject(id, name)`, `deleteProject(id)`
  - `listNotes(projectId)`, `createNote(note)`, `updateNote(id, fields)`, `deleteNote(id)`
  - `getSettings()`, `upsertSetting(key, value)`

**Verification:** Import in a test script, call `getDb()`, verify tables exist.

---

## Step 3: Create Encryption Module

File: `lib/server/crypto.ts`

- Keyfile path: `~/.openfang/apps/nodepad/data/.keyfile`
- `getOrCreateKey()`: read keyfile or generate 32 random bytes, write with mode 0o600
- `encrypt(plaintext: string): string` — AES-256-GCM, random 12-byte IV, return `iv:ciphertext:tag` hex
- `decrypt(blob: string): string` — split on `:`, decrypt
- `isSensitiveKey(key: string): boolean` — true if key matches apiKey/token/key pattern

**Verification:** Encrypt a test string, decrypt it, verify roundtrip.

---

## Step 4: Create API Routes

### 4a: Projects routes

File: `app/api/projects/route.ts`
- GET: `listProjects()` → JSON array
- POST: body `{name}`, generate ID, `createProject()` → JSON object

File: `app/api/projects/[id]/route.ts`
- GET: `getProject(id)` + `listNotes(id)` → JSON with notes array
- PUT: body `{name}`, `updateProject()` → JSON
- DELETE: `deleteProject(id)` → 204

### 4b: Notes routes

File: `app/api/projects/[id]/notes/route.ts`
- GET: `listNotes(projectId)` → JSON array
- POST: body with note fields, `createNote()` → JSON

File: `app/api/notes/[id]/route.ts`
- PUT: body with partial fields, `updateNote()` → JSON
- DELETE: `deleteNote(id)` → 204

### 4c: Settings routes

File: `app/api/settings/route.ts`
- GET: `getSettings()`, decrypt sensitive values → JSON object
- PUT: body `{key, value}`, encrypt if sensitive, `upsertSetting()` → JSON

**Verification:** `curl` each endpoint after build.

---

## Step 5: Update Client — Settings

File: `lib/ai-settings.ts`

- Replace `localStorage.getItem(STORAGE_KEY)` with `fetch('/api/settings')` 
- Replace `localStorage.setItem(STORAGE_KEY, ...)` with `fetch('/api/settings', {method: 'PUT', body: ...})`
- `loadSettings()` becomes async, returns cached values synchronously after first fetch
- `useAISettings` hook: fetch settings on mount, cache in state, update via API
- `loadAIConfig()` needs to work synchronously for enrichment calls — use a module-level cache populated by the hook

**Verification:** Open settings panel, set API key, refresh browser, key persists.

---

## Step 6: Update Client — Project & Note Persistence

File: `app/page.tsx`

### 6a: Initial load (replace localStorage read)
- Replace the `useEffect` at line ~137 that reads `nodepad-projects` from localStorage
- Fetch `GET /api/projects`, then `GET /api/projects/[id]` for the first/active project
- Set state from API response
- If no projects exist, create default project via `POST /api/projects`

### 6b: Save on change (replace localStorage write)
- Remove the `useEffect` at line ~206 that writes to localStorage
- Remove the backup `useEffect` at line ~214

### 6c: Individual mutations
- `addBlock`: after updating state, `POST /api/projects/[id]/notes` with the new note
- `editBlock`: after updating state, `PUT /api/notes/[id]` with new text
- `deleteBlock`: after updating state, `DELETE /api/notes/[id]`
- `enrichBlock` completion: already calls back to update state — add `PUT /api/notes/[id]` with enrichment fields
- Project create/rename/delete: corresponding API calls

### 6d: Ghost notes
- Ghost synthesis results: `POST /api/projects/[id]/notes` with `is_ghost: 1`
- Ghost dismissal: `DELETE /api/notes/[id]`
- Ghost solidify (to thesis): `PUT /api/notes/[id]` setting `is_ghost: 0, content_type: 'thesis'`

**Verification:** Add notes, refresh browser, notes persist. Delete note, refresh, gone.

---

## Step 7: Update next.config.mjs

Add `better-sqlite3` to `serverComponentsExternalPackages` (Next.js needs this for native modules):

```js
experimental: {
  serverComponentsExternalPackages: ['better-sqlite3'],
}
```

Or the equivalent for Next.js 16 (`serverExternalPackages`).

**Verification:** `npm run build` passes.

---

## Step 8: Build and Deploy

```bash
cd /tmp/nodepad-fork && npm run build
cp -r /tmp/nodepad-fork/{.next,node_modules,package.json,next.config.mjs,public,lib,app,components,proxy.ts,tsconfig.json,components.json,postcss.config.mjs} ~/.openfang/apps/nodepad/
```

Service daemon auto-restarts nodepad.

**Verification:** `curl http://localhost:3033/api/projects` returns `[]` or default project.

---

## Step 9: Commit and Push

```bash
cd /tmp/nodepad-fork
git add -A
git commit -m "feat: SQLite storage backend replacing localStorage

- lib/server/db.ts: SQLite singleton with WAL mode, schema, CRUD
- lib/server/crypto.ts: AES-256-GCM encryption for API keys
- API routes: projects, notes, settings (11 endpoints)
- Client: fetch-based persistence replacing localStorage
- No migration from localStorage (clean slate)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
git push
```

---

## Execution Order

Steps 1-3 are independent infrastructure (can be done in parallel).
Steps 4a-4c depend on steps 2-3.
Step 5 depends on step 4c.
Step 6 depends on steps 4a-4b.
Step 7 is independent but needed before step 8.
Steps 8-9 are sequential, after everything else.
