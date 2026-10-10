// ─────────────────────────────────────────────────────────────────────────
// sim francisco · the city feed, as a floating panel over the map
//
// A thread of what happened in the city and how its synthetic residents took
// it, laid out like the news bubble it replaces: a dated entry per event with
// the residents' reactions quoted under it, and every question asked of the
// city as a dated entry too, so the lineage of "world changed → we measured"
// reads top to bottom.
//
// Data: events + tests come from the persona-memory lineage endpoint; reactions
// are one batched model call per request over a diverse sample of residents,
// stored on the graph so everyone sees the same thread. The city's baseline
// headlines (what residents already know) sit at the bottom as plain posts.
// ─────────────────────────────────────────────────────────────────────────

import { BASE, today } from "./config.js";
import { workspaceHeaders, shareUrl, startNewWorkspace } from "./workspace.js?v=2";
import { detectKind } from "./detect-kind.js";
import { buildEvidenceChartModel } from "./evidence-chart.js";
import { createPersonaChart } from "./persona-chart.js?v=5";
import { buildVerifiedDataModel, renderVerifiedData, bindVerifiedData, verifiedMapSelection } from "./verified-data.js";

const SENTIMENTS = ["support", "oppose", "worried", "angry", "sad", "hopeful", "indifferent"];
const REACT_N = 12;
const REFRESH_MS = 20000;
const LINEAGE_LIMIT = 100;
const PREVIEW_POSTS = 5;   // event posts near the top fetch their comment previews lazily
const PREVIEW_N = 3;
const COLLAPSE_KEY = "simtra.feed.collapsed";
const VIEW_KEY = "simtra.feed.view";
const VIEWS = [["all", "All"], ["news", "News"], ["asks", "Surveys"], ["data", "Data"]];
const VIEW_TITLES = { all: "Show everything", news: "Only posted news and events", asks: "Only surveys you ran", data: "Only verified Census data queries" };
const TEST_KINDS = {
  poll: "survey",
  ab_test: "A/B test",
  counterfactual_baseline: "baseline",
  counterfactual_exposed: "with hypothetical",
  predict_market: "market",
  validate: "validation",
};

