import { chromium, devices } from 'playwright'

/**
 * Test viewport behavior on iPad-sized screen.
 * Chromium can't simulate Safari's address bar, but we CAN verify:
 * 1. Root div starts at y=0 and fills exactly the viewport
 * 2. No content overflows the viewport
 * 3. No stale CSS rules (position:fixed, touch-action on body, etc.)
 * 4. The actual served CSS matches what we expect
 */
async function main() {
  const browser = await chromium.launch()
  const iPad = devices['iPad Pro 11']

  const context = await browser.newContext({ ...iPad })
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:3034', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)

  // Screenshot
  await page.screenshot({ path: '/tmp/nodepad-ipad-viewport.png', fullPage: false })
  console.log('Screenshot saved: /tmp/nodepad-ipad-viewport.png')

  // 1. Check computed styles on html, body, and root div
  const computedStyles = await page.evaluate(() => {
    const html = document.documentElement
    const body = document.body
    const rootDiv = body.querySelector(':scope > div:not([hidden])') as HTMLElement
    if (!rootDiv) return 'ERROR: no visible root div found'

    const htmlStyle = getComputedStyle(html)
    const bodyStyle = getComputedStyle(body)
    const rootStyle = getComputedStyle(rootDiv)

    return {
      html: {
        height: htmlStyle.height,
        overflow: htmlStyle.overflow,
        overflowX: htmlStyle.overflowX,
        overflowY: htmlStyle.overflowY,
        position: htmlStyle.position,
        touchAction: htmlStyle.touchAction,
      },
      body: {
        height: bodyStyle.height,
        overflow: bodyStyle.overflow,
        overflowX: bodyStyle.overflowX,
        overflowY: bodyStyle.overflowY,
        position: bodyStyle.position,
        touchAction: bodyStyle.touchAction,
        margin: bodyStyle.margin,
        padding: bodyStyle.padding,
      },
      rootDiv: {
        className: rootDiv.className.slice(0, 80),
        height: rootStyle.height,
        overflow: rootStyle.overflow,
        position: rootStyle.position,
        display: rootStyle.display,
        top: rootDiv.getBoundingClientRect().top,
        bottom: rootDiv.getBoundingClientRect().bottom,
        computedHeight: rootDiv.getBoundingClientRect().height,
      },
      viewport: {
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
        bodyScrollHeight: body.scrollHeight,
        bodyClientHeight: body.clientHeight,
        htmlScrollHeight: html.scrollHeight,
        htmlClientHeight: html.clientHeight,
        dvh: CSS.supports('height', '100dvh'),
      }
    }
  })
  console.log('\n=== Computed Styles ===')
  console.log(JSON.stringify(computedStyles, null, 2))

  // 2. Check ALL stylesheets for dangerous rules on html/body
  const dangerousRules = await page.evaluate(() => {
    const dangerous: string[] = []
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          const text = rule.cssText
          if (rule instanceof CSSStyleRule) {
            const sel = rule.selectorText?.toLowerCase()
            if (sel && (sel === 'html' || sel === 'body' || sel.includes('html,') || sel.includes(',html') || sel.includes('body,'))) {
              // Check for dangerous properties
              const style = rule.style
              const props = ['overflow', 'overflowX', 'overflowY', 'position', 'height', 'maxHeight', 'touchAction', 'overscrollBehavior']
              for (const prop of props) {
                const val = style.getPropertyValue(prop.replace(/([A-Z])/g, '-$1').toLowerCase())
                if (val) {
                  dangerous.push(`${sel} { ${prop}: ${val} }`)
                }
              }
            }
          }
        }
      } catch (e) {
        // Cross-origin stylesheets can't be read
      }
    }
    return dangerous
  })
  console.log('\n=== Dangerous html/body CSS rules ===')
  if (dangerousRules.length === 0) {
    console.log('PASS: No dangerous overrides on html/body')
  } else {
    console.log('FAIL: Found overrides:')
    dangerousRules.forEach(r => console.log('  ' + r))
  }

  // 3. Check all key UI elements are within viewport
  const elements = await page.evaluate(() => {
    const results: Record<string, any> = {}
    const vh = window.innerHeight

    // Sidebar header
    const headers = Array.from(document.querySelectorAll('h2'))
    const nodepadH = headers.find(e => e.textContent?.includes('nodepad'))
    if (nodepadH) {
      const r = nodepadH.getBoundingClientRect()
      results['NODEPAD header'] = { top: r.top, bottom: r.bottom, visible: r.top >= 0 && r.bottom <= vh }
    }

    // Input bar
    const input = document.querySelector('[data-testid="canvas-input"]') as HTMLElement
    if (input) {
      const r = input.getBoundingClientRect()
      results['Input bar'] = { top: r.top, bottom: r.bottom, visible: r.top >= 0 && r.bottom <= vh }
    }

    // View toggle
    const btns = Array.from(document.querySelectorAll('button'))
    const canvasBtn = btns.find(b => b.textContent?.trim().toLowerCase() === 'canvas')
    if (canvasBtn) {
      const r = canvasBtn.getBoundingClientRect()
      results['View toggle'] = { top: r.top, bottom: r.bottom, visible: r.top >= 0 && r.bottom <= vh }
    }

    // Sidebar toggle
    const toggleBtn = document.querySelector('[data-testid="sidebar-toggle"]') as HTMLElement
    if (toggleBtn) {
      const r = toggleBtn.getBoundingClientRect()
      results['Sidebar toggle'] = { top: r.top, bottom: r.bottom, visible: r.top >= 0 && r.bottom <= vh }
    }

    return results
  })
  console.log('\n=== Element Visibility ===')
  let allVisible = true
  for (const [name, info] of Object.entries(elements)) {
    const status = info.visible ? 'PASS' : 'FAIL'
    if (!info.visible) allVisible = false
    console.log(`${status}: ${name} — top=${info.top.toFixed(1)} bottom=${info.bottom.toFixed(1)}`)
  }

  // 4. Compare with v1
  console.log('\n=== v1 Comparison ===')
  const page2 = await context.newPage()
  try {
    await page2.goto('http://127.0.0.1:3033', { waitUntil: 'networkidle', timeout: 5000 })
    await page2.waitForTimeout(1000)
    await page2.screenshot({ path: '/tmp/nodepad-v1-ipad.png', fullPage: false })
    console.log('v1 screenshot saved: /tmp/nodepad-v1-ipad.png')

    const v1Styles = await page2.evaluate(() => {
      const body = document.body
      const bodyStyle = getComputedStyle(body)
      const rootDiv = body.querySelector(':scope > div:not([hidden])') as HTMLElement
      const rootStyle = rootDiv ? getComputedStyle(rootDiv) : null
      return {
        body: {
          height: bodyStyle.height,
          overflow: bodyStyle.overflow,
          position: bodyStyle.position,
        },
        rootDiv: rootDiv ? {
          className: rootDiv.className.slice(0, 80),
          height: rootStyle!.height,
          overflow: rootStyle!.overflow,
          top: rootDiv.getBoundingClientRect().top,
        } : 'not found'
      }
    })
    console.log('v1 styles:', JSON.stringify(v1Styles, null, 2))
  } catch (e) {
    console.log('v1 not reachable on port 3033 — skipping comparison')
  }

  // Summary
  console.log('\n=== SUMMARY ===')
  console.log(`All elements visible: ${allVisible ? 'YES' : 'NO'}`)
  console.log(`Dangerous CSS rules: ${dangerousRules.length === 0 ? 'NONE' : dangerousRules.length + ' found'}`)
  console.log(`Root div fills viewport: ${typeof computedStyles === 'string' ? 'ERROR' : computedStyles.rootDiv.computedHeight === computedStyles.viewport.innerHeight ? 'YES' : 'NO'}`)
  console.log(`Body scrolls: ${typeof computedStyles === 'string' ? 'ERROR' : computedStyles.viewport.bodyScrollHeight > computedStyles.viewport.bodyClientHeight ? 'YES (BAD)' : 'NO (GOOD)'}`)

  await browser.close()
}

main().catch(console.error)
