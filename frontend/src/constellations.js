// ─────────────────────────────────────────────────────────────────────────
// Constellations — an optional starfield view of how the simulated residents
// grouped on one question. The city renderer is never touched: this module
// builds its own canvas + chrome, paints over the map while active, and tears
// everything down on destroy().
//
// What a star is, precisely: an *illustrative* placement of one synthetic
// resident inside a response group. The backend returns weighted aggregate
// shares, not independent per-resident votes, so a star is a drawing of the
// group it was placed in — never a recorded individual answer. Lines inside a
// cluster mark nearest neighbours in that drawing; they are not social ties.
// Both statements stay on screen (`.cst-note`) whenever the view is up.
//
// Performance: only a bounded, evenly-spaced subset of each group is drawn
// (BUDGET.stars*). The full population is retained on the model — `shown` vs
// `count` per group, and the header states both — so nothing is thrown away,
// the frame cost is just capped. Dust, connections and labels are baked into a
// static layer on layout; the per-frame loop only redraws the glowing stars,
// and under prefers-reduced-motion there is no loop at all.
//
// Public surface (the agreed interface):
//   initConstellations(map, state) -> { setActive(active), setResult(model), destroy() }
//   model: { question, groups: [{ id, label, share, members }], illustrative: true }
// The pure layout helpers below are exported for tests; they never touch the DOM.
// ─────────────────────────────────────────────────────────────────────────

// Night surface the palette was validated against.
export const SKY = { surface: "#0a0f1f", dust: "rgba(226, 232, 245, 0.5)", ink: "#f2f5fb", inkSoft: "#aeb8cd" };

// Validated dark categorical palette, in slot order (worst adjacent CVD ΔE 8.4
// on SKY.surface, worst adjacent normal-vision ΔE 19.3, all ≥ 3:1 contrast).
// Slots are handed out per group id in first-seen order and never cycled, so a
// re-grouped result keeps each group's colour. A ninth group draws neutral and
// leans on its direct label — every cluster is labelled, so identity is never
// carried by colour alone.
const GROUP_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const NEUTRAL = "#9aa3b8";

// Drawing budget. Mobile gets a smaller subset: fewer pixels, same story.
export const BUDGET = Object.freeze({
  starsDesktop: 240,
  starsMobile: 110,
  minPerGroup: 3,
  edgesPerGroup: 90,
  edgesTotal: 420,
  dust: 150,
});

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

// Deterministic RNG: the same model and viewport always produce the same sky,
// so a star does not jump to a new place when the view is toggled.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ── model ────────────────────────────────────────────────────────────────
// Accepts the agreed model and tolerates the shapes a real backend payload
// arrives in (members as personas or ids, an explicit count instead of a list,
// share as a fraction or a percentage). Anything unusable returns null rather
// than drawing a half-built sky.
export function normalizeModel(model) {
  if (!model || !Array.isArray(model.groups)) return null;
  const seen = new Set();
  const groups = [];
  for (const raw of model.groups) {
    if (!raw) continue;
    const members = Array.isArray(raw.members) ? raw.members.filter((m) => m != null) : [];
    const declared = isNum(raw.member_count) ? raw.member_count : isNum(raw.count) ? raw.count : null;
    const count = Math.max(0, Math.round(declared ?? members.length));
    let share = isNum(raw.share) ? raw.share : null;
    if (share != null && share > 1) share /= 100;          // a percentage, not a fraction
    if (share != null) share = clamp(share, 0, 1);
    if (!count && !share) continue;
    let id = typeof raw.id === "string" && raw.id ? raw.id : `group-${groups.length + 1}`;
    while (seen.has(id)) id = `${id}·${groups.length + 1}`;  // ids must stay unique: colour keys off them
    seen.add(id);
    groups.push({
      id,
      label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id,
      explanation: typeof raw.explanation === "string" ? raw.explanation : null,
      share, count, members,
    });
  }
  if (!groups.length) return null;
  const countTotal = groups.reduce((s, g) => s + g.count, 0);
  const shareTotal = groups.reduce((s, g) => s + (g.share ?? 0), 0);
  for (const g of groups) {
    // Weight for drawing only: a backend share when there is one (B keeps the
    // survey weighting intact), otherwise the member split. Never recomputed
    // from the stars we happen to draw.
    g.weight = g.share != null && shareTotal > 0 ? g.share / shareTotal
      : countTotal > 0 ? g.count / countTotal
      : 1 / groups.length;
  }
  return {
    question: typeof model.question === "string" ? model.question : "",
    provenance: typeof model.provenance === "string" ? model.provenance : null,
    // An absent flag is treated as illustrative: the cautious reading is the
    // safe one, and nothing here ever establishes individual votes.
    illustrative: model.illustrative !== false,
    mock: model.mock === true,
    groups, totalMembers: countTotal,
  };
}