// ── http ───────────────────────────────────────────────────────────────────
async function req(path, { method = "GET", body, timeout = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...workspaceHeaders(), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const error = new Error(data?.error || data?.message || res.statusText);
      error.status = res.status;
      throw error;
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") {
      const error = new Error("the backend took too long to answer");
      error.status = 504;
      throw error;
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const api = {
  lineage: (city, limit = LINEAGE_LIMIT) =>
    req(`/cities/${encodeURIComponent(city)}/lineage?limit=${limit}`, { timeout: 20000 }),
  events: (city, limit = 50) =>
    req(`/cities/${encodeURIComponent(city)}/events?limit=${limit}`, { timeout: 20000 }),
  postEvent: (city, body) =>
    req(`/cities/${encodeURIComponent(city)}/events`, { method: "POST", body, timeout: 20000 }),
  reactions: (city, eventId, limit = 50) =>
    req(`/cities/${encodeURIComponent(city)}/events/${encodeURIComponent(eventId)}/reactions?limit=${limit}`,
      { timeout: 20000 }),
  react: (branchId, eventId, n = REACT_N) =>
    req(`/branches/${encodeURIComponent(branchId)}/events/${encodeURIComponent(eventId)}/react`,
      { method: "POST", body: { n }, timeout: 120000 }),
  poll: (branchId, body) =>
    req(`/branches/${encodeURIComponent(branchId)}/poll`, { method: "POST", body, timeout: 180000 }),
};

// ── helpers ────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sentimentOf = (s) => (SENTIMENTS.includes(s) ? s : "indifferent");
function friendly(error) {
  const s = error?.status;
  if (s === 503) return "Persona memory is not configured on this backend.";
  if (s === 429 || s === 502) return "Residents are rate-limited right now. Try again in a minute.";
  if (s === 504) return "The backend took too long to answer. Try again.";
  if (s === 404) return "That no longer exists on the backend.";
  return error?.message || "Something went wrong.";
}
function tally(reactions) {
  const out = {};
  for (const r of reactions || []) {
    const s = sentimentOf(r.sentiment);
    out[s] = (out[s] || 0) + 1;
  }
  return out;
}
function fmtDate(iso) {
  // date-only strings are calendar dates, not UTC instants: keep them local
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(iso);
  if (isNaN(d.getTime())) return iso || "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso || "";
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
const plural = (n, w, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;

// ── state ──────────────────────────────────────────────────────────────────
const state = {
  loaded: false,        // first lineage fetch finished (skeleton until then)
  getCity: () => "sf",
  getBranch: () => null,
  getCityDisplay: () => "San Francisco",
  getResidents: () => 0,
  getNews: () => [],
  // map / resident hooks supplied by the app so timeline charts can highlight
  // residents exactly like the result card's evidence panel does
  setSegmentSelection: () => {},
  getSegmentSelectionSummary: () => ({ active: false, rawMatchingAgents: 0, weightedPumsCount: 0 }),
  getRawResidents: () => [],
  evidenceReady: () => false,
  dimensionLabels: {},
  groupLabel: (d, k) => k,
  drawHead: () => {},
  openPerson: () => {},
  fetchAnswers: async () => null,
  fetchPersonal: null,
  sourceHint: () => null,
  getPopulationKey: () => null,
  openPastResult: null,
  chart: null,          // the one open timeline chart: { id, host, dispose, close }
  items: [],            // lineage items (events, tests, data queries), newest first
  posts: new Map(),     // item id -> post element
  memoryOff: false,
  lineageOff: false,
  busy: 0,              // in-flight reacts (pauses refresh)
  autoCollapsed: false, // folded away while a result card is up; not persisted
  collapsed: false,
  view: "all",           // quick filter over the log: all | news | asks | data
  kindManual: false,     // the poster picked the kind by hand; stop auto-detecting
  refreshTimer: null,
  loadSeq: 0,
  root: null,
  el: {},
};

// ── skeleton ───────────────────────────────────────────────────────────────
const ICONS = {
  caret: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`,
  heart: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.3 4.6 13a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9a4.6 4.6 0 0 1 6.5 6.5z"/></svg>`,
  comment: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 5H4v10h5l3 3 3-3h5z"/></svg>`,
};
const initials = (name) => {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((w) => w[0]).join("") || "?").toUpperCase();
};

function build(root) {
  root.innerHTML = `
    <div class="fp-head">
      <div class="fp-head-row">
        <button class="fp-collapse" type="button" aria-expanded="true" aria-controls="fp-body">
          <span class="fp-lockup">
            <span class="fp-kicker">timeline</span>
            <span class="fp-city"></span>
          </span>
        </button>
        <div class="fp-menu-wrap">
          <button type="button" class="fp-more" aria-label="Timeline options" title="Share this timeline or start a new one" aria-haspopup="menu" aria-expanded="false">···</button>
          <div class="fp-menu hidden" role="menu">
            <button type="button" role="menuitem" data-ws="share">Share timeline link</button>
            <button type="button" role="menuitem" data-ws="new">Start a new workspace</button>
          </div>
        </div>
        <button class="fp-collapse fp-collapse-caret" type="button" aria-label="Collapse timeline" aria-expanded="true" aria-controls="fp-body">
          <span class="fp-caret">${ICONS.caret}</span>
        </button>
      </div>
      <div class="fp-status" aria-live="polite"></div>
      <div class="fp-ws-confirm hidden" role="dialog" aria-label="Start a new workspace">
        <span>Start a new, empty workspace? The current one stays reachable by its link.</span>
        <button type="button" class="fp-primary fp-ws-go">New workspace</button>
        <button type="button" class="fp-ws-link fp-ws-cancel">Cancel</button>
      </div>
    </div>
    <div id="fp-body" class="fp-body">
      <div class="fp-views" role="tablist" aria-label="Show">
        ${VIEWS.map(([v, label]) => `<button type="button" role="tab" class="fp-view" data-view="${v}" aria-selected="${v === "all"}" title="${VIEW_TITLES[v]}">${label}<span class="fp-view-n"></span></button>`).join("")}
      </div>
      <div class="fp-composer">
        <form class="fp-form fp-form-post" data-mode="post">
          <textarea class="fp-text" name="text" rows="2" maxlength="2000" required
                    placeholder="What happened? Residents will remember it."
                    aria-label="What happened"></textarea>
          <div class="fp-row">
            <select class="fp-select fp-kind" name="kind" aria-label="Kind of event" title="Detected from the text; change it here">
              <option value="news">news</option>
              <option value="policy">policy</option>
              <option value="incident">incident</option>
              <option value="rumor">rumor</option>
            </select>
            <input class="fp-date-input" type="date" name="as_of_date" aria-label="Date it happened" />
            <button class="fp-primary" type="submit">Post</button>
          </div>
          <div class="fp-error" role="alert"></div>
        </form>
      </div>
      <div class="fp-notice hidden" role="status"></div>
      <div class="fp-thread"></div>
    </div>`;
  const q = (s) => root.querySelector(s);
  state.el = {
    collapse: q(".fp-collapse"),
    city: q(".fp-city"),
    status: q(".fp-status"),
    wsConfirm: q(".fp-ws-confirm"),
    body: q("#fp-body"),
    formPost: q(".fp-form-post"),
    kind: q(".fp-kind"),
    views: q(".fp-views"),
    notice: q(".fp-notice"),
    thread: q(".fp-thread"),
  };
  state.el.formPost.elements.as_of_date.value = today();
  const text = state.el.formPost.elements.text;
  text.addEventListener("input", () => {
    if (!text.value.trim()) { state.kindManual = false; setKind("news"); return; }
    if (!state.kindManual) setKind(detectKind(text.value));
  });
  state.el.kind.addEventListener("change", () => { state.kindManual = true; setKind(state.el.kind.value); });
  state.el.views.addEventListener("click", (e) => {
    const b = e.target.closest(".fp-view");
    if (b) setView(b.dataset.view);
  });
}

function setKind(kind) {
  const sel = state.el.kind;
  sel.value = kind;
  sel.dataset.kind = kind;
}

// quick filters over the log; "news" also shows the city's baseline headlines
const VIEW_OF = { event: "news", test: "asks", data_query: "data" };
function inView(item) { return state.view === "all" || VIEW_OF[item.type] === state.view; }
function setView(view) {
  state.view = VIEWS.some(([v]) => v === view) ? view : "all";
  try { localStorage.setItem(VIEW_KEY, state.view); } catch { /* ignore */ }
  syncViews();
  renderThread();
}
function syncViews() {
  const counts = { all: state.items.length, news: 0, asks: 0, data: 0 };
  for (const i of state.items) counts[VIEW_OF[i.type]] = (counts[VIEW_OF[i.type]] || 0) + 1;
  for (const b of state.el.views.querySelectorAll(".fp-view")) {
    b.setAttribute("aria-selected", b.dataset.view === state.view ? "true" : "false");
    b.querySelector(".fp-view-n").textContent = counts[b.dataset.view] ? ` ${counts[b.dataset.view]}` : "";
  }
}

// ── public api ─────────────────────────────────────────────────────────────
// lineage items as last loaded (newest first); the app reads these to build the
// "over time" history of a question without a second fetch
export function lineageItems() { return state.items; }

export function initFeedPanel({
  getCity, getBranch, getCityDisplay, getResidents, getNews,
  setSegmentSelection, getSegmentSelectionSummary, getRawResidents, evidenceReady, dimensionLabels,
  groupLabel, drawHead, openPerson, fetchAnswers, fetchPersonal, sourceHint, getPopulationKey, openPastResult,
} = {}) {
  const root = document.getElementById("feed-panel");
  if (!root) return;
  state.root = root;
  if (getCity) state.getCity = getCity;
  if (getBranch) state.getBranch = getBranch;
  if (getCityDisplay) state.getCityDisplay = getCityDisplay;
  if (getResidents) state.getResidents = getResidents;
  if (getNews) state.getNews = getNews;
  if (setSegmentSelection) state.setSegmentSelection = setSegmentSelection;
  if (getSegmentSelectionSummary) state.getSegmentSelectionSummary = getSegmentSelectionSummary;
  if (getRawResidents) state.getRawResidents = getRawResidents;
  if (evidenceReady) state.evidenceReady = evidenceReady;
  if (dimensionLabels) state.dimensionLabels = dimensionLabels;
  if (groupLabel) state.groupLabel = groupLabel;
  if (drawHead) state.drawHead = drawHead;
  if (openPerson) state.openPerson = openPerson;
  if (fetchAnswers) state.fetchAnswers = fetchAnswers;
  if (fetchPersonal) state.fetchPersonal = fetchPersonal;
  if (sourceHint) state.sourceHint = sourceHint;
  if (getPopulationKey) state.getPopulationKey = getPopulationKey;
  if (openPastResult) state.openPastResult = openPastResult;
  build(root);

  state.collapsed = false; // always expanded on load; the caret folds it for this session only
  try { const v = localStorage.getItem(VIEW_KEY); if (VIEWS.some(([k]) => k === v)) state.view = v; } catch { /* private mode */ }
  applyCollapsed();
  for (const b of root.querySelectorAll(".fp-collapse")) b.addEventListener("click", () => {
    state.autoCollapsed = false;
    state.collapsed = !state.collapsed;
    applyCollapsed();
  });

  state.el.formPost.addEventListener("submit", postEvent);
  // overflow menu: the workspace works invisibly; only its two actions surface here
  const more = root.querySelector(".fp-more"), menu = root.querySelector(".fp-menu");
  const closeMenu = () => { menu.classList.add("hidden"); more.setAttribute("aria-expanded", "false"); };
  document.getElementById("ui")?.appendChild(menu); // outside the panel: never clipped by its overflow
  const placeMenu = () => {
    const r = more.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.left = `${Math.round(Math.min(r.right, window.innerWidth - 12) - menu.offsetWidth)}px`;
  };
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !open); more.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) { placeMenu(); menu.querySelector("button").focus(); }
  });
  window.addEventListener("resize", () => { if (!menu.classList.contains("hidden")) placeMenu(); });
  document.addEventListener("pointerdown", (e) => { if (!menu.contains(e.target) && e.target !== more) closeMenu(); });
  menu.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closeMenu(); more.focus(); } });
  menu.querySelector('[data-ws="share"]').addEventListener("click", async () => {
    closeMenu();
    const url = shareUrl();
    try { await navigator.clipboard.writeText(url); notice("Link copied"); }
    catch { notice(url); }
    setTimeout(() => notice(""), 2500);
  });
  menu.querySelector('[data-ws="new"]').addEventListener("click", () => {
    closeMenu();
    state.el.wsConfirm.classList.remove("hidden");
    state.el.wsConfirm.querySelector(".fp-ws-go").focus();
  });
  state.el.wsConfirm.querySelector(".fp-ws-cancel").addEventListener("click", () => state.el.wsConfirm.classList.add("hidden"));
  state.el.wsConfirm.querySelector(".fp-ws-go").addEventListener("click", () => startNewWorkspace());
  for (const f of [state.el.formPost]) {
    f.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); f.requestSubmit(); }
    });
  }
  // the map listens for wheel / pointer on the canvas; keep the panel's own
  // scrolling and typing from leaking into camera or the "/" shortcut
  for (const ev of ["wheel", "pointerdown", "keydown"]) root.addEventListener(ev, (e) => e.stopPropagation());

  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshFeedPanel({ quiet: true }); });
  watchResultCard();
  scheduleRefresh();
  root.classList.remove("hidden");
  refreshFeedPanel();
  watchStatus();
}

