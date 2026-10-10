import { createConstellationBridge } from "./constellation-bridge.js?v=2";
// ─────────────────────────────────────────────────────────────────────────
// sim francisco · pixel-map frontend · orchestration
//
// Flow:  idle → click "ask" (bottom-center) → multiline composer
//        → submit → branch + poll the electorate (composer shows "predicting…")
//        → stochastic green/red verdicts pop over the sprite crowd
//        → result card expands above the composer → dismiss → idle
// Map:   click anywhere → camera zooms into that spot (sprites walk the roads);
//        the "whole city" button returns to the overview.
// ─────────────────────────────────────────────────────────────────────────

import { SIM, PREDICT, TIMING, MAP } from "./config.js";
import { SFMap } from "./map.js";
import { assignVerdicts } from "./verdict.js";
import {
  AB_CROSS_KEY_SEP, AB_MIN_SEGMENT_N, abCrossMatrix, abLeanAlpha, abSegments,
  abTopMovers, isCrossBreakdown, normalizeBreakdowns, pct, signedPp,
} from "./ab-analysis.js";
import * as api from "./api.js?v=ws-2-constellations";
import { buildEvidenceChartModel } from "./evidence-chart.js";
import { createPersonaChart, answerLabel } from "./persona-chart.js?v=5";
import { buildVerifiedDataModel, renderVerifiedData, bindVerifiedData, reduceVerifiedSelection, verifiedMapSelection } from "./verified-data.js";
import { snapshotAudience, describeAudience, audienceHeader, audienceScope } from "./audience.js";
import { initFeedPanel, refreshFeedPanel, lineageItems } from "./feedpanel.js?v=18";
import { initTour, startTour } from "./tour.js?v=1";
import { isFreshWorkspace } from "./workspace.js?v=2";

const $ = (id) => document.getElementById(id);
const els = {
  canvas: $("map"),
  titleSelect: $("title-select"),
  titleBtn: $("title-btn"),
  titleCurrent: $("title-current"),
  titleMenu: $("title-menu"),
  status: $("status"),
  newsBubble: $("news-bubble"),
  boot: $("boot"),
  bootFill: $("boot-fill"),
  returnBtn: $("return"),
  summary: $("summary"),
  summaryLabel: $("summary-label"),
  summaryText: $("summary-text"),
  summaryAudience: $("summary-audience"),
  progress: $("progress"),
  progressFill: $("progress-fill"),
  progressLabel: $("progress-label"),
  dock: $("dock"),
  ask: $("ask"),
  askInput: $("ask-input"),
  askLabel: $("ask-label"),
  resultCard: $("result-card"),
  toast: $("toast"),
  askSubmit: $("ask-submit"),
  askExtra: document.querySelector(".ask-extra"),
  askModes: document.querySelector(".ask-modes"),
  askError: $("ask-error"),
  abFields: $("ab-fields"),
  abA: $("ab-a"),
  abB: $("ab-b"),
  marketingFields: $("marketing-fields"),
  marketingCopy: $("marketing-copy"),
  audienceChip: $("audience-chip"),
  audienceChipText: $("audience-chip-text"),
  audienceChipCount: $("audience-chip-count"),
  audienceCard: $("audience-card"),
  audienceCardTitle: $("audience-card-title"),
  audienceCardMeta: $("audience-card-meta"),
  audienceCardDone: $("audience-card-done"),
  filterModal: $("filter-modal"),
  filterScrim: $("filter-scrim"),
  filterClose: $("filter-close"),
  filterForm: $("filter-form"),
  filterAge: $("filter-age"),
  filterPuma: $("filter-puma"),
  filterOccupation: $("filter-occupation"),
  filterEducation: $("filter-education"),
  filterError: $("filter-error"),
  filterApply: $("filter-apply"),
  filterClear: $("filter-clear"),
  infoBtn: $("info-btn"),
  about: $("about"),
  aboutScrim: $("about-scrim"),
  aboutClose: $("about-close"),
  charCard: $("char-card"),
};

export const map = new SFMap(els.canvas);
const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
const motionOverride = new URLSearchParams(location.search).get("motion");
map.reducedMotion = motionOverride === "on" ? false : motionPreference.matches;
motionPreference.addEventListener("change", (event) => {
  map.reducedMotion = motionOverride === "on" ? false : event.matches;
});
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");

export const state = {
  phase: "booting", queryMode: "simulation", askMode: "predict",
  simId: null, mainBranch: null, branchId: null,
  lastResult: null, lastAbInput: null, lastMarketingInput: null, reqId: 0, abort: null,
  residents: SIM.n, rawResidents: [],
  cities: [],            // [{slug, display, bbox, ...}] from GET /cities
  city: null,            // the active city object (falls back to a synthetic "sf")
  switching: false,      // true while a city swap is re-creating the simulation
  filters: {},           // exact-age, area, occupation, and education filters (AND-combined)
  filterSourceRecords: null, // number of Census PUMS records behind the current sample
  news: [],              // the active city's recent articles (expandable bubble)
  newsExpanded: false,   // whether the news bubble is showing all of them
};

// City remains the default. Optional teammate modules load only on demand.
const viewCity = $("view-city"), viewConstellations = $("view-constellations");
const viewNotice = $("view-notice"), viewCaption = $("view-caption");
let lastViewMessage = "";
function syncConstellationInsets() {
  const top = els.ask.getBoundingClientRect().top;
  document.documentElement.style.setProperty("--constellation-dock-clearance", `${Math.max(160, innerHeight - top + 12)}px`);
}
const constellationDockObserver = new ResizeObserver(syncConstellationInsets);
constellationDockObserver.observe(els.ask);
window.addEventListener("resize", syncConstellationInsets);

export const constellations = createConstellationBridge({
  map, state,
  loadRenderer: async () => {
    const module = await import("./constellations.js");
    if (!$("constellation-styles")) {
      const link = document.createElement("link");
      link.id = "constellation-styles"; link.rel = "stylesheet"; link.href = "constellations.css";
      document.head.append(link);
    }
    return module;
  },
  loadModel: () => import("./constellation-model.js"),
  onChange: ({ active, busy, message }) => {
    document.body.classList.toggle("simtra-constellations-active", active);
    els.canvas.style.visibility = active ? "hidden" : "";
    els.canvas.setAttribute("aria-hidden", String(active));
    els.canvas.tabIndex = active ? -1 : 0;
    viewCity.setAttribute("aria-pressed", String(!active));
    viewConstellations.setAttribute("aria-pressed", String(active));
    viewConstellations.disabled = busy;
    viewConstellations.textContent = busy ? "Connecting…" : "✦ Constellations";
    viewCaption.hidden = !active;
    if (active) syncConstellationInsets();
    if (message) { viewNotice.textContent = message; viewNotice.hidden = false; lastViewMessage = message; }
    else if (active || busy || !lastViewMessage) { viewNotice.hidden = true; }
  },
});
viewCity.addEventListener("click", () => { lastViewMessage = ""; constellations.setActive(false); });
viewConstellations.addEventListener("click", () => constellations.setActive(true));
window.addEventListener("pagehide", () => constellations.destroy());

// fallback city when /cities is unavailable — keeps the single-city SF behavior.
const SF_FALLBACK = { slug: "sf", display: "San Francisco", bbox: { ...MAP.bbox }, default: true };

const citySlug = () => state.city?.slug || "sf";

function currentAudience() {
  return snapshotAudience({
    city: state.city, filters: state.filters,
    sourceRecords: state.filterSourceRecords, residents: state.residents,
  });
}

function setRunAudience(audience) {
  const info = describeAudience(audience);
  els.summaryAudience.textContent = [info.title, info.qualification, info.location].filter(Boolean).join(" · ");
}

const FILTER_OCCUPATION_LABEL = {
  management_business: "management / business",
  software_tech: "software / tech",
  engineer: "engineer",
  science_analysis: "science / analysis",
  social_services: "social services",
  legal: "legal",
  education: "education",
  arts_media: "arts / design / media",
  healthcare: "healthcare",
  service: "service work",
  sales_office: "sales / office",
  construction_trades: "construction / trades",
  production_transportation: "production / transportation",
  military: "military",
  unemployed: "unemployed",
  not_in_workforce: "not in workforce",
  other: "other work",
};
const FILTER_EDUCATION_LABEL = {
  lt_hs: "no HS diploma",
  hs: "high-school diploma",
  some_college: "some college",
  bachelors: "bachelor's degree",
  graduate: "graduate degree",
};

function normalizeFilters(filters = {}) {
  const out = {};
  if (Number.isInteger(filters.age)) out.age = filters.age;
  if (Number.isInteger(filters.puma)) out.puma = filters.puma;
  if (filters.occupation) out.occupation = filters.occupation;
  if (filters.education) out.education = filters.education;
  return out;
}
function filterCount(filters = state.filters) { return Object.keys(normalizeFilters(filters)).length; }
function areaLabel(puma) {
  return (state.city?.neighborhoods || []).find((area) => Number(area.puma) === Number(puma))?.label;
}
function filterSummary(filters = state.filters) {
  const f = normalizeFilters(filters);
  return [
    Number.isInteger(f.age) ? `age ${f.age}` : null,
    f.puma ? (areaLabel(f.puma) || `area ${f.puma}`) : null,
    f.occupation ? FILTER_OCCUPATION_LABEL[f.occupation] : null,
    f.education ? FILTER_EDUCATION_LABEL[f.education] : null,
  ].filter(Boolean).join(" · ");
}
function syncFilterButton() {
  const count = filterCount();
  const chip = els.audienceChip;
  els.ask.classList.toggle("has-audience", count > 0);
  chip.setAttribute("aria-pressed", count ? "true" : "false");
  chip.disabled = state.switching || state.phase === "booting" || state.phase === "error";
  const summary = count ? filterSummary() : "";
  els.audienceChipText.textContent = count ? summary : "everyone · tap to filter";
  const source = state.filterSourceRecords;
  if (count && source != null) {
    els.audienceChipCount.textContent = source.toLocaleString();
    show(els.audienceChipCount);
  } else {
    hide(els.audienceChipCount);
  }
  chip.title = count ? `Asking ${summary} · ${source != null ? source.toLocaleString() + " Census records" : "filtered sample"} · change filters` : "Everyone in the city · filter residents";
  chip.setAttribute("aria-label", chip.title);
  els.returnBtn.querySelector("span").textContent = count ? "audience overview" : "whole city";
  els.returnBtn.setAttribute("aria-label", count ? "Return to the sampled audience overview" : "Return to the whole city");
}

// fetch LLM chatter for the residents now on screen (sparse, batched, best-effort)
async function requestChatter(ids) {
  if (state.queryMode === "verified" || !state.mainBranch || !ids?.length) return;
  const branch = state.mainBranch;
  try {
    const data = await api.getChatter(branch, ids);
    if (branch !== state.mainBranch) return;            // city swapped mid-flight — drop it
    const ch = data?.chatter || {};
    for (const [id, text] of Object.entries(ch)) map.setThought(Number(id), text);
  } catch { /* best-effort: residents keep their neutral fallback thought */ }
}
map.onNeedChatter = requestChatter;

const isBusy = () => state.phase === "waiting" || state.phase === "reveal";
const inputOpen = () => els.ask.dataset.state === "input";

const ASK_MODE_LABEL = { predict: "ask", ab: "A/B test", marketing: "post test" };
const ASK_MODE_PLACEHOLDER = {
  predict: "predict anything — e.g. will a Democrat win the 2026 California governor race?",
  ab: "Which message makes you more likely to support this proposal?",
  marketing: "Do you support the proposed transit measure?",
};
function setAsk(s) {
  els.ask.dataset.state = s;
  els.askLabel.textContent = s === "busy"
    ? (state.queryMode === "verified" ? "querying data…" : state.askMode === "ab" ? "testing A/B…" : state.askMode === "marketing" ? "testing the post…" : "predicting…")
    : ASK_MODE_LABEL[state.askMode] || "ask";
}

// One composer, three question types. The type row lives inside the box, so
// switching never leaves the place the question is typed.
function setAskMode(mode) {
  state.askMode = mode;
  els.ask.dataset.mode = mode;
  for (const b of els.askModes.querySelectorAll(".ask-mode")) b.setAttribute("aria-checked", b.dataset.mode === mode ? "true" : "false");
  els.abFields.hidden = mode !== "ab";
  els.marketingFields.hidden = mode !== "marketing";
  els.askInput.placeholder = ASK_MODE_PLACEHOLDER[mode];
  els.askInput.setAttribute("aria-label", mode === "ab" ? "Evaluation question" : mode === "marketing" ? "Target question" : "Predict anything");
  els.askError.textContent = "";
  if (els.ask.dataset.state !== "busy") setAsk(els.ask.dataset.state);
}

function cleanupBranch() {
  resetEvidence();
  if (state.branchId) { api.deleteBranch(state.branchId); state.branchId = null; }
}


