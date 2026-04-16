import { chromium, devices } from 'playwright'

async function main() {
  const browser = await chromium.launch()
  const iPad = devices['iPad Pro 11']

  // Test with iPad viewport
  const context = await browser.newContext({
    ...iPad,
  })

  const page = await context.newPage()
  await page.goto('http://127.0.0.1:3034', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)

  // Screenshot
  await page.screenshot({ path: '/tmp/nodepad-ipad.png', fullPage: false })
  console.log('Screenshot: /tmp/nodepad-ipad.png')

  // Check root element dimensions
  const rootInfo = await page.evaluate(() => {
    const root = document.querySelector('body > div')
    if (!root) return 'no root div found'
    const rect = root.getBoundingClientRect()
    const style = getComputedStyle(root)
    return `root: top=${rect.top} height=${rect.height} style.height=${style.height} window.innerHeight=${window.innerHeight}`
  })
  console.log(rootInfo)

  // Check if sidebar header is visible (should be near top=0)
  const sidebarInfo = await page.evaluate(() => {
    // Look for the NODEPAD text
    const els = Array.from(document.querySelectorAll('h2'))
    const nodepadEl = els.find(e => e.textContent?.includes('nodepad'))
    if (!nodepadEl) return 'NODEPAD header not found'
    const rect = nodepadEl.getBoundingClientRect()
    return `NODEPAD header: top=${rect.top} bottom=${rect.bottom} visible=${rect.top >= 0 && rect.bottom <= window.innerHeight}`
  })
  console.log(sidebarInfo)

  // Check view toggle position
  const viewToggle = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'))
    const canvasBtn = btns.find(b => b.textContent?.trim().toLowerCase() === 'canvas')
    if (!canvasBtn) return 'Canvas button not found'
    const rect = canvasBtn.getBoundingClientRect()
    return `Canvas btn: top=${rect.top} bottom=${rect.bottom} visible=${rect.top >= 0 && rect.bottom <= window.innerHeight}`
  })
  console.log(viewToggle)

  // Check bottom input
  const inputInfo = await page.evaluate(() => {
    const input = document.querySelector('[data-testid="canvas-input"]') as HTMLElement
    if (!input) return 'Canvas input not found'
    const rect = input.getBoundingClientRect()
    return `Input: top=${rect.top} bottom=${rect.bottom} visible=${rect.bottom <= window.innerHeight}`
  })
  console.log(inputInfo)

  // Check if anything overflows
  const overflowInfo = await page.evaluate(() => {
    const body = document.body
    const html = document.documentElement
    return `body: scrollH=${body.scrollHeight} clientH=${body.clientHeight} | html: scrollH=${html.scrollHeight} clientH=${html.clientHeight} | innerH=${window.innerHeight}`
  })
  console.log(overflowInfo)

  await browser.close()
}

main().catch(console.error)
