// ─────────────────────────────────────────────────────────────────────────
// Persona chart · the demographic view of a poll, drawn from the simulation.
//
// One module renders every chart type (bar, histogram, scatter, box, line) for
// both the result card and the timeline. Data comes from the simulation only:
// the poll's group shares (`model`, via buildEvidenceChartModel) and, when the
// current population is the one that answered, each resident's own answer
// (`answers`, from GET /tests/:id/answers) joined with the resident list.
// Census figures only ever appear as source backing inside "i" tooltips.
//
// Residents are part of the chart: hovering a bar / box / bin / point shows the
// sprite heads of the people behind it, clicking opens the list of those people,
// and a person opens the app's persona modal. Selection also highlights the same
// residents on the map through `onGroupSelect`.
//
// No dependencies, no chart library: DOM rows for bars, inline SVG for the rest.
// ─────────────────────────────────────────────────────────────────────────

export const CHART_TYPES = ["bar", "histogram", "scatter", "box", "line"];
const CHART_TITLES = { bar: "Share by group", histogram: "How support is spread across residents", scatter: "Each resident: age or income vs support", box: "Spread of support within each group", line: "Trend across groups, or over time when asked more than once" };
const NUMERIC_DIMENSIONS = new Set(["age", "income"]);
const ORDERED_DIMENSIONS = new Set(["age", "income", "education"]);
const HEAD_CAP = 12;
const PEOPLE_PAGE = 20;
const SCATTER_CAP = 1500;
const HIST_BINS = 10;

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
const fmtInt = (n) => Number(n || 0).toLocaleString();
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

// ── chart selection ────────────────────────────────────────────────────────
// Deterministic: the same question, framing and dimension always pick the same
// chart, so the choice reads as a judgment rather than a coin flip.
export function pickChart({ framing = "vote", options = [], dimension = "gender", askCount = 1, question = "" } = {}) {
  const q = String(question || "").toLowerCase();
  if (askCount >= 2) return "line";
  if (NUMERIC_DIMENSIONS.has(dimension)) return "scatter";
  if (/\b(how many|what share|what percent|what proportion)\b/.test(q)) return "histogram";
  if (framing !== "options" && /\b(vary|varies|differ|differs|split|divided|polari[sz]ed)\b/.test(q)) return "box";
  return "bar";
}

// ── per-resident support ───────────────────────────────────────────────────
// Binary polls: the resident's (archetype's) probability of yes. Option polls:
// the probability of the winning option, so every chart shares one axis.
export function supportOf(answer, topIndex = 0) {
  if (!answer) return null;
  if (Array.isArray(answer.dist) && answer.dist.length) return clamp01(answer.dist[topIndex] ?? 0);
  return Number.isFinite(answer.p_yes) ? clamp01(answer.p_yes) : null;
}

export function answerLabel(answer, { framing, options, topIndex = 0 } = {}) {
  if (!answer) return null;
  if (framing === "options" && Array.isArray(answer.dist) && answer.dist.length) {
    let best = 0;
    answer.dist.forEach((p, i) => { if (p > answer.dist[best]) best = i; });
    return { text: options[best] ?? `Option ${best + 1}`, strength: answer.dist[best] ?? 0, positive: best === topIndex };
  }
  const p = supportOf(answer, topIndex) ?? 0;
  const yes = framing === "belief" ? "yes" : "yes";
  return { text: `${Math.round(p * 100)}% ${yes}`, strength: p, positive: p >= 0.5 };
}

// ── weighted helpers ───────────────────────────────────────────────────────
const weightOf = (r) => (Number.isFinite(r?.pums_weight) && r.pums_weight > 0 ? r.pums_weight : 1);

export function weightedQuantiles(values, weights, qs = [0.05, 0.25, 0.5, 0.75, 0.95]) {
  const rows = values.map((v, i) => [v, weights[i]]).filter(([v]) => Number.isFinite(v)).sort((a, b) => a[0] - b[0]);
  const total = rows.reduce((s, [, w]) => s + w, 0);
  if (!rows.length || total <= 0) return qs.map(() => null);
  const out = [];
  for (const q of qs) {
    let acc = 0, picked = rows[rows.length - 1][0];
    for (const [v, w] of rows) { acc += w; if (acc / total >= q) { picked = v; break; } }
    out.push(picked);
  }
  return out;
}

export function weightedMean(values, weights) {
  let s = 0, t = 0;
  values.forEach((v, i) => { if (Number.isFinite(v)) { s += v * weights[i]; t += weights[i]; } });
  return t > 0 ? s / t : null;
}

// Deterministic, weight-aware sample: keep the heaviest residents, then every
// k-th of the rest, so the same poll always draws the same points.
export function sampleResidents(rows, cap = SCATTER_CAP) {
  if (rows.length <= cap) return rows;
  const sorted = [...rows].sort((a, b) => weightOf(b.resident) - weightOf(a.resident));
  const head = sorted.slice(0, Math.floor(cap / 3));
  const rest = sorted.slice(head.length);
  const stride = Math.max(1, Math.floor(rest.length / (cap - head.length)));
  return head.concat(rest.filter((_, i) => i % stride === 0)).slice(0, cap);
}