// The app owns selection lifetime; the lane modules remain pure render/query tools.
const verified = { model:null, selection:{segments:[]}, combine:false, dispose:null };
// The persona chart under a result: one instance per result card.
const chart = { inst: null, host: null, testId: null, seq: 0 };
function resetEvidence() {
  verified.dispose?.(); verified.dispose = null;
  verified.model = null; verified.selection = {segments:[]}; verified.combine = false;
  chart.inst?.destroy(); chart.inst = null; chart.host = null; chart.testId = null; chart.seq++;
  map.clearSegmentSelection();
}
function clearEvidenceSelection() {
  verified.selection = {segments:[]};
  if (verified.model && $("verified-host")) renderActiveVerified();
  chart.inst?.clearSelection();
  map.clearSegmentSelection();
}
window.addEventListener("simtra:branch-deleted", ({ detail }) => {
  if (detail.branchId === state.branchId) { resetEvidence(); $("evidence-panel")?.remove(); }
});
function evidenceLabel(dimension, key) {
  key = typeof key === "string" ? key : "Unknown";
  if (dimension.includes("_x_")) return dimension.split("_x_").map((axis,i) => evidenceLabel(axis, key.split("|")[i])).join(" · ");
  if (dimension === "age") return `Age ${key.replaceAll("-", "–")}`;
  return abGroupLabel(dimension, key);
}
// Legacy breakdown aliases are the same demographic, not additional dimensions.
const DIM_ALIASES = { educ:"education", income_q:"income", puma:"geography" };
function chartModelFor(result, ab = false) {
  const poll = ab ? { ...result, breakdowns: {}, p_distribution: [["Variant A",result.a_share],["Variant B",result.b_share]],
    option_breakdowns: (result.breakdowns || []).map((b) => ({ ...b, groups: b.groups.map((g) => ({...g,shares:[g.a_share,g.b_share]})) })) } : result;
  const model = buildEvidenceChartModel(poll);
  model.breakdowns = model.breakdowns.filter((b) => !DIM_ALIASES[b.dimension] || !model.breakdowns.some((other) => other.dimension === DIM_ALIASES[b.dimension]))
    .map((b) => ({...b,dimension:DIM_ALIASES[b.dimension] || b.dimension,groups:b.groups.map((g) => ({...g,dimension:DIM_ALIASES[g.dimension] || g.dimension}))}));
  return model;
}
// Which option the chart treats as "support": the winner of an options poll,
// otherwise yes.
function topIndexOf(result) {
  const dist = (result.p_distribution || []).map((d) => (Array.isArray(d) ? Number(d[1]) : Number(d)) || 0);
  if (!dist.length) return 0;
  let best = 0; dist.forEach((p, i) => { if (p > dist[best]) best = i; });
  return best;
}
function chartOptionsOf(result, ab = false) {
  if (ab) return ["Variant A", "Variant B"];
  if (result.framing === "options" && Array.isArray(result.p_distribution)) return result.p_distribution.map((d) => String(Array.isArray(d) ? d[0] : d));
  return [];
}
// Ask specific residents the question in their own words (one batched model call).
async function fetchPersonal(testId, agentIds) {
  if (!state.mainBranch || !testId || !agentIds?.length) return null;
  const data = await api.postPersonalAnswers(testId, { branch_id: state.mainBranch, agent_ids: agentIds, limit: 20 });
  const m = new Map();
  for (const a of data?.answers || []) m.set(Number(a.agent_id), { ...a, personal: true });
  return m;
}
// A resident's answers to a test: fetched once the background memory write has
// landed (the write is best-effort, so a 404 is retried once).
async function fetchAnswers(testId, attempt = 0) {
  try {
    const data = await api.getTestAnswers(testId);
    const m = new Map();
    for (const a of data?.answers || []) m.set(Number(a.agent_id), a);
    return m;
  } catch (e) {
    if (e?.status === 404 && attempt < 2) { await new Promise((r) => setTimeout(r, 2500)); return fetchAnswers(testId, attempt + 1); }
    return null;
  }
}
// The same question asked before, in order, for the line chart's "over time" mode.
function askHistory(question, framing, current) {
  const items = lineageItems();
  const norm = (q) => String(q || "").trim().toLowerCase();
  const asks = items.filter((i) => i.type === "test" && norm(i.question) === norm(question) && (!framing || i.framing === framing))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const history = asks.map((i) => ({
    id: i.id, created_at: i.created_at, p_yes: framing === "options" && Array.isArray(i.p_distribution) && i.p_distribution.length ? Math.max(...i.p_distribution) : i.p_yes,
    label: fmtTime(i.created_at), events_known: i.events_known, item: i, current: current && i.id === current,
  }));
  const events = items.filter((i) => i.type === "event").map((e) => ({ created_at: e.created_at, text: e.text }));
  return { history, events };
}
function fmtTime(iso) {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function attachEvidence(result, ab = false) {
  chart.inst?.destroy(); chart.inst = null;
  const model = chartModelFor(result, ab);
  const testId0 = result.memory_test_id || result.past?.test_id || null;
  const asked = askHistory(result.question, ab ? null : (result.framing || "vote"), testId0);
  // nothing to chart: no stored breakdowns and the question was only asked once
  if (!model.breakdowns.some((b) => b.groups.length) && asked.history.length < 2) return;
  const section = document.createElement("section"); section.id = "evidence-panel";
  const host = document.createElement("div"); section.append(host);
  // under the result itself: after the bars, meta and scope; ABOVE the advanced
  // breakdown and the quotes
  const adv = els.resultCard.querySelector(".ab-adv");
  const anchor = els.resultCard.querySelector(".res-hydra") || els.resultCard.querySelector(".res-meta") || els.resultCard.querySelector(".res-scope");
  if (adv) adv.before(section);
  else if (anchor) anchor.after(section);
  else { const why = els.resultCard.querySelector(".res-why") || els.resultCard.querySelector(".res-actions"); why ? why.before(section) : els.resultCard.append(section); }
  const framing = ab ? "options" : result.framing || "vote";
  const options = chartOptionsOf(result, ab);
  const topIndex = ab ? 0 : topIndexOf(result);
  const testId = testId0;
  const { history, events } = asked;
  chart.host = host; chart.testId = testId;
  const seq = ++chart.seq;
  chart.inst = createPersonaChart(host, {
    question: result.question, framing, options, topIndex, model,
    testId, fetchPersonal: testId ? (ids) => fetchPersonal(testId, ids) : null,
    residents: state.rawResidents, answers: null,
    answersNote: testId ? "Loading each resident's answer…" : "Per-resident answers aren't stored for this result, so this view shows group shares.",
    history, events,
    labels: { dimension: (d) => AB_DIM_LABEL[d] || d, group: evidenceLabel },
    drawHead: (canvas, id) => map.drawHeadTo(canvas, id),
    openPerson: openPersonaModal,
    onGroupSelect: (segments) => map.setSegmentSelection(segments?.length ? { clauses: segments, operator: "or" } : null),
    onOpenAsk: (h) => { if (h?.item && !h.current) openPastResult(h.item); },
    sourceHint: censusHint,
  });
  if (testId) {
    fetchAnswers(testId).then((answers) => {
      if (seq !== chart.seq || !chart.inst) return;
      const samePopulation = !result.past || samePopulationAs(result.past.population_key);
      if (answers && answers.size && samePopulation) chart.inst.setAnswers(answers, "");
      else chart.inst.setAnswers(null, answers && answers.size && !samePopulation
        ? "These residents were asked in a different simulation, so this view shows group shares without per-person answers."
        : "Per-resident answers aren't available for this result, so this view shows group shares.");
    });
  }
}
function populationKey() {
  const c = citySlug(); const seed = SIM.seed; const n = state.residents;
  return filterCount() ? null : `${c}:${seed}:${n}`;
}
// Backend population keys carry a workspace prefix outside `public`
// ("<ws>:sf:42:10000"), so compare on the city:seed:n tail.
function samePopulationAs(key) {
  const mine = populationKey();
  if (!key || !mine) return !key;
  return key === mine || key.endsWith(":" + mine);
}
export { samePopulationAs };
// Census figures back the chart only as tooltip text: one verified-data query per
// dimension, cached per city, never used as chart data.
const CENSUS_ALIAS = { age: "age", gender: "sex", race: "race and ethnicity", education: "education", employment: "employment", citizenship: "citizenship", nativity: "nativity", marital: "marital status", tenure: "tenure" };
const censusCache = new Map();  // `${city}:${dimension}` -> { byKey: Map, label } | null (unavailable) | "pending"
function censusHint(dimension, key) {
  const alias = CENSUS_ALIAS[dimension]; if (!alias) return null;
  const id = `${citySlug()}:${dimension}`;
  const c = censusCache.get(id);
  if (c === undefined) {
    censusCache.set(id, "pending");
    api.dataQuery(citySlug(), `Show the ${alias} distribution`, undefined, { record: false }).then((res) => {
      const byKey = new Map();
      for (const row of res?.chart?.series || []) {
        const clause = row?.map_filter?.clauses?.[0];
        if (clause?.key) byKey.set(clause.key, row);
      }
      censusCache.set(id, res?.status === "ok" && byKey.size ? { byKey, vintage: res?.source?.vintage || "2023 ACS" } : null);
      chart.inst?.render();
      refreshFeedPanel({ quiet: true });
    }).catch(() => censusCache.set(id, null));
    return null;
  }
  if (!c || c === "pending") return null;
  const row = c.byKey.get(key); if (!row) return null;
  const share = Number(row.value); const unit = share <= 100 ? `${share.toFixed(1)}%` : String(share);
  return `Census ${c.vintage} PUMS: this group is ${unit} of ${state.city?.display || "the city"} (${Number(row.raw_records || 0).toLocaleString()} records)`;
}
// Map tap → the resident's group in the chart's active dimension.
function selectEvidenceResident({ id, segments }) {
  if (!chart.inst || state.phase !== "results") return;
  const dimension = chart.inst.dimension;
  const key = segments?.[dimension];
  if (!key || !chart.inst.selectGroup(dimension, key)) { toast("This resident has no group in the active chart dimension."); return; }
  $("evidence-panel")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
map.onResidentSelect = selectEvidenceResident;

// ── persona modal (a resident behind a statistic) ─────────────────────────
const personaEls = { modal: $("persona-modal"), scrim: $("persona-scrim"), close: $("persona-close"), body: $("persona-body") };
const personaOpen = () => !personaEls.modal.classList.contains("hidden");
let personaSeq = 0;
function closePersonaModal() { hide(personaEls.modal); hide(personaEls.scrim); personaSeq++; }
async function openPersonaModal(resident, answer, ctx = {}) {
  if (!resident) return;
  const seq = ++personaSeq;
  const a = answerLabel(answer, ctx);
  const sub = [Number.isFinite(resident.age) ? `${resident.age}` : null, RACE_LABEL[resident.race_eth] || resident.race_eth, EDUC_LABEL[resident.educ] || resident.educ, resident.occupation, resident.neighborhood].filter(Boolean).join(" · ");
  personaEls.body.innerHTML = `
    <div class="persona-head">
      <canvas class="persona-portrait" width="72" height="72"></canvas>
      <div><div class="persona-name">${escapeHtml(resident.name || `Resident ${resident.id}`)}</div><div class="persona-sub">${escapeHtml(sub)}</div></div>
    </div>
    ${a ? `<div class="persona-answer"><b>${escapeHtml(a.text)}</b>${ctx.question ? ` · ${escapeHtml(ctx.question)}` : ""}${answer?.why ? `<br>“${escapeHtml(answer.why)}”` : ""}<span class="pc-archetype">${ctx.personal ? "their own answer" : "archetype view"}</span></div>` : ""}
    <div class="persona-section persona-loading">Loading their story…</div>`;
  show(personaEls.modal); show(personaEls.scrim);
  map.drawCharTo(personaEls.body.querySelector(".persona-portrait"), map.charOf(resident.id));
  personaEls.close.focus({ preventScroll: true });
  const branch = state.mainBranch;
  if (!branch) return;
  try {
    const d = await api.getAgentDetail(branch, resident.id);
    if (seq !== personaSeq) return;
    const facts = [
      ["Age", d.age], ["Sex", d.sex === "women" ? "female" : d.sex === "men" ? "male" : d.sex], ["Race / ethnicity", RACE_LABEL[d.race_eth] || d.race_eth],
      ["Education", EDUC_LABEL[d.educ] || d.educ], ["Work", d.occupation], ["Neighborhood", d.neighborhood],
      ["Housing", d.homeowner ? "owns" : "rents"], ["Marital status", String(d.marital || "").replaceAll("_", " ")],
      ["Born", d.nativity === "foreign_born" ? "abroad" : "in the US"], ["Citizen", d.citizen ? "yes" : "no"],
      ["Religion", String(d.religion || "").replaceAll("_", " ").toLowerCase()],
    ].filter(([, v]) => v !== undefined && v !== null && v !== "");
    personaEls.body.querySelector(".persona-loading").outerHTML = `
      <div class="persona-section"><div class="res-why-label">who they are</div><p class="persona-prose">${escapeHtml(d.persona || "")}</p></div>
      ${d.values_summary ? `<div class="persona-section"><div class="res-why-label">what they care about</div><p class="persona-prose">${escapeHtml(d.values_summary)}</p></div>` : ""}
      <div class="persona-section"><div class="res-why-label">on record</div><dl class="persona-facts">${facts.map(([k, v]) => `<div class="persona-fact"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl></div>`;
  } catch {
    if (seq !== personaSeq) return;
    personaEls.body.querySelector(".persona-loading").textContent = "Their full persona isn't available right now.";
  }
}
personaEls.close.addEventListener("click", closePersonaModal);
personaEls.scrim.addEventListener("click", closePersonaModal);

// Reopen a past ask from the timeline as a full result card, rebuilt from memory.
function openPastResult(item) {
  if (!item || item.type !== "test") return;
  if (isBusy()) return;
  closeCharCard();
  const stored = item.breakdowns && typeof item.breakdowns === "object" ? item.breakdowns : {};
  const options = Array.isArray(item.options) ? item.options : [];
  const framing = options.length && Array.isArray(item.p_distribution) && item.p_distribution.length ? "options" : (item.framing || "vote");
  const result = {
    question: item.question, framing, model: item.model, n_agents: item.n_agents,
    p_yes: item.p_yes, ci_low: null, ci_high: null,
    p_distribution: framing === "options" ? options.map((o, i) => [o, item.p_distribution[i] ?? 0]) : (stored.p_distribution || []),
    breakdowns: stored.breakdowns || {}, option_breakdowns: stored.option_breakdowns || [],
    sample_rationales: [], hydra: null, audience: currentAudience(),
    past: { test_id: item.id, created_at: item.created_at, events_known: item.events_known, population_key: item.population_key, kind: item.kind, under_event: item.under_event },
  };
  map.clearVerdicts();
  state.lastResult = result;
  constellations.setResult(result);
  showResults(result);
}


// ── boot ───────────────────────────────────────────────────────────────
// 0 → 1 progress on the thin boot bar. createSim is one slow step (~0.2); the
// agent fetch is paged, so it fills the rest (0.2 → 0.97) as residents arrive.
function setBoot(p) { els.bootFill.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`; }

async function boot() {
  map.onZoomChange = (zoomedIn) => { zoomedIn ? show(els.returnBtn) : hide(els.returnBtn); };
  map.start();
  initFeedPanel({
    getCity: citySlug,
    getBranch: () => state.mainBranch,
    getCityDisplay: () => state.city?.display || "San Francisco",
    getResidents: () => state.residents,
    getNews: () => state.news,
    // timeline charts highlight residents through the same map API the result card uses
    setSegmentSelection: (selection) => map.setSegmentSelection(selection),
    getSegmentSelectionSummary: () => map.getSegmentSelectionSummary(),
    getRawResidents: () => state.rawResidents,
    evidenceReady: (dimension) => state.rawResidents.length > 0 && state.rawResidents.every((r) =>
      Number.isFinite(r.pums_weight) && r.pums_weight >= 0 && typeof r.segments?.[dimension] === "string"),
    dimensionLabels: AB_DIM_LABEL,
    // persona charts inside timeline entries share the result card's pieces
    groupLabel: evidenceLabel,
    drawHead: (canvas, id) => map.drawHeadTo(canvas, id),
    openPerson: openPersonaModal,
    fetchAnswers,
    fetchPersonal,
    sourceHint: censusHint,
    getPopulationKey: populationKey,
    openPastResult,
  });
  setStatusLoading("waking the city…");
  if (api.isDemo) { document.body.classList.add("offline-demo"); $("demo-banner").hidden = false; }
  syncFilterButton();
  // A brand-new workspace gets example surveys and events so it never opens empty.
  if (isFreshWorkspace() && !api.isDemo) {
    setStatusLoading("loading example surveys…");
    try { await api.seedWorkspace(); } catch (e) { console.warn("workspace seeding skipped:", e); }
  }

  // Load the city catalog first (best-effort). If it fails we keep the existing
  // single-city SF behavior — the switcher just stays hidden.
  let initial = SF_FALLBACK;
  try {
    const data = await api.getCities();
    const cities = (data?.cities || []).filter((c) => c && c.slug);
    if (cities.length) {
      state.cities = cities;
      initial = cities.find((c) => c.default) || cities[0];
      buildTitleSelect();
    }
  } catch (err) {
    console.warn("city catalog unavailable, falling back to SF:", err);
  }

  await loadCity(initial);
  if (state.phase !== "error") initTour();
}

// Create (or re-create) the simulation for a city, point the map base/bbox at it,
// load that city's agents and reset the overview. Shared by boot + the switcher.
async function loadCity(city, { filters = state.filters, preserveOnError = false } = {}) {
  filters = normalizeFilters(filters);
  constellations.reset();
  state.lastResult = null;
  resetEvidence();
  state.rawResidents = [];
  state.city = city;
  // Committed local tiles supply dimensions and shoreline masks without a live source call.
  const maskBase = `assets/${city.slug}_tiles.png`;
  if (city.bbox) MAP.bbox = { ...city.bbox };
  MAP.base = maskBase;
  map.setSatellite(true);           // satellite imagery on (PR 3 had switched to flat local tiles)
  map.setBase(maskBase);
  syncActiveTitle();

  setStatusLoading(`waking ${city.display}…`);
  hide(els.newsBubble);            // clear the previous city's news while loading
  state.news = [];
  state.mainBranch = null;
  refreshFeedPanel();              // the feed follows the city; branch arrives after boot
  show(els.boot); setBoot(0.06);
  try {
    const sim = await api.createSimulation({
      city: city.slug,
      ...(filterCount(filters) ? { filters } : {}),
    });
    if (filterCount(filters) && sim.source_records == null) {
      throw new Error("This backend does not support resident filters yet. Run the updated backend locally.");
    }
    setBoot(0.2);
    const agents = await api.getAllAgents(sim.main_branch, (loaded, total) => {
      setBoot(0.2 + 0.77 * (total ? loaded / total : 0));
    });
    if (!agents.length) throw new Error("no agents returned");
    state.rawResidents = agents;
    state.simId = sim.simulation_id;
    state.mainBranch = sim.main_branch;
    state.filters = filters;
    state.filterSourceRecords = sim.source_records ?? city.n_pums ?? null;
    map.setAgents(agents);
    state.residents = agents.length;
    map.setSim(city.slug, state.mainBranch);     // scope ambient chatter to this city + branch
    setBoot(1);
    state.phase = "idle";
    setIdleStatus();
    syncFilterButton();
    // let the bar finish, fade it out, then surface the news in its place (no overlap)
    setTimeout(() => { hide(els.boot); loadNews(city.slug); }, 450);
    refreshFeedPanel();              // branch is ready: enable posting
    return sim;
  } catch (err) {
    console.error(err);
    hide(els.boot);
    if (preserveOnError && state.simId && state.mainBranch) {
      state.phase = "idle";
      setIdleStatus();
      syncFilterButton();
      if (state.news.length) { renderNews(); show(els.newsBubble); }
      throw err;
    }
    hide(els.newsBubble);
    state.simId = null; state.mainBranch = null;
    map.setAgents(fallbackAgents(SIM.n));        // never leave an empty city
    els.status.textContent = "backend unreachable · retrying…";
    toast("Couldn't reach the backend — retrying every few seconds.");
    state.phase = "error";
    syncFilterButton();
    scheduleBackendRetry(city, filters);
    return null;
  }
}

// After an outage the page keeps checking the backend and reloads the city the
// moment it answers, instead of sitting in a dead "offline" state.
const RETRY_EVERY_MS = 5000, RETRY_MAX = 24;
function scheduleBackendRetry(city, filters) {
  if (state.retryTimer) return;
  let tries = 0;
  const tick = async () => {
    tries += 1;
    try {
      const h = await api.health();
      if (h && h.status === "ok") {
        clearInterval(state.retryTimer); state.retryTimer = null;
        els.status.textContent = "backend is back · waking the city…";
        state.phase = "booting";
        await loadCity(city, { filters });
        return;
      }
    } catch { /* still down */ }
    if (tries >= RETRY_MAX) {
      clearInterval(state.retryTimer); state.retryTimer = null;
      els.status.textContent = "backend unreachable · reload to try again";
    }
  };
  state.retryTimer = setInterval(tick, RETRY_EVERY_MS);
}

// status card in a loading state: spinner instead of the live dot
function setStatusLoading(text) {
  els.status.textContent = text;
  els.status.classList.add("is-loading");
}

function setIdleStatus() {
  els.status.classList.remove("is-loading");
  const n = state.residents.toLocaleString();
  const display = (state.city?.display || "san francisco").toLowerCase();
  const kd = state.city?.knowledge_date;
  const audience = describeAudience(currentAudience());
  els.status.classList.toggle("status--audience", !!audience.filterCount);
  if (audience.filterCount) {
    els.status.innerHTML = `<span class="status-audience-label">Current audience · ${audience.filterCount} filters</span>
      <strong class="status-persona">${escapeHtml(audience.title)}</strong>
      ${audience.qualification ? `<span class="status-persona-detail">${escapeHtml(audience.qualification)}</span>` : ""}
      <span class="status-persona-detail">${escapeHtml(audience.location)}</span>
      <span class="status-sample">${n} simulated residents in this audience</span>`;
  } else {
    const clock = kd ? `<span class="status-clock">residents know the news up to ${escapeHtml(fmtDate(kd))}</span>` : "";
    els.status.innerHTML = `${escapeHtml(display)} · ${n} simulated residents${clock}`;
  }
  show(els.status);
}

// The audience can wrap to several lines. Keep news below it at every viewport.
function positionContext() {
  $("ui").style.setProperty("--context-bottom", `${Math.ceil(els.status.getBoundingClientRect().bottom) + 10}px`);
}
new ResizeObserver(positionContext).observe(els.status);

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// fetch the city's recent news into the bubble (best-effort); click to expand all
async function loadNews(slug) {
  state.newsExpanded = false;
  // headlines now surface inside the feed panel as "city desk" posts; the
  // legacy bubble stays hidden.
  try {
    const data = await api.getNews(slug);
    state.news = data.articles || [];
  } catch {
    state.news = [];
  }
  hide(els.newsBubble);
  if (slug === citySlug()) refreshFeedPanel({ quiet: true });
}

// render the news bubble in its current (collapsed / expanded) state
function renderNews() {
  const arts = state.news;
  if (!arts.length) { hide(els.newsBubble); return; }
  els.newsBubble.dataset.expanded = state.newsExpanded ? "true" : "false";
  const caret = arts.length > 1
    ? `<svg class="news-toggle" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>`
    : "";
  const head = `<span class="news-head"><span>informing the residents</span>${caret}</span>`;
  // on mobile the status drops the clock for space, so surface it here when opened
  const kd = state.city?.knowledge_date;
  const clock = (state.newsExpanded && kd && window.innerWidth < 560)
    ? `<div class="news-clock">residents know the news up to ${escapeHtml(fmtDate(kd))}</div>` : "";
  const body = clock + (state.newsExpanded
    ? arts.map((a) =>
        `<div class="news-art">` +
        (a.date ? `<span class="news-art-date">${escapeHtml(fmtDate(a.date))}</span>` : "") +
        `<span class="news-art-head">${escapeHtml(a.headline)}</span>` +
        (a.summary ? `<span class="news-art-sum">${escapeHtml(a.summary)}</span>` : "") +
        `</div>`
      ).join("")
    : arts.slice(0, 3).map((a) => `<span class="news-item">${escapeHtml(a.headline)}</span>`).join(""));
  els.newsBubble.innerHTML = head + body;
}

// click the bubble to expand it to all the news updating the residents (and back)
els.newsBubble.addEventListener("click", () => {
  if (!state.news.length) return;
  state.newsExpanded = !state.newsExpanded;
  renderNews();
});

// ── title-select: the title itself is the city switcher ────────────────────
function buildTitleSelect() {
  els.titleMenu.innerHTML = state.cities.map((c) =>
    `<button class="title-option" type="button" role="option" data-slug="${escapeHtml(c.slug)}"
       aria-selected="false">${escapeHtml(c.display)}</button>`
  ).join("");
  els.titleMenu.querySelectorAll(".title-option").forEach((btn) => {
    btn.addEventListener("click", () => { closeTitleMenu(); onSelectCity(btn.dataset.slug); });
  });
  syncActiveTitle();
}

function titleMenuOpen() { return els.titleBtn.getAttribute("aria-expanded") === "true"; }
function openTitleMenu() {
  if (state.cities.length <= 1 || state.switching) return;
  show(els.titleMenu);
  els.titleBtn.setAttribute("aria-expanded", "true");
}
function closeTitleMenu() {
  hide(els.titleMenu);
  els.titleBtn.setAttribute("aria-expanded", "false");
}
function toggleTitleMenu() { titleMenuOpen() ? closeTitleMenu() : openTitleMenu(); }

// reflect the active city in the title button + the menu; lock while swapping
function syncActiveTitle() {
  const city = state.cities.find((c) => c.slug === citySlug());
  els.titleCurrent.textContent = city?.display || state.city?.display || "San Francisco";
  els.titleMenu.querySelectorAll(".title-option").forEach((btn) => {
    btn.setAttribute("aria-selected", btn.dataset.slug === citySlug() ? "true" : "false");
    btn.disabled = state.switching;
  });
  els.titleBtn.disabled = state.switching || state.cities.length <= 1;
}

// title-button toggles the dropdown; click-away / Escape close it
els.titleBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!els.titleBtn.disabled) toggleTitleMenu();
});
document.addEventListener("click", (e) => {
  if (titleMenuOpen() && !els.titleSelect.contains(e.target)) closeTitleMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && titleMenuOpen()) closeTitleMenu();
});

