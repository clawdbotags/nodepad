# v2 MVP Decisions Log

## 2026-04-14

### Fresh rewrite over surgical strip
V1 was ~7.6k lines across tiling/kanban/graph views, ghost panel, content-type
system, ai-enrich pipeline, smart split, etc. Stripping all that while keeping
the scaffolding was higher-risk than writing a minimal v2 page.tsx from scratch.
Kept: Next.js scaffolding, sqlite setup, AES keyfile, /api/settings.
Deleted: all components/, all lib/ai-*, content-types, detect-content-type,
export, nodepad-format, initial-data, ai-settings, every view component.

### Separate DB
v2 uses `~/.openfang/apps/nodepad-v2/data/nodepad.db` to avoid touching the
running v1 on port 3033. On first run, v2 copies settings rows from the v1 DB
so the OpenRouter API key works out of the box. Keyfile is shared (v1 if
present) so encrypted settings can be decrypted.

### Canvas implementation
HTML blocks absolutely positioned + SVG overlay for connection lines. No D3,
no physics simulation. Drag = manual mousedown/mousemove/mouseup tracking on
the canvas. Positions persisted on mouseup (not during drag).

### Augment flow
Server-side endpoint `/api/sessions/:id/augment`:
1. Collects selected blocks (or all if empty selection)
2. Sends system + user prompt to OpenRouter `/chat/completions`
3. Creates new block at centroid of scope with `is_ai_generated = true`
4. Rewires external connections (one endpoint in scope) to new block
5. Drops internal connections (both endpoints in scope)
6. Deletes old blocks
7. Returns full snapshot so client can undo

### Undo
Client-side undo stack (in-memory, bounded implicitly by lifetime). Ctrl+Z
after augment: delete the new block, recreate old blocks with their original
IDs and positions, recreate original connections. Simpler than persisting an
undo log server-side. Lost on page reload — acceptable for MVP.

### Export
Markdown: `# session name`, bulleted list of blocks (with `_(AI-generated)_`
marker), optional `## Connections` section with `→` references between block
text snippets.

### Retention
`cleanupOldSessions()` called on every `GET /api/sessions`. Deletes sessions
with `updated_at < now - 2 days`. No background job needed.

### What's deliberately missing vs spec
- No "smart placement" on create — staggered grid instead of random.
- No connection labels (spec explicitly parks this).
- No visual distinction for AI blocks beyond left border (parked question).
- No crossable canvas bounds (canvas is the whole main area; no pan/zoom).
- No rename of session from UI (PATCH endpoint exists, no UI trigger).
- No delete-session button in UI (API supports it; add later).
- Entering a session's name in sidebar shows creation-timestamp string; not
  first-block snippet as the spec suggests. Parked.