// ── layout ───────────────────────────────────────────────────────────────
// Clusters sit in a grid sized to the viewport, so labels have room and never
// collide: one cluster, one label, one cell. Cell order follows the model's
// group order (colour keys off id, so order is presentation only).
function gridFor(n, width, height) {
  const aspect = width / Math.max(1, height);
  let cols = clamp(Math.round(Math.sqrt(n * aspect)), 1, n);
  if (width < 560) cols = Math.min(cols, 2);
  const rows = Math.ceil(n / cols);
  // Re-derive the columns from the rows so the last row is never left with a
  // single lonely cluster: 5 clusters across 2 rows become 3 + 2, not 4 + 1.
  cols = Math.ceil(n / rows);
  return { cols, rows };
}

// Clusters per row, as even as the count allows, with the remainder going to
// the top rows so the last row is never the fullest.
function rowCounts(n, rows) {
  const base = Math.floor(n / rows);
  let extra = n % rows;
  return Array.from({ length: rows }, () => base + (extra-- > 0 ? 1 : 0));
}

// Best-candidate sampling: a few tries per star, keep the one furthest from
// what is already placed. Cheap, and it reads as a constellation rather than
// as a clump.
function scatter(rng, n, radius) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    let best = null, bestD = -1;
    const tries = i === 0 ? 1 : 8;
    for (let t = 0; t < tries; t++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * radius;          // uniform over the disc
      const p = { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.86 };  // slightly oblate: reads as a constellation
      let d = Infinity;
      for (const q of pts) d = Math.min(d, (p.x - q.x) ** 2 + (p.y - q.y) ** 2);
      if (d > bestD) { bestD = d; best = p; }
    }
    pts.push(best);
  }
  return pts;
}

// Bounded connections: each star links to its nearest neighbours inside its own
// group, capped per group and overall. Never across groups.
function connect(stars, perGroupCap) {
  const edges = [];
  const seen = new Set();
  for (let i = 0; i < stars.length && edges.length < perGroupCap; i++) {
    const a = stars[i];
    let n1 = -1, d1 = Infinity, n2 = -1, d2 = Infinity;
    for (let j = 0; j < stars.length; j++) {
      if (j === i) continue;
      const b = stars[j];
      const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
      if (d < d1) { n2 = n1; d2 = d1; n1 = j; d1 = d; }
      else if (d < d2) { n2 = j; d2 = d; }
    }
    for (const j of [n1, n2]) {
      if (j < 0 || edges.length >= perGroupCap) continue;
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ ax: a.x, ay: a.y, bx: stars[j].x, by: stars[j].y });
    }
  }
  return edges;
}

// Evenly spaced indices across the whole group — a representative subset, not
// the first N. The untouched member list stays on the group.
function subsetIndices(count, shown) {
  const out = [];
  if (count <= 0 || shown <= 0) return out;
  if (shown >= count) { for (let i = 0; i < count; i++) out.push(i); return out; }
  for (let k = 0; k < shown; k++) out.push(Math.floor((k * count) / shown));
  return out;
}

// Star budget per group: proportional to the group's weight, at least
// minPerGroup (or the group's own size, if smaller), never above the cap.
//
// A group never draws more stars than it has personas for, so every star on
// screen can be inspected. A group that arrives as an aggregate (a share and a
// count, no member list) still gets its weighted allocation — those stars carry
// no persona, and the card says so rather than inventing one.
function allocate(groups, budget) {
  const want = groups.map((g) => {
    const sampled = g.members.length;
    const size = sampled || g.count || Math.max(1, Math.round(g.weight * budget));
    return Math.min(size, Math.max(BUDGET.minPerGroup, Math.round(g.weight * budget)));
  });
  let total = want.reduce((s, n) => s + n, 0);
  // Trim the largest allocations first until the whole sky fits the budget.
  while (total > budget) {
    let pick = -1, max = -1;
    for (let i = 0; i < want.length; i++) if (want[i] > 1 && want[i] > max) { max = want[i]; pick = i; }
    if (pick < 0) break;
    want[pick]--; total--;
  }
  return want;
}