// ── population filters ──────────────────────────────────────────────────
// Filters are sent when the simulation is created, so every later workflow
// (map, poll, A/B, and marketing counterfactual) uses the same subset.
let filterPreviousFocus = null;
const filterOpen = () => !els.filterModal.classList.contains("hidden");

function setFilterError(message) {
  els.filterError.textContent = message || "";
  if (message) els.filterError.focus();
}

function setFilterBusy(busy) {
  els.filterForm.setAttribute("aria-busy", busy ? "true" : "false");
  for (const control of [
    els.filterAge, els.filterOccupation, els.filterEducation,
    els.filterApply, els.filterClear,
  ]) control.disabled = busy;
  els.filterPuma.disabled = busy || !(state.city?.neighborhoods || []).length;
  els.filterApply.textContent = busy ? "Building sample…" : "Apply filters";
}

function populateFilterAreas(selectedPuma) {
  const areas = state.city?.neighborhoods || [];
  els.filterPuma.innerHTML = `<option value="">Anywhere in this city</option>` + areas.map((area) =>
    `<option value="${Number(area.puma)}">${escapeHtml(area.label)}</option>`
  ).join("");
  els.filterPuma.value = selectedPuma == null ? "" : String(selectedPuma);
  els.filterPuma.disabled = !areas.length;
}

