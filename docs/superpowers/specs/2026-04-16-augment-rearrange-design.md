# Augment "Rearrange" Mode — Design Spec

**Date:** 2026-04-16
**Status:** Approved for implementation planning
**Author:** Engineer (with Albert)

## Summary

A third augment mode, "Rearrange", that lets a vision-capable LLM look at the current canvas as an image and produce new spatial positions for the existing blocks (plus optional connection edits). Block text is never modified. The mode is exposed as a checkbox in the augment dialog, mutually exclusive with "Structured", and runs against `google/gemini-3-flash` by default for cost/latency reasons.

## Goals

- Give the LLM real spatial context (a screenshot of the canvas) so it can produce placements that respect the existing layout instead of dumping into a 4-col grid.
- Let users phrase placement intent in natural language ("spread these as a left-to-right timeline", "branch off the top idea", "group similar topics") and get a layout that actually reflects it.
- Keep the change scoped: no new layout engines, no new primitives, no new view modes. Reuse the existing augment endpoint, dialog, and undo machinery.

## Non-goals

- No predefined layout types (tree / flow / cluster as enums). The LLM picks freely; the client only enforces non-overlap.
- No editing of block text. Block creation/deletion belongs to Default and Structured modes.
- No multi-step "agent" loops. One LLM call per Rearrange action.
- No live preview. Result lands when the call returns; user undoes with Ctrl-Z if they don't like it.
- No support for text-only models in Rearrange. If the configured model can't accept images, the call errors with a clear message pointing to settings.

## UX

The augment dialog (`app/page.tsx`, around line 1480) currently has one checkbox: "Structured output — multiple blocks + connections". Add a second checkbox immediately below it:

> ☐ **Rearrange** — let AI move blocks into a new spatial layout (vision)

Rules:

- The two checkboxes are mutually exclusive. Selecting one unchecks the other.
- When Rearrange is checked, the dialog title changes from "Augment …" to "Rearrange …" so the user knows the call won't change text.
- The submit button label changes from "Augment" to "Rearrange" when checked.
- When Rearrange is checked and the configured model is text-only, show an inline warning under the checkbox: *"Current model can't see images. Switch to a vision-capable model in settings."* — and disable the submit button.

Scope behavior matches existing augment: with no selection, scope = whole canvas; with selection, scope = selected blocks only. Connections to/from out-of-scope blocks are preserved (only positions and within-scope connections may change).

## Architecture

### Request flow (client)

1. User opens the augment dialog, types an instruction, checks "Rearrange", presses submit.
2. Client renders the visible canvas (or full canvas bounding box, whichever is larger) to a PNG via the **canvas snapshot pipeline** (see below).
3. Client computes a normalized coordinate frame that exactly matches the snapshot: each in-scope block's `(x, y, w, h)` is rescaled to a 0–1000 coordinate space using the snapshot's bounding box.
4. Client POSTs to `/api/sessions/:id/augment` with:

   ```json
   {
     "mode": "rearrange",
     "prompt": "user's instruction text",
     "block_ids": ["abc123", "def456", ...],
     "image_data_url": "data:image/png;base64,...",
     "frame": { "min_x": 100, "min_y": 200, "max_x": 1500, "max_y": 1100 },
     "blocks_in_frame": [
       { "id": "abc123", "text": "...", "x": 130, "y": 240, "w": 120, "h": 60 }
     ]
   }
   ```

   `blocks_in_frame[*].x|y|w|h` are already in the 0–1000 normalized coordinate system that matches the image. The LLM never sees canvas pixels.

5. Server calls the LLM, returns `{moves, new_connections, removed_connection_ids, snapshot}`.
6. Client converts each `moves[*].x|y` from 0–1000 back to canvas pixels using the same `frame`, runs the **collision resolver**, then PATCHes the resulting positions and applies the connection diff.

### Server-side (one call to LLM)

Server endpoint: existing `app/api/sessions/[id]/augment/route.ts`, with a new branch on `mode === "rearrange"`. Reasons to extend the existing route rather than create `/rearrange`:

- All three modes share scope resolution, settings loading, and snapshot/undo machinery.
- The route already dispatches on `mode`. Adding a third branch is the smallest diff.