export function planLayout(model, options = {}) {
  const normalized = model && model.groups && model.groups[0]?.weight != null ? model : normalizeModel(model);
  const width = Math.max(1, Math.round(options.width ?? 0));
  const height = Math.max(1, Math.round(options.height ?? 0));
  const empty = { width, height, groups: [], stars: [], edgeCount: 0, totalShown: 0, totalMembers: 0, dust: [] };
  if (!normalized || width < 2 || height < 2) return empty;

  const mobile = width < 560 || height < 520;
  const budget = options.maxStars ?? (mobile ? BUDGET.starsMobile : BUDGET.starsDesktop);
  // Room for the app's own chrome (title, status, bottom dock) plus this view's
  // header and note, so clusters and labels never land under either.
  const insets = options.insets ?? (mobile
    ? { top: 184, right: 14, bottom: 196, left: 14 }
    : { top: 150, right: 28, bottom: 188, left: 28 });
  const box = {
    x: insets.left,
    y: insets.top,
    w: Math.max(60, width - insets.left - insets.right),
    h: Math.max(60, height - insets.top - insets.bottom),
  };

  const seedBase = hashString(`${normalized.question}|${normalized.groups.map((g) => g.id).join(",")}|${width}x${height}`);
  const { cols, rows } = gridFor(normalized.groups.length, box.w, box.h);
  const perRow = rowCounts(normalized.groups.length, rows);
  const cellH = box.h / rows;
  const maxWeight = Math.max(...normalized.groups.map((g) => g.weight));
  const want = allocate(normalized.groups, budget);

  // Cell index per group: its row, and its column inside that row (a short row
  // is centred, so a 3 + 2 grid does not leave a cluster hanging at one edge).
  const cellOf = [];
  for (let row = 0, g = 0; row < rows; row++) {
    for (let col = 0; col < perRow[row]; col++, g++) cellOf.push({ row, col, inRow: perRow[row] });
  }

  const groups = [];
  const stars = [];
  let edgeCount = 0;
  normalized.groups.forEach((g, i) => {
    const { row, col, inRow } = cellOf[i];
    const cellW = box.w / inRow;
    const cx = box.x + cellW * (col + 0.5);
    // Clusters sit a little above their cell centre; the label takes the space below.
    const cy = box.y + cellH * (row + 0.5) - Math.min(18, cellH * 0.08);
    const span = Math.min(cellW, cellH);
    const scale = maxWeight > 0 ? 0.5 + 0.5 * Math.sqrt(g.weight / maxWeight) : 1;
    const radius = Math.max(16, span * 0.3 * scale);

    // Never more stars than the group has personas for (see allocate).
    const available = g.members.length || g.count;
    const shown = Math.max(1, Math.min(want[i], available || want[i]));
    const picks = subsetIndices(available || shown, shown);
    const rng = mulberry32(seedBase + hashString(g.id));
    const points = scatter(rng, picks.length, radius);
    const starR = clamp(radius * 0.085, 2.1, 4.6);

    const groupStars = points.map((p, k) => {
      const memberIndex = picks[k] ?? k;
      const member = g.members[memberIndex] ?? null;
      return {
        x: cx + p.x, y: cy + p.y,
        r: starR * (0.8 + rng() * 0.5),
        phase: rng() * Math.PI * 2,
        groupId: g.id, groupLabel: g.label, color: null,  // colour is assigned by the renderer's stable slot map
        memberIndex, member,
      };
    });
    const edges = connect(groupStars, BUDGET.edgesPerGroup);
    const allowed = Math.max(0, BUDGET.edgesTotal - edgeCount);
    const kept = edges.slice(0, allowed);
    edgeCount += kept.length;

    groups.push({
      id: g.id, label: g.label, explanation: g.explanation,
      share: g.share, weight: g.weight, count: g.count,
      shown: groupStars.length, cx, cy, radius,
      labelX: cx, labelY: cy + radius + 26, labelMaxW: cellW - 10,
      stars: groupStars, edges: kept,
    });
    for (const s of groupStars) stars.push(s);
  });

  // Background dust: static, deterministic, never interactive.
  const dustRng = mulberry32(seedBase ^ 0x9e3779b9);
  const dust = [];
  for (let i = 0; i < BUDGET.dust; i++) {
    dust.push({ x: dustRng() * width, y: dustRng() * height, r: 0.4 + dustRng() * 0.9, a: 0.18 + dustRng() * 0.3 });
  }

  return {
    width, height, insets, mobile, groups, stars, dust, edgeCount,
    totalShown: stars.length,
    totalMembers: normalized.totalMembers,
    question: normalized.question,
    illustrative: normalized.illustrative,
    mock: normalized.mock,
    provenance: normalized.provenance,
  };
}

// Nearest star to a point, inside a forgiving radius (a finger is not a pixel).
export function hitTestStars(layout, x, y, tolerance = 0) {
  if (!layout?.stars?.length) return null;
  let best = null, bestD = Infinity;
  for (const s of layout.stars) {
    const reach = Math.max(tolerance || 0, s.r * 2.6, 11);
    const d = (s.x - x) ** 2 + (s.y - y) ** 2;
    if (d <= reach * reach && d < bestD) { bestD = d; best = s; }
  }
  return best;
}

// ── mock data (development only) ─────────────────────────────────────────
// Labelled as mock everywhere it surfaces: the renderer shows a "mock data"
// badge whenever `mock: true`, so a stub sky can never be mistaken for a run.
const MOCK_NAMES = ["Mei Chen", "Andre Brooks", "Rosa Delgado", "Tom Keller", "Priya Nair", "Sam Okafor", "Lena Vogt", "Marcus Hale", "Yuki Tanaka", "Ava Romero", "Dmitri Sokolov", "Grace Mbeki"];
const MOCK_HOODS = ["the Sunset", "Mission", "Bayview", "Richmond", "SoMa", "North Beach"];
const MOCK_JOBS = ["nurse", "bus operator", "line cook", "software engineer", "teacher", "retired"];
const MOCK_GROUPS = [
  { id: "mock-strong-yes", label: "Strong yes", share: 0.34, why: "sees it as overdue (mock)" },
  { id: "mock-lean-yes", label: "Leaning yes, with conditions", share: 0.26, why: "wants the cost spelled out (mock)" },
  { id: "mock-unsure", label: "Unsure / needs detail", share: 0.18, why: "has not heard enough (mock)" },
  { id: "mock-lean-no", label: "Leaning no", share: 0.14, why: "doubts it reaches their block (mock)" },
  { id: "mock-strong-no", label: "Strong no", share: 0.08, why: "opposes the spending (mock)" },
];