function writeFilterForm(filters = state.filters) {
  const f = normalizeFilters(filters);
  els.filterAge.value = Number.isInteger(f.age) ? String(f.age) : "";
  populateFilterAreas(f.puma);
  els.filterOccupation.value = f.occupation || "";
  els.filterEducation.value = f.education || "";
}

function readFilterForm() {
  const ageText = els.filterAge.value.trim();
  const age = ageText === "" ? null : Number(ageText);
  if (age != null && (!Number.isInteger(age) || age < 0 || age > 99)) {
    throw new Error("Age must be a whole number from 0 to 99.");
  }
  return normalizeFilters({
    ...(age == null ? {} : { age }),
    ...(els.filterPuma.value ? { puma: Number(els.filterPuma.value) } : {}),
    ...(els.filterOccupation.value ? { occupation: els.filterOccupation.value } : {}),
    ...(els.filterEducation.value ? { education: els.filterEducation.value } : {}),
  });
}

function openFilters() {
  if (isBusy() || state.switching || state.phase === "booting") return;
  if (state.phase === "error" || !state.mainBranch) {
    toast("Resident filters need the backend — it's currently unreachable.");
    return;
  }
  closeCharCard();
  hideAudienceCard();
  filterPreviousFocus = els.audienceChip;
  writeFilterForm();
  setFilterError("");
  setFilterBusy(false);
  show(els.filterScrim);
  show(els.filterModal);
  requestAnimationFrame(() => els.filterAge.focus());
}

function closeFilters(restoreFocus = true) {
  hide(els.filterModal);
  hide(els.filterScrim);
  setFilterError("");
  setFilterBusy(false);
  if (restoreFocus && filterPreviousFocus?.focus) filterPreviousFocus.focus();
}

function filterErrorMessage(err) {
  return (err?.message || "Couldn't build that sample.")
    .replace(/^POST \/simulations → \d+:\s*/, "");
}

async function applyPopulationFilters(filters) {
  if (isBusy() || state.switching || !state.city) return;
  const previousFilters = state.filters;
  const previousSourceRecords = state.filterSourceRecords;
  const requested = normalizeFilters(filters);

  state.reqId++;
  if (state.abort) { state.abort.abort(); state.abort = null; }
  map.onProgress = null; map.onRevealComplete = null;
  els.progress.classList.remove("indeterminate");
  cleanupBranch();
  closeCharCard();
  hide(els.summary); hide(els.resultCard);
  if (inputOpen()) closeInput();

  setFilterError("");
  setFilterBusy(true);
  state.switching = true;
  state.phase = "booting";
  syncActiveTitle();
  syncFilterButton();

  try {
    const sim = await loadCity(state.city, { filters: requested, preserveOnError: true });
    closeFilters(false);
    showAudienceCard(sim, requested);
  } catch (err) {
    state.filters = previousFilters;
    state.filterSourceRecords = previousSourceRecords;
    setFilterError(filterErrorMessage(err));
    state.phase = "idle";
    setIdleStatus();
  } finally {
    state.switching = false;
    setFilterBusy(false);
    syncActiveTitle();
    syncFilterButton();
  }
}

// The audience card confirms who will be asked from now on. It is a plain
// card in the dock, dismissed by Done or on its own after a moment.
let audienceCardTimer = null;
function showAudienceCard(sim, filters) {
  const info = describeAudience(currentAudience());
  const count = filterCount(filters);
  const qual = info.qualification ? ` ${info.qualification[0].toLowerCase()}${info.qualification.slice(1)}` : "";
  els.audienceCardTitle.textContent = count
    ? `${info.title}${qual}`
    : `Everyone in ${state.city?.display || "the city"}`;
  const source = sim?.source_records ?? state.filterSourceRecords;
  els.audienceCardMeta.textContent = [
    info.location,
    `${(state.residents || 0).toLocaleString()} simulated residents`,
    source != null ? `${source.toLocaleString()} Census ${source === 1 ? "record" : "records"}` : null,
  ].filter(Boolean).join(" · ");
  show(els.audienceCard);
  clearTimeout(audienceCardTimer);
  audienceCardTimer = setTimeout(hideAudienceCard, 9000);
  requestAnimationFrame(() => els.audienceCardDone.focus({ preventScroll: true }));
}
function hideAudienceCard() { clearTimeout(audienceCardTimer); hide(els.audienceCard); }
els.audienceCardDone.addEventListener("click", () => { hideAudienceCard(); els.audienceChip.focus(); });
els.audienceChip.addEventListener("click", (e) => { e.stopPropagation(); openFilters(); });
els.audienceChip.addEventListener("keydown", (e) => e.stopPropagation());
els.filterClose.addEventListener("click", () => closeFilters());
els.filterScrim.addEventListener("click", () => closeFilters());
els.filterForm.addEventListener("submit", (e) => {
  e.preventDefault();
  try { applyPopulationFilters(readFilterForm()); }
  catch (err) { setFilterError(err.message); }
});
els.filterClear.addEventListener("click", () => {
  writeFilterForm({});
  applyPopulationFilters({});
});

async function onSelectCity(slug) {
  if (state.switching || slug === citySlug()) return;
  const city = state.cities.find((c) => c.slug === slug);
  if (!city) return;

  // tear down any in-flight prediction / lingering UI from the previous city
  state.reqId++;
  if (state.abort) { state.abort.abort(); state.abort = null; }
  map.onProgress = null; map.onRevealComplete = null;
  els.progress.classList.remove("indeterminate");
  cleanupBranch();
  closeCharCard();
  if (filterOpen()) closeFilters(false);
  hideAudienceCard();
  hide(els.summary); hide(els.resultCard);
  if (inputOpen()) closeInput();

  // Areas are city-specific, so a city change returns to that city's full sample.
  state.filters = {};
  state.filterSourceRecords = null;
  syncFilterButton();

  state.switching = true;
  state.phase = "booting";
  syncActiveTitle();
  try {
    await loadCity(city);
  } finally {
    state.switching = false;
    syncActiveTitle();
    syncFilterButton();
  }
}
// keep the status text right-sized across orientation changes
window.addEventListener("resize", () => {
  if (state.phase === "idle" || state.phase === "results") setIdleStatus();
  positionContext();
});

// random points inside the map bbox, for the offline preview only
function fallbackAgents(n) {
  const { bbox } = map.proj;
  const out = [];
  for (let i = 0; i < n; i++) {
    const lon = bbox.minLon + Math.random() * (bbox.maxLon - bbox.minLon);
    const lat = bbox.minLat + Math.random() * (bbox.maxLat - bbox.minLat);
    out.push({ lonlat: [lon, lat] });
  }
  return out;
}

// ── ask composer (multiline) ───────────────────────────────────────────
// The composer opens at exactly one line and expands only HORIZONTALLY; it grows
// vertically solely when the typed text wraps past a single line.
const LINE_H = 24;
function autoGrow() {
  const ta = els.askInput;
  ta.style.height = LINE_H + "px";          // reset to one line, then measure
  const sh = ta.scrollHeight;
  if (sh > LINE_H + 1) {
    const cap = Math.round(window.innerHeight * 0.4);
    const h = Math.min(sh, cap);
    ta.style.height = h + "px";
    ta.style.overflowY = h >= cap ? "auto" : "hidden";
  } else {
    ta.style.overflowY = "hidden";
  }
}

function openInput({ mode = "predict", preserve = false } = {}) {
  if (isBusy() || state.phase === "booting" || state.switching) return;
  if (state.queryMode !== "verified" && (state.phase === "error" || !state.simId)) { toast("Predictions need the backend — it's currently unreachable."); return; }
  cleanupBranch();
  map.clearVerdicts();
  closeCharCard();
  hideAudienceCard();
  hide(els.summary);
  hide(els.resultCard);
  setAskMode(mode);
  els.askInput.value = ""; els.askInput.style.height = LINE_H + "px";
  if (!preserve) { els.abA.value = ""; els.abB.value = ""; els.marketingCopy.value = ""; }
  else if (mode === "ab" && state.lastAbInput) {
    els.askInput.value = state.lastAbInput.question; els.abA.value = state.lastAbInput.variant_a; els.abB.value = state.lastAbInput.variant_b;
  } else if (mode === "marketing" && state.lastMarketingInput) {
    els.askInput.value = state.lastMarketingInput.question; els.marketingCopy.value = state.lastMarketingInput.marketingText;
  }
  setAsk("input");
  state.phase = "idle";
  setIdleStatus();
  requestAnimationFrame(() => { if (inputOpen()) { autoGrow(); els.askInput.focus(); } });
}

function closeInput() {
  clearEvidenceSelection();
  setAsk("idle");
  els.askInput.value = "";
  els.askInput.style.height = LINE_H + "px";
  els.askInput.blur();
  els.askError.textContent = "";
  setComposerBusy(false);
  setAskMode("predict");
}

// While an A/B or post test runs, the composer's extra fields stay put but
// cannot be edited; the send button doubles as the busy indicator.
function setComposerBusy(busy) {
  els.ask.setAttribute("aria-busy", busy ? "true" : "false");
  for (const f of [els.askInput, els.abA, els.abB, els.marketingCopy]) f.disabled = busy;
  els.askSubmit.disabled = busy;
}


// Every result card, live or reopened from the timeline, gets a persistent close
// button in the top-right corner (the bottom "Dismiss" can be far below the fold).
function showResultCard() {
  if (!els.resultCard.querySelector(".res-close")) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "about-close res-close"; btn.setAttribute("aria-label", "Close result");
    btn.textContent = "×";
    btn.addEventListener("click", dismissResults);
    els.resultCard.prepend(btn);
  }
  show(els.resultCard);
}

function dismissResults() {
  state.queryMode = "simulation";
  hide(els.resultCard);
  els.resultCard.classList.remove("ab-result");
  abRerender = null;
  hide(els.summary);
  map.clearVerdicts();
  cleanupBranch();
  setAsk("idle");
  setIdleStatus();
  state.phase = "idle";
}

function cancelPrediction() {
  state.queryMode = "simulation";
  setComposerBusy(false);
  state.reqId++;
  if (state.abort) { state.abort.abort(); state.abort = null; }
  map.onProgress = null; map.onRevealComplete = null;
  els.progress.classList.remove("indeterminate");
  hide(els.summary);
  hide(els.resultCard);
  if (marketingOpen()) closeMarketing();
  map.clearVerdicts();
  cleanupBranch();
  setAsk("idle");
  setIdleStatus();
  state.phase = "idle";
}

