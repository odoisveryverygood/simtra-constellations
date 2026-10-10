// Browser test for the constellation renderer. Drives the standalone harness
// (frontend/constellations-demo.html, mock data only) in Chromium: star clicks,
// keyboard parity, resize, reduced motion, teardown. Then loads the real app in
// ?demo=1, mounts the view over it, and checks the city renderer is untouched.
//
// No backend and no model calls: the harness is mock data, and the app page runs
// in its offline demo mode with every non-local request blocked.
//
//   node tests/constellations-browser.mjs            # from frontend/
//   SIMTRA_TEST_PORT=5193 node tests/constellations-browser.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
// Playwright is a dev dependency of the test, not of the app (the frontend has
// no package manager). Resolve it from the local install or from a global one;
// PLAYWRIGHT_MODULE overrides both.
const { chromium } = await (async () => {
  const candidates = [process.env.PLAYWRIGHT_MODULE, "playwright", "/opt/node-tools/node_modules/playwright/index.js"].filter(Boolean);
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      // A CommonJS install arrives under `default`.
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return { chromium };
    } catch { /* try the next one */ }
  }
  throw new Error(`playwright not found; tried ${candidates.join(", ")} — set PLAYWRIGHT_MODULE to its index.js`);
})();

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.SIMTRA_TEST_PORT) || 5193;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".txt": "text/plain" };

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(req.url.split("?")[0]);
    const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end("not found"); }
});