// Reload the thread for the current city. Called by the app when the city
// changes or the simulation finishes waking (branch id becomes available).
export async function refreshFeedPanel({ quiet = false } = {}) {
  if (!state.root) return;
  const city = state.getCity();
  const seq = ++state.loadSeq;
  syncHeader();
  if (!quiet) { state.el.thread.setAttribute("aria-busy", "true"); }
  try {
    const items = await loadItems(city);
    if (seq !== state.loadSeq) return;
    state.memoryOff = false;
    if (state.chart && !items.some((i) => i.id === state.chart.id)) closeChart();
    state.items = items;
    state.loaded = true;
    notice("");
    renderThread();
    syncHeader();
    previewComments(city);
  } catch (e) {
    if (seq !== state.loadSeq) return;
    if (e.status === 503) {
      state.memoryOff = true;
      state.items = [];
      state.loaded = true;
      renderThread();
      notice("Persona memory is not configured on this backend, so residents cannot remember or react.");
    } else if (!quiet) {
      notice(friendly(e));
    }
    syncHeader();
  } finally {
    state.el.thread.removeAttribute("aria-busy");
  }
}

async function loadItems(city) {
  if (!state.lineageOff) {
    try {
      const data = await api.lineage(city);
      return (data.items || []).slice().reverse();
    } catch (e) {
      if (e.status !== 404) throw e;
      state.lineageOff = true;
    }
  }
  const data = await api.events(city);
  return (data.events || []).map((ev) => ({ type: "event", ...ev }));
}