// heuristic framing, used only as a fallback when /parse is unavailable
function guessFraming(question) {
  return /\b(will|won't|by \d{4}|going to)\b/i.test(question) ||
    /^(will|is|are|does|do|can|could|would|should)\b/i.test(question) ? "belief" : "vote";
}

// Verified questions are independent of simulation creation, branches and opinions.
async function runVerifiedQuery(question) {
  question = (question || "").trim();
  if (!question || isBusy() || state.switching) return;
  state.queryMode = "verified";
  cleanupBranch(); map.clearVerdicts();
  const myReq = ++state.reqId;
  state.abort = new AbortController();
  state.phase = "waiting"; setAsk("busy"); els.askInput.blur();
  hide(els.resultCard); show(els.summary);
  els.summaryLabel.textContent = "VERIFIED DATA";
  els.summaryText.textContent = question;
  els.progress.classList.add("indeterminate");
  els.progressLabel.textContent = "Querying the complete PUMS snapshot… (Escape to cancel)";
  try {
    const response = await api.dataQuery(citySlug(), question, state.abort.signal);
    if (myReq !== state.reqId) return;
    verified.model = buildVerifiedDataModel(response);
    if (!verified.model.question) verified.model.question = question;
    showVerifiedResult();
  } catch (error) {
    if (myReq !== state.reqId) return;
    verified.model = buildVerifiedDataModel({question});
    showVerifiedResult();
    const note = document.createElement("p"); note.setAttribute("role", "status");
    note.textContent = "Unknown — the verified-data service is unavailable. Try again when it is reachable.";
    $("verified-host").prepend(note);
  } finally {
    if (myReq === state.reqId) state.abort = null;
  }
}

function showVerifiedResult() {
  constellations.reset();
  state.phase = "results"; setAsk("idle"); hide(els.summary);
  els.progress.classList.remove("indeterminate");
  els.resultCard.classList.remove("ab-result");
  els.resultCard.setAttribute("aria-label", "Verified data result");
  els.resultCard.innerHTML = `<div id="verified-host"></div><p id="verified-announcement" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p><div class="res-actions"><button id="res-again" class="btn btn-primary">Ask another</button><button id="res-dismiss" class="btn">Dismiss</button></div>`;
  renderActiveVerified();
  verified.dispose = bindVerifiedData($("verified-host"), {
    getModel:() => verified.model, getSelection:() => verified.selection,
    onSelectionChange:(next, action) => {
      verified.selection = verified.combine && action.type === "select"
        ? reduceVerifiedSelection(verified.model, verified.selection, {...action,type:"add"}) : next;
      renderActiveVerified();
    },
  });
  $("verified-host").addEventListener("change", event => {
    if (event.target.id === "verified-combine") verified.combine = event.target.checked;
  });
  $("res-again").addEventListener("click", openInput);
  $("res-dismiss").addEventListener("click", dismissResults);
  showResultCard();
  els.resultCard.scrollTop = 0;
  $("verified-heading").focus({preventScroll:true});
}

function renderActiveVerified() {
  const result = verifiedMapSelection(verified.model, verified.selection, state.rawResidents, citySlug());
  map.setSegmentSelection(result.selection);
  $("verified-host").innerHTML = renderVerifiedData(verified.model, verified.selection, result.count, result.ready);
  // Keep the live region mounted while the buttons rerender and regain focus.
  const summary = $("verified-host").querySelector("[data-verified-summary]");
  if (summary) { summary.removeAttribute("role"); summary.removeAttribute("aria-live"); }
  $("verified-announcement").textContent = summary?.textContent || "";
  if ($("verified-combine")) $("verified-combine").checked = verified.combine;
}

// ── prediction flow ─────────────────────────────────────────────────────
// 1) classify the question for the current city (POST /cities/<slug>/parse)
// 2) if unsupported → a gentle "try rephrasing" card (no poll)
// 3) if supported → poll the branch with the parsed {framing, question, description, options}
// Verified-data questions (Census/PUMS distributions and counts) are routed by
// their shape; everything else is a simulated prediction. Mirrors the backend's
// data_query grammar ("show the age distribution", "show population by race",
// "what share of adults …", "how many …").
const VERIFIED_QUESTION = /\b(distribution|population(?: counts)? by|what share of|what percent(?:age)? of|how many)\b/i;
function looksLikeVerifiedQuestion(question) {
  return VERIFIED_QUESTION.test(question || "");
}

async function runPrediction(question) {
  question = (question || "").trim();
  if (!question) return;
  if (state.askMode === "ab") return runAbTest();
  if (state.askMode === "marketing") return runMarketingTest();
  if (looksLikeVerifiedQuestion(question)) return runVerifiedQuery(question);
  state.queryMode = "simulation";
  if (state.phase === "error" || !state.simId) { toast("Predictions need the backend — it's currently unreachable."); return; }

  const audience = currentAudience();
  setRunAudience(audience);

  cleanupBranch();
  const myReq = ++state.reqId;
  state.abort = new AbortController();
  const signal = state.abort.signal;
  state.phase = "waiting";
  setAsk("busy");
  els.askInput.blur();

  els.summaryLabel.textContent = "READING";
  els.summaryText.textContent = question;
  els.progressFill.style.width = "12%";
  els.progress.classList.add("indeterminate");
  els.progressLabel.textContent = "understanding your question… (esc to cancel)";
  hide(els.resultCard);
  show(els.summary);
  map.setWaiting();

  try {
    // classify first; fall back to a heuristic binary framing if /parse is missing
    let parsed = null;
    try {
      parsed = await api.parseQuestion(citySlug(), question, signal);
    } catch (perr) {
      console.warn("parse unavailable, falling back to binary framing:", perr);
    }
    if (myReq !== state.reqId) return;

    if (parsed && parsed.supported === false) {
      const routerUnavailable = /could not reach the model|router.*unavailable/i.test(parsed.reason || "");
      if (routerUnavailable) {
        console.warn("question router unavailable, using local framing fallback");
        parsed = null;
      } else {
        showRephrase(parsed, question);
        return;
      }
    }

    const framing = parsed?.framing || guessFraming(question);
    const description = parsed?.description || "";
    const options = parsed?.options && parsed.options.length ? parsed.options : undefined;
    // Keep the user's own wording. The router still supplies framing, a neutral
    // description and any option list, but the question residents see (and the
    // timeline records) is exactly what was typed.
    const pollQuestion = question;

    els.summaryLabel.textContent = "PREDICTING";
    els.progressFill.style.width = "18%";
    els.progressLabel.textContent = "tallying the electorate… (esc to cancel)";

    const branch = await api.createBranch(state.simId, { ticks: PREDICT.branch_ticks, name: "predict", signal });
    if (myReq !== state.reqId) { api.deleteBranch(branch.branch_id); return; }
    state.branchId = branch.branch_id;

    const result = await api.poll(state.branchId, {
      question: pollQuestion, description, framing, ...(options ? { options } : {}),
      as_of_date: PREDICT.as_of_date, model: PREDICT.model,
    }, signal);
    if (myReq !== state.reqId) return;

    state.lastResult = { ...result, framing, question: pollQuestion, audience };
    constellations.setResult(state.lastResult);
    setTimeout(() => refreshFeedPanel({ quiet: true }), 1500); // the poll is now a post in the feed

    // p_yes drives the on-map green/red reveal for both paths; for options it is the
    // winning option's share, so the crowd still visualizes the result's strength.
    const verdicts = assignVerdicts(map.agents, result.p_yes, pollQuestion, map.proj.planarSize);
    map.setRationales(result.sample_rationales);   // real per-agent reasoning → thought bubbles
    els.progress.classList.remove("indeterminate");
    els.progressLabel.textContent = `0 / ${map.agents.length.toLocaleString()} responses`;
    map.onProgress = onRevealProgress;
    map.onRevealComplete = () => { if (myReq === state.reqId) showResults(state.lastResult); };
    state.phase = "reveal";
    map.startReveal(verdicts, TIMING.revealMs);
  } catch (err) {
    if (myReq !== state.reqId) return;
    console.error(err);
    toast(`Poll failed: ${err.message}`);
    hide(els.summary);
    els.progress.classList.remove("indeterminate");
    cleanupBranch();
    setAsk("idle");
    setIdleStatus();
    state.phase = "idle";
  }
}

const marketingOpen = () => inputOpen() && state.askMode === "marketing";

function setMarketingError(message) {
  els.askError.textContent = message || "";
  if (message) { if (!inputOpen()) openInput({ mode: "marketing", preserve: true }); els.askError.focus(); }
}

function setMarketingBusy(busy, label = "reading target…") {
  setComposerBusy(busy);
  if (busy) els.askLabel.textContent = label;
}

function openMarketing({ preserve = false } = {}) {
  if (isBusy()) return;
  if (state.phase === "error" || !state.mainBranch) { toast("Post tests need the backend — it's currently unreachable."); return; }
  resetEvidence();
  openInput({ mode: "marketing", preserve });
}

function closeMarketing(restoreFocus = true) {
  closeInput();
  if (restoreFocus) els.ask.focus();
}

async function runMarketingTest() {
  const input = {
    question: els.askInput.value.trim(),
    marketingText: els.marketingCopy.value,
  };
  if (!input.question) { setMarketingError("Enter the yes/no question whose support you want to measure."); return; }
  if (!input.marketingText.trim()) { setMarketingError("Enter the planned post copy to test."); return; }
  if (input.marketingText.length > 4000) { setMarketingError("Planned post copy must be at most 4,000 characters."); return; }
  if (state.phase === "error" || !state.mainBranch) { setMarketingError("Marketing tests need the backend — it's currently unreachable."); return; }

  cleanupBranch();
  const audience = currentAudience();
  setRunAudience(audience);

  state.lastMarketingInput = input;
  const myReq = ++state.reqId;
  state.abort = new AbortController();
  const signal = state.abort.signal;
  state.phase = "waiting";
  setAsk("busy");
  setMarketingError("");
  setMarketingBusy(true);

  try {
    const parsed = await api.parseQuestion(citySlug(), input.question, signal);
    if (myReq !== state.reqId) return;
    if (parsed?.supported === false) {
      setMarketingBusy(false);
      setMarketingError(parsed.reason || "This target could not be turned into a resident poll.");
      setAsk("idle");
      setIdleStatus();
      state.phase = "idle";
      return;
    }
    if (parsed?.framing !== "vote") {
      setMarketingBusy(false);
      setMarketingError("Use a yes/no support or voting question for this marketing test.");
      setAsk("idle");
      setIdleStatus();
      state.phase = "idle";
      return;
    }

    const pollQuestion = (input.question || parsed.question || "").trim(); // keep the user's wording
    const description = (parsed.description || "").trim();
    if (!pollQuestion || !description) {
      setMarketingBusy(false);
      setMarketingError("The target parser did not return a complete binary poll. Try rephrasing the question.");
      setAsk("idle");
      setIdleStatus();
      state.phase = "idle";
      return;
    }

    els.summaryLabel.textContent = "TESTING MARKETING";
    els.summaryText.textContent = pollQuestion;
    els.progressFill.style.width = "18%";
    els.progress.classList.add("indeterminate");
    els.progressLabel.textContent = "comparing baseline with simulated exposure… (esc to cancel)";
    hide(els.resultCard);
    show(els.summary);
    map.setWaiting();

    setMarketingBusy(true, "Comparing responses…");
    const branch = await api.createBranch(state.simId, {
      ticks: PREDICT.branch_ticks,
      name: "marketing-counterfactual",
      signal,
    });
    if (myReq !== state.reqId) { api.deleteBranch(branch.branch_id); return; }
    state.branchId = branch.branch_id;

    const result = await api.counterfactual(state.branchId, {
      question: pollQuestion,
      description,
      framing: parsed.framing,
      as_of_date: PREDICT.as_of_date,
      model: PREDICT.model,
      population: "all",
      marketing_text: input.marketingText,
    }, signal);
    if (myReq !== state.reqId) return;
    setTimeout(() => refreshFeedPanel({ quiet: true }), 1500); // both legs are posts in the feed

    const completedBranch = state.branchId;
    state.branchId = null;
    if (completedBranch) api.deleteBranch(completedBranch);
    closeMarketing(false);

    state.lastResult = { ...result, kind: "marketing", framing: parsed.framing, question: pollQuestion, audience };
    const exposed = result.exposed || {};
    const verdicts = assignVerdicts(map.agents, exposed.p_yes, `${pollQuestion}\n${input.marketingText}`, map.proj.planarSize);
    map.setRationales(exposed.sample_rationales || []);
    els.progress.classList.remove("indeterminate");
    els.progressLabel.textContent = `0 / ${map.agents.length.toLocaleString()} exposed responses`;
    map.onProgress = onRevealProgress;
    map.onRevealComplete = () => { if (myReq === state.reqId) showMarketingResults(state.lastResult); };
    state.phase = "reveal";
    map.startReveal(verdicts, TIMING.revealMs);
  } catch (err) {
    if (myReq !== state.reqId) return;
    console.error(err);
    hide(els.summary);
    els.progress.classList.remove("indeterminate");
    map.clearVerdicts();
    cleanupBranch();
    setAsk("idle");
    setIdleStatus();
    state.phase = "idle";
    openMarketing({ preserve: true });
    setMarketingError(`Marketing test failed: ${err.message}`);
  }
}

const abOpen = () => inputOpen() && state.askMode === "ab";

function openAbTest() {
  if (isBusy()) return;
  if (state.phase === "error" || !state.mainBranch) { toast("A/B tests need the backend — it's currently unreachable."); return; }
  resetEvidence();
  openInput({ mode: "ab", preserve: true });
}

function closeAbTest(restoreFocus = true) {
  closeInput();
  if (restoreFocus) els.ask.focus();
}

async function runAbTest() {
  const input = {
    question: els.askInput.value.trim(),
    variant_a: els.abA.value,
    variant_b: els.abB.value,
  };
  if (!input.question || !input.variant_a.trim() || !input.variant_b.trim()) {
    els.askError.textContent = "Add the question and both variants.";
    (input.question ? (input.variant_a.trim() ? els.abB : els.abA) : els.askInput).focus();
    return;
  }
  if (input.variant_a.trim() === input.variant_b.trim()) {
    els.askError.textContent = "The two variants are the same. Change one of them.";
    els.abB.focus();
    return;
  }
  if (state.phase === "error" || !state.mainBranch) { els.askError.textContent = "A/B tests need the backend — it's currently unreachable."; return; }

  cleanupBranch();
  state.lastAbInput = input;
  const audience = currentAudience();
  setRunAudience(audience);
  els.askError.textContent = "";
  closeInput();
  const myReq = ++state.reqId;
  state.abort = new AbortController();
  const signal = state.abort.signal;
  state.phase = "waiting";
  setAsk("busy");
  els.askLabel.textContent = "testing A/B…";
  hide(els.resultCard);
  els.summaryLabel.textContent = "TESTING A/B";
  els.summaryText.textContent = input.question;
  els.progressFill.style.width = "18%";
  els.progress.classList.add("indeterminate");
  els.progressLabel.textContent = "comparing demographic groups… (esc to cancel)";
  show(els.summary);
  map.setWaiting();

  try {
    const result = await api.abTest(state.mainBranch, {
      ...input,
      as_of_date: PREDICT.as_of_date,
      model: PREDICT.ab_model,
      population: "all",
    }, signal);
    if (myReq !== state.reqId) return;
    state.lastResult = { ...result, audience };
    constellations.setResult(state.lastResult);
    setTimeout(() => refreshFeedPanel({ quiet: true }), 1500); // the A/B test is now a post in the feed
    const verdicts = assignVerdicts(map.agents, result.a_share, input.question, map.proj.planarSize);
    map.setRationales(result.sample_rationales || []);
    els.progress.classList.remove("indeterminate");
    els.progressLabel.textContent = `0 / ${map.agents.length.toLocaleString()} responses`;
    map.onProgress = onRevealProgress;
    map.onRevealComplete = () => { if (myReq === state.reqId) showAbResults(state.lastResult); };
    state.phase = "reveal";
    map.startReveal(verdicts, TIMING.revealMs);
  } catch (err) {
    if (myReq !== state.reqId) return;
    console.error(err);
    hide(els.summary);
    els.progress.classList.remove("indeterminate");
    setAsk("idle");
    setIdleStatus();
    state.phase = "idle";
    if (err.status === 404) {
      openAbTest();
      els.askError.textContent =
        "A/B testing is temporarily unavailable because the frontend and API versions do not match. Update the backend, then run the test again — your inputs are saved.";
    } else {
      toast(`A/B test failed: ${err.message}`);
    }
  }
}

function onRevealProgress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  els.progressFill.style.width = `${Math.max(6, pct)}%`;
  els.progressLabel.textContent = `${done.toLocaleString()} / ${total.toLocaleString()} responses`;
}

