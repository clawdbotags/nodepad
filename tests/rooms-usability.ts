import { chromium, devices } from "playwright"
import { mkdirSync } from "node:fs"

/**
 * Reproduce Albert's complaint: on mobile, opening the left pane and
 * tapping "Rooms" doesn't let you switch rooms — you have to collapse
 * the pane first. We screenshot each step so the regression is obvious
 * at a glance.
 */
async function main() {
  const outDir = "/tmp/nodepad-rooms"
  mkdirSync(outDir, { recursive: true })

  const browser = await chromium.launch()
  const phone = devices["iPhone 13"]
  const context = await browser.newContext({
    ...phone,
    permissions: ["microphone"],
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()

  page.on("console", msg => {
    if (msg.type() === "error") console.log("[console-error]", msg.text())
  })

  const baseUrl = process.env.NODEPAD_URL || "http://127.0.0.1:3034"
  // networkidle never fires — Matrix /sync long-poll keeps the network busy.
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2500)

  const shots: string[] = []
  async function shot(name: string) {
    const p = `${outDir}/${name}.png`
    await page.screenshot({ path: p, fullPage: false })
    shots.push(p)
    console.log(`> ${name}`)
  }

  async function layout(label: string) {
    const data = await page.evaluate(`(function(){
      var r = function(el){ if(!el) return null; var b = el.getBoundingClientRect(); return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height),visible: b.width>0 && b.height>0} }
      var aside = document.querySelector('aside')
      var roomsOverlayCandidates = Array.from(document.querySelectorAll('div')).filter(function(d){ return d.getAttribute('aria-hidden') === 'false' && d.className && d.className.indexOf('z-40') !== -1 })
      return {
        vw: window.innerWidth,
        vh: window.innerHeight,
        aside: r(aside),
        asideZIndex: aside ? getComputedStyle(aside).zIndex : null,
        sidebarBackdrop: r(document.querySelector('[data-testid="sidebar-backdrop"]')),
        sessionItems: document.querySelectorAll('[data-testid^="session-item-"]').length,
        sidebarModeTabs: r(document.querySelector('[data-testid="sidebar-mode-tabs"]')),
        chatViewRoomList: roomsOverlayCandidates.length,
      }
    })()`)
    console.log("LAYOUT", label, JSON.stringify(data, null, 2))
    return data as any
  }

  // 1. cold load on mobile — sidebar defaults to open per our page.tsx
  await shot("01-cold")
  await layout("cold")

  // 2. make sure sidebar is OPEN. On mobile the default is closed (240→0
  //    slide animation), so we tap the open chevron.
  const info1 = await layout("check-initial")
  const asideOpen = (info1.aside?.w ?? 0) >= 100
  if (!asideOpen) {
    const open = page.locator('[data-testid="sidebar-toggle"]').first()
    if (await open.count()) {
      await open.click()
      await page.waitForTimeout(500)
      console.log("tapped sidebar-toggle to open")
    } else {
      console.log("!! sidebar-toggle not found, can't open")
    }
  }
  await shot("02-sidebar-open-nodes")
  await layout("sidebar-open-nodes")

  // 3. Tap "Rooms" tab inside the sidebar. The complaint: this should
  //    show the room list — but (my hypothesis) the canvas sidebar stays
  //    showing sessions because ChatView overlay is z-40 behind the z-50
  //    aside.
  const roomsTab = page.locator('[data-testid="sidebar-mode-tabs"] button', { hasText: /Rooms/i }).first()
  if (!(await roomsTab.count())) {
    console.log("!! Rooms tab not found inside sidebar-mode-tabs")
  } else {
    await roomsTab.click()
    await page.waitForTimeout(600)
  }
  await shot("03-after-tap-rooms-sidebar-still-open")
  const afterTap = await layout("after-tap-rooms")

  // 4. What's visible on screen right now? Count *visible* room vs session
  //    items. If sessions still show up here, that's the bug.
  const visibility = await page.evaluate(`(function(){
    function visibleRect(el){ if(!el) return false; var r = el.getBoundingClientRect(); if (r.width<=0||r.height<=0) return false; var cs = getComputedStyle(el); if (cs.visibility==='hidden' || cs.display==='none' || parseFloat(cs.opacity)===0) return false; return true }
    var sessionVisible = 0
    document.querySelectorAll('[data-testid^="session-item-"]').forEach(function(el){ if (visibleRect(el)) sessionVisible++ })
    // ChatView's rooms list uses SidebarListItem too but without the session-item- prefix.
    // Look for the ChatView root (absolute inset-0 flex bg-black) and count its list items.
    var chatRoot = document.querySelector('div[aria-hidden="false"].z-40, div.z-40:not([aria-hidden="true"])')
    var roomsVisible = 0
    var roomsOverlayVisible = false
    if (chatRoot) {
      roomsOverlayVisible = visibleRect(chatRoot)
      chatRoot.querySelectorAll('button').forEach(function(el){ if (visibleRect(el)) roomsVisible++ })
    }
    // Are any sessions being covered up by the chat overlay z-40? The canvas aside is z-50 on mobile.
    var aside = document.querySelector('aside')
    return {
      sessionVisibleCount: sessionVisible,
      chatOverlayVisible: roomsOverlayVisible,
      chatOverlayButtonCount: roomsVisible,
      asideZIndex: aside ? getComputedStyle(aside).zIndex : null,
      chatOverlayZIndex: chatRoot ? getComputedStyle(chatRoot).zIndex : null,
      asideVisible: aside ? visibleRect(aside) : false,
      activeTabLabel: (function(){
        var active = document.querySelector('[data-testid="sidebar-mode-tabs"] [data-active="true"], [data-testid="sidebar-mode-tabs"] button.bg-primary, [data-testid="sidebar-mode-tabs"] button[aria-selected="true"]')
        return active ? active.textContent : null
      })()
    }
  })()`)
  console.log("VISIBILITY after Rooms tap", JSON.stringify(visibility, null, 2))

  // 5. Now collapse the sidebar and see if the rooms list becomes interactive.
  const closeBtn = page.locator('[data-testid="sidebar-close"]:visible').first()
  if (await closeBtn.count()) {
    await closeBtn.click()
  } else {
    // tap backdrop
    const bd = page.locator('[data-testid="sidebar-backdrop"]:visible').first()
    if (await bd.count()) await bd.click()
    else await page.mouse.click(360, 400)
  }
  await page.waitForTimeout(500)
  await shot("04-sidebar-collapsed-rooms-now-visible")
  await layout("sidebar-collapsed")

  // 6. Try tapping a room now — should work.
  const visibility2 = await page.evaluate(`(function(){
    function visibleRect(el){ if(!el) return false; var r = el.getBoundingClientRect(); return r.width>0 && r.height>0 }
    var chatRoot = document.querySelector('div.z-40')
    var out = []
    if (chatRoot) chatRoot.querySelectorAll('button').forEach(function(el){ if (visibleRect(el) && el.textContent && el.textContent.length < 80) out.push(el.textContent.trim().slice(0,60)) })
    return out.slice(0, 20)
  })()`)
  console.log("ROOMS LIST after collapse", visibility2)

  console.log("shots:", shots.join(" "))
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
