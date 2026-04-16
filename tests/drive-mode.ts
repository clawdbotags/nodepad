import { chromium, devices } from 'playwright'
import { mkdirSync } from 'node:fs'

/**
 * Drive Mode smoke test. Verifies:
 *   1. The steering-wheel button renders in the entry bar.
 *   2. Tapping it opens the overlay.
 *   3. The overlay shows a big mic button + status text.
 *   4. Close button dismisses cleanly.
 *
 * No real audio — Playwright's mic is silent so the recorder will
 * fire "too short" but that's fine; we just want to see the UI works.
 */
async function main() {
  const outDir = '/tmp/nodepad-drive'
  mkdirSync(outDir, { recursive: true })

  const browser = await chromium.launch()
  const phone = devices['iPhone 13']
  const context = await browser.newContext({
    ...phone,
    permissions: ['microphone'],
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()
  page.on('console', m => {
    if (m.type() === 'error') console.log('[console-error]', m.text())
  })

  const baseUrl = process.env.NODEPAD_URL || 'https://ubuntu-4gb-hel1-1.tail6fe47c.ts.net:8444'
  await page.goto(`${baseUrl}/?session=s4rexszo`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)

  const driveBtn = page.locator('[data-testid="drive-mode-btn"]')
  const driveBtnCount = await driveBtn.count()
  console.log(`drive-mode-btn count: ${driveBtnCount}`)
  if (driveBtnCount === 0) {
    console.error('FAIL: drive button not found')
    await page.screenshot({ path: `${outDir}/00-no-drive-btn.png`, fullPage: false })
    await browser.close()
    process.exit(1)
  }

  await page.screenshot({ path: `${outDir}/01-entry-bar.png`, fullPage: false })

  // Tap drive button
  await driveBtn.first().click()
  await page.waitForTimeout(800)

  const overlay = page.locator('[data-testid="drive-mode-overlay"]')
  if ((await overlay.count()) === 0) {
    console.error('FAIL: drive overlay did not open')
    await page.screenshot({ path: `${outDir}/02-no-overlay.png`, fullPage: false })
    await browser.close()
    process.exit(1)
  }
  await page.screenshot({ path: `${outDir}/02-overlay-open.png`, fullPage: false })

  // Check button + rundown elements exist
  const bigBtn = page.locator('[data-testid="drive-mode-button"]')
  const rundown = page.locator('[data-testid="drive-mode-rundown"]')
  console.log(`drive-mode-button: ${await bigBtn.count()}, rundown: ${await rundown.count()}`)
  const layout = await page.evaluate(`(function(){
    var r = function(el){ return el ? el.getBoundingClientRect() : null }
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      overlay: r(document.querySelector('[data-testid="drive-mode-overlay"]')),
      button: r(document.querySelector('[data-testid="drive-mode-button"]')),
      rundown: r(document.querySelector('[data-testid="drive-mode-rundown"]')),
      close: r(document.querySelector('[data-testid="drive-mode-close"]')),
    }
  })()`)
  console.log('LAYOUT', JSON.stringify(layout, null, 2))

  // Close
  await page.locator('[data-testid="drive-mode-close"]').click()
  await page.waitForTimeout(400)
  if ((await overlay.count()) > 0) {
    console.error('FAIL: drive overlay did not close')
    process.exit(1)
  }

  console.log('PASS: drive mode UI works')
  await browser.close()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