function scheduleRefresh() {
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (document.hidden || state.memoryOff || state.busy > 0 || state.collapsed) return;
    refreshFeedPanel({ quiet: true });
  }, REFRESH_MS);
}

// ── header / chrome ────────────────────────────────────────────────────────
function syncHeader() {
  const { el } = state;
  el.city.textContent = state.getCityDisplay();
  const branch = state.getBranch();
  const n = state.getResidents();
  const events = state.items.filter((i) => i.type === "event").length;
  const asks = state.items.filter((i) => i.type === "test").length;
  const queries = state.items.filter((i) => i.type === "data_query").length;
  let status;
  if (state.memoryOff) status = "memory off";
  else if (!branch) status = "waking the residents…";
  else status = `${n.toLocaleString()} residents`;
  if (events || asks || queries) {
    const parts = [plural(events, "event"), plural(asks, "survey")];
    if (queries) parts.push(plural(queries, "data query", "data queries"));
    status = `${parts.join(" · ")} in memory · ${status}`;
  }
  el.status.textContent = status;
  el.status.classList.toggle("is-loading", /…$/.test(status) || (!state.loaded && !state.memoryOff));
  const canWrite = !!branch && !state.memoryOff;
  for (const f of [el.formPost]) {
    const btn = f.querySelector(".fp-primary");
    btn.disabled = !canWrite;
    btn.title = canWrite ? "" : (state.memoryOff ? "persona memory is off" : "wait for the residents to wake");
  }
}

// The result card and the panel share the right side of the map. While a
// result is up, fold the panel away; put it back when the card goes. This is
// a temporary state and never touches the remembered preference.
function watchResultCard() {
  const card = document.getElementById("result-card");
  if (!card || typeof MutationObserver === "undefined") return;
  const apply = () => {
    const visible = !card.classList.contains("hidden");
    // the result card owns the map highlight while it is up
    if (visible) closeChart();
    if (visible && !state.collapsed) {
      state.autoCollapsed = true;
      state.collapsed = true;
      applyCollapsed();
    } else if (!visible && state.autoCollapsed) {
      state.autoCollapsed = false;
      state.collapsed = false;
      applyCollapsed();
    }
  };
  new MutationObserver(apply).observe(card, { attributes: true, attributeFilter: ["class"] });
  apply();
}

// The panel sits under the top-right status card, whose height changes with the
// audience text (a filtered audience wraps to several lines). Track it live.
function placeBelowStatus() {
  const status = document.getElementById("status");
  if (!status || !state.root) return;
  const r = status.getBoundingClientRect();
  const hidden = status.classList.contains("hidden") || r.height === 0;
  const top = hidden ? 92 : Math.round(r.bottom + 12);
  state.root.style.top = `${top}px`;
}
function watchStatus() {
  const status = document.getElementById("status");
  if (!status || typeof ResizeObserver === "undefined") return;
  const ro = new ResizeObserver(placeBelowStatus);
  ro.observe(status);
  window.addEventListener("resize", placeBelowStatus);
  placeBelowStatus();
}

const REDUCED = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
const FOLD_MS = 220;
// Expand / collapse the body with a height + opacity fold so the change reads.
function foldBody(show) {
  const b = state.el.body;
  if (REDUCED) { b.hidden = !show; return; }
  clearTimeout(state.foldTimer);
  const ease = `max-height ${FOLD_MS}ms cubic-bezier(.2,.7,.2,1), opacity ${FOLD_MS}ms ease`;
  // A forced reflow between the start and end values makes the transition run
  // deterministically (no reliance on requestAnimationFrame timing).
  if (show) {
    b.hidden = false;
    b.style.transition = "none"; b.style.overflow = "hidden"; b.style.maxHeight = "0px"; b.style.opacity = "0";
    void b.offsetHeight;
    b.style.transition = ease; b.style.maxHeight = `${b.scrollHeight}px`; b.style.opacity = "1";
    state.foldTimer = setTimeout(() => { b.style.maxHeight = ""; b.style.overflow = ""; b.style.transition = ""; b.style.opacity = ""; }, FOLD_MS + 20);
  } else {
    b.style.transition = "none"; b.style.overflow = "hidden"; b.style.maxHeight = `${b.getBoundingClientRect().height}px`; b.style.opacity = "1";
    void b.offsetHeight;
    b.style.transition = ease; b.style.maxHeight = "0px"; b.style.opacity = "0";
    state.foldTimer = setTimeout(() => { b.hidden = true; b.style.maxHeight = ""; b.style.overflow = ""; b.style.transition = ""; b.style.opacity = ""; }, FOLD_MS + 20);
  }
}
function applyCollapsed({ animate = true } = {}) {
  state.root.dataset.collapsed = state.collapsed ? "true" : "false";
  for (const b of state.root.querySelectorAll(".fp-collapse")) b.setAttribute("aria-expanded", state.collapsed ? "false" : "true");
  if (animate) foldBody(!state.collapsed); else state.el.body.hidden = state.collapsed;
  syncHeader();
}

function notice(text) {
  state.el.notice.textContent = text;
  state.el.notice.classList.toggle("hidden", !text);
}