The server validates the payload, builds the LLM request, parses the LLM's JSON, validates it against the in-scope block IDs (every `block_id` in `moves` must exist in the scope), persists the changes in a single transaction, and returns the result + a snapshot for undo.

### LLM contract

**Model:** `google/gemini-3-flash` is the default for Rearrange. It's vision-capable, fast, and cheap — well-suited to the "loose spatial judgment + small JSON output" workload here. The user can override via settings (`rearrangeModelId` if set, else fall back to `modelId`, else default to `google/gemini-3-flash`).

**API shape:** OpenAI-compatible `chat/completions` (works through OpenRouter today). Image is passed as a `data:image/png;base64,...` URL inside an `image_url` content part — Gemini and Sonnet both accept this format via OpenRouter.

**System prompt (concrete, kept short):**

```
You are a spatial layout assistant for a thinking canvas.

You will receive:
1. An image of the current canvas. Each text block is visible at its actual position.
2. A JSON list of the in-scope blocks with their text and their (x, y, w, h) in
   the image's coordinate frame, where the image spans [0, 1000] on both axes.
3. The user's instruction describing how they want the blocks rearranged.

Your job: decide a new (x, y) for each in-scope block so the resulting layout
matches the user's instruction, using the image to ground your spatial sense.
You may also propose new connections between in-scope blocks, or removals of
existing within-scope connections, when the instruction implies it.

Constraints:
- Coordinates are in the same 0–1000 frame. Stay within [0, 1000] on both axes.
- Do not change block text. Do not add or delete blocks. Do not change block
  sizes — w and h are given so you can avoid overlaps; you do not output them.
- Avoid heavy overlaps. The client will nudge tiny overlaps apart, but two
  blocks should not be assigned the same point.
- Only include blocks whose position should change in `moves`. Omitting a block
  means "leave it where it is."
- Connection ids in `removed_connection_ids` must come from the supplied
  `existing_connections` list.

Return ONLY valid JSON, no markdown, no commentary, in this exact shape:

{
  "moves": [{ "block_id": "abc123", "x": 240, "y": 600 }],
  "new_connections": [{ "from_id": "abc123", "to_id": "def456" }],
  "removed_connection_ids": []
}
```

**User message** (multimodal):

```
content: [
  { type: "text", text: "Instruction: <user prompt>\n\nIn-scope blocks (coords already in 0–1000 frame):\n<json>" },
  { type: "text", text: "Existing within-scope connections:\n<json of {id, from_id, to_id}>" },
  { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
]
```

**Temperature:** 0.2. Spatial reasoning rewards consistency over creativity.

**Response format:** `{ type: "json_object" }` (Gemini honors this through OpenRouter).

### Canvas snapshot pipeline

Constraints:
- Must capture both the SVG connections and the absolutely-positioned block divs.
- Output ≤ 512 KB after PNG compression to stay token-cheap.
- Frame must cover every in-scope block plus a small margin so the LLM sees their context.

Approach:
1. Compute the **content frame**: the bounding box of every in-scope block's `(x, y, x+w, y+h)`, expanded by 80 px on each side. If the user's current viewport is larger, use the viewport instead so the LLM also sees nearby out-of-scope blocks.
2. Use `html-to-image` (small dep, ~30 KB, works in the browser) on the wrapper div that holds the SVG + blocks, with a `pixelRatio` chosen so the longest edge of the snapshot is 1024 px. This handles the existing `transform: translate() scale()` correctly — pass `cacheBust: true` and `style: { transform: "none" }` to render the un-transformed content, then we crop in JS to the frame.
3. Convert to a PNG data URL. Reject and error if the resulting base64 string exceeds 512 KB after a 0.85 quality re-encode.

If `html-to-image` proves flaky on iPad Safari (the platform that matters here), the fallback is to render to a `<canvas>` manually: draw a black background, draw the SVG via `Image` + `drawImage`, then for each block draw a rounded rect with the text. Less faithful but bulletproof.

### Collision resolver (client)

After the server returns `moves`, the client merges them with the un-moved blocks' positions to get the proposed full layout. Then:

```
for each pair (a, b) of in-scope blocks:
  if their rects overlap by more than 0 px:
    compute the minimum push along the shorter axis to clear the overlap
    apply half the push to each (subject to canvas bounds)
repeat until no pair overlaps, max 8 iterations
```

