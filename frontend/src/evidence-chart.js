// Dependency-free PollResult chart. This module never fetches data or owns app state.
//
// Integration contract:
//   const model = buildEvidenceChartModel(pollResult);
//   host.innerHTML = renderEvidenceChart(model, selection);
//   const dispose = bindEvidenceChart(host, {
//     getModel: () => model, getSelection: () => selection,
//     onSelectionChange: (next, action) => { ...update app/map and render again... }
//   });
// Install the binding once on a stable host; dispose before removing that host.
// selection = { segments: [{ dimension, key }], weightedCount?: number }.
// Segments combine with OR. weightedCount is the app's deduplicated weighted
// union, never a raw agent count. It is discarded on a selection change; the app
// must recompute it. Without it, only a single dimension can be safely summed.
// onSelectionChange is a request; only the app commits selection state.
//
// Optional evidence contract (absent from PollResult at the base commit):
// evidence = { sources: [source], context_citations: [citation], stale?: boolean,
//              conflicts?: string[] }.
// A single population_source or a top-level source record is also accepted.
// source = { id?, provider, dataset, vintage, direct_url, retrieved_at,
//            local_snapshot, weight_field, limitations: string[] | string,
//            verified: boolean, stale?: boolean, conflicts?: string[] }.
// url/source_url and verification_status are accepted aliases. Verification is
// a caller-supplied attestation, not a frontend audit. Complete metadata plus an
// explicit positive attestation is required. Missing/unsafe URLs, conflicting
// metadata, explicit untrusted state, or stale flags suppress the verified label.
// Freshness is supplied by the producer; no wall-clock guesses are made here.
// citation = { title, type?, url? }; existing hydra.sources are context only.
// Source verification NEVER makes simulated agents or predicted shares verified.

export const MIN_SEGMENT_N = 20;
const DIMENSIONS = ["age", "gender", "race", "education", "income", "tenure",
  "marital", "nativity", "employment", "citizenship", "geography",
  "gender_x_age", "race_x_income", "education_x_income"];