// ── thread ─────────────────────────────────────────────────────────────────
function renderThread() {
  const { thread } = state.el;
  const seen = new Set();
  const frag = document.createDocumentFragment();
  syncViews();
  for (const item of state.items) {
    if (!inView(item)) continue;
    seen.add(item.id);
    let post = state.posts.get(item.id);
    if (!post) {
      post = item.type === "test" ? testPost(item)
        : item.type === "data_query" ? dataQueryPost(item)
        : eventPost(item);
      state.posts.set(item.id, post);
    } else if (post.dataset.busy !== "true") {
      // refresh the parts that can change between loads
      if (item.type === "test") fillTest(post, item);
      else if (item.type === "data_query") fillDataQuery(post, item);
      else fillEvent(post, item);
    }
    frag.appendChild(post);
  }
  for (const id of [...state.posts.keys()]) if (!seen.has(id)) state.posts.delete(id);
  // the city's baseline headlines: what residents already know, as plain posts
  const news = state.view === "all" || state.view === "news" ? (state.getNews() || []) : [];
  for (const a of news.slice(0, 6)) frag.appendChild(newsPost(a));
  const stillWaking = !state.getBranch() && !state.memoryOff;
  if (!frag.childElementCount && (!state.loaded || stillWaking) && !state.memoryOff) {
    // still fetching (or seeding a fresh workspace): skeleton rows, not an empty state
    const sk = document.createElement("div");
    sk.className = "fp-skeleton";
    sk.setAttribute("aria-label", "Loading the timeline");
    sk.innerHTML = `<div class="fp-skel-note"><span class="fp-spinner" aria-hidden="true"></span>${state.getBranch() ? "loading the timeline…" : "waking the residents…"}</div>` +
      Array.from({ length: 3 }, () => `<div class="fp-skel-row"><span class="fp-skel-dot"></span><div><div class="fp-skel-line w40"></div><div class="fp-skel-line w90"></div><div class="fp-skel-line w70"></div></div></div>`).join("");
    frag.appendChild(sk);
  }
  if (!frag.childElementCount) {
    const empty = document.createElement("div");
    empty.className = "fp-empty";
    empty.textContent = state.memoryOff
      ? "Nothing to remember while persona memory is off."
      : state.view === "asks" ? "No surveys yet. Ask the city something from the box below."
      : state.view === "data" ? "No data queries yet. Try \"show the age distribution\"."
      : "The residents remember nothing yet. Post an event and see how they take it.";
    frag.appendChild(empty);
  }
  thread.replaceChildren(frag);
}

// fetch a few comments for the event posts near the top (best-effort)
async function previewComments(city) {
  const targets = state.items.filter((i) => i.type === "event" && (i.reaction_count || 0) > 0).slice(0, PREVIEW_POSTS);
  await Promise.all(targets.map(async (item) => {
    if (item.reactions?.length) return;
    try {
      const data = await api.reactions(city, item.id, PREVIEW_N);
      if (city !== state.getCity()) return;
      const live = state.items.find((e) => e.id === item.id);
      const post = state.posts.get(item.id);
      if (!live || !post || post.dataset.busy === "true") return;
      live.reactions = data.reactions || [];
      // keep the lineage tally: this call is limited to PREVIEW_N rows, so its
      // own sentiment map only covers those
      if (!(live.sentiment && Object.keys(live.sentiment).length) && data.sentiment) live.sentiment = data.sentiment;
      fillEvent(post, live);
    } catch { /* preview only */ }
  }));
}

// ── posts: the news bubble's entry ─────────────────────────────────────────
// uppercase date · kind label, then a bold headline; everything else is quiet.
const dateLabel = (parts) => `<div class="fp-date">${parts.filter(Boolean).map(esc).join(" · ")}</div>`;
const postHead = ({ avatar, avatarClass = "", source = "", date = "" }) => `
    <div class="fp-post-head">
      <span class="fp-avatar ${avatarClass}">${esc(avatar)}</span>
      <span class="fp-source">${esc(source)}</span>
      <span class="fp-date">${esc(date)}</span>
    </div>`;

// ── event post ─────────────────────────────────────────────────────────────
function eventPost(item) {
  const post = document.createElement("article");
  post.className = "fp-post fp-post-event";
  post.dataset.id = item.id;
  post.innerHTML = `
    ${postHead({ avatar: "n", avatarClass: "fp-avatar-event", source: "", date: "" })}
    <div class="fp-title"></div>
    <div class="fp-progress hidden" role="progressbar" aria-label="Residents are reacting"><i></i></div>
    <div class="fp-engage" aria-hidden="true">
      <span class="fp-eng"><i class="fp-ico">${ICONS.heart}</i><span class="fp-eng-n"></span></span>
      <span class="fp-eng"><i class="fp-ico">${ICONS.comment}</i><span class="fp-eng-n"></span></span>
    </div>
    <div class="fp-crowd" aria-hidden="true"></div>
    <div class="fp-reacted"></div>
    <div class="fp-comments"></div>
    <div class="fp-post-actions"></div>`;
  fillEvent(post, item);
  return post;
}

function fillEvent(post, item, { pending = 0 } = {}) {
  const kind = item.kind || "news";
  post.querySelector(".fp-avatar").textContent = kind[0];
  post.querySelector(".fp-source").textContent = `${state.getCity()} · ${kind}`;
  post.querySelector(".fp-date").textContent = fmtDate(item.as_of_date);
  post.querySelector(".fp-title").textContent = item.text || "";
  post.querySelector(".fp-progress")?.classList.toggle("hidden", !pending);
  const counts = item.sentiment && Object.keys(item.sentiment).length ? item.sentiment : tally(item.reactions);
  const total = item.reaction_count || Object.values(counts).reduce((a, b) => a + b, 0);
  const [heartN, commentN] = post.querySelectorAll(".fp-eng-n");
  heartN.textContent = total ? total.toLocaleString() : "";
  commentN.textContent = total ? total.toLocaleString() : "";

  // crowd strip: one square per resident, grouped by sentiment in canonical order
  const crowd = post.querySelector(".fp-crowd");
  const squares = [];
  for (const s of SENTIMENTS) for (let i = 0; i < (counts[s] || 0); i++) squares.push(`<i data-s="${s}"></i>`);
  for (let i = 0; i < pending; i++) squares.push(`<i class="fp-sq-pending"></i>`);
  crowd.innerHTML = squares.join("");
  crowd.classList.toggle("hidden", !squares.length);

  const reacted = post.querySelector(".fp-reacted");
  if (total) {
    const parts = SENTIMENTS.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
    reacted.textContent = [`${plural(total, "resident")} reacted`, ...parts].join(" · ");
  } else {
    reacted.textContent = pending ? `asking ${pending} residents…` : "no reactions yet";
  }

  const comments = post.querySelector(".fp-comments");
  const shown = (item.reactions || []).slice(0, 3);
  comments.innerHTML = shown.map(commentNode).join("");
  if (pending) comments.insertAdjacentHTML("beforeend", `<div class="fp-skel"><i></i></div>`.repeat(2));

  renderEventActions(post, item, { busy: pending > 0 });
}

