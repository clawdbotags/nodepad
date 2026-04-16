import { chromium, devices } from 'playwright'
import { mkdirSync } from 'node:fs'

/**
 * Phone-portrait audit. Drives the app at iPhone-13 dimensions
 * and screenshots every key surface so we can see what's broken
 * vertically. No assertions — eyeball-driven.
 */
async function main() {
  const outDir = '/tmp/nodepad-phone'
  mkdirSync(outDir, { recursive: true })

  const browser = await chromium.launch()
  const phone = devices['iPhone 13']
  const context = await browser.newContext({
    ...phone,
    permissions: ['microphone'],
  })
  const page = await context.newPage()

  page.on('console', msg => {
    if (msg.type() === 'error') console.log('[console-error]', msg.text())
  })

  // Deep-link to the session that has actual content so we can see Tiled view.
  await page.goto('http://127.0.0.1:3034/?session=s4rexszo', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)

  const shots: string[] = []
  async function shot(name: string) {
    const p = `${outDir}/${name}.png`
    await page.screenshot({ path: p, fullPage: false })
    shots.push(p)
    console.log(`> ${name}`)
  }

  // 1. cold load (should be tiled view, sidebar closed)
  await shot('01-cold')

  // Diagnostics on layout (string-form to dodge tsx __name shim)
  const layout = await page.evaluate(`(function(){
    var r = function(el){ if(!el) return null; var b = el.getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height} }
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      isMobile: window.matchMedia('(max-width: 767px)').matches,
      bodyOverflow: getComputedStyle(document.body).overflow,
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      root: r(document.body.firstElementChild),
      main: r(document.querySelector('main')),
      entry: r(document.querySelector('[data-testid="entry-bar"]')),
      viewToggle: r(document.querySelector('[data-testid="view-toggle"]')),
      sidebar: r(document.querySelector('aside')),
      tileCount: document.querySelectorAll('[data-testid="tile"]').length,
      firstTile: r(document.querySelectorAll('[data-testid="tile"]')[0]),
    }
  })()`)
  console.log('LAYOUT', JSON.stringify(layout, null, 2))

  // 2. open sidebar via the chevron
  const sidebarToggle = page.locator('[data-testid="sidebar-toggle"]:visible').first()
  if (await sidebarToggle.count()) {
    await sidebarToggle.click()
    await page.waitForTimeout(400)
    await shot('02-sidebar-open')
    // close via backdrop — click far right where backdrop isn't covered by aside
    await page.mouse.click(370, 400)
    await page.waitForTimeout(400)
  } else {
    console.log('NO sidebar-toggle testid found')
  }

  // 3. open augment dialog (sidebar-button)
  // Need sidebar open first
  const sidebarToggle2 = page.locator('[data-testid="sidebar-toggle"]:visible').first()
  if (await sidebarToggle2.count()) await sidebarToggle2.click()
  await page.waitForTimeout(300)

  // 4. open augment dialog (mobile auto-closes sidebar)
  const augBtn = page.locator('[data-testid="augment-btn"]').first()
  if (await augBtn.count()) {
    await augBtn.click()
    await page.waitForTimeout(700)
    await shot('03-augment-dialog')
    // close augment via backdrop tap
    await page.locator('[data-testid="augment-backdrop"]').first().click({ position: { x: 100, y: 100 } })
    await page.waitForTimeout(400)

    const dialog = await page.evaluate(`(function(){
      var r = function(el){ return el ? el.getBoundingClientRect() : null }
      return {
        dialog: r(document.querySelector('[data-testid="augment-dialog"]')),
        prompt: r(document.querySelector('[data-testid="augment-prompt-input"]')),
        submit: r(document.querySelector('[data-testid="augment-submit"]')),
        mic: r(document.querySelector('[data-testid="augment-voice-btn"]')),
        vw: window.innerWidth,
        vh: window.innerHeight,
      }
    })()`)
    console.log('DIALOG', JSON.stringify(dialog, null, 2))

    // close
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  } else {
    console.log('NO open-augment testid')
  }

  // 5. Switch to graph
  const toggleBtns = page.locator('[data-testid="view-toggle"] button')
  const count = await toggleBtns.count()
  console.log(`view-toggle has ${count} buttons`)
  for (let i = 0; i < count; i++) {
    const t = await toggleBtns.nth(i).innerText()
    console.log(`  btn[${i}]: "${t.trim()}"`)
  }
  // find graph
  for (let i = 0; i < count; i++) {
    const t = (await toggleBtns.nth(i).innerText()).trim().toLowerCase()
    if (t.includes('graph')) {
      await toggleBtns.nth(i).click()
      await page.waitForTimeout(800)
      await shot('04-graph')
      break
    }
  }

  // 6. Sidebar interaction with mobile drawer
  // already shot 02

  console.log('shots:', shots.join(' '))
  await browser.close()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