// ── result card ──────────────────────────────────────────────────────────
function formatPct(value) {
  const n = (Number(value) || 0) * 100;
  return `${n.toFixed(1).replace(/\.0$/, "")}%`;
}

// a reopened ask: when it was asked and what the residents knew at the time
function pastMeta(result) {
  const p = result.past;
  const when = new Date(p.created_at);
  const stamp = Number.isNaN(when.getTime()) ? "" : when.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const known = Number.isFinite(p.events_known) ? ` · asked with ${p.events_known} event${p.events_known === 1 ? "" : "s"} in memory` : "";
  const hypo = p.under_event ? `<div class="res-meta">under hypothetical: ${escapeHtml(p.under_event)}</div>` : "";
  return `<div class="res-meta">From the timeline · ${escapeHtml(stamp)}${known}${result.model ? ` · ${escapeHtml(result.model)}` : ""}</div>${hypo}`;
}

function hydraMeta(result) {
  const hydra = result?.hydra;
  if (!hydra || hydra.status !== "connected" || !Number(hydra.chunks)) return "";
  const sourceTitles = (hydra.sources || []).map((source) => source.title).filter(Boolean);
  const sourceText = sourceTitles.length ? ` · ${sourceTitles.slice(0, 3).join(", ")}` : "";
  return `<div class="res-meta res-hydra">Additional source context${escapeHtml(sourceText)}</div>`;
}