O(n²) per iteration. For typical canvases (< 100 blocks) this is sub-millisecond.

After resolution, the client batches PATCH calls to `/api/notes/:id` for every block whose final position differs from its prior DB position by more than 1 px. Connections are applied via the existing `POST /api/sessions/:id/connections` and `DELETE /api/connections/:id` endpoints. (We could batch these into one server call later; for v1 the per-item endpoints are fine.)

### Undo

Snapshot persisted server-side at the moment of the rearrange call:

```ts
{
  mode: "rearrange",
  prior_positions: [{ id, x, y }],            // every in-scope block's pre-rearrange position
  added_connection_ids: [...],                // ids the rearrange created (for delete on undo)
  removed_connections: [{ id, from_id, to_id }] // re-create on undo
}
```

Ctrl-Z handler: PATCH each block back to `prior_positions`, DELETE each `added_connection_ids`, POST each `removed_connections`. Reuses the existing client-side undo stack pattern.

## Data model changes

None required. We're moving existing rows and editing the existing `connections` table — both schemas already accommodate this.

Optional addition (post-v1, not in this spec): a `rearrangeModelId` row in the `settings` table so the user can pick a different model for Rearrange than for Default/Structured augment. v1 just falls back to the global `modelId` and finally to `google/gemini-3-flash`.

## Error handling

| Failure | Surface |
|---|---|
| Snapshot too large after re-encode | Inline error in dialog: *"Canvas too dense to snapshot. Zoom in or select a subset of blocks."* |
| Configured model is text-only | Disable the submit button; inline note as described in UX. |
| LLM returns malformed JSON | Standard augment error toast + dialog stays open with prompt preserved. |
| LLM returns `block_id`s not in scope | Server filters them out silently and applies the rest. Logs a warning. |
| LLM returns coords outside 0–1000 | Client clamps to [0, 1000] before converting back to pixels. |
| Network failure mid-rearrange | Existing fetch error toast. No partial DB state — server applies the full diff in one transaction. |
| Collision resolver hits iteration cap | Apply best-effort layout, log a warning. (Highly unlikely with < 50 blocks.) |

## Testing

Playwright additions to `tests/mvp.spec.ts`:

1. **Rearrange checkbox is mutex with Structured** — checking one unchecks the other.
2. **Submit button disabled with text-only model** — set `modelId = "qwen/qwen-2.5-7b"` (or any text-only) in settings, open dialog, check Rearrange, assert submit is disabled and warning is visible.
3. **Happy path with mock** — stub the LLM call to return a fixed `{moves}` response. Verify the blocks end up at the new positions in the DB.
4. **Undo restores positions** — capture pre-rearrange positions, run rearrange, Ctrl-Z, assert positions are restored exactly.
5. **Connection diff** — stub LLM to return one new connection and one removal, verify both are applied and undone.
6. **Coordinate clamp** — stub LLM to return `x: 1500`, verify client clamps to 1000 (= canvas frame max).

The snapshot pipeline itself doesn't get a Playwright test — it's exercised by the happy path test, which can assert that the request body to the (mocked) LLM endpoint contains an `image_url` part. Visual fidelity of the snapshot is checked manually on iPad Safari before release.

## Files touched

- `app/page.tsx` — augment dialog: third checkbox + mutex logic + submit label + warning. Snapshot + collision resolver helpers (kept inline for now, extract if they grow). Undo handler extension.
- `app/api/sessions/[id]/augment/route.ts` — new `mode === "rearrange"` branch with system prompt, multimodal user message, response validation, transactional apply, snapshot for undo.
- `lib/server/db.ts` — small helper `updateNotePosition(id, x, y)` if not already present (a one-row UPDATE).
- `package.json` — add `html-to-image` dependency.
- `tests/mvp.spec.ts` — six new tests as listed above.

## Out of scope (future work)

- Streaming preview of the LLM's intermediate reasoning.
- A "Rearrange this region" gesture (drag a box, rearrange just inside it). v1 uses the existing selection mechanism instead.
- Per-mode model picker in the settings UI. v1 requires editing settings JSON to override.
- Letting Rearrange add or delete blocks (decision (a) on the locking question — kept strict).
- Text-only fallback path (decision (a) on the locking question — error cleanly instead).