export function createMockModel({ groups = 5, population = 10000, question = "Should the city expand late-night transit service? (mock question)" } = {}) {
  const rng = mulberry32(20261010);
  const picked = MOCK_GROUPS.slice(0, clamp(groups, 1, MOCK_GROUPS.length));
  const total = picked.reduce((s, g) => s + g.share, 0);
  return {
    question, illustrative: true, mock: true,
    provenance: "mock fixture — no model call, no backend",
    groups: picked.map((g, gi) => {
      const count = Math.max(1, Math.round((g.share / total) * population));
      const members = [];
      for (let i = 0; i < Math.min(count, 60); i++) {
        members.push({
          id: gi * 1000 + i,
          name: MOCK_NAMES[(gi * 7 + i) % MOCK_NAMES.length],
          age: 22 + Math.floor(rng() * 55),
          neighborhood: MOCK_HOODS[(gi * 3 + i) % MOCK_HOODS.length],
          occupation: MOCK_JOBS[(gi * 5 + i) % MOCK_JOBS.length],
          explanation: g.why,
          synthetic: true,
        });
      }
      return { id: g.id, label: g.label, share: g.share, member_count: count, members };
    }),
  };
}

// ── renderer ─────────────────────────────────────────────────────────────
const SR_ONLY = "cst-sr-only";
// Canvas `font` does not resolve CSS custom properties, so the stack is literal
// here — the same families styles.css asks for, minus the variable.
const FONT = '"neue-haas-grotesk-display", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
const pct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

class Constellations {
  constructor(map, state, options = {}) {
    this.map = map || null;
    this.state = state || null;
    this.host = options.host || document.body;
    this.active = false;
    this.model = null;
    this.layout = null;
    this.dirty = true;
    this.selected = null;
    this.focusIndex = -1;
    this._raf = null;
    this._resizeRaf = null;
    this._glow = new Map();     // colour → pre-rendered glow sprite
    this._slots = new Map();    // group id → colour slot, stable across results
    this._nextSlot = 0;

    this._ensureStylesheet();
    this._build();
    this._bind();
  }

  // Ship the view's own stylesheet so the renderer stands alone: the demo
  // harness and an integrated index.html both work, and a <link> already in
  // the page is left as the only copy.
  _ensureStylesheet() {
    try {
      if (document.querySelector("link[data-constellations]")) return;
      const href = new URL("../constellations.css", import.meta.url).href;
      if ([...document.styleSheets].some((s) => s.href === href)) return;
      const link = el("link");
      link.rel = "stylesheet"; link.href = href;
      link.dataset.constellations = "";
      // An injected sheet arrives a tick or two late. Until it does the view is
      // laid out from inline structure alone (see _build), and the first frame
      // after it lands is re-measured against the real chrome.
      link.addEventListener("load", () => {
        if (!this.els) return;
        this.dirty = true;
        if (this.active) { this._relayout(); this._drawFrame(performance.now()); }
      }, { once: true });
      document.head.append(link);
    } catch { /* a missing stylesheet degrades to unstyled chrome, not a crash */ }
  }

  _build() {
    const root = el("div", "cst-root");
    root.hidden = true;
    root.setAttribute("aria-hidden", "true");
    // Structure is inline, cosmetics are in constellations.css: the view has to
    // cover the city canvas and receive its own clicks even in the window
    // before an injected stylesheet loads, or if the sheet is missing entirely.
    // An integrator who wants a different stacking order sets root.style.zIndex.
    root.style.cssText = "position:fixed;inset:0;z-index:3;";

    const canvas = el("canvas", "cst-sky");
    canvas.style.cssText = "position:absolute;inset:0;display:block;width:100%;height:100%;background:#0a0f1f;touch-action:none;";
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Constellation view of simulated response groups. Group shares are listed below the view; use the arrow keys to move between residents and Enter to inspect one.");

    const header = el("div", "cst-header");
    const kicker = el("div", "cst-kicker", "constellations");
    const badge = el("span", "cst-badge cst-badge--mock", "mock data");
    badge.hidden = true;
    kicker.append(badge);
    const question = el("h2", "cst-question");
    const meta = el("div", "cst-meta");
    header.append(kicker, question, meta);

    const legend = el("ul", "cst-legend");
    const note = el("div", "cst-note");
    const summary = el("div", SR_ONLY);   // the table view, for screen readers

    const card = el("div", "cst-card");
    card.hidden = true;
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "false");
    card.setAttribute("aria-label", "Simulated resident");