// residents of a segment; cross-tab keys are `left|right`
export function residentsIn(residents, dimension, key) {
  return residents.filter((r) => r?.segments && r.segments[dimension] === key);
}

// ── main ───────────────────────────────────────────────────────────────────
// Residents' own answers, cached per test so reopening a list is instant.
const personalCache = new Map(); // `${testId}:${agentId}` -> { p_yes, dist, why, personal: true }
const pkey = (testId, id) => `${testId}:${id}`;

export function createPersonaChart(host, opts) {
  const o = {
    question: "", framing: "vote", options: [], topIndex: 0,
    testId: null,
    // (agentIds) => Map<agentId, {p_yes, dist, why}> | null — asks these residents in their own words
    fetchPersonal: null,
    model: { breakdowns: [], options: [] },
    residents: [], answers: null, answersNote: "",
    history: [], events: [],
    dimension: null, type: null, compact: false,
    labels: { dimension: (d) => d, group: (d, k) => k },
    drawHead: () => {}, drawPortrait: () => {},
    openPerson: () => {}, onGroupSelect: () => {}, onOpenAsk: null,
    sourceHint: () => null,
    ...opts,
  };
  const dims = o.model.breakdowns.filter((b) => b.groups.length).map((b) => b.dimension);
  // first view: the requested dimension, else gender (a two-group bar reads at a
  // glance), else whatever the poll has
  const st = {
    dimension: dims.includes(o.dimension) ? o.dimension : dims.includes("gender") ? "gender" : dims[0] || null,
    type: null,
    manual: false,
    people: null,      // { title, share, rows: [{resident, answer, support}], shown }
    selected: null,    // { dimension, key } | { kind: "bin", index } | ...
    listeners: [],
    destroyed: false,
  };
  const askCount = () => (o.history || []).length;
  const autoType = () => pickChart({ framing: o.framing, options: o.options, dimension: st.dimension, askCount: askCount(), question: o.question });
  st.type = CHART_TYPES.includes(o.type) ? o.type : autoType();
  if (o.type) st.manual = true;

  const hasAnswers = () => !!(o.answers && o.answers.size);
  const answerOf = (r) => (hasAnswers() ? o.answers.get(r.id) || null : null);
  const personalOf = (id) => (o.testId ? personalCache.get(pkey(o.testId, id)) || null : null);
  const rowsFor = (residents) => residents.map((resident) => {
    const answer = answerOf(resident);
    return { resident, answer, support: supportOf(answer, o.topIndex), personal: personalOf(resident.id), pending: false };
  });
  const groupsOf = () => (o.model.breakdowns.find((b) => b.dimension === st.dimension)?.groups) || [];
  const groupShare = (g) => (o.framing === "options" ? g.shares[o.topIndex] : g.shares[0]);
  const positiveLabel = o.framing === "options" ? (o.options[o.topIndex] || "top option") : o.framing === "belief" ? "yes" : "support";

  // ── shell ──
  host.classList.add("pc");
  host.classList.toggle("pc-compact", !!o.compact);
  host.innerHTML = `
    <div class="pc-head">
      <span class="res-why-label pc-kicker">by demographic${tip("Group shares are the simulation's predicted answers within each group, weighted by Census person weights. Residents inherit their archetype's answer, so groups can look chunky.")}</span>
      <h3 class="pc-title">How different groups answered</h3>
      <div class="pc-controls">
        <select class="pc-dim" aria-label="Demographic dimension">${dims.map((d) => `<option value="${esc(d)}">${esc(o.labels.dimension(d))}</option>`).join("")}</select>
        <div class="pc-types" role="tablist" aria-label="Chart type">${CHART_TYPES.map((t) => `<button type="button" role="tab" class="pc-type" data-type="${t}" aria-selected="false" title="${CHART_TITLES[t]}">${t}</button>`).join("")}</div>
      </div>
    </div>
    <div class="pc-note hidden"></div>
    <div class="pc-body"></div>
    <div class="pc-people hidden"></div>`;
  const el = {
    dim: host.querySelector(".pc-dim"),
    types: host.querySelector(".pc-types"),
    note: host.querySelector(".pc-note"),
    body: host.querySelector(".pc-body"),
    people: host.querySelector(".pc-people"),
  };
  if (st.dimension) el.dim.value = st.dimension;
  if (dims.length < 2) el.dim.hidden = true;

  function on(target, type, fn, options) { target.addEventListener(type, fn, options); st.listeners.push(() => target.removeEventListener(type, fn, options)); }
  on(el.dim, "change", () => { st.dimension = el.dim.value; if (!st.manual) st.type = autoType(); clearSelection(); render(); });
  on(el.types, "click", (e) => {
    const b = e.target.closest(".pc-type"); if (!b) return;
    st.type = b.dataset.type; st.manual = true; clearSelection(); render();
  });
  on(host, "keydown", (e) => { if (e.key === "Escape" && (st.selected || st.people)) { e.stopPropagation(); clearSelection(); render(); } });

  function tip(text, extra = "") {
    return `<span class="pc-tip-wrap"><button type="button" class="pc-info" aria-label="About this number">i</button><span role="tooltip" class="pc-tooltip">${esc(text)}${extra ? `<br>${esc(extra)}` : ""}</span></span>`;
  }

  function clearSelection() {
    st.selected = null; st.people = null;
    el.people.classList.add("hidden"); el.people.replaceChildren();
    o.onGroupSelect(null);
  }

  // ── heads ──
  function headsHtml(rows, cap = HEAD_CAP) {
    const shown = rows.slice(0, cap);
    const more = rows.length - shown.length;
    return `<span class="pc-heads" aria-hidden="true">${shown.map((r) => `<canvas class="pc-head-c" width="20" height="20" data-agent="${r.resident.id}"></canvas>`).join("")}${more > 0 ? `<span class="pc-heads-more">+${fmtInt(more)}</span>` : ""}</span>`;
  }
  function paintHeads(scope) {
    for (const c of scope.querySelectorAll(".pc-head-c")) o.drawHead(c, Number(c.dataset.agent));
  }
  // strongest answers first so the heads shown are the people who feel it most
  const byStrength = (rows) => [...rows].sort((a, b) => (b.support ?? -1) - (a.support ?? -1) || weightOf(b.resident) - weightOf(a.resident));

  // ── people list (the residents behind a statistic) ──
  function openPeople({ title, subtitle, rows, segments }) {
    st.people = { title, subtitle, rows: byStrength(rows), shown: PEOPLE_PAGE, seq: (st.people?.seq || 0) + 1 };
    o.onGroupSelect(segments || null);
    renderPeople();
    el.people.classList.remove("hidden");
    el.people.querySelector(".pc-people-back")?.focus({ preventScroll: true });
    askPersonal();
  }
  // Ask the residents on the visible page for their own answers (one batched call
  // per page); rows keep their order so nothing jumps under the cursor.
  async function askPersonal() {
    const p = st.people;
    if (!p || !o.testId || typeof o.fetchPersonal !== "function") return;
    const seq = p.seq;
    const need = p.rows.slice(0, p.shown).filter((r) => !r.personal && !r.pending && !r.failed);
    if (!need.length) return;
    for (const r of need) r.pending = true;
    paintPending();
    let got = null;
    try { got = await o.fetchPersonal(need.map((r) => r.resident.id)); } catch { got = null; }
    if (st.destroyed) return;
    for (const r of need) {
      r.pending = false;
      const a = got?.get?.(r.resident.id);
      if (a) { r.personal = a; personalCache.set(pkey(o.testId, r.resident.id), a); }
      else r.failed = true;
    }
    if (st.people === p && p.seq === seq) renderPeople();
  }
  function paintPending() {
    const p = st.people; if (!p) return;
    for (const li of el.people.querySelectorAll(".pc-person")) {
      const row = p.rows.find((r) => r.resident.id === Number(li.dataset.agent));
      const why = li.querySelector(".pc-person-why");
      if (row?.pending && why) { why.classList.add("pending"); why.textContent = `asking ${firstName(row.resident)}…`; }
    }
  }
  function renderPeople() {
    const p = st.people; if (!p) return;
    const rows = p.rows.slice(0, p.shown);
    el.people.innerHTML = `
      <div class="pc-people-head">
        <button type="button" class="pc-link pc-people-back">← All groups</button>
        <span class="pc-people-title">${esc(p.title)}</span>
        <span class="pc-people-sub">${esc(p.subtitle)}</span>
      </div>
      ${!p.rows.length ? `<p class="pc-empty">No residents in this group in the current simulation.</p>` : ""}
      <ul class="pc-list">${rows.map((r) => personRow(r)).join("")}</ul>
      ${p.rows.length > p.shown ? `<button type="button" class="pc-link pc-people-more">Show ${Math.min(PEOPLE_PAGE, p.rows.length - p.shown)} more</button>` : ""}`;
    paintHeads(el.people);
    for (const c of el.people.querySelectorAll(".pc-person-portrait")) o.drawHead(c, Number(c.dataset.agent));
    el.people.querySelector(".pc-people-back").addEventListener("click", () => { clearSelection(); render(); });
    el.people.querySelector(".pc-people-more")?.addEventListener("click", () => { p.shown += PEOPLE_PAGE; renderPeople(); askPersonal(); });
    for (const li of el.people.querySelectorAll(".pc-person")) {
      li.addEventListener("click", () => {
        const row = p.rows.find((r) => r.resident.id === Number(li.dataset.agent));
        if (row) o.openPerson(row.resident, row.personal || row.answer, { framing: o.framing, options: o.options, topIndex: o.topIndex, question: o.question, personal: !!row.personal });
      });
    }
  }
  const firstName = (r) => String(r.name || `Resident ${r.id}`).split(" ")[0];
  function personRow(r) {
    const own = r.personal;
    const a = answerLabel(own || r.answer, o);
    const meta = [r.resident.occupation, r.resident.neighborhood, Number.isFinite(r.resident.age) ? `${r.resident.age}` : null].filter(Boolean).join(" · ");
    const why = own?.why || r.answer?.why || "";
    const quote = r.pending
      ? `<span class="pc-person-why pending">asking ${esc(firstName(r.resident))}…</span>`
      : why ? `<span class="pc-person-why">“${esc(why)}”${own ? "" : `<span class="pc-archetype">archetype view</span>`}</span>` : "";
    return `<li class="pc-person" data-agent="${r.resident.id}" tabindex="0" role="button">
      <canvas class="pc-person-portrait" width="28" height="28" data-agent="${r.resident.id}"></canvas>
      <span class="pc-person-main">
        <span class="pc-person-name">${esc(r.resident.name || `Resident ${r.resident.id}`)}${a ? `<span class="pc-answer ${a.positive ? "pos" : ""}${own ? " own" : ""}">${esc(a.text)}</span>` : ""}</span>
        <span class="pc-person-meta">${esc(meta)}</span>
        ${quote}
      </span></li>`;
  }

  // ── render ──
  function render() {
    if (st.destroyed) return;
    for (const b of el.types.querySelectorAll(".pc-type")) b.setAttribute("aria-selected", b.dataset.type === st.type ? "true" : "false");
    el.note.classList.add("hidden");
    const groups = groupsOf();
    if (!groups.length) {
      if (askCount() >= 2) { st.type = "line"; st.lineMode = "time"; el.types.hidden = true; el.dim.hidden = true; renderLine([]); return; }
      el.body.innerHTML = `<p class="pc-empty">No demographic breakdowns were stored for this question.</p>`; return;
    }
    let type = st.type;
    const needsAnswers = type === "histogram" || type === "scatter" || type === "box";
    if (needsAnswers && !hasAnswers()) {
      note(o.answersNote || "Per-resident answers aren't available for this population, so this view shows group shares instead.");
      type = "bar";
    }
    if (type === "line" && askCount() < 2 && !ORDERED_DIMENSIONS.has(st.dimension)) type = "bar";
    if (type === "bar") renderBar(groups);
    else if (type === "histogram") renderHistogram();
    else if (type === "scatter") renderScatter(groups);
    else if (type === "box") renderBox(groups);
    else renderLine(groups);
    paintHeads(el.body);
    if (st.people) renderPeople();
  }
  function note(text) { el.note.textContent = text; el.note.classList.remove("hidden"); }

  // rows shared by hover/click on a group
  function groupRows(g) { return rowsFor(residentsIn(o.residents, g.dimension, g.key)); }
  function groupTitle(g) { return o.labels.group(g.dimension, g.key); }
  function bindGroupTargets(scope, groups) {
    for (const t of scope.querySelectorAll("[data-group]")) {
      const g = groups[Number(t.dataset.group)];
      const rows = () => groupRows(g);
      const heads = t.querySelector(".pc-heads-slot");
      const showHeads = () => { if (heads && !heads.childElementCount) { heads.innerHTML = headsHtml(byStrength(rows())); paintHeads(heads); } };
      t.addEventListener("mouseenter", showHeads);
      t.addEventListener("focus", showHeads);
      t.addEventListener("click", () => {
        const share = groupShare(g);
        openPeople({
          title: groupTitle(g),
          subtitle: `${fmtInt(g.n ?? rows().length)} residents · ${share == null ? "share unknown" : `${pct(share)} ${positiveLabel}`}`,
          rows: rows(), segments: [{ dimension: g.dimension, key: g.key }],
        });
        st.selected = { dimension: g.dimension, key: g.key };
        for (const other of scope.querySelectorAll("[data-group]")) other.setAttribute("aria-pressed", other === t ? "true" : "false");
      });
      t.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); t.click(); } });
    }
  }
  function groupTip(g) {
    const parts = [`${fmtInt(g.n ?? 0)} simulated residents · Census weight ${fmtInt(Math.round(g.weight || 0))}`];
    const src = o.sourceHint(g.dimension, g.key);
    if (src) parts.push(src);
    return parts.join(" · ");
  }

  // ── bar ──
  function renderBar(groups) {
    const isOpt = o.framing === "options" && o.model.options.length > 2;
    const legend = isOpt ? `<div class="pc-legend">${o.model.options.map((l, i) => `<span><i class="pc-sw ${i === o.topIndex ? "top" : `g${i % 4}`}"></i>${esc(l)}</span>`).join("")}</div>` : "";
    el.body.innerHTML = `${legend}<div class="pc-rows">${groups.map((g, i) => {
      const share = groupShare(g);
      const selected = st.selected?.dimension === g.dimension && st.selected?.key === g.key;
      const fill = isOpt
        ? `<div class="pc-track pc-stack">${o.model.options.map((_, k) => `<i class="pc-seg ${k === o.topIndex ? "top" : `g${k % 4}`}" style="width:${(g.shares[k] ?? 0) * 100}%" title="${esc(o.model.options[k])} ${pct(g.shares[k] ?? 0)}"></i>`).join("")}</div>`
        : `<div class="pc-track"><i class="pc-fill" style="width:${(share ?? 0) * 100}%"></i></div>`;
      return `<div class="pc-row" data-group="${i}" tabindex="0" role="button" aria-pressed="${selected}" aria-label="${esc(groupTitle(g))}, ${share == null ? "unknown" : pct(share)} ${esc(positiveLabel)}">
        <div class="pc-row-head">
          <span class="pc-row-label">${esc(groupTitle(g))}${tip(groupTip(g))}</span>
          <span class="pc-heads-slot"></span>
          <span class="pc-row-pct">${share == null ? "—" : pct(share)}</span>
        </div>
        ${fill}
      </div>`;
    }).join("")}</div>`;
    bindGroupTargets(el.body, groups);
  }

  // ── svg helpers ──
  const W = o.compact ? 380 : 620;
  const svgOpen = (h, label) => `<svg class="pc-svg" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMinYMin meet">`;
  const axisLabelY = (x, y, text, anchor = "middle") => `<text class="pc-axis" x="${x}" y="${y}" text-anchor="${anchor}">${esc(text)}</text>`;

  // ── histogram ──
  function renderHistogram() {
    const rows = rowsFor(o.residents).filter((r) => r.support != null);
    const bins = Array.from({ length: HIST_BINS }, (_, i) => ({ index: i, lo: i / HIST_BINS, hi: (i + 1) / HIST_BINS, rows: [], weight: 0 }));
    for (const r of rows) { const b = bins[Math.min(HIST_BINS - 1, Math.floor(r.support * HIST_BINS))]; b.rows.push(r); b.weight += weightOf(r.resident); }
    const total = bins.reduce((s, b) => s + b.weight, 0) || 1;
    const H = o.compact ? 150 : 190, pad = { l: 8, r: 8, t: 14, b: 26 };
    const bw = (W - pad.l - pad.r) / HIST_BINS, ih = H - pad.t - pad.b;
    const max = Math.max(...bins.map((b) => b.weight / total), 0.0001);
    const mean = weightedMean(rows.map((r) => r.support), rows.map((r) => weightOf(r.resident)));
    el.body.innerHTML = `${svgOpen(H, `Distribution of ${positiveLabel} across residents`)}
      <line class="pc-base" x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}"/>
      ${bins.map((b) => { const h = (b.weight / total) / max * ih; const x = pad.l + b.index * bw; const sel = st.selected?.kind === "bin" && st.selected.index === b.index;
        return `<g class="pc-bin${sel ? " sel" : ""}" data-bin="${b.index}" tabindex="0" role="button" aria-label="${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}% ${esc(positiveLabel)}: ${fmtInt(b.rows.length)} residents"><rect class="pc-bin-hit" x="${x}" y="${pad.t}" width="${bw}" height="${ih}"/><rect class="pc-bin-bar" x="${x + 2}" y="${H - pad.b - h}" width="${bw - 4}" height="${h}" rx="2"/></g>`; }).join("")}
      ${mean != null ? `<line class="pc-mean" x1="${pad.l + mean * (W - pad.l - pad.r)}" x2="${pad.l + mean * (W - pad.l - pad.r)}" y1="${pad.t}" y2="${H - pad.b}"/>` : ""}
      ${[0, 0.5, 1].map((v) => axisLabelY(pad.l + v * (W - pad.l - pad.r), H - 8, `${Math.round(v * 100)}%`, v === 0 ? "start" : v === 1 ? "end" : "middle")).join("")}
    </svg>
    <div class="pc-caption">How likely each resident is to ${esc(o.framing === "options" ? `pick “${o.options[o.topIndex] || ""}”` : positiveLabel)}${mean != null ? ` · average ${pct(mean)}` : ""}${tip("Weighted by Census person weights. Residents share their archetype's answer, so bars come in clumps.")}</div>
    <div class="pc-hover"></div>`;
    const hover = el.body.querySelector(".pc-hover");
    for (const g of el.body.querySelectorAll(".pc-bin")) {
      const b = bins[Number(g.dataset.bin)];
      const show = () => { hover.innerHTML = `<span class="pc-hover-label">${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}% · ${fmtInt(b.rows.length)} residents</span>${headsHtml(byStrength(b.rows))}`; paintHeads(hover); };
      g.addEventListener("mouseenter", show); g.addEventListener("focus", show);
      const open = () => { st.selected = { kind: "bin", index: b.index }; openPeople({ title: `${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}% ${positiveLabel}`, subtitle: `${fmtInt(b.rows.length)} residents`, rows: b.rows, segments: null }); render(); };
      g.addEventListener("click", open);
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    }
  }

  // ── scatter ──
  function xValue(r) {
    if (st.dimension === "income") { const q = Number(String(r.segments?.income || "q0").slice(1)); return Number.isFinite(q) ? q : 0; }
    return Number.isFinite(r.age) ? r.age : null;
  }
  function renderScatter(groups) {
    const numeric = NUMERIC_DIMENSIONS.has(st.dimension) ? st.dimension : "age";
    const all = rowsFor(o.residents).filter((r) => r.support != null && xValue(r.resident) != null);
    const rows = sampleResidents(all);
    const H = o.compact ? 190 : 240, pad = { l: 34, r: 10, t: 12, b: 28 };
    const xs = all.map((r) => xValue(r.resident));
    const xmin = numeric === "income" ? 0 : Math.min(...xs, 18), xmax = numeric === "income" ? 4 : Math.max(...xs, 80);
    const X = (v) => pad.l + (v - xmin) / (xmax - xmin || 1) * (W - pad.l - pad.r);
    const Y = (v) => H - pad.b - v * (H - pad.t - pad.b);
    const seeded = (i) => ((i * 9301 + 49297) % 233280) / 233280 - 0.5;
    // trend: weighted mean per ordered group of the active dimension
    const trend = groups.map((g) => {
      const gr = all.filter((r) => r.resident.segments?.[g.dimension] === g.key);
      const m = weightedMean(gr.map((r) => r.support), gr.map((r) => weightOf(r.resident)));
      const cx = weightedMean(gr.map((r) => xValue(r.resident)), gr.map((r) => weightOf(r.resident)));
      return m == null || cx == null ? null : { x: X(cx), y: Y(m), g };
    }).filter(Boolean).sort((a, b) => a.x - b.x);
    const income = numeric === "income";
    el.body.innerHTML = `${svgOpen(H, `${positiveLabel} by ${o.labels.dimension(numeric)}`)}
      <line class="pc-base" x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}"/>
      <line class="pc-base" x1="${pad.l}" x2="${pad.l}" y1="${pad.t}" y2="${H - pad.b}"/>
      ${[0, 0.5, 1].map((v) => axisLabelY(pad.l - 6, Y(v) + 4, `${Math.round(v * 100)}%`, "end")).join("")}
      ${(income ? [0, 1, 2, 3, 4] : [20, 40, 60, 80]).map((v) => axisLabelY(X(v), H - 8, income ? `Q${v + 1}` : String(v))).join("")}
      ${trend.length > 1 ? `<polyline class="pc-trend" points="${trend.map((p) => `${p.x},${p.y}`).join(" ")}"/>` : ""}
      ${rows.map((r, i) => `<circle class="pc-pt" data-agent="${r.resident.id}" tabindex="0" role="button" aria-label="${esc(r.resident.name || "Resident")}, ${pct(r.support)}" cx="${X(xValue(r.resident) + (income ? seeded(i) * 0.7 : seeded(i) * 1.6))}" cy="${Y(r.support + seeded(i + 7) * 0.03)}" r="${o.compact ? 2.2 : 2.8}"/>`).join("")}
    </svg>
    <div class="pc-caption">Each dot is a resident · ${fmtInt(rows.length)} of ${fmtInt(all.length)} shown${tip("Points are a deterministic, weight-aware sample. The faint line joins the weighted average of each group. Residents inherit their archetype's answer, so dots stack.")}</div>
    <div class="pc-hover"></div>`;
    const hover = el.body.querySelector(".pc-hover");
    const byId = new Map(rows.map((r) => [r.resident.id, r]));
    for (const c of el.body.querySelectorAll(".pc-pt")) {
      const r = byId.get(Number(c.dataset.agent));
      const show = () => { const a = answerLabel(r.answer, o); hover.innerHTML = `${headsHtml([r], 1)}<span class="pc-hover-label">${esc(r.resident.name || "Resident")} · ${esc(r.resident.occupation || "")} · ${a ? esc(a.text) : ""}</span>`; paintHeads(hover); };
      c.addEventListener("mouseenter", show); c.addEventListener("focus", show);
      const open = () => o.openPerson(r.resident, r.answer, { framing: o.framing, options: o.options, topIndex: o.topIndex, question: o.question });
      c.addEventListener("click", open);
      c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    }
  }

  // ── box ──
  function renderBox(groups) {
    const rowH = o.compact ? 30 : 34, pad = { l: 8, r: 8, t: 6, b: 22 };
    const labelW = o.compact ? 96 : 150;
    const H = pad.t + groups.length * rowH + pad.b;
    const X = (v) => pad.l + labelW + v * (W - pad.l - pad.r - labelW);
    const stats = groups.map((g) => { const rows = groupRows(g).filter((r) => r.support != null); const q = weightedQuantiles(rows.map((r) => r.support), rows.map((r) => weightOf(r.resident))); return { g, rows, q }; });
    el.body.innerHTML = `${svgOpen(H, `Spread of ${positiveLabel} within each group`)}
      ${[0, 0.5, 1].map((v) => `<line class="pc-grid" x1="${X(v)}" x2="${X(v)}" y1="${pad.t}" y2="${H - pad.b}"/>${axisLabelY(X(v), H - 6, `${Math.round(v * 100)}%`)}`).join("")}
      ${stats.map(({ g, q }, i) => { const y = pad.t + i * rowH + rowH / 2; const sel = st.selected?.dimension === g.dimension && st.selected?.key === g.key; const has = q[0] != null;
        return `<g class="pc-box${sel ? " sel" : ""}" data-group="${i}" tabindex="0" role="button" aria-pressed="${sel}" aria-label="${esc(groupTitle(g))}: median ${has ? pct(q[2]) : "unknown"}">
          <rect class="pc-box-hit" x="${pad.l}" y="${y - rowH / 2}" width="${W - pad.l - pad.r}" height="${rowH}"/>
          <text class="pc-box-label" x="${pad.l}" y="${y + 4}">${esc(groupTitle(g))}</text>
          ${has ? `<line class="pc-whisk" x1="${X(q[0])}" x2="${X(q[4])}" y1="${y}" y2="${y}"/><rect class="pc-box-rect" x="${X(q[1])}" y="${y - 7}" width="${Math.max(1, X(q[3]) - X(q[1]))}" height="14" rx="3"/><line class="pc-median" x1="${X(q[2])}" x2="${X(q[2])}" y1="${y - 9}" y2="${y + 9}"/>` : `<text class="pc-axis" x="${X(0.5)}" y="${y + 4}" text-anchor="middle">no answers</text>`}
        </g>`; }).join("")}
    </svg>
    <div class="pc-caption">Box = middle half of residents, line = median, whiskers = 5th to 95th percentile${tip("Weighted quantiles of each resident's predicted answer within the group. Residents inherit their archetype's answer, so boxes can collapse to a line.")}</div>
    <div class="pc-hover"></div>`;
    const hover = el.body.querySelector(".pc-hover");
    for (const t of el.body.querySelectorAll(".pc-box")) {
      const { g, rows } = stats[Number(t.dataset.group)];
      const show = () => { hover.innerHTML = `<span class="pc-hover-label">${esc(groupTitle(g))} · ${fmtInt(rows.length)} residents</span>${headsHtml(byStrength(rows))}`; paintHeads(hover); };
      t.addEventListener("mouseenter", show); t.addEventListener("focus", show);
      const open = () => { st.selected = { dimension: g.dimension, key: g.key }; openPeople({ title: groupTitle(g), subtitle: `${fmtInt(rows.length)} residents · median ${rows.length ? pct(weightedQuantiles(rows.map((r) => r.support), rows.map((r) => weightOf(r.resident)), [0.5])[0]) : "—"}`, rows, segments: [{ dimension: g.dimension, key: g.key }] }); render(); };
      t.addEventListener("click", open);
      t.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    }
  }

  // ── line ──
  function renderLine(groups) {
    const overTime = askCount() >= 2 && (st.lineMode ?? "time") === "time";
    const H = o.compact ? 170 : 210, pad = { l: 34, r: 12, t: 14, b: 30 };
    const Y = (v) => H - pad.b - v * (H - pad.t - pad.b);
    const modes = askCount() >= 2 && groups.length ? `<div class="pc-modes"><button type="button" class="pc-mode${overTime ? " on" : ""}" data-mode="time">over time</button><button type="button" class="pc-mode${!overTime ? " on" : ""}" data-mode="dim">by ${esc(o.labels.dimension(st.dimension))}</button></div>` : "";
    if (overTime) {
      const pts = o.history.map((h, i) => ({ h, i }));
      const X = (i) => pad.l + (pts.length > 1 ? i / (pts.length - 1) : 0.5) * (W - pad.l - pad.r);
      const t0 = Date.parse(pts[0].h.created_at), t1 = Date.parse(pts[pts.length - 1].h.created_at);
      const ticks = (o.events || []).filter((e) => { const t = Date.parse(e.created_at); return Number.isFinite(t) && t >= t0 && t <= t1; });
      const tx = (t) => pad.l + (t1 > t0 ? (Date.parse(t) - t0) / (t1 - t0) : 0.5) * (W - pad.l - pad.r);
      el.body.innerHTML = `${modes}${svgOpen(H, `${positiveLabel} each time this was asked`)}
        <line class="pc-base" x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}"/>
        ${[0, 0.5, 1].map((v) => axisLabelY(pad.l - 6, Y(v) + 4, `${Math.round(v * 100)}%`, "end")).join("")}
        ${ticks.map((e) => `<g class="pc-tick"><line x1="${tx(e.created_at)}" x2="${tx(e.created_at)}" y1="${H - pad.b}" y2="${H - pad.b + 6}"/><title>${esc(e.text)}</title></g>`).join("")}
        <polyline class="pc-line" points="${pts.map((p) => `${X(p.i)},${Y(clamp01(p.h.p_yes))}`).join(" ")}"/>
        ${pts.map((p) => `<g class="pc-lpt${p.h.current ? " cur" : ""}" data-ask="${p.i}" tabindex="0" role="button" aria-label="Asked ${esc(p.h.label || "")}: ${pct(p.h.p_yes)}"><circle cx="${X(p.i)}" cy="${Y(clamp01(p.h.p_yes))}" r="${o.compact ? 4 : 5}"/><text class="pc-axis" x="${X(p.i)}" y="${H - 10}" text-anchor="middle">${esc(p.h.label || "")}</text></g>`).join("")}
      </svg>
      <div class="pc-caption">${fmtInt(pts.length)} asks${ticks.length ? ` · ${fmtInt(ticks.length)} events in between (ticks)` : ""}${tip("Each point is one time this question was asked, in order. Ticks mark events added to the residents' memory between asks.")}</div>
      <div class="pc-hover"></div>`;
      const hover = el.body.querySelector(".pc-hover");
      for (const g of el.body.querySelectorAll(".pc-lpt")) {
        const p = pts[Number(g.dataset.ask)];
        const show = () => { hover.innerHTML = `<span class="pc-hover-label">${esc(p.h.label || "")} · ${pct(p.h.p_yes)}${Number.isFinite(p.h.events_known) ? ` · ${fmtInt(p.h.events_known)} events in memory` : ""}</span>`; };
        g.addEventListener("mouseenter", show); g.addEventListener("focus", show);
        if (o.onOpenAsk) { g.addEventListener("click", () => o.onOpenAsk(p.h)); g.addEventListener("keydown", (e) => { if (e.key === "Enter") o.onOpenAsk(p.h); }); }
      }
    } else {
      const X = (i) => pad.l + (groups.length > 1 ? i / (groups.length - 1) : 0.5) * (W - pad.l - pad.r);
      const shares = groups.map((g) => groupShare(g));
      el.body.innerHTML = `${modes}${svgOpen(H, `${positiveLabel} across ${o.labels.dimension(st.dimension)}`)}
        <line class="pc-base" x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}"/>
        ${[0, 0.5, 1].map((v) => axisLabelY(pad.l - 6, Y(v) + 4, `${Math.round(v * 100)}%`, "end")).join("")}
        <polyline class="pc-line" points="${groups.map((g, i) => shares[i] == null ? "" : `${X(i)},${Y(shares[i])}`).filter(Boolean).join(" ")}"/>
        ${groups.map((g, i) => { const sel = st.selected?.dimension === g.dimension && st.selected?.key === g.key; return `<g class="pc-lpt${sel ? " sel" : ""}" data-group="${i}" tabindex="0" role="button" aria-pressed="${sel}" aria-label="${esc(groupTitle(g))}: ${shares[i] == null ? "unknown" : pct(shares[i])}"><circle cx="${X(i)}" cy="${Y(shares[i] ?? 0)}" r="${o.compact ? 4 : 5}"/><text class="pc-axis" x="${X(i)}" y="${H - 10}" text-anchor="middle">${esc(shortLabel(groupTitle(g)))}</text></g>`; }).join("")}
      </svg>
      <div class="pc-caption">${esc(positiveLabel)} across ${esc(o.labels.dimension(st.dimension))}${tip("Group shares from the simulation, in the dimension's natural order.")}</div>
      <div class="pc-hover"></div>`;
      const hover = el.body.querySelector(".pc-hover");
      for (const t of el.body.querySelectorAll(".pc-lpt")) {
        const g = groups[Number(t.dataset.group)];
        const show = () => { const rows = byStrength(groupRows(g)); hover.innerHTML = `<span class="pc-hover-label">${esc(groupTitle(g))} · ${fmtInt(rows.length)} residents</span>${headsHtml(rows)}`; paintHeads(hover); };
        t.addEventListener("mouseenter", show); t.addEventListener("focus", show);
        t.setAttribute("data-group", String(groups.indexOf(g)));
      }
      bindGroupTargets(el.body, groups);
    }
    el.body.querySelectorAll(".pc-mode").forEach((b) => b.addEventListener("click", () => { st.lineMode = b.dataset.mode; clearSelection(); render(); }));
  }
  const shortLabel = (s) => (s.length > 14 ? `${s.slice(0, 13)}…` : s);

  render();
  return {
    render,
    clearSelection() { if (st.selected || st.people) { clearSelection(); render(); } },
    hasSelection() { return !!(st.selected || st.people); },
    // open the people behind one group (map tap → its group); false when absent
    selectGroup(dimension, key) {
      const groups = o.model.breakdowns.find((b) => b.dimension === dimension)?.groups || [];
      const g = groups.find((x) => x.key === key);
      if (!g) return false;
      if (st.dimension !== dimension) { st.dimension = dimension; el.dim.value = dimension; }
      st.selected = { dimension, key };
      const rows = rowsFor(residentsIn(o.residents, dimension, key));
      const share = groupShare(g);
      openPeople({ title: groupTitle(g), subtitle: `${fmtInt(g.n ?? rows.length)} residents · ${share == null ? "share unknown" : `${pct(share)} ${positiveLabel}`}`, rows, segments: [{ dimension, key }] });
      render();
      return true;
    },
    setAnswers(answers, note = "") {
      o.answers = answers; o.answersNote = note;
      if (o.testId && answers?.forEach) answers.forEach((a, id) => {
        if (a && a.personal_why != null) personalCache.set(pkey(o.testId, Number(id)), { p_yes: a.personal_p_yes ?? a.p_yes, dist: a.personal_dist || [], why: a.personal_why, personal: true });
      });
      if (!st.manual) st.type = autoType(); render();
    },
    setSourceHint(fn) { o.sourceHint = fn; render(); },
    setHistory(history, events) { o.history = history || []; o.events = events || []; if (!st.manual) st.type = autoType(); render(); },
    get type() { return st.type; },
    get dimension() { return st.dimension; },
    destroy() { st.destroyed = true; for (const off of st.listeners) off(); host.replaceChildren(); host.classList.remove("pc", "pc-compact"); o.onGroupSelect(null); },
  };
}