function showMarketingResults(result) {
  resetEvidence();
  state.phase = "results";
  els.resultCard.classList.remove("ab-result");
  abRerender = null;
  setAsk("idle");
  els.progressFill.style.width = "100%";
  hide(els.summary);
  clearTimeout(toastTimer); hide(els.toast);

  const baseline = result.baseline || {};
  const exposed = result.exposed || {};
  const deltaPoints = (Number(result.delta) || 0) * 100;
  const deltaAbs = Math.abs(deltaPoints).toFixed(1).replace(/\.0$/, "");
  const signedDelta = `${deltaPoints > 0 ? "+" : deltaPoints < 0 ? "−" : ""}${deltaAbs} pp`;
  const deltaClass = deltaPoints > 0 ? "positive" : deltaPoints < 0 ? "negative" : "";
  const rationales = (exposed.sample_rationales || []).slice(0, 3);
  const n = exposed.n_agents ?? map.agents.length;

  els.resultCard.innerHTML = `
    ${audienceHeader(result.audience, n)}
    <div class="res-q">${escapeHtml(result.question || exposed.question || "")}</div>
    <div class="res-cf-headline">
      <span class="res-cf-delta ${deltaClass}">${signedDelta}</span>
      <span class="res-cf-verb">simulated support shift</span>
    </div>
    <div class="res-cf-grid">
      <div class="res-cf-arm">
        <span class="res-cf-label">baseline support</span>
        <span class="res-cf-value">${formatPct(baseline.p_yes)}</span>
        <span class="res-cf-ci">95% CI ${formatPct(baseline.ci_low)}–${formatPct(baseline.ci_high)}</span>
      </div>
      <div class="res-cf-arm exposed">
        <span class="res-cf-label">exposed support</span>
        <span class="res-cf-value">${formatPct(exposed.p_yes)}</span>
        <span class="res-cf-ci">95% CI ${formatPct(exposed.ci_low)}–${formatPct(exposed.ci_high)}</span>
      </div>
    </div>
    <div class="res-scope">${audienceScope(result.audience)} · same audience in both arms</div>
    ${hydraMeta(exposed)}
    <div class="res-cf-note">Model-based comparison under simulated exposure of every sampled resident to the planned copy—not an estimate of organic reach. Each arm has its own 95% CI; no separate CI was estimated for the delta, so treat small shifts cautiously.</div>
    ${rationales.length ? `<div class="res-why"><div class="res-why-label">simulated responses after exposure</div><ul>${rationales.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul></div>` : ""}
    <div class="res-actions"><button id="res-edit-marketing" class="btn btn-primary">Edit test</button><button id="res-dismiss" class="btn">Dismiss</button></div>`;
  showResultCard();
  attachEvidence(exposed);
  $("res-edit-marketing").addEventListener("click", () => openMarketing({ preserve: true }));
  $("res-dismiss").addEventListener("click", dismissResults);
  requestAnimationFrame(() => {
    els.resultCard.scrollTop = 0;
    $("res-edit-marketing").focus({ preventScroll: true });
  });
}

function showResults(result) {
  resetEvidence();
  state.phase = "results";
  els.resultCard.classList.remove("ab-result");
  abRerender = null;
  setAsk("idle");
  els.progressFill.style.width = "100%";
  hide(els.summary);
  clearTimeout(toastTimer); hide(els.toast);

  if (result.framing === "options" && Array.isArray(result.p_distribution) && result.p_distribution.length) {
    showOptionResults(result);
    return;
  }

  const pct = Math.round((result.p_yes ?? 0) * 100);
  const noPct = 100 - pct;
  const belief = result.framing === "belief";
  const ciLow = Math.round((result.ci_low ?? result.p_yes) * 100);
  const ciHigh = Math.round((result.ci_high ?? result.p_yes) * 100);
  const n = result.n_agents ?? map.agents.length;
  const rationales = (result.sample_rationales || []).slice(0, 3);

  // Binary polls carry the same demographic cut set as A/B tests, so they get the
  // same advanced panel — with yes/no as the two options instead of A/B.
  const breakdowns = normalizeBreakdowns(result.option_breakdowns);
  abPanel.labels = belief ? { a: "yes", b: "no" } : { a: "support", b: "oppose" };
  abPanel.view = "movers";
  abPanel.dimension = null;
  abPanel.cross = null;
  const yesShare = result.p_yes ?? 0;
  const segments = abSegments(breakdowns, yesShare, abCellLabel);

  const renderPanel = () => {
    els.resultCard.innerHTML = `
      ${audienceHeader(result.audience, n)}
      <div class="res-q">${escapeHtml(result.question || "")}</div>
      <div class="res-headline">
        <span class="res-pct">${pct}<span class="res-pct-sym">%</span></span>
        <span class="res-verb">${belief ? "answer yes" : "vote yes"}</span>
      </div>
      <div class="res-bar">
        <div class="res-bar-yes" style="width:${pct}%"></div>
        <div class="res-bar-no" style="width:${noPct}%"></div>
      </div>
      <div class="res-legend">
        <span><i class="dot yes"></i>${belief ? "yes" : "support"} ${pct}%</span>
        <span><i class="dot no"></i>${belief ? "no" : "oppose"} ${noPct}%</span>
      </div>
      <div class="res-scope">${audienceScope(result.audience)}</div>
      ${result.past ? pastMeta(result) : `<div class="res-meta">Model estimate · 95% interval ${ciLow}–${ciHigh}%</div>`}
      ${hydraMeta(result)}
      ${breakdowns.length ? abAdvancedSection({ a_share: yesShare }, segments, breakdowns) : ""}
      ${rationales.length ? `<div class="res-why">
        <div class="res-why-label">simulated responses from this audience</div>
        <ul>${rationales.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
      </div>` : ""}
      <div class="res-actions">
        <button id="res-again" class="btn btn-primary">Ask another</button>
        <button id="res-dismiss" class="btn">Dismiss</button>
      </div>
    `;
    attachEvidence(result);
    wireResultActions();
  };

  abRerender = renderPanel;
  bindAbPanelControls();
  renderPanel();
  showResultCard();
  requestAnimationFrame(() => { els.resultCard.scrollTop = 0; });
}

// the "Ask another / Dismiss" footer is identical across every result card
function wireResultActions(focusEl) {
  const again = $("res-again");
  again.addEventListener("click", openInput);
  $("res-dismiss").addEventListener("click", dismissResults);
  // preventScroll: the actions sit at the bottom of a card that now scrolls, and
  // focusing them would push the headline out of view.
  requestAnimationFrame(() => (focusEl || again).focus({ preventScroll: true }));
}

const RESULT_ACTIONS = `
  <div class="res-actions">
    <button id="res-again" class="btn btn-primary">Ask another</button>
    <button id="res-dismiss" class="btn">Dismiss</button>
  </div>`;

// multi-option result: a horizontal bar per option (sorted desc), winner emphasized
function showOptionResults(result) {
  const dist = (result.p_distribution || [])
    .filter((d) => Array.isArray(d) && d.length >= 2)
    .map(([label, p]) => ({ label: String(label), p: Number(p) || 0 }))
    .sort((a, b) => b.p - a.p);
  const n = result.n_agents ?? map.agents.length;
  const rationales = (result.sample_rationales || []).slice(0, 3);

  const rows = dist.map((d, i) => {
    const pct = Math.round(d.p * 100);
    return `
      <div class="res-opt${i === 0 ? " win" : ""}">
        <div class="res-opt-head">
          <span class="res-opt-label">${escapeHtml(d.label)}</span>
          <span class="res-opt-pct">${pct}%</span>
        </div>
        <div class="res-opt-track"><div class="res-opt-fill" style="width:${pct}%"></div></div>
      </div>`;
  }).join("");

  els.resultCard.innerHTML = `
    ${audienceHeader(result.audience, n)}
    <div class="res-q">${escapeHtml(result.question || "")}</div>
    <div class="res-options">${rows}</div>
    <div class="res-scope">${audienceScope(result.audience)}</div>
    ${result.past ? pastMeta(result) : ""}
    ${hydraMeta(result)}
    ${rationales.length ? `<div class="res-why">
      <div class="res-why-label">simulated responses from this audience</div>
      <ul>${rationales.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
    </div>` : ""}
    ${RESULT_ACTIONS}
  `;
  attachEvidence(result);
  showResultCard();
  wireResultActions();
  requestAnimationFrame(() => { els.resultCard.scrollTop = 0; });
}

const AB_DIM_LABEL = {
  age: "Age", gender: "Gender", race: "Race / ethnicity", education: "Education",
  income: "Income", tenure: "Housing", marital: "Marital status",
  nativity: "Nativity", employment: "Employment", citizenship: "Citizenship",
  geography: "Geography",
  gender_x_age: "Gender × age",
  race_x_income: "Race × income",
  education_x_income: "Education × income",
};

// Short forms used inside dense cross-tab axes, where the long label won't fit.
const AB_DIM_SHORT = {
  age: "Age", gender: "Gender", race: "Race", education: "Education",
  income: "Income", tenure: "Housing", marital: "Marital", nativity: "Nativity",
  employment: "Employment", citizenship: "Citizenship", geography: "Geography",
};

const GENDER_LABEL = { women: "Women", men: "Men" };
const MARITAL_LABEL = {
  married: "Married", never_married: "Never married", divorced: "Divorced",
  separated: "Separated", widowed: "Widowed",
};
const NATIVITY_LABEL = { us_born: "US-born", foreign_born: "Foreign-born" };
const EMPLOYMENT_LABEL = { employed: "Employed", not_employed: "Not employed" };
const CITIZENSHIP_LABEL = { citizen: "Citizens", noncitizen: "Non-citizens" };
const INCOME_LABEL = {
  q0: "Income Q1 (lowest)", q1: "Income Q2", q2: "Income Q3",
  q3: "Income Q4", q4: "Income Q5 (highest)",
};


function abGroupLabel(dimension, key) {
  if (dimension === "gender") return GENDER_LABEL[key] || key;
  if (dimension === "race") return RACE_LABEL[key] || key;
  if (dimension === "education") return EDUC_LABEL[key] || key;
  if (dimension === "income") return INCOME_LABEL[key] || `Income ${String(key).toUpperCase()}`;
  if (dimension === "tenure") return key === "own" ? "Homeowners" : "Renters";
  if (dimension === "marital") return MARITAL_LABEL[key] || key;
  if (dimension === "nativity") return NATIVITY_LABEL[key] || key;
  if (dimension === "employment") return EMPLOYMENT_LABEL[key] || key;
  if (dimension === "citizenship") return CITIZENSHIP_LABEL[key] || key;
  if (dimension === "geography") return `PUMA ${key}`;
  return key;
}

// Cross-tab keys arrive as `left|right`; label each axis with its own dimension.
function abCellLabel(breakdown, key) {
  const axes = breakdown.axes;
  if (!axes) return abGroupLabel(breakdown.dimension, key);
  const [left, right] = String(key).split(AB_CROSS_KEY_SEP);
  return `${abGroupLabel(axes[0], left)} · ${abGroupLabel(axes[1], right)}`;
}


// Which advanced view is showing, and which dimension within it. Persisted across
// re-renders of the panel body so switching tabs doesn't lose the user's place.
const abPanel = { view: "movers", dimension: null, cross: null, labels: { a: "A", b: "B" } };
// Re-render closure for the currently displayed A/B result. The panel's click
// handler is bound once (see `bindAbPanelControls`) and routed through this, so
// repeated tests never stack duplicate listeners on the persistent result card.
let abRerender = null;
let abPanelBound = false;

function bindAbPanelControls() {
  if (abPanelBound) return;
  abPanelBound = true;
  els.resultCard.addEventListener("click", (event) => {
    if (!abRerender) return;
    const viewBtn = event.target.closest("[data-ab-view]");
    if (viewBtn) {
      abPanel.view = viewBtn.dataset.abView;
      abRerender();
      els.resultCard.querySelector(`[data-ab-view="${abPanel.view}"]`)?.focus();
      return;
    }
    const dimBtn = event.target.closest("[data-ab-dim]");
    if (!dimBtn) return;
    if (dimBtn.dataset.abKind === "cross") abPanel.cross = dimBtn.dataset.abDim;
    else abPanel.dimension = dimBtn.dataset.abDim;
    abRerender();
    els.resultCard.querySelector(`[data-ab-dim="${dimBtn.dataset.abDim}"]`)?.focus();
  });

  // Roving tabindex needs arrow keys to be a conforming tab pattern.
  els.resultCard.addEventListener("keydown", (event) => {
    if (!abRerender) return;
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step || !event.target.closest("[data-ab-view]")) return;
    event.preventDefault();
    const index = AB_VIEWS.findIndex(([view]) => view === abPanel.view);
    abPanel.view = AB_VIEWS[(index + step + AB_VIEWS.length) % AB_VIEWS.length][0];
    abRerender();
    els.resultCard.querySelector(`[data-ab-view="${abPanel.view}"]`)?.focus();
  });
}

/** One demographic segment rendered as a labelled 100% A/B split bar. */
function abSegmentRow(segment, showDimension) {
  const a = pct(segment.aShare);
  const b = pct(segment.bShare);
  const lean = segment.swingPp >= 0 ? "a" : "b";
  const thin = segment.n < AB_MIN_SEGMENT_N;
  const dim = showDimension
    ? `<em class="ab-group-dim">${escapeHtml(AB_DIM_LABEL[segment.dimension] || segment.dimension)}</em>`
    : "";
  return `<div class="ab-group">
    <div class="ab-group-head">
      <span>${escapeHtml(segment.label)}${dim}</span>
      <span>${abPanel.labels.a} ${a}% · ${abPanel.labels.b} ${b}%</span>
    </div>
    <div class="ab-split" role="img" aria-label="${abPanel.labels.a} ${a} percent, ${abPanel.labels.b} ${b} percent">
      <span class="ab-a" style="width:${a}%"></span><span class="ab-b" style="width:${b}%"></span>
    </div>
    <div class="ab-group-meta">
      <span class="ab-swing lean-${lean}">${signedPp(segment.swingPp)} pp vs overall audience</span>
      <span>${Math.round(segment.weight).toLocaleString()} weighted · ${segment.n.toLocaleString()} agents</span>
      ${thin ? `<span class="ab-thin">thin sample</span>` : ""}
    </div>
  </div>`;
}

/**
 * Cross-tab matrix. Values are direct-labelled in every cell — the tint is a
 * redundant cue, never the only way to read the number.
 */
function abHeatmap(breakdown, overallAShare) {
  const { rows, cols, cells } = abCrossMatrix(breakdown);
  const [rowDim, colDim] = breakdown.axes || [breakdown.dimension, breakdown.dimension];
  const head = cols
    .map((col) => `<th scope="col">${escapeHtml(abGroupLabel(colDim, col))}</th>`)
    .join("");
  const body = rows.map((row) => {
    const tds = cols.map((col) => {
      const group = cells.get(`${row}${AB_CROSS_KEY_SEP}${col}`);
      if (!group) return `<td class="ab-cell empty" aria-label="no data">–</td>`;
      const swing = (group.a_share - overallAShare) * 100;
      const lean = swing >= 0 ? "a" : "b";
      const thin = (group.n || 0) < AB_MIN_SEGMENT_N;
      return `<td class="ab-cell lean-${lean}${thin ? " thin" : ""}" style="--lean-alpha:${abLeanAlpha(swing).toFixed(3)}"
        title="${escapeHtml(abGroupLabel(rowDim, row))} · ${escapeHtml(abGroupLabel(colDim, col))} — ${group.n.toLocaleString()} agents">
        <span class="ab-cell-share">${abPanel.labels.a} ${pct(group.a_share)}%</span>
        <span class="ab-cell-swing">${signedPp(swing)}</span>
      </td>`;
    }).join("");
    return `<tr><th scope="row">${escapeHtml(abGroupLabel(rowDim, row))}</th>${tds}</tr>`;
  }).join("");
  return `<div class="ab-matrix-wrap">
    <table class="ab-matrix">
      <caption class="sr-only">${abPanel.labels.a} share by ${escapeHtml(AB_DIM_SHORT[rowDim] || rowDim)} and ${escapeHtml(AB_DIM_SHORT[colDim] || colDim)}</caption>
      <thead><tr><td></td>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>
  <div class="ab-matrix-key">
    <span><i class="dot ab-a-dot"></i>leans ${abPanel.labels.a} vs overall audience</span>
    <span><i class="dot ab-b-dot"></i>leans ${abPanel.labels.b} vs overall audience</span>
    <span class="ab-thin">shaded stripe = thin sample (&lt;${AB_MIN_SEGMENT_N} agents)</span>
  </div>`;
}

// Toggle buttons rather than a second `tablist`: these filter the content of the
// already-selected tab panel, and nesting tablists misreports the structure.
function abChips(breakdowns, activeDimension, kind) {
  return `<div class="ab-chips" role="group" aria-label="Demographic dimension">
    ${breakdowns.map((breakdown) => {
      const active = breakdown.dimension === activeDimension;
      return `<button type="button" class="ab-chip${active ? " active" : ""}"
        aria-pressed="${active}" data-ab-dim="${escapeHtml(breakdown.dimension)}" data-ab-kind="${kind}">
        ${escapeHtml(AB_DIM_LABEL[breakdown.dimension] || breakdown.dimension)}</button>`;
    }).join("")}
  </div>`;
}

/** Body of the advanced panel for the currently selected view. */
function abPanelBody(result, segments, breakdowns) {
  const overall = result.a_share || 0;
  if (abPanel.view === "movers") {
    const movers = abTopMovers(segments);
    if (!movers.length) {
      return `<p class="ab-empty">No group has at least ${AB_MIN_SEGMENT_N} simulated residents to display.</p>`;
    }
    return `<p class="ab-lede">Groups within this sample that differ most from the overall audience's ${pct(overall)}% ${abPanel.labels.a}.</p>
      ${movers.map((segment) => abSegmentRow(segment, true)).join("")}`;
  }
  if (abPanel.view === "cross") {
    const crosses = breakdowns.filter(isCrossBreakdown);
    if (!crosses.length) return `<p class="ab-empty">No cross-tabs in this result.</p>`;
    const active = crosses.find((b) => b.dimension === abPanel.cross) || crosses[0];
    return `${abChips(crosses, active.dimension, "cross")}
      <p class="ab-lede">${abPanel.labels.a} share in each cell, versus the overall audience's ${pct(overall)}%.</p>
      ${abHeatmap(active, overall)}`;
  }
  const singles = breakdowns.filter((b) => !isCrossBreakdown(b));
  if (!singles.length) return `<p class="ab-empty">No demographic breakdown in this result.</p>`;
  const active = singles.find((b) => b.dimension === abPanel.dimension) || singles[0];
  const rows = segments.filter((segment) => segment.dimension === active.dimension);
  return `${abChips(singles, active.dimension, "single")}
    ${rows.map((segment) => abSegmentRow(segment, false)).join("")}`;
}

const AB_VIEWS = [
  ["movers", "Top movers"],
  ["single", "By dimension"],
  ["cross", "Cross-tabs"],
];

function abAdvancedSection(result, segments, breakdowns) {
  const tabs = AB_VIEWS.map(([view, label]) => {
    const active = abPanel.view === view;
    return `<button type="button" role="tab" id="ab-tab-${view}" class="ab-view${active ? " active" : ""}"
      aria-selected="${active}" aria-controls="ab-adv-body" tabindex="${active ? 0 : -1}"
      data-ab-view="${view}">${label}</button>`;
  }).join("");
  let open = false;
  try { open = sessionStorage.getItem("simtra.adv.open") === "1"; } catch { /* ignore */ }
  return `<details class="ab-adv${abPanel.labels.a === "A" ? "" : " tone-yesno"}"${open ? " open" : ""}>
    <summary class="ab-adv-summary">
      <span class="ab-adv-caret" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg></span>
      <span class="ab-adv-title">Advanced breakdown</span>
      <span class="ab-adv-hint">top movers, by dimension, cross-tabs</span>
    </summary>
    <div class="ab-adv-inner">
      <div class="ab-adv-head">
        <div class="ab-views" role="tablist" aria-label="Breakdown view">${tabs}</div>
      </div>
      <div class="ab-adv-body" id="ab-adv-body" role="tabpanel" tabindex="0"
        aria-labelledby="ab-tab-${abPanel.view}">${abPanelBody(result, segments, breakdowns)}</div>
    </div>
  </details>`;
}
// remember the disclosure for the session (re-renders rebuild the markup)
els.resultCard.addEventListener("toggle", (e) => {
  if (e.target.classList?.contains("ab-adv")) { try { sessionStorage.setItem("simtra.adv.open", e.target.open ? "1" : "0"); } catch { /* ignore */ } }
}, true);

function showAbResults(result) {
  resetEvidence();
  state.phase = "results";
  setAsk("idle");
  hide(els.summary);
  els.progress.classList.remove("indeterminate");
  els.resultCard.classList.add("ab-result");
  const aPct = pct(result.a_share);
  const bPct = pct(result.b_share);
  const margin = Number(result.margin_pp || 0);
  const winner = result.winner === "a" ? "Variant A leads" : result.winner === "b" ? "Variant B leads" : "Near tie";
  const marginText = `${margin > 0 ? "+" : ""}${margin.toFixed(1)} pp for ${margin >= 0 ? "A" : "B"}`;
  const breakdowns = normalizeBreakdowns(result.breakdowns);
  const segments = abSegments(breakdowns, result.a_share || 0, abCellLabel);
  const aCi = result.a_ci || [result.a_share, result.a_share];
  const rationales = (result.sample_rationales || []).slice(0, 3);

  // Each new test starts on the ranked view; stale dimension picks are dropped.
  abPanel.labels = { a: "A", b: "B" };
  abPanel.view = "movers";
  abPanel.dimension = null;
  abPanel.cross = null;

  const renderPanel = () => {
    els.resultCard.innerHTML = `
      ${audienceHeader(result.audience, result.n_agents)}
      <div class="res-q">${escapeHtml(result.question || "")}</div>
      <div class="ab-headline"><strong>${winner}</strong><span>${marginText}</span></div>
      <div class="ab-split ab-overall" role="img" aria-label="Variant A ${aPct} percent, Variant B ${bPct} percent">
        <span class="ab-a" style="width:${aPct}%"></span><span class="ab-b" style="width:${bPct}%"></span>
      </div>
      <div class="res-legend ab-legend"><span><i class="dot ab-a-dot"></i>Variant A ${aPct}%</span><span><i class="dot ab-b-dot"></i>Variant B ${bPct}%</span></div>
      <div class="res-scope">${audienceScope(result.audience)}</div>
      <div class="res-meta">A · 95% model interval ${pct(aCi[0])}–${pct(aCi[1])}%</div>
      ${hydraMeta(result)}
      ${breakdowns.length ? abAdvancedSection(result, segments, breakdowns) : ""}
      ${rationales.length ? `<div class="res-why"><div class="res-why-label">simulated responses from this audience</div><ul>${rationales.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul></div>` : ""}
      <p class="ab-note">Simulated, PUMS-weighted preference under full exposure. Segment and cross-tab figures are model estimates with no per-group significance test — read them as direction, not proof. Not causal proof or organic reach.</p>
      <div class="res-actions"><button id="res-edit-ab" class="btn btn-primary">Edit test</button><button id="res-dismiss" class="btn">Dismiss</button></div>`;
    attachEvidence(result, true);
    $("res-edit-ab").addEventListener("click", openAbTest);
    $("res-dismiss").addEventListener("click", dismissResults);
  };

  abRerender = renderPanel;
  bindAbPanelControls();
  renderPanel();
  showResultCard();
  // The card scrolls internally, and the advanced panel makes it tall enough to
  // overflow. Focusing the action button would scroll the winner headline out of
  // view, so keep the scroll pinned to the top and focus without moving it.
  requestAnimationFrame(() => {
    els.resultCard.scrollTop = 0;
    $("res-edit-ab").focus({ preventScroll: true });
  });
}

// gentle "try rephrasing" card for an unsupported question (no map reveal)
function showRephrase(parsed, question) {
  state.phase = "results";
  setAsk("idle");
  els.progress.classList.remove("indeterminate");
  hide(els.summary);
  clearTimeout(toastTimer); hide(els.toast);
  map.clearVerdicts();
  cleanupBranch();

  const reason = parsed.reason || "I couldn't turn that into a poll for this city.";
  const examples = (parsed.examples || []).filter(Boolean).slice(0, 4);

  els.resultCard.innerHTML = `
    <div class="res-q">${escapeHtml(question || "")}</div>
    <div class="res-rephrase-label">try rephrasing</div>
    <div class="res-rephrase-reason">${escapeHtml(reason)}</div>
    ${examples.length ? `<div class="res-examples">
      ${examples.map((ex) => `<button type="button" class="res-example">${escapeHtml(ex)}</button>`).join("")}
    </div>` : ""}
    ${RESULT_ACTIONS}
  `;
  showResultCard();
  // clicking an example pre-fills the composer with it, ready to submit
  els.resultCard.querySelectorAll(".res-example").forEach((btn) => {
    btn.addEventListener("click", () => {
      const text = btn.textContent;
      openInput();
      requestAnimationFrame(() => { els.askInput.value = text; els.askInput.focus(); autoGrow(); });
    });
  });
  wireResultActions();
}

// ── misc ─────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  show(els.toast);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(els.toast), 4200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const typingTarget = (el) => el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

els.askSubmit.addEventListener("click", event => { event.stopPropagation(); runPrediction(els.askInput.value); });

// ── events ───────────────────────────────────────────────────────────────
// The composer is always expanded. A click anywhere in it focuses the field;
// nothing is cleared and no result card is dismissed until a question is sent.
els.ask.addEventListener("click", (e) => {
  if (isBusy()) { cancelPrediction(); return; }
  if (!inputOpen()) setAsk("input");
  if (!els.askExtra.contains(e.target)) els.askInput.focus();
});
els.askInput.addEventListener("focus", () => { if (!isBusy() && !inputOpen()) setAsk("input"); });
els.askModes.addEventListener("click", (e) => {
  const b = e.target.closest(".ask-mode");
  if (!b) return;
  e.stopPropagation();
  setAskMode(b.dataset.mode);
  (b.dataset.mode === "ab" && els.askInput.value ? els.abA : b.dataset.mode === "marketing" && els.askInput.value ? els.marketingCopy : els.askInput).focus();
});
// Enter sends the question; in the variant / post fields Enter is a newline.
for (const f of [els.abA, els.abB, els.marketingCopy]) {
  f.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runPrediction(els.askInput.value); } });
}