const ORDERS = {
  age: ["u18", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"],
  gender: ["women", "men"],
  race: ["white", "black", "hispanic", "asian", "pacific", "native", "other_multi"],
  education: ["lt_hs", "hs", "some_college", "bachelors", "graduate"],
  income: ["q0", "q1", "q2", "q3", "q4"], tenure: ["own", "rent"],
  marital: ["married", "never_married", "divorced", "separated", "widowed"],
  nativity: ["us_born", "foreign_born"], employment: ["employed", "not_employed"],
  citizenship: ["citizen", "noncitizen"],
};
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const array = (value) => Array.isArray(value) ? value : [];
const string = (value) => typeof value === "string" ? value.trim() : "";
const scalar = (value) => typeof value === "number" && Number.isFinite(value) ? String(value) : string(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const rank = (order, key) => { const i = order.indexOf(key); return i < 0 ? order.length : i; };
const count = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const share = (value) => count(value) !== null && value <= 1 ? value : null;
const numberText = (value) => count(value) === null ? "Unknown" : String(Number(value.toFixed(2)));
const percentText = (value) => value === null ? "Unknown percentage" : `${(value * 100).toFixed(1)}%`;
const identity = (segment) => JSON.stringify([segment?.dimension, segment?.key]);
const strings = (value) => typeof value === "string" ? [value].filter(Boolean) : array(value).map(string).filter(Boolean);

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/** Only absolute HTTP(S) URLs become anchors; rejected URLs remain escaped text. */
export function safeSourceUrl(value) {
  const url = string(value);
  if (!/^https?:\/\//i.test(url) || /[\u0000-\u0020\u007f]/.test(url)) return null;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname &&
      !parsed.username && !parsed.password ? parsed.href : null;
  } catch { return null; }
}

function groupCompare(dimension, a, b) {
  if (dimension === "geography" || dimension === "puma") {
    const numeric = (key) => /^\d+$/.test(key) ? Number(key) : Infinity;
    return (numeric(a.key) - numeric(b.key) || 0) || compare(a.key, b.key);
  }
  const axes = dimension.split("_x_");
  const left = a.key.split("|");
  const right = b.key.split("|");
  for (let i = 0; i < axes.length; i++) {
    const order = Object.hasOwn(ORDERS, axes[i]) ? ORDERS[axes[i]] : [];
    const difference = rank(order, left[i]) - rank(order, right[i]);
    if (difference) return difference;
  }
  return compare(a.key, b.key);
}

/** Pure normalization. No coercion of absent/invalid counts into zero. */
export function normalizeBreakdowns(result = {}) {
  result = record(result);
  const modern = array(result.option_breakdowns).filter((b) => string(b?.dimension));
  const legacy = record(result.breakdowns);
  const distribution = array(result.p_distribution);
  const largestShares = modern.reduce((n, b) => array(b.groups).reduce(
    (m, g) => Math.max(m, array(g?.shares).length), n), 0);
  const optionCount = Math.max(2, distribution.length, largestShares);
  const options = Array.from({ length: optionCount }, (_, i) =>
    string(distribution[i]?.[0]) || (optionCount === 2 ? ["Yes", "No"][i] : `Option ${i + 1}`));
  const rows = new Map();
  for (const dimension of Object.keys(legacy)) {
    rows.set(dimension, [{ dimension, groups: legacy[dimension], legacy: true }]);
  }
  // Modern dimensions override their legacy counterparts, including empty groups.
  for (const dimension of new Set(modern.map((b) => b.dimension))) {
    rows.set(dimension, modern.filter((b) => b.dimension === dimension));
  }
  const dimensions = [...rows.keys()].sort((a, b) =>
    rank(DIMENSIONS, a) - rank(DIMENSIONS, b) || compare(a, b));
  return { options, breakdowns: dimensions.map((dimension) => {
    const entries = rows.get(dimension);
    const grouped = new Map();
    for (const entry of entries) for (const raw of array(entry.groups)) {
      const group = record(raw);
      const key = string(group.key);
      if (!key) continue;
      const yes = share(group.yes_share);
      const values = entry.legacy
        ? (optionCount === 2 && yes !== null ? [yes, 1 - yes] : [])
        : array(group.shares);
      const normalized = {
        dimension, key,
        shares: options.map((_, i) => share(values[i])),
        weight: count(group.weight),
        n: Number.isInteger(group.n) ? count(group.n) : null,
      };
      const previous = grouped.get(key);
      // Duplicate identities cannot safely denote different counts/distributions.
      if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) {
        grouped.set(key, { dimension, key, shares: options.map(() => null),
          weight: null, n: null, conflicting: true });
      } else if (!previous) grouped.set(key, normalized);
    }
    const groups = [...grouped.values()].sort((a, b) => groupCompare(dimension, a, b)).map((group) => {
      const total = group.shares.reduce((sum, p) => sum + (p ?? 0), 0);
      const invalidShares = group.shares.some((p) => p === null) || Math.abs(total - 1) > 0.001;
      const empty = group.n === 0 || group.weight === 0;
      return { ...group, shares: invalidShares || empty ? options.map(() => null) : group.shares,
        empty, thin: group.n !== null && group.n > 0 && group.n < MIN_SEGMENT_N,
        invalidShares: invalidShares && !empty };
    });
    return { dimension, groups };
  }) };
}

function normalizeSource(raw, inherited) {
  const source = record(raw);
  const aliases = [source.direct_url, source.url, source.source_url].map(string).filter(Boolean);
  const limitations = strings(source.limitations);
  const conflicts = [...strings(inherited.conflicts), ...strings(source.conflicts)];
  if (new Set(aliases).size > 1) conflicts.push("Conflicting source URLs");
  if (source.verified === false && source.verification_status === "verified") conflicts.push("Conflicting verification metadata");
  const normalized = {
    id: scalar(source.id), provider: string(source.provider), dataset: string(source.dataset),
    vintage: scalar(source.vintage), direct_url: aliases[0] || "",
    retrieved_at: string(source.retrieved_at), local_snapshot: string(source.local_snapshot),
    weight_field: string(source.weight_field), limitations,
    stale: source.stale === true || inherited.stale === true || source.status === "stale",
    conflicts,
    attested: (source.verified === true || source.verification_status === "verified") &&
      source.verified !== false && source.trusted !== false && inherited.trusted !== false &&
      (!source.verification_status || source.verification_status === "verified"),
  };
  normalized.complete = ["provider", "dataset", "vintage", "direct_url", "retrieved_at", "local_snapshot", "weight_field"]
    .every((key) => normalized[key]) && (Array.isArray(source.limitations) || !!string(source.limitations));
  normalized.clickableUrl = safeSourceUrl(normalized.direct_url);
  return normalized;
}

export function sourceTruthLabel(source) {
  return source.complete && source.clickableUrl && source.attested && !source.stale &&
    source.conflicts.length === 0 ? "Verified source data" : "Unknown";
}

/** Hydra retrieval status and chunks are context, never population verification. */
export function normalizeEvidence(evidence, hydra) {
  const supplied = record(evidence);
  const context = record(hydra);
  let rawSources = array(supplied.sources);
  if (supplied.population_source) rawSources = [...rawSources, supplied.population_source];
  if (supplied.provider || supplied.dataset) rawSources = [...rawSources, supplied];
  const sources = rawSources.map((source) => normalizeSource(source, supplied));
  // Preserve conflicting records for inspection; do not select a convenient winner.
  for (let i = 0; i < sources.length; i++) for (let j = i + 1; j < sources.length; j++) {
    const a = sources[i], b = sources[j];
    const same = a.id && a.id === b.id || a.provider && a.dataset && a.provider === b.provider && a.dataset === b.dataset;
    const fields = ["provider", "dataset", "vintage", "direct_url", "retrieved_at", "local_snapshot", "weight_field", "attested", "stale", "limitations"];
    if (same && fields.some((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))) {
      a.conflicts.push("Conflicting source metadata"); b.conflicts.push("Conflicting source metadata");
    }
  }
  for (const source of sources) {
    source.conflicts = [...new Set(source.conflicts)].sort(compare);
    source.truthLabel = sourceTruthLabel(source);
  }
  sources.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const citations = [...array(supplied.context_citations), ...array(context.sources)].map((raw) => {
    const citation = record(raw);
    return { title: string(citation.title) || string(raw) || "Unknown context citation",
      type: string(citation.type), url: string(citation.url) || string(citation.direct_url) };
  }).sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  return { sources, citations, hydraStatus: string(context.status) || "Unknown",
    hydraChunks: Number.isInteger(context.chunks) ? count(context.chunks) : null,
    conflicts: strings(supplied.conflicts), stale: supplied.stale === true,
    hasVerifiedSource: sources.some((source) => source.truthLabel === "Verified source data") };
}

export function buildEvidenceChartModel(result = {}) {
  result = record(result);
  return { question: string(result.question), ...normalizeBreakdowns(result),
    evidence: normalizeEvidence(result.evidence, result.hydra) };
}

/** Discard stale/unknown identities and deduplicate using tuples, not delimiters. */
export function normalizeSelection(model, selection = {}) {
  const requested = new Set(array(selection?.segments).map(identity));
  return model.breakdowns.flatMap((b) => b.groups).filter((g) => requested.has(identity(g)))
    .map(({ dimension, key }) => ({ dimension, key }));
}

/** Pure selection reducer. action = {type: 'select'|'add'|'clear', dimension?, key?}. */
export function reduceEvidenceSelection(model, selection, action) {
  const segments = normalizeSelection(model, selection);
  if (action.type === "clear") return { segments: [] };
  if (!["select", "add"].includes(action.type)) return { segments };
  const target = normalizeSelection(model, { segments: [action] })[0];
  if (!target) return { segments };
  return { segments: normalizeSelection(model, { segments: action.type === "add" ? [...segments, target] : [target] }) };
}

export function selectionSummary(model, selection = {}) {
  const selected = normalizeSelection(model, selection);
  if (!selected.length) return "Active rule: none. Weighted population selected: 0.";
  const rule = selected.map((s) => `${s.dimension} = ${s.key}`).join(" OR ");
  const groups = model.breakdowns.flatMap((b) => b.groups).filter((g) => selected.some((s) => identity(s) === identity(g)));
  const oneDimension = new Set(selected.map((s) => s.dimension)).size === 1;
  const supplied = count(selection.weightedCount);
  // Ignore supplied union counts if the selection contained unknown identities.
  const allKnown = array(selection.segments).every((s) => selected.some((g) => identity(g) === identity(s)));
  const total = allKnown && supplied !== null ? supplied : oneDimension && groups.every((g) => g.weight !== null)
    ? groups.reduce((sum, g) => sum + g.weight, 0) : null;
  return `Active rule: ${rule}. Weighted population selected: ${numberText(total)}.${total === null ? " Overlapping or incomplete groups prevent a reliable combined count." : ""}`;
}

export function segmentAccessibilityLabel(segment, options, selected = false) {
  const shares = options.map((option, i) => `${option}: ${percentText(segment.shares[i])}`).join("; ");
  return `${segment.dimension}: ${segment.key}. ${shares}. Weighted population: ${numberText(segment.weight)}. Raw synthetic-agent count: ${numberText(segment.n)}. ${selected ? "Selected." : "Not selected."}${segment.empty ? " Empty group." : ""}${segment.thin ? ` Thin sample: fewer than ${MIN_SEGMENT_N} synthetic agents.` : ""}${segment.invalidShares ? " Incomplete or invalid option shares." : ""}${segment.conflicting ? " Conflicting breakdown data." : ""}`;
}

function sourceLink(url, title) {
  const safe = safeSourceUrl(url);
  return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title || url)}</a>`
    : escapeHtml(title || url || "Unknown");
}

export function renderEvidenceProvenance(evidence) {
  const fields = { provider: "Provider", dataset: "Dataset", vintage: "Vintage", direct_url: "Direct URL",
    retrieved_at: "Retrieval time", local_snapshot: "Local snapshot", weight_field: "Weight field" };
  return `<section aria-label="Evidence provenance"><h3>Evidence provenance</h3>
    ${evidence.sources.length ? evidence.sources.map((source) => `<article>
      <h4>${escapeHtml(source.truthLabel)}${source.truthLabel === "Unknown" ? " — source verification" : ""}</h4>
      ${!source.complete ? "<p>Source details unavailable</p>" : ""}
      ${source.stale ? "<p>Stale source</p>" : ""}
      ${source.conflicts.map((c) => `<p>${escapeHtml(c)}</p>`).join("")}
      <dl>${Object.entries(fields).map(([key, label]) => `<dt>${label}</dt><dd>${key === "direct_url" ? sourceLink(source[key]) : escapeHtml(source[key] || "Unknown")}</dd>`).join("")}
      <dt>Limitations</dt><dd>${source.limitations.length ? source.limitations.map(escapeHtml).join("; ") : "No limitations supplied"}</dd></dl>
    </article>`).join("") : "<p>Unknown — Source details unavailable</p>"}
    ${evidence.stale ? "<p>Evidence marked stale</p>" : ""}
    ${evidence.conflicts.map((c) => `<p>${escapeHtml(c)}</p>`).join("")}
    <h4>Context citations</h4><p>Retrieval context; population verification is separate.</p>
    <p>Hydra status: ${escapeHtml(evidence.hydraStatus)}; chunks: ${numberText(evidence.hydraChunks)}</p>
    ${evidence.citations.length ? `<ul>${evidence.citations.map((c) => `<li>${sourceLink(c.url, c.title)}${c.type ? ` — ${escapeHtml(c.type)}` : ""}</li>`).join("")}</ul>` : "<p>Unknown — no context citations supplied</p>"}
  </section>`;
}

/** Pure HTML renderer; the host supplies selection and installs event delegation. */
export function renderEvidenceChart(model, selection = {}) {
  const selected = new Set(normalizeSelection(model, selection).map(identity));
  const hasGroups = model.breakdowns.some((b) => b.groups.length);
  return `<section class="evidence-chart" aria-label="Population evidence chart">
    <h2>${escapeHtml(model.question || "Population evidence chart")}</h2>
    <p><strong>Simulated population</strong>: weighted population and raw synthetic-agent counts describe demographic groups.</p>
    <p><strong>Model-based inference</strong>: option percentages are predicted shares within each group, not observed responses.</p>
    ${!model.evidence.hasVerifiedSource ? "<p>Unknown — no trusted, complete source metadata available. This chart is a simulation.</p>" : ""}
    <p>Click to select. Shift-click to combine with OR. Enter or Space activates; Shift adds. Arrow keys move between segments. Escape clears.</p>
    <button type="button" data-evidence-action="clear">Clear selection</button>
    <p role="status" aria-live="polite" aria-atomic="true" data-evidence-summary>${escapeHtml(selectionSummary(model, selection))}</p>
    ${!hasGroups ? "<p>No demographic breakdowns available.</p>" : ""}
    ${model.breakdowns.map((breakdown) => `<fieldset><legend>${escapeHtml(breakdown.dimension)}</legend>
      ${!breakdown.groups.length ? "<p>No groups available.</p>" : breakdown.groups.map((segment) => {
        const active = selected.has(identity(segment));
        return `<button type="button" data-dimension="${escapeHtml(segment.dimension)}" data-key="${escapeHtml(segment.key)}" aria-pressed="${active}" aria-label="${escapeHtml(segmentAccessibilityLabel(segment, model.options, active))}" style="display:block;width:100%;text-align:left;margin-block:0.5rem">
          <span>${active ? "✓ Selected: " : "Select: "}${escapeHtml(segment.key)}</span>
          ${model.options.map((option, i) => `<span style="display:block">${escapeHtml(option)}: ${percentText(segment.shares[i])}
            <span aria-hidden="true" style="display:block;width:100%;border:1px solid currentColor"><span style="display:block;height:0.5rem;background:currentColor;width:${segment.shares[i] === null ? 0 : segment.shares[i] * 100}%"></span></span></span>`).join("")}
          <span style="display:block">Weighted population: ${numberText(segment.weight)} · Raw synthetic-agent count: ${numberText(segment.n)}</span>
          ${segment.empty ? "<span>Empty group — percentage unavailable</span>" : ""}
          ${segment.thin ? `<span>Thin sample — fewer than ${MIN_SEGMENT_N} synthetic agents</span>` : ""}
          ${segment.invalidShares ? "<span>Unknown — incomplete or invalid option shares</span>" : ""}
          ${segment.conflicting ? "<span>Conflicting breakdown data</span>" : ""}
        </button>`;
      }).join("")}</fieldset>`).join("")}
    ${renderEvidenceProvenance(model.evidence)}
  </section>`;
}

/** Pure event-to-action mapping, also usable with the app's own delegation. */
export function evidenceChartAction(event, segment) {
  if (event.type === "keydown" && event.key === "Escape") return { type: "clear" };
  if (!segment) return null;
  if (event.type === "click" || event.type === "keydown" && ["Enter", " "].includes(event.key)) {
    return { type: event.shiftKey ? "add" : "select", dimension: segment.dimension, key: segment.key };
  }
  return null;
}

export function nextSegmentIndex(length, index, key) {
  if (!length) return -1;
  if (["ArrowRight", "ArrowDown"].includes(key)) return (index + 1 + length) % length;
  if (["ArrowLeft", "ArrowUp"].includes(key)) return (index - 1 + length) % length;
  return index;
}

/** Optional DOM adapter. Pure exports above work in Node without a DOM. */
export function bindEvidenceChart(host, { getModel, getSelection, onSelectionChange }) {
  const selector = "button[data-dimension][data-key]";
  const handle = (event) => {
    const target = event.target?.closest?.("button");
    if (target && !host.contains(target)) return;
    const segment = target?.matches(selector) ? target.dataset : null;
    if (event.type === "keydown" && segment && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      const buttons = [...host.querySelectorAll(selector)];
      event.preventDefault();
      buttons[nextSegmentIndex(buttons.length, buttons.indexOf(target), event.key)]?.focus();
      return;
    }
    const action = target?.dataset.evidenceAction === "clear" && event.type === "click"
      ? { type: "clear" } : evidenceChartAction(event, segment);
    if (!action) return;
    // Prevent native Enter/Space click synthesis after handling keydown ourselves.
    event.preventDefault();
    if (event.repeat) return;
    onSelectionChange(reduceEvidenceSelection(getModel(), getSelection(), action), action);
    // Synchronous re-render replaces the focused button: restore its tuple identity.
    if (segment) [...host.querySelectorAll(selector)].find((button) =>
      button.dataset.dimension === segment.dimension && button.dataset.key === segment.key)?.focus();
    else host.querySelector('[data-evidence-action="clear"]')?.focus();
  };
  host.addEventListener("click", handle);
  host.addEventListener("keydown", handle);
  return () => { host.removeEventListener("click", handle); host.removeEventListener("keydown", handle); };
}