    root.append(canvas, header, legend, note, summary, card);
    this.host.append(root);
    this.els = { root, canvas, header, kicker, badge, question, meta, legend, note, summary, card };
    this.ctx = canvas.getContext("2d");
    this.staticLayer = document.createElement("canvas");
    this.staticCtx = this.staticLayer.getContext("2d");
  }

  _bind() {
    this._onResize = () => {
      if (this._resizeRaf) return;
      this._resizeRaf = requestAnimationFrame(() => {
        this._resizeRaf = null;
        this.dirty = true;
        if (this.active) { this._relayout(); this._drawFrame(performance.now()); }
      });
    };
    window.addEventListener("resize", this._onResize);
    this._mql = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") || null;
    this._onMotion = () => { this._syncLoop(); if (this.active) this._drawFrame(performance.now()); };
    this._mql?.addEventListener?.("change", this._onMotion);

    const canvas = this.els.canvas;
    let downX = 0, downY = 0, moved = 0;
    canvas.style.touchAction = "none";
    this._onPointerDown = (e) => { downX = e.clientX; downY = e.clientY; moved = 0; };
    this._onPointerMove = (e) => { if (e.buttons) moved += Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY); };
    this._onPointerUp = (e) => {
      if (moved > 10) return;                       // a drag, not a tap
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const coarse = globalThis.matchMedia?.("(pointer: coarse)")?.matches;
      const hit = hitTestStars(this.layout, x, y, coarse ? 22 : 14);
      if (hit) this._select(hit);
      else this._closeCard();
    };
    canvas.addEventListener("pointerdown", this._onPointerDown);
    canvas.addEventListener("pointermove", this._onPointerMove);
    canvas.addEventListener("pointerup", this._onPointerUp);

    // Keyboard parity for the click interaction: arrows walk the stars, Enter
    // inspects, Escape closes. A canvas is otherwise a dead end.
    this._onKeyDown = (e) => {
      const stars = this.layout?.stars || [];
      if (!stars.length) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault(); this.focusIndex = (this.focusIndex + 1) % stars.length; this._select(stars[this.focusIndex]);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault(); this.focusIndex = (this.focusIndex - 1 + stars.length) % stars.length; this._select(stars[this.focusIndex]);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault(); this._select(stars[Math.max(0, this.focusIndex)]);
      } else if (e.key === "Escape") {
        if (this.selected) { e.preventDefault(); this._closeCard(); }
      }
    };
    canvas.addEventListener("keydown", this._onKeyDown);
  }

  // ── colour slots ──
  _colorFor(groupId) {
    if (!this._slots.has(groupId)) this._slots.set(groupId, this._nextSlot++);
    const slot = this._slots.get(groupId);
    return slot < GROUP_COLORS.length ? GROUP_COLORS[slot] : NEUTRAL;
  }

  // ── public API ───────────────────────────────────────────────────────────
  setActive(active) {
    const next = Boolean(active);
    if (next === this.active) return;
    this.active = next;
    this.els.root.hidden = !next;
    this.els.root.setAttribute("aria-hidden", next ? "false" : "true");
    if (next) {
      this._relayout();
      this._drawFrame(performance.now());
      this._syncLoop();
      this.els.canvas.focus({ preventScroll: true });
    } else {
      this._stopLoop();
      this._closeCard();
    }
  }

  setResult(model) {
    const normalized = normalizeModel(model);
    this.model = normalized;
    this.selected = null;
    this.focusIndex = -1;
    this.dirty = true;
    // Assign slots in the model's own group order, so colours are stable and
    // deterministic rather than dependent on which star was drawn first.
    if (normalized) for (const g of normalized.groups) this._colorFor(g.id);
    this._closeCard();
    this._renderChrome();
    if (this.active) { this._relayout(); this._drawFrame(performance.now()); this._syncLoop(); }
  }

  destroy() {
    this._stopLoop();
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    window.removeEventListener("resize", this._onResize);
    this._mql?.removeEventListener?.("change", this._onMotion);
    const c = this.els.canvas;
    c.removeEventListener("pointerdown", this._onPointerDown);
    c.removeEventListener("pointermove", this._onPointerMove);
    c.removeEventListener("pointerup", this._onPointerUp);
    c.removeEventListener("keydown", this._onKeyDown);
    this.els.root.remove();
    this.layout = null; this.model = null; this._glow.clear();
  }

  // ── layout + chrome ─────────────────────────────────────────────────────
  get reducedMotion() {
    if (this.map && typeof this.map.reducedMotion === "boolean") return this.map.reducedMotion;
    return Boolean(this._mql?.matches);
  }

  _viewport() {
    const root = this.els.root;
    const w = root.clientWidth || window.innerWidth || 0;
    const h = root.clientHeight || window.innerHeight || 0;
    return { w, h };
  }

  // The chrome's real heights, so clusters and their labels never slide under
  // the header or the legend — a wrapped legend on a phone is much taller than
  // any constant would guess. Falls back to planLayout's own defaults when the
  // view is hidden (display:none measures as zero).
  _measuredInsets(w, h) {
    const { header, legend, note } = this.els;
    const mobile = w < 560 || h < 520;
    const side = mobile ? 14 : 28;
    // Floors reserve the *app's* chrome — its title, status line and bottom
    // dock sit above this view and cannot be measured from here. The measured
    // values only ever push the field further in, never out from under them.
    const floors = mobile ? { top: 184, bottom: 196 } : { top: 150, bottom: 188 };
    const bottomOf = (node) => { const r = node.getBoundingClientRect(); return r.height > 0 ? r.bottom : null; };
    const topOf = (node) => { const r = node.getBoundingClientRect(); return r.height > 0 ? r.top : null; };
    const headerBottom = bottomOf(header);
    const chromeTop = Math.min(...[topOf(legend), topOf(note)].filter((v) => v != null), Infinity);
    if (headerBottom == null || !Number.isFinite(chromeTop)) return undefined;
    const top = Math.round(Math.max(floors.top, headerBottom + 20));
    const bottom = Math.round(Math.max(floors.bottom, h - chromeTop + 20));
    // A measurement taken before the stylesheet lands can be nonsense (chrome
    // in normal flow is far taller than when it is positioned). If what is left
    // is not a usable field, fall back to the floors.
    if (top + bottom > h * 0.8) return { left: side, right: side, ...floors };
    return { left: side, right: side, top, bottom };
  }

  _relayout() {
    const { w, h } = this._viewport();
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    for (const canvas of [this.els.canvas, this.staticLayer]) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    this.els.canvas.style.width = `${w}px`;
    this.els.canvas.style.height = `${h}px`;
    this.dpr = dpr;
    this.layout = this.model ? planLayout(this.model, { width: w, height: h, insets: this._measuredInsets(w, h) }) : null;
    if (this.layout) for (const s of this.layout.stars) s.color = this._colorFor(s.groupId);
    this._paintStatic();
    this._renderMeta();          // the star count is only known once the layout is
    this.dirty = false;
  }

  // The line under the question: where these residents come from, how many
  // there are, and how many of them this sky actually draws.
  _renderMeta() {
    if (!this.model) return;
    const city = this.state?.city?.display;
    const shownTotal = this.layout?.totalShown ?? null;
    this.els.meta.textContent = [
      city ? `${city} · simulated residents` : "simulated residents",
      this.model.totalMembers ? `${this.model.totalMembers.toLocaleString()} in the population` : null,
      shownTotal ? `${shownTotal} drawn as stars` : null,
      this.model.provenance,
    ].filter(Boolean).join(" · ");
  }

  _renderChrome() {
    const { question, meta, legend, note, badge, summary } = this.els;
    const model = this.model;
    badge.hidden = !model?.mock;
    if (!model) {
      question.textContent = "No result yet";
      meta.textContent = "Ask a question, then open this view to see how the simulated residents grouped.";
      legend.replaceChildren(); note.textContent = ""; summary.replaceChildren();
      return;
    }
    question.textContent = model.question || "Simulated response groups";
    this._renderMeta();

    legend.replaceChildren(...model.groups.map((g) => {
      const item = el("li", "cst-legend-item");
      const swatch = el("span", "cst-swatch");
      swatch.style.background = this._colorFor(g.id);
      const label = el("span", "cst-legend-label", g.label);
      const share = el("span", "cst-legend-share", g.share != null ? pct(g.share) : `${g.count.toLocaleString()} residents`);
      item.append(swatch, label, share);
      return item;
    }));

    note.textContent = model.illustrative
      ? "Simulated residents and simulated results. Star placement is illustrative — the model returns weighted group shares, not individual votes — and the lines link nearby stars in the same group, not real relationships."
      : "Simulated residents and simulated results. Lines link nearby stars in the same group, not real relationships.";

    // The table view: the same numbers as text, for screen readers and for
    // anyone who cannot use the colours.
    const list = el("ul");
    for (const g of model.groups) {
      list.append(el("li", null, `${g.label}: ${g.share != null ? pct(g.share) : ""}${g.count ? ` (${g.count.toLocaleString()} simulated residents)` : ""}`));
    }
    summary.replaceChildren(el("p", null, "Response groups:"), list);
  }

  // ── painting ────────────────────────────────────────────────────────────
  _glowSprite(color) {
    let sprite = this._glow.get(color);
    if (sprite) return sprite;
    const size = 64;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.22, color);
    grad.addColorStop(0.55, withAlpha(color, 0.35));
    grad.addColorStop(1, withAlpha(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    sprite = c;
    this._glow.set(color, sprite);
    return sprite;
  }

  // Dust, connections and labels change only with the layout, so they are
  // baked once; the animated loop then redraws stars alone.
  _paintStatic() {
    const ctx = this.staticCtx;
    if (!ctx) return;
    const { w, h } = this._viewport();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = SKY.surface;
    ctx.fillRect(0, 0, w, h);
    const layout = this.layout;
    if (!layout) return;

    for (const d of layout.dust) {
      ctx.globalAlpha = d.a;
      ctx.fillStyle = SKY.dust;
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    for (const g of layout.groups) {
      const color = this._colorFor(g.id);
      ctx.strokeStyle = withAlpha(color, 0.3);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const e of g.edges) { ctx.moveTo(e.ax, e.ay); ctx.lineTo(e.bx, e.by); }
      ctx.stroke();
      this._paintLabel(ctx, g, color, layout);
    }
  }

  // A label pill per cluster: dark fill, light text, clamped inside the
  // viewport so it stays readable at every size.
  _paintLabel(ctx, group, color, layout) {
    const share = group.share != null ? pct(group.share) : `${group.count.toLocaleString()}`;
    const sub = group.shown < group.count ? `${share} · ${group.shown} of ${group.count.toLocaleString()} drawn` : share;
    const padX = 10, padY = 7, dot = 7, gap = 6;
    // A pill never spills past its own cell, so neighbouring labels cannot
    // collide: the group name is ellipsized to the room it actually has.
    const maxBoxW = Math.max(90, Math.min(layout.width - 16, group.labelMaxW ?? layout.width));
    ctx.save();
    ctx.font = `600 ${layout.mobile ? 12 : 13}px ${FONT}`;
    const title = fitText(ctx, group.label, maxBoxW - padX * 2 - dot - gap);
    const titleW = ctx.measureText(title).width;
    ctx.font = `500 ${layout.mobile ? 10 : 11}px ${FONT}`;
    const subW = ctx.measureText(sub).width;
    const boxW = Math.min(maxBoxW, Math.max(titleW + dot + gap, subW) + padX * 2);
    const boxH = padY * 2 + (layout.mobile ? 26 : 29);
    let x = clamp(group.labelX - boxW / 2, 8, Math.max(8, layout.width - boxW - 8));
    let y = clamp(group.labelY - boxH / 2, 8, Math.max(8, layout.height - boxH - 8));

    ctx.fillStyle = "rgba(6, 10, 22, 0.78)";
    ctx.strokeStyle = withAlpha(color, 0.5);
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, boxW, boxH, 9);
    ctx.fill(); ctx.stroke();

    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(x + padX + dot / 2, y + padY + (layout.mobile ? 6 : 7), dot / 2 + 1, 0, Math.PI * 2);
    ctx.fill();

    ctx.textBaseline = "top";
    ctx.fillStyle = SKY.ink;
    ctx.font = `600 ${layout.mobile ? 12 : 13}px ${FONT}`;
    ctx.fillText(title, x + padX + dot + gap, y + padY - 1, boxW - padX * 2 - dot - gap);
    ctx.fillStyle = SKY.inkSoft;
    ctx.font = `500 ${layout.mobile ? 10 : 11}px ${FONT}`;
    ctx.fillText(sub, x + padX, y + padY + (layout.mobile ? 14 : 16), boxW - padX * 2);
    ctx.restore();
  }

  _drawFrame(now) {
    const ctx = this.ctx;
    if (!ctx) return;
    const { w, h } = this._viewport();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.els.canvas.width, this.els.canvas.height);
    ctx.drawImage(this.staticLayer, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const layout = this.layout;
    if (!layout) {
      ctx.fillStyle = SKY.inkSoft;
      ctx.font = `500 14px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText("No result to map yet.", w / 2, h / 2);
      ctx.textAlign = "left";
      return;
    }

    const still = this.reducedMotion;
    ctx.globalCompositeOperation = "lighter";
    for (const s of layout.stars) {
      const twinkle = still ? 1 : 0.78 + 0.22 * Math.sin(now / 900 + s.phase);
      const sprite = this._glowSprite(s.color || NEUTRAL);
      const size = s.r * 5.6 * twinkle;
      ctx.globalAlpha = still ? 0.9 : 0.75 + 0.25 * twinkle;
      ctx.drawImage(sprite, s.x - size / 2, s.y - size / 2, size, size);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    if (this.selected) {
      const s = this.selected;
      ctx.beginPath();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.arc(s.x, s.y, Math.max(9, s.r * 3.4), 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = withAlpha(s.color || NEUTRAL, 0.8);
      ctx.lineWidth = 1;
      ctx.arc(s.x, s.y, Math.max(13, s.r * 4.8), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  _loop = (now) => {
    this._raf = requestAnimationFrame(this._loop);
    this._drawFrame(now);
  };

  _syncLoop() {
    const wants = this.active && !this.reducedMotion && (this.layout?.stars?.length || 0) > 0;
    if (wants && !this._raf) this._raf = requestAnimationFrame(this._loop);
    else if (!wants) this._stopLoop();
  }

  _stopLoop() { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } }

  // ── resident card ───────────────────────────────────────────────────────
  _select(star) {
    if (!star) return;
    this.selected = star;
    const stars = this.layout?.stars || [];
    const idx = stars.indexOf(star);
    if (idx >= 0) this.focusIndex = idx;
    this._openCard(star);
    if (this.reducedMotion || !this._raf) this._drawFrame(performance.now());
  }

  _openCard(star) {
    const card = this.els.card;
    const m = star.member || null;
    const group = this.layout?.groups.find((g) => g.id === star.groupId) || null;
    const color = star.color || NEUTRAL;

    const close = el("button", "cst-card-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => this._closeCard());

    const head = el("div", "cst-card-head");
    const portrait = el("canvas", "cst-card-portrait");
    portrait.width = portrait.height = 48;
    const ident = el("div", "cst-card-id");
    const details = [
      m?.age != null ? `${m.age}` : null,
      m?.occupation || m?.job || null,
      m?.neighborhood || m?.hood || null,
    ].filter(Boolean).join(" · ");
    ident.append(
      el("div", "cst-card-name", m?.name || (m?.id != null ? `Resident ${m.id}` : "Simulated resident")),
      // No invented persona: a star the result carried no persona for says so.
      el("div", "cst-card-sub", details || (m ? "synthetic persona" : "this result carried no persona for this star")),
    );
    head.append(portrait, ident);

    const groupRow = el("div", "cst-card-group");
    const swatch = el("span", "cst-swatch");
    swatch.style.background = color;
    groupRow.append(swatch, el("span", null, group ? `${group.label}${group.share != null ? ` · ${pct(group.share)} of the population` : ""}` : star.groupLabel || ""));

    const kids = [close, head, groupRow];
    const why = m?.explanation || m?.why || group?.explanation;
    if (why) kids.push(el("p", "cst-card-why", `“${why}”`));
    kids.push(el("p", "cst-card-disclaimer",
      "Simulated persona. This placement illustrates the group's share; it is not a recorded answer from an individual, and the lines are not relationships."));

    card.replaceChildren(...kids);
    card.hidden = false;
    this._placeCard(star);
    // The city's own sprite sheet draws the face, so a resident looks the same
    // in both views. Absent (or in the standalone harness) the slot stays empty.
    try {
      const charId = m?.id ?? star.memberIndex;
      if (this.map?.drawCharTo && this.map?.charOf) this.map.drawCharTo(portrait, this.map.charOf(charId));
      else portrait.classList.add("cst-card-portrait--empty");
    } catch { portrait.classList.add("cst-card-portrait--empty"); }
  }

  // Put the card on whichever side hides fewer stars, so inspecting one
  // resident does not bury a whole cluster. A tie goes to the side away from
  // the star being inspected. The stylesheet owns the bottom offset, and on a
  // phone the card spans the width, so there is no side to pick.
  _placeCard(star) {
    const card = this.els.card;
    const layout = this.layout;
    if (!layout || layout.width < 560) { card.style.left = ""; card.style.right = ""; return; }
    const box = card.getBoundingClientRect();
    const w = box.width || 320, h = box.height || 220;
    const bottom = box.height ? layout.height - box.bottom : 148;
    const covered = (x0) => layout.stars.reduce((n, s) =>
      n + (s.x >= x0 && s.x <= x0 + w && s.y >= layout.height - bottom - h && s.y <= layout.height - bottom ? 1 : 0), 0);
    const leftCount = covered(20);
    const rightCount = covered(layout.width - 20 - w);
    const onRight = leftCount === rightCount ? star.x <= layout.width / 2 : rightCount < leftCount;
    card.style.left = onRight ? "" : "20px";
    card.style.right = onRight ? "20px" : "";
  }

  _closeCard() {
    this.selected = null;
    if (this.els?.card) { this.els.card.hidden = true; this.els.card.replaceChildren(); }
    if (this.layout && this.active && !this._raf) this._drawFrame(performance.now());
  }
}

// Trim a label to the width it has, with an ellipsis. Binary search keeps it to
// a handful of measureText calls even for a long group name.
function fitText(ctx, text, maxWidth) {
  const full = String(text ?? "");
  if (maxWidth <= 0) return "";
  if (ctx.measureText(full).width <= maxWidth) return full;
  let lo = 0, hi = full.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${full.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${full.slice(0, lo).trimEnd()}…` : "…";
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function withAlpha(hex, a) {
  const n = parseInt(String(hex).slice(1), 16);
  if (!Number.isFinite(n)) return `rgba(255,255,255,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// The agreed entry point. `map` and `state` are read-only here: the city
// renderer keeps its own camera, agents and loop, and nothing in this module
// mutates either.
export function initConstellations(map, state, options = {}) {
  const view = new Constellations(map, state, options);
  view._renderChrome();
  return {
    setActive: (active) => view.setActive(active),
    setResult: (model) => view.setResult(model),
    destroy: () => view.destroy(),
    // Escape hatches for tests and the demo harness; not part of the contract.
    _view: view,
  };
}