function commentNode(r) {
  const s = sentimentOf(r.sentiment);
  const who = [r.occupation, r.neighborhood].filter(Boolean).join(" · ");
  return `
    <div class="fp-comment">
      <span class="fp-avatar fp-avatar-sm" data-s="${s}">${esc(initials(r.name))}</span>
      <div class="fp-comment-body">
        <div class="fp-comment-text"><b>${esc(r.name)}</b> ${esc(r.text)} <span class="fp-comment-s">${s}</span></div>
        ${who ? `<div class="fp-comment-who">${esc(who)}</div>` : ""}
      </div>
    </div>`;
}

function renderEventActions(post, item, { busy = false, note = "", error = false } = {}) {
  const box = post.querySelector(".fp-post-actions");
  if (!box) return;
  box.replaceChildren();
  if (busy) return;
  const total = item.reaction_count || 0;
  const shown = (item.reactions || []).length;
  const branch = state.getBranch();
  const link = (text, onClick, primary = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = primary ? "fp-link fp-link-primary" : "fp-link";
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  };
  if (total > shown) box.appendChild(link(`View all ${total} comments`, () => showAll(item.id)));
  if (branch && !state.memoryOff) {
    box.appendChild(link(total ? `Ask ${REACT_N} more residents` : "Ask residents", () => reactTo(item.id), !total));
  }
  if (note) {
    const n = document.createElement("span");
    n.className = error ? "fp-note fp-note-error" : "fp-note";
    n.textContent = note;
    box.appendChild(n);
  }
}

async function showAll(eventId) {
  const item = state.items.find((e) => e.id === eventId);
  const post = state.posts.get(eventId);
  if (!item || !post) return;
  renderEventActions(post, item, { note: "loading…" });
  try {
    const data = await api.reactions(state.getCity(), eventId);
    item.reactions = data.reactions || [];
    item.reaction_count = Math.max(item.reaction_count || 0, item.reactions.length);
    if (data.sentiment && Object.keys(data.sentiment).length) item.sentiment = data.sentiment;
    fillEvent(post, item);
    post.querySelector(".fp-comments").innerHTML = item.reactions.map(commentNode).join("");
    renderEventActions(post, { ...item, reactions: item.reactions });
  } catch (e) {
    renderEventActions(post, item, { note: friendly(e), error: true });
  }
}

// Reactions arrive in two halves so the first residents show up in a couple of
// seconds while the rest are still answering.
async function reactTo(eventId, { pending = REACT_N } = {}) {
  const item = state.items.find((e) => e.id === eventId);
  const post = state.posts.get(eventId);
  const branch = state.getBranch();
  if (!item || !post || !branch) return;
  post.dataset.busy = "true";
  state.busy++;
  let remaining = pending;
  fillEvent(post, item, { pending: remaining });
  const absorb = (fresh) => {
    const counts = { ...(item.sentiment || {}) };
    for (const r of fresh) { const s = sentimentOf(r.sentiment); counts[s] = (counts[s] || 0) + 1; }
    item.sentiment = counts;
    item.reaction_count = (item.reaction_count || 0) + fresh.length;
    item.reactions = [...fresh, ...(item.reactions || [])];
  };
  try {
    const first = Math.max(1, Math.floor(pending / 2));
    const batches = pending > 3 ? [first, pending - first] : [pending];
    for (const n of batches) {
      const res = await api.react(branch, eventId, n);
      absorb(res.reactions || []);
      remaining -= n;
      fillEvent(post, item, { pending: Math.max(0, remaining) });
    }
    post.dataset.busy = "false";
    fillEvent(post, item);
  } catch (e) {
    post.dataset.busy = "false";
    fillEvent(post, item);
    renderEventActions(post, item, { note: friendly(e), error: true });
  } finally {
    state.busy--;
  }
}

// ── test post ──────────────────────────────────────────────────────────────
function testPost(item) {
  const post = document.createElement("article");
  post.className = "fp-post fp-post-test";
  post.dataset.id = item.id;
  post.innerHTML = `
    ${postHead({ avatar: "?", avatarClass: "fp-avatar-ask", source: "you asked", date: "" })}
    <div class="fp-title"></div>
    <div class="fp-result"></div>
    <div class="fp-bar" aria-hidden="true"><i class="fp-bar-yes"></i><i class="fp-bar-no"></i></div>
    <div class="fp-memory"></div>
    <div class="fp-hypo hidden"></div>
    <div class="fp-post-actions"></div>
    <div class="fp-chart hidden"></div>`;
  fillTest(post, item);
  return post;
}