els.ask.addEventListener("keydown", (event) => {
  if (event.target === els.ask && ["Enter", " "].includes(event.key)) { event.preventDefault(); openInput(); }
});

// multiline composer: Enter submits, Shift+Enter inserts a newline
els.askInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runPrediction(els.askInput.value); }
});
els.askInput.addEventListener("input", autoGrow);


els.returnBtn.addEventListener("click", () => { map.returnToOverview(); });

// ── character inspector (tap a character when zoomed in) ────────────────────
const charOpen = () => !els.charCard.classList.contains("hidden");
function closeCharCard() {
  clearEvidenceSelection(); stopTyping(); hide(els.charCard); }

// ── typewriter ──
// After a poll a resident "speaks" their rationale into a speech bubble. Only
// the visual span animates: the full sentence is on the bubble's aria-label
// from the first frame, so assistive tech never reads a half-typed string.
let typeTimer = null;
const REDUCED_MOTION = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
function stopTyping() {
  if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
}
function typeInto(el, text, caret) {
  stopTyping();
  if (!el) return;
  if (REDUCED_MOTION?.matches) { el.textContent = text; caret?.remove(); return; }
  el.textContent = "";
  // Pace to the sentence: a long rationale still lands in about two seconds,
  // a short one still reads as typing rather than appearing all at once.
  const maxDuration = 2000;
  const minStep = 12;
  const ticks = Math.min(text.length, Math.max(1, Math.floor(maxDuration / minStep)));
  const charsPerTick = Math.max(1, Math.ceil(text.length / ticks));
  const step = Math.min(30, Math.max(minStep, Math.round(maxDuration / ticks)));
  let i = 0;
  typeTimer = setInterval(() => {
    i = Math.min(text.length, i + charsPerTick);
    el.textContent = text.slice(0, i);
    if (i >= text.length) { stopTyping(); caret?.remove(); }
  }, step);
}
const RACE_LABEL = { white: "white", black: "Black", asian: "Asian", hispanic: "Latino/Hispanic", pacific: "Pacific Islander", native: "Native American", other_multi: "multiracial" };
const EDUC_LABEL = { lt_hs: "no HS diploma", hs: "high-school educated", some_college: "some college", bachelors: "bachelor's degree", graduate: "graduate degree" };
const ISSUE_LABEL = { s_housing: "housing", s_crime: "public safety", s_homeless: "homelessness", s_cost: "cost of living", s_environment: "climate", s_immigration: "immigration" };
function leanLabel(v, lo, hi) { if (v == null) return null; return v < -0.33 ? lo : v > 0.33 ? hi : null; }
function topIssues(v, n = 2) {
  if (!v) return [];
  return Object.keys(ISSUE_LABEL).map((k) => [ISSUE_LABEL[k], v[k] ?? 0]).sort((a, b) => b[1] - a[1]).slice(0, n).map((x) => x[0]);
}
function showCharCard(s) {
  if (!s || !s.name) return;                 // offline-preview agents have no persona
  const v = s.values || {};
  const dem = [
    s.age != null ? `${s.age}` : null,
    RACE_LABEL[s.race] || s.race,
    EDUC_LABEL[s.educ] || s.educ,
    s.job,
  ].filter(Boolean).join(" · ");
  const tags = [leanLabel(v.economic, "economically left", "economically right"), leanLabel(v.social, "socially progressive", "socially conservative")].filter(Boolean);
  const issues = topIssues(v, 2);
  const isPoll = s.verdict != null;
  const label = isPoll ? `leaning ${s.verdict}` : "thinking";
  const labelClass = isPoll ? (s.verdict === "yes" ? "yes" : "no") : "";
  const thought = isPoll && s.rationale ? s.rationale : s.thought;
  const speech = thought || "…";
  const identity = (extra = "") => `
    <div class="char-id">
      <div class="char-name">${escapeHtml(s.name)}</div>
      <div class="char-sub">${escapeHtml(dem)}${s.hood ? " · " + escapeHtml(s.hood) : ""}</div>
      ${extra}
    </div>`;
  const tagRow = `
    <div class="char-tags">
      ${tags.map((t) => `<span class="char-tag">${escapeHtml(t)}</span>`).join("")}
      ${issues.map((i) => `<span class="char-tag issue">cares about ${escapeHtml(i)}</span>`).join("")}
    </div>`;

  stopTyping();
  els.charCard.classList.toggle("char-card--spotlight", isPoll);

  // After a poll the resident is the subject: a big portrait, and the
  // rationale delivered as speech rather than as a quoted field.
  els.charCard.innerHTML = isPoll
    ? `
      <button id="char-close" class="char-close" aria-label="Close">×</button>
      <div class="char-speech" role="note" aria-label="${escapeHtml(speech)}">
        <p class="char-speech-text" aria-hidden="true">
          <span class="char-speech-ghost">${escapeHtml(speech)}</span>
          <span class="char-speech-typed"><span id="char-typed"></span><span id="char-caret" class="char-caret"></span></span>
        </p>
      </div>
      <div class="char-head">
        <canvas id="char-portrait" class="char-portrait" width="96" height="96"></canvas>
        ${identity(`<span class="char-verdict ${labelClass}">${escapeHtml(label)}</span>`)}
      </div>
      ${tagRow}`
    : `
      <button id="char-close" class="char-close" aria-label="Close">×</button>
      <div class="char-head">
        <canvas id="char-portrait" class="char-portrait" width="46" height="46"></canvas>
        ${identity()}
      </div>
      ${tagRow}
      <div class="char-think">
        <div class="char-label ${labelClass}">${label}</div>
        <div class="char-thought">“${escapeHtml(speech)}”</div>
      </div>`;

  show(els.charCard);
  $("char-close").addEventListener("click", closeCharCard);
  map.drawCharTo($("char-portrait"), s.char);
  if (isPoll) typeInto($("char-typed"), speech, $("char-caret"));
}
map.onSpriteTap = showCharCard;
map.onEmptyTap = () => { if (charOpen()) { closeCharCard(); return true; } return false; };

// about card (the ? button)
const aboutOpen = () => !els.about.classList.contains("hidden");
function openAbout() { show(els.about); show(els.aboutScrim); }
function closeAbout() { hide(els.about); hide(els.aboutScrim); }
$("about-tips")?.addEventListener("click", () => { closeAbout(); startTour(); });
els.infoBtn.addEventListener("click", openAbout);
els.aboutClose.addEventListener("click", closeAbout);
els.aboutScrim.addEventListener("click", closeAbout);


document.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && filterOpen()) {
    const focusable = [...els.filterModal.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled])")];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  } else if (e.key === "Escape") {
    if (e.defaultPrevented) return;
    if (personaOpen()) { e.preventDefault(); closePersonaModal(); return; }
    if (verified.selection.segments.length) { e.preventDefault(); clearEvidenceSelection(); return; }
    if (chart.inst?.hasSelection()) { e.preventDefault(); clearEvidenceSelection(); return; }
    if (!els.audienceCard.classList.contains("hidden")) { hideAudienceCard(); return; }
    if (filterOpen()) closeFilters();
    else if (aboutOpen()) closeAbout();
    else if (charOpen()) closeCharCard();
    else if (isBusy()) cancelPrediction();
    else if (state.phase === "results" || !els.resultCard.classList.contains("hidden")) dismissResults();
    else if (els.askInput.value) { els.askInput.value = ""; autoGrow(); els.askError.textContent = ""; }
    else if (typingTarget(document.activeElement)) document.activeElement.blur();
    else if (map.zoomedIn) map.returnToOverview();
  } else if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if (!isBusy() && !inputOpen() && !marketingOpen() && !abOpen() && !filterOpen()) openInput();
  } else if (e.key === "/" && !isBusy() && !inputOpen() && !marketingOpen() && !abOpen() && !filterOpen() && !typingTarget(document.activeElement)) {
    e.preventDefault();
    openInput();
  }
});

// `?abdemo=1` renders a saved A/B response straight into the result card, so the
// advanced breakdown can be reviewed without spending a model call. Dev affordance
// only — it never fires unless the flag is present.
async function showAbDemo() {
  try {
    const res = await fetch("fixtures/ab-sample.json");
    if (!res.ok) throw new Error(`fixture ${res.status}`);
    const result = await res.json();
    result.audience = snapshotAudience({ city: { display: "San Francisco" }, residents: result.n_agents });
    showAbResults(result);
  } catch (err) {
    console.error(err);
    toast(`Couldn't load the A/B demo fixture: ${err.message}`);
  }
}

boot().then(() => {
  if (new URLSearchParams(location.search).get("abdemo")) showAbDemo();
});
