# Nodepad Development Session — 2026-04-13

Conversation between Albert (user) and Engineer (OpenFang platform agent).

## Timeline

### 04:13Z — Initial contact
Albert asked to search for the "caveman skill" for Claude Code. Found it — a token-reduction skill by Julius Brussee. Albert wanted to apply it to nodepad's LLM interaction but decided against it after learning nodepad already uses tight structured JSON output.

### 04:17Z — Nodepad discovery
Found nodepad (originally "motepad") cloned at `/tmp/nodepad`. Identified it as a spatial AI-augmented thinking tool by mskayyali. Two LLM systems: enrichment (classify + annotate notes) and ghost synthesis (emergent thesis).

### 04:29Z — Deployment
Albert asked to run nodepad with minimal maintenance. Set it up as a managed service:
- Built Next.js production bundle
- Copied to `~/.openfang/apps/nodepad/`
- Created service definition for service-daemon
- Fixed bug: daemon was running `.sh` script with Python interpreter, rewrote as `.py` wrapper
- Live on port 3033

### 05:46Z — Cost reduction
Killed 3 Gemini-based agents (watchdog-hand, rss-analyst-hand, canvas-hand) to reduce OpenRouter costs.

### 05:59Z — Nodepad usage analysis
Albert shared his nodepad canvas (speech class assignment). Two nodes:
1. Task: prepare a story for Monday's class (full Bewertungsraster/grading rubric)
2. Reflection: assessment criteria should be separate from tasks

Identified issues: everything crammed into one node, no way to distinguish criteria from tasks.

### 06:03Z — Matrix image support
Albert tried to send a screenshot but agents couldn't see Matrix images. Built image download support into the session wrapper:
- Detects image filenames in messages
- Queries Matrix room events for matching `m.image` event
- Downloads `mxc://` media via Matrix media API
- Saves to `/tmp/openfang-media/` with timestamp
- Rewrites prompt with local file path
- Works for all agents using the session wrapper

### 06:08Z — Nodepad features discovered
Found that nodepad already supports `#type` prefix for manual classification (e.g., `#definition`, `#task`). This was undocumented but built into `addBlock` in page.tsx.

### 06:17Z — Smart split feature
Albert wanted to paste multi-item text and have it split into separate notes. Built the feature:
- `lib/ai-split.ts`: LLM call to split text into discrete items
- `components/split-confirm.tsx`: confirmation modal UI
- `app/page.tsx`: detection heuristic + split/keep-single flow
- Forked repo to clawdbotags/nodepad, committed on `feature/smart-split` branch

### 06:24Z — SQLite storage brainstorming
Albert requested replacing localStorage with SQLite. Full brainstorming session:

**Questions answered:**
1. Goals: multi-device access + durability + agent access (all three)
2. Architecture: thin API layer in Next.js (Approach A, over microservice or WASM)
3. Migration: clean slate (no localStorage migration)
4. API keys: move to SQLite with encryption
5. Encryption: AES-256-GCM with auto-generated .keyfile

**Design decisions:**
- DB at `~/.openfang/apps/nodepad/data/nodepad.db` with WAL mode
- 3 tables: projects, notes, settings
- Confidence field removed (unused)
- 11 REST API endpoints
- Optimistic UI (React state + fire-and-forget API calls)
- Agents can query DB directly via sqlite3

### 06:38Z — Implementation
Design spec and implementation plan written to `docs/`. Subagent executed all 9 implementation steps:
- Installed better-sqlite3
- Created server DB module and crypto module
- Created all API routes
- Updated ai-settings.ts and page.tsx
- Build passes, deployed, verified

## Artifacts

| File | Description |
|------|-------------|
| `docs/2026-04-13-sqlite-storage-design.md` | Full design spec |
| `docs/2026-04-13-sqlite-storage-plan.md` | Step-by-step implementation plan |
| `docs/2026-04-13-conversation-log.md` | This file |
| `lib/server/db.ts` | SQLite singleton, schema, CRUD |
| `lib/server/crypto.ts` | AES-256-GCM encryption |
| `lib/ai-split.ts` | LLM-assisted note splitting |
| `components/split-confirm.tsx` | Split confirmation modal |
| `app/api/projects/route.ts` | Projects list/create |
| `app/api/projects/[id]/route.ts` | Project get/update/delete |
| `app/api/projects/[id]/notes/route.ts` | Notes list/create |
| `app/api/notes/[id]/route.ts` | Note update/delete |
| `app/api/settings/route.ts` | Settings get/put (encrypted) |

## Infrastructure Changes (outside nodepad)

- **Session wrapper** (`claude-session-wrapper.py`): Added Matrix image download support
- **Service daemon**: nodepad registered as managed service (`nodepad.py` + `nodepad.toml`)
- **Agents killed**: watchdog-hand, rss-analyst-hand, canvas-hand (Gemini/OpenRouter cost)