function fillTest(post, item) {
  const kind = TEST_KINDS[item.kind] || item.kind || "survey";
  post.querySelector(".fp-date").textContent = [fmtWhen(item.created_at), kind].join(" · ");
  post.querySelector(".fp-title").textContent = item.question || "";
  const options = Array.isArray(item.options) ? item.options : [];
  const dist = Array.isArray(item.p_distribution) ? item.p_distribution : [];
  const isOptions = options.length > 0 && dist.length > 0;
  let p = Number.isFinite(item.p_yes) ? item.p_yes : 0;
  let framing = item.framing === "belief" ? "say it will happen" : "would vote yes";
  if (isOptions) {
    let best = 0; dist.forEach((v, i) => { if (v > dist[best]) best = i; });
    p = dist[best] ?? 0;
    framing = `chose “${options[best] ?? ""}”`;
  }
  const pct = Math.round(p * 100);
  post.querySelector(".fp-bar-yes").style.width = `${pct}%`;
  const meta = [item.n_agents ? `${item.n_agents.toLocaleString()} residents` : "", item.model || ""].filter(Boolean).join(" · ");
  post.querySelector(".fp-result").innerHTML = `<b>${pct}% ${esc(framing)}</b>${meta ? ` <span class="fp-muted">· ${esc(meta)}</span>` : ""}`;
  const title = post.querySelector(".fp-title");
  if (state.openPastResult) {
    title.classList.add("fp-title-link");
    title.setAttribute("role", "button"); title.tabIndex = 0; title.title = "Open this result";
    if (!title.dataset.bound) {
      title.dataset.bound = "1";
      const open = () => { const it = state.items.find((i) => i.id === post.dataset.id); if (it) state.openPastResult(it); };
      title.addEventListener("click", open);
      title.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    }
  }
  const mem = post.querySelector(".fp-memory");
  const known = Number.isFinite(item.events_known) ? item.events_known : null;
  let memHtml = known === null ? "" : `asked with ${plural(known, "event")} in memory`;
  const pts = Number.isFinite(item.delta) ? Math.round(item.delta * 100) : 0;
  if (pts !== 0) {
    memHtml += ` <span class="fp-delta" data-dir="${pts > 0 ? "up" : "down"}">${pts > 0 ? "+" : ""}${pts} pts since last asked</span>`;
  }
  mem.innerHTML = memHtml;
  mem.classList.toggle("hidden", !memHtml);
  const hypo = post.querySelector(".fp-hypo");
  hypo.textContent = item.under_event ? `under hypothetical: ${item.under_event}` : "";
  hypo.classList.toggle("hidden", !item.under_event);
  renderChartLink(post, item, "Explore demographic evidence");
}

// ── charts inside entries ──────────────────────────────────────────────────
// One chart is open at a time. Opening it takes over the map highlight the same
// way the result card's evidence panel does; closing it (or a result card
// opening) clears the highlight.
function renderChartLink(post, item, label) {
  const box = post.querySelector(".fp-post-actions");
  if (!box) return;
  box.replaceChildren();
  const open = state.chart?.id === item.id;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "fp-link";
  b.setAttribute("aria-expanded", open ? "true" : "false");
  b.textContent = open ? "Hide chart" : label;
  b.addEventListener("click", () => (open ? closeChart() : openChart(item)));
  box.appendChild(b);
}

function closeChart() {
  const c = state.chart;
  if (!c) return;
  state.chart = null;
  c.dispose?.();
  c.host.replaceChildren();
  c.host.classList.add("hidden");
  state.setSegmentSelection(null);
  const item = state.items.find((i) => i.id === c.id);
  const post = state.posts.get(c.id);
  if (item && post) renderChartLink(post, item, item.type === "test" ? "Explore demographic evidence" : "View chart");
}

function openChart(item) {
  closeChart();
  const post = state.posts.get(item.id);
  const host = post?.querySelector(".fp-chart");
  if (!host) return;
  host.classList.remove("hidden");
  state.chart = { id: item.id, host, dispose: null };
  if (item.type === "test") mountEvidenceChart(item, host);
  else mountVerifiedChart(item, host);
  renderChartLink(post, item, item.type === "test" ? "Explore demographic evidence" : "View chart");
}

// ids inside the chart markup are meant for the result card; inside the panel
// they would collide with it, so strip them (bindings use classes/attributes)
function stripIds(host) {
  for (const el of host.querySelectorAll("[id]")) el.removeAttribute("id");
}