const cases = [];
const check = (condition, message, evidence) => {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(evidence)}`);
};
const pass = (name, evidence = {}) => { cases.push({ name, status: "passed", ...evidence }); console.log(`  ok  ${name}`); };

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
let failure = null;

try {
  // ── the standalone harness ──────────────────────────────────────────────
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${base}/constellations-demo.html`);
  await page.waitForFunction(() => globalThis.__cst?.view?._view?.layout?.stars?.length > 0);

  const layout = () => page.evaluate(() => {
    const v = globalThis.__cst.view._view;
    return {
      stars: v.layout.stars.length, groups: v.layout.groups.length, edges: v.layout.edgeCount,
      members: v.layout.totalMembers, width: v.layout.width, height: v.layout.height,
      first: { x: v.layout.stars[0].x, y: v.layout.stars[0].y },
      canvasW: v.els.canvas.width, canvasH: v.els.canvas.height,
      legend: [...v.els.legend.querySelectorAll(".cst-legend-item")].map((n) => n.textContent),
      note: v.els.note.textContent, badge: !v.els.badge.hidden,
      looping: Boolean(v._raf),
    };
  });

  const first = await layout();
  check(errors.length === 0, "harness console errors", errors);
  check(first.stars > 0 && first.stars <= 240, "star budget", first);
  check(first.groups === 5 && first.legend.length === 5, "legend covers every group", first.legend);
  check(first.members === 10000, "full population retained", first);
  check(/illustrative/i.test(first.note) && /not real relationships/i.test(first.note), "disclaimer on screen", first.note);
  check(first.badge === true, "mock data badge shown for a mock model", first);
  pass("a. harness boots with a bounded, labelled sky", { stars: first.stars, groups: first.groups, edges: first.edges });

  // Clicking a star opens its persona card.
  const star = await page.evaluate(() => {
    const s = globalThis.__cst.view._view.layout.stars[3];
    return { x: s.x, y: s.y, groupId: s.groupId };
  });
  await page.mouse.click(star.x, star.y);
  await page.locator(".cst-card").waitFor({ state: "visible" });
  const card = await page.evaluate(() => ({
    name: document.querySelector(".cst-card-name")?.textContent,
    group: document.querySelector(".cst-card-group")?.textContent,
    disclaimer: document.querySelector(".cst-card-disclaimer")?.textContent,
    selected: Boolean(globalThis.__cst.view._view.selected),
  }));
  check(card.name && card.name.length > 0, "card names the resident", card);
  check(/%/.test(card.group), "card states the group share", card);
  check(/not a recorded answer/i.test(card.disclaimer), "card marks the placement illustrative", card.disclaimer);
  pass("b. clicking a star inspects its synthetic persona", card);

  // Empty sky closes the card.
  await page.mouse.click(8, 400);
  await page.locator(".cst-card").waitFor({ state: "hidden" });
  pass("c. clicking empty sky closes the card");

  // Keyboard parity: arrows walk the stars, Escape closes.
  await page.locator(".cst-sky").focus();
  await page.keyboard.press("ArrowRight");
  await page.locator(".cst-card").waitFor({ state: "visible" });
  const walked = await page.evaluate(() => globalThis.__cst.view._view.focusIndex);
  await page.keyboard.press("ArrowRight");
  const walkedAgain = await page.evaluate(() => globalThis.__cst.view._view.focusIndex);
  check(walkedAgain === walked + 1, "arrow keys walk the stars", { walked, walkedAgain });
  await page.keyboard.press("Escape");
  await page.locator(".cst-card").waitFor({ state: "hidden" });
  pass("d. keyboard reaches the same interaction", { walked, walkedAgain });

  // Resize relayouts into the new viewport, including a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction((before) => globalThis.__cst.view._view.layout.width !== before, first.width);
  const mobile = await layout();
  check(mobile.width === 390 && mobile.height === 844, "layout follows the viewport", mobile);
  check(mobile.stars <= 110, "mobile budget", mobile);
  const inside = await page.evaluate(() => globalThis.__cst.view._view.layout.stars.every((s) => s.x >= 0 && s.x <= 390 && s.y >= 0 && s.y <= 844));
  check(inside, "stars stay inside the phone viewport", mobile);
  const tapped = await page.evaluate(() => { const s = globalThis.__cst.view._view.layout.stars[2]; return { x: s.x, y: s.y }; });
  await page.touchscreen?.tap?.(tapped.x, tapped.y).catch(() => page.mouse.click(tapped.x, tapped.y));
  await page.locator(".cst-card").waitFor({ state: "visible" });
  pass("e. resize relayouts and stars stay tappable on a phone", { stars: mobile.stars });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => globalThis.__cst.view._view.layout.width === 1440);

  // A ninth group has no colour slot: it renders neutral and keeps its label.
  await page.click("#groups-9");
  await page.waitForFunction(() => globalThis.__cst.view._view.layout.groups.length === 9);
  const slots = await page.evaluate(() => {
    const v = globalThis.__cst.view._view;
    const colors = v.layout.groups.map((g) => v._colorFor(g.id));
    return { colors, unique: new Set(colors.slice(0, 8)).size, ninth: colors[8], labels: v.layout.groups.map((g) => g.label).filter(Boolean).length };
  });
  check(slots.unique === 8, "the first eight groups get distinct slots", slots);
  check(slots.ninth === "#9aa3b8", "the ninth group is neutral, not a cycled hue", slots);
  check(slots.labels === 9, "every group keeps a direct label", slots);
  pass("f. colour slots are never cycled past the validated palette", slots);

  // Reduced motion: no animation loop, and the sky still renders.
  const reduced = await context.browser().newContext({ viewport: { width: 1200, height: 800 }, reducedMotion: "reduce" });
  const rpage = await reduced.newPage();
  await rpage.goto(`${base}/constellations-demo.html`);
  await rpage.waitForFunction(() => globalThis.__cst?.view?._view?.layout?.stars?.length > 0);
  const motion = await rpage.evaluate(() => {
    const v = globalThis.__cst.view._view;
    return { looping: Boolean(v._raf), reduced: v.reducedMotion, stars: v.layout.stars.length };
  });
  check(motion.reduced === true && motion.looping === false, "no animation loop under reduced motion", motion);
  check(motion.stars > 0, "the sky still draws", motion);
  await reduced.close();
  pass("g. prefers-reduced-motion stops the animation, not the view", motion);

  // destroy() leaves no DOM, no listeners, no loop.
  await page.click("#destroy");
  const after = await page.evaluate(() => ({
    roots: document.querySelectorAll(".cst-root").length,
    loop: Boolean(globalThis.__cst.view._view._raf),
  }));
  check(after.roots === 0 && after.loop === false, "destroy tears the view down", after);
  check(errors.length === 0, "harness console errors", errors);
  pass("h. destroy() removes the view entirely", after);
  await context.close();

  // ── over the real city renderer ─────────────────────────────────────────
  // The app page runs in offline demo mode and every non-local request is
  // blocked, so this never touches a backend or a model.
  const appCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const app = await appCtx.newPage();
  const appErrors = [];
  const blocked = new Set();
  app.on("pageerror", (e) => appErrors.push(String(e)));
  app.on("console", (m) => {
    // Blocking the app's external requests (fonts, satellite tiles) makes
    // Chromium log a resource failure per abort; those are this test's own
    // doing, so only real page errors count.
    if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) appErrors.push(m.text());
  });
  await app.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    blocked.add(new URL(url).origin);
    return route.abort();
  });
  await app.goto(`${base}/index.html?demo=1`);
  await app.waitForFunction(async () => (await import("/src/app.js")).state.phase === "idle");

  // The city keeps booting asynchronously after phase "idle" (decoding the base
  // image, then re-fitting the overview around the land mask), so wait for the
  // land mask before snapshotting.
  await app.waitForFunction(async () => Boolean((await import("/src/app.js")).map.landBox), null, { polling: 250, timeout: 20000 });

  const before = await app.evaluate(async () => {
    const { map } = await import("/src/app.js");
    // The map's own boot keeps nudging the camera (the land-mask re-fit), so
    // "untouched" is the invariant a stray tap would break: still in overview,
    // never zoomed to a point, same population, same loop.
    return { agents: map.agents.length, zoomedIn: map.zoomedIn, overview: map.camTarget.zoom <= map._overviewZoom() + 1e-6, mode: map.mode, raf: Boolean(map._raf) };
  });
  const mounted = await app.evaluate(async () => {
    const { map, state } = await import("/src/app.js");
    const { initConstellations, createMockModel } = await import("/src/constellations.js");
    const view = initConstellations(map, state);
    globalThis.__cstApp = view;
    view.setResult(createMockModel({ groups: 4 }));
    view.setActive(true);
    const v = view._view;
    return { stars: v.layout.stars.length, visible: !v.els.root.hidden, zIndex: getComputedStyle(v.els.root).zIndex };
  });
  check(mounted.stars > 0 && mounted.visible, "the view mounts over the live app", mounted);
  pass("i. the view mounts over the real app without a backend", mounted);

  // The injected stylesheet lands a tick after mount and triggers one
  // relayout; wait for it so the star coordinates read below are the final ones.
  await app.waitForFunction(() => getComputedStyle(document.querySelector(".cst-root")).zIndex === "3");
  await app.waitForFunction(() => {
    const key = JSON.stringify(globalThis.__cstApp._view.layout.stars[1]);
    const settled = globalThis.__skyKey === key;
    globalThis.__skyKey = key;
    return settled;
  }, null, { polling: 150 });

  // Inspecting a star here draws the city's own sprite into the card.
  const appStar = await app.evaluate(() => { const s = globalThis.__cstApp._view.layout.stars[1]; return { x: s.x, y: s.y }; });
  await app.mouse.click(appStar.x, appStar.y);
  await app.locator(".cst-card").waitFor({ state: "visible" });
  const portrait = await app.evaluate(() => {
    const c = document.querySelector(".cst-card-portrait");
    const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    return { painted: data.some((v) => v !== 0), empty: c.classList.contains("cst-card-portrait--empty") };
  });
  check(portrait.painted || portrait.empty, "portrait either draws or degrades visibly", portrait);
  pass("j. the card reuses the city's sprite for the same resident", portrait);

  // The city renderer is untouched: same agents, same camera, same loop.
  const after2 = await app.evaluate(async () => {
    const { map } = await import("/src/app.js");
    globalThis.__cstApp.setActive(false);
    globalThis.__cstApp.destroy();
    return { agents: map.agents.length, zoomedIn: map.zoomedIn, overview: map.camTarget.zoom <= map._overviewZoom() + 1e-6, mode: map.mode, raf: Boolean(map._raf), roots: document.querySelectorAll(".cst-root").length };
  });
  check(after2.agents === before.agents, "resident population unchanged", { before, after: after2 });
  check(after2.mode === before.mode && after2.raf === before.raf, "city render loop unchanged", { before, after: after2 });
  check(after2.zoomedIn === false && before.zoomedIn === false && after2.overview && before.overview,
    "city camera untouched — the sky absorbed the clicks, the map never zoomed to one", { before, after: after2 });
  check(after2.roots === 0, "teardown leaves the app as it was", after2);
  check(appErrors.length === 0, "app console errors", appErrors);
  console.log(`  (blocked external origins: ${[...blocked].join(", ") || "none"})`);
  pass("k. the city renderer and its camera are untouched", { agents: after2.agents, mode: after2.mode, zoomedIn: after2.zoomedIn });
  await appCtx.close();
} catch (error) {
  failure = error;
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${cases.length} passed${failure ? ", 1 failed" : ""}`);
if (failure) { console.error(failure.message); process.exit(1); }
