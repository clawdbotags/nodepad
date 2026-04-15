import { chromium } from 'playwright'

async function main() {
  const browser = await chromium.launch()

  // iPad Air viewport
  const context = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  })

  const page = await context.newPage()
  await page.goto('http://127.0.0.1:3034', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)

  // Screenshot the full page
  await page.screenshot({ path: '/tmp/nodepad-ipad.png', fullPage: false })
  console.log('Screenshot saved to /tmp/nodepad-ipad.png')

  // Also check what's visible at the very top
  const top = await page.evaluate(() => {
    const el = document.querySelector('main')
    if (!el) return 'no main'
    const rect = el.getBoundingClientRect()
    return `main: top=${rect.top} left=${rect.left} width=${rect.width} height=${rect.height}`
  })
  console.log(top)

  const bodyInfo = await page.evaluate(() => {
    const b = document.body
    return `body: h=${b.clientHeight} scrollH=${b.scrollHeight} paddingTop=${getComputedStyle(b).paddingTop}`
  })
  console.log(bodyInfo)

  await browser.close()
}

main().catch(console.error)