function mountEvidenceChart(item, host) {
  const stored = item.breakdowns && typeof item.breakdowns === "object" ? item.breakdowns : null;
  const model = stored ? buildEvidenceChartModel({ question: item.question, ...stored }) : { breakdowns: [], options: [] };
  const norm0 = (q) => String(q || "").trim().toLowerCase();
  const repeats = state.items.filter((i) => i.type === "test" && norm0(i.question) === norm0(item.question) && i.framing === item.framing).length;
  if (!model.breakdowns.some((b) => b.groups.length) && repeats < 2) {
    host.innerHTML = `<p class="fp-chart-empty">No demographic breakdowns were stored for this question.</p>`;
    return;
  }
  const options = Array.isArray(item.options) ? item.options : [];
  const dist = Array.isArray(item.p_distribution) ? item.p_distribution : [];
  const framing = options.length && dist.length ? "options" : (item.framing || "vote");
  let topIndex = 0; dist.forEach((v, i) => { if (v > dist[topIndex]) topIndex = i; });
  const norm = (q) => String(q || "").trim().toLowerCase();
  const asks = state.items.filter((i) => i.type === "test" && norm(i.question) === norm(item.question) && i.framing === item.framing)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const history = asks.map((i) => ({
    id: i.id, created_at: i.created_at, label: fmtWhen(i.created_at).replace(/^.*?,\s*/, ""), events_known: i.events_known, item: i, current: i.id === item.id,
    p_yes: Array.isArray(i.p_distribution) && i.p_distribution.length && (i.options || []).length ? Math.max(...i.p_distribution) : i.p_yes,
  }));
  const events = state.items.filter((i) => i.type === "event").map((e) => ({ created_at: e.created_at, text: e.text }));
  const inst = createPersonaChart(host, {
    question: item.question, framing, options, topIndex, model, compact: true,
    testId: item.id, fetchPersonal: state.fetchPersonal ? (ids) => state.fetchPersonal(item.id, ids) : null,
    residents: state.getRawResidents(), answers: null, answersNote: "Loading each resident's answer…",
    history, events,
    labels: { dimension: (d) => state.dimensionLabels[d] || d, group: state.groupLabel },
    drawHead: state.drawHead,
    openPerson: state.openPerson,
    onGroupSelect: (segments) => state.setSegmentSelection(segments?.length ? { clauses: segments, operator: "or" } : null),
    onOpenAsk: state.openPastResult ? (h) => { if (h?.item) state.openPastResult(h.item); } : null,
    sourceHint: state.sourceHint,
  });
  state.chart.dispose = () => inst.destroy();
  const chartRef = state.chart;
  state.fetchAnswers(item.id).then((answers) => {
    if (state.chart !== chartRef) return;
    const mine = state.getPopulationKey();
    const same = !item.population_key || !mine || item.population_key === mine || item.population_key.endsWith(":" + mine);
    if (answers && answers.size && same) inst.setAnswers(answers, "");
    else inst.setAnswers(null, answers && answers.size && !same
      ? "These residents were asked in a different simulation, so this view shows group shares without per-person answers."
      : "Per-resident answers aren't available for this result, so this view shows group shares.");
  });
}

function mountVerifiedChart(item, host) {
  const model = buildVerifiedDataModel(item.response || {});
  if (!model.question) model.question = item.question || "";
  const chart = { model, selection: { segments: [] }, combine: false };
  const render = () => {
    const result = verifiedMapSelection(chart.model, chart.selection, state.getRawResidents(), state.getCity());
    state.setSegmentSelection(result.selection);
    host.innerHTML = renderVerifiedData(chart.model, chart.selection, result.count, result.ready);
    stripIds(host);
    const combine = host.querySelector(".combine-control input");
    if (combine) combine.checked = chart.combine;
  };
  host.addEventListener("change", (e) => {
    if (e.target.matches(".combine-control input")) chart.combine = e.target.checked;
  });
  state.chart.dispose = bindVerifiedData(host, {
    getModel: () => chart.model,
    getSelection: () => chart.selection,
    onSelectionChange: (next, action) => {
      chart.selection = chart.combine && action.type === "select"
        ? { segments: [...chart.selection.segments.filter((s) => s.key !== action.key), { dimension: action.dimension, key: action.key }] }
        : next;
      render();
    },
  });
  render();
}

// ── verified-data post ─────────────────────────────────────────────────────
function dataQueryPost(item) {
  const post = document.createElement("article");
  post.className = "fp-post fp-post-query";
  post.dataset.id = item.id;
  post.innerHTML = `
    ${postHead({ avatar: "#", avatarClass: "fp-avatar-data", source: "verified data", date: "" })}
    <div class="fp-title"></div>
    <div class="fp-answer"></div>
    <div class="fp-post-actions"></div>
    <div class="fp-chart hidden"></div>`;
  fillDataQuery(post, item);
  return post;
}

function fillDataQuery(post, item) {
  post.querySelector(".fp-date").textContent = [fmtWhen(item.created_at), "verified data"].join(" · ");
  post.querySelector(".fp-title").textContent = item.question || "";
  const answer = post.querySelector(".fp-answer");
  answer.textContent = item.answer || "";
  answer.classList.toggle("hidden", !item.answer);
  renderChartLink(post, item, "View chart");
}

// ── baseline headlines ─────────────────────────────────────────────────────
function newsPost(a) {
  const post = document.createElement("article");
  post.className = "fp-post fp-post-news";
  post.innerHTML = `
    ${postHead({ avatar: "d", avatarClass: "fp-avatar-desk", source: "city desk", date: a.date ? fmtDate(a.date) : "" })}
    <div class="fp-title"></div>
    <div class="fp-sum"></div>`;
  post.querySelector(".fp-title").textContent = a.headline || "";
  post.querySelector(".fp-sum").textContent = a.summary || "";
  return post;
}

// ── composer actions ───────────────────────────────────────────────────────
async function postEvent(ev) {
  ev.preventDefault();
  const f = state.el.formPost;
  const err = f.querySelector(".fp-error");
  err.textContent = "";
  const text = f.elements.text.value.trim();
  const as_of_date = f.elements.as_of_date.value || today();
  const kind = state.el.kind.value || detectKind(text);
  if (!text) { err.textContent = "Write what happened first."; f.elements.text.focus(); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(as_of_date)) { err.textContent = "Pick a valid date."; return; }
  const btn = f.querySelector(".fp-primary");
  btn.disabled = true; btn.textContent = "Posting…";
  try {
    const { event } = await api.postEvent(state.getCity(), { text, as_of_date, kind });
    f.elements.text.value = "";
    state.kindManual = false; setKind("news");
    if (state.view !== "all" && state.view !== "news") setView("all");
    const item = { type: "event", ...event, reaction_count: 0, sentiment: {}, reactions: [] };
    state.items = [item, ...state.items.filter((e) => e.id !== item.id)];
    renderThread();
    state.el.body.scrollTo({ top: state.el.thread.offsetTop - 8, behavior: "smooth" });
    btn.textContent = "Residents reacting…";
    await reactTo(item.id);
  } catch (e) {
    err.textContent = friendly(e);
  } finally {
    btn.textContent = "Post";
    syncHeader();
  }
}

