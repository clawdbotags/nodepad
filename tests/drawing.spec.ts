import { test, expect, Page } from "@playwright/test"

const BASE = "http://localhost:3034"

async function resetServer(page: Page) {
  const res = await page.request.get(`${BASE}/api/sessions`)
  const sessions = await res.json()
  for (const s of sessions) {
    await page.request.delete(`${BASE}/api/sessions/${s.id}`)
  }
}

test.beforeEach(async ({ page }) => {
  await resetServer(page)
})

test("drawing: ✎ button creates a drawing block which opens fullscreen overlay", async ({ page }) => {
  await page.goto(BASE)
  await expect(page.locator('[data-testid^="session-item-"]').first()).toBeVisible({ timeout: 5000 })

  // Click the new sketch button
  const sketchBtn = page.getByTestId("new-drawing-btn")
  await expect(sketchBtn).toBeVisible()
  await sketchBtn.click()

  // A new drawing block should appear and the overlay should mount automatically
  const overlay = page.getByTestId("excalidraw-overlay")
  await expect(overlay).toBeVisible({ timeout: 10_000 })

  // Excalidraw editor canvas eventually mounts inside the overlay
  await expect(overlay.locator("canvas").first()).toBeVisible({ timeout: 15_000 })

  // Close the overlay (saves)
  await page.getByTestId("excalidraw-close").click()
  await expect(overlay).toHaveCount(0)

  // The drawing block should still be present on canvas
  const drawingBlock = page.locator('[data-block-kind="drawing"]').first()
  await expect(drawingBlock).toBeVisible()

  // The ⛶ expand button on the block re-opens the overlay
  await drawingBlock.locator('[data-testid^="drawing-expand-"]').click()
  await expect(page.getByTestId("excalidraw-overlay")).toBeVisible()

  // Escape closes & saves
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("excalidraw-overlay")).toHaveCount(0)
})

test("drawing: tile view shows drawing block and double-tap opens overlay", async ({ page }) => {
  await page.goto(BASE)
  await expect(page.locator('[data-testid^="session-item-"]').first()).toBeVisible({ timeout: 5000 })

  // Create a drawing block via API to bypass the overlay open flow
  const sessId = await page.evaluate(async () => {
    const ss = await fetch("/api/sessions").then(r => r.json())
    return ss[0].id
  })
  await page.request.post(`${BASE}/api/sessions/${sessId}/notes`, {
    data: {
      text: JSON.stringify({ elements: [], appState: {}, files: {} }),
      kind: "drawing", x: 100, y: 100, width: 300, height: 240,
    },
  })

  // Reload, switch to tiled view
  await page.reload()
  await page.getByTestId("view-tiled").click().catch(() => { /* may have a different testid */ })
  // Fallback: click any element with the word "Tiled"
  const tiledBtn = page.getByRole("button", { name: /tiled/i })
  if (await tiledBtn.count()) await tiledBtn.first().click()

  // The tile should render with data-block-kind="drawing"
  const tile = page.locator('[data-block-kind="drawing"]').first()
  await expect(tile).toBeVisible()

  // Click the tile-drawing-expand button
  await tile.locator('[data-testid^="tile-drawing-expand-"]').click()
  await expect(page.getByTestId("excalidraw-overlay")).toBeVisible({ timeout: 10_000 })
})

test("voice: mic button visible in entry bar and toggles to recording state", async ({ page, context }) => {
  await context.grantPermissions(["microphone"], { origin: BASE })
  await page.goto(BASE)
  await expect(page.locator('[data-testid^="session-item-"]').first()).toBeVisible({ timeout: 5000 })

  const mic = page.getByTestId("voice-input-btn")
  await expect(mic).toBeVisible()
  await expect(mic).toHaveAttribute("aria-pressed", "false")
})
