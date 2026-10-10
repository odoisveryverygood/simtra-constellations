import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The browser uses .js ES modules without a package.json. A data URL keeps this
// suite compatible with Node's built-in runner without changing package scope.
const source = await readFile(new URL("../src/evidence-chart.js", import.meta.url), "utf8");
const chart = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const { buildEvidenceChartModel: build, renderEvidenceChart: render,
  normalizeBreakdowns, normalizeEvidence, normalizeSelection, reduceEvidenceSelection,
  selectionSummary, segmentAccessibilityLabel, safeSourceUrl, escapeHtml,
  sourceTruthLabel, evidenceChartAction, nextSegmentIndex, bindEvidenceChart } = chart;

const group = (key, shares = [0.6, 0.4], weight = 1234.5, n = 40) => ({ key, shares, weight, n });
const binary = () => ({ question: "Support the proposal?", p_distribution: [],
  option_breakdowns: [{ dimension: "age", groups: [group("18-24"), group("65+", [0.2, 0.8], 300, 10)] }] });
const sourceRecord = (extra = {}) => ({ id: "fixture-source", provider: "Fixture provider",
  dataset: "Fixture microdata", vintage: "2024", direct_url: "https://example.org/data.csv",
  retrieved_at: "2026-09-12T10:00:00Z", local_snapshot: "data/fixture.csv",
  weight_field: "PWGTP", limitations: ["Synthetic fixture; not real source verification"],
  verified: true, ...extra });
const selected = (dimension = "age", key = "18-24") => ({ segments: [{ dimension, key }] });

test("binary option breakdowns preserve Yes/No proportions and weighted/raw counts", () => {
  const model = build(binary());
  assert.deepEqual(model.options, ["Yes", "No"]);
  const segment = model.breakdowns[0].groups[0];
  assert.deepEqual(segment.shares, [0.6, 0.4]);
  assert.equal(segment.weight, 1234.5);
  assert.equal(segment.n, 40);
  assert.match(segmentAccessibilityLabel(segment, model.options), /Yes: 60.0%; No: 40.0%/);
  assert.match(render(model), /Weighted population: 1234.5 · Raw synthetic-agent count: 40/);
});

test("legacy HashMap breakdowns derive No only for binary polls", () => {
  const input = { breakdowns: { age: [{ key: "65+", yes_share: 0.25, weight: 2000, n: 12 }] } };
  assert.deepEqual(normalizeBreakdowns(input).breakdowns[0].groups[0].shares, [0.25, 0.75]);
  const multi = normalizeBreakdowns({ ...input, p_distribution: [["A", 0.2], ["B", 0.3], ["C", 0.5]] });
  assert.deepEqual(multi.breakdowns[0].groups[0].shares, [null, null, null]);
});

test("modern dimensions override legacy; absent dimensions fall back; explicit empties survive", () => {
  const model = build({ ...binary(), breakdowns: {
    age: [{ key: "wrong", yes_share: 1, weight: 1, n: 1 }],
    income: [{ key: "q0", yes_share: 0.5, weight: 20, n: 2 }],
  } });
  assert.deepEqual(model.breakdowns.map((b) => b.dimension), ["age", "income"]);
  assert.equal(model.breakdowns[0].groups[0].key, "18-24");
  assert.equal(model.breakdowns[1].groups[0].weight, 20);
  const empty = build({ option_breakdowns: [{ dimension: "age", groups: [] }],
    breakdowns: { age: [{ key: "65+", yes_share: 1, weight: 20, n: 1 }] } });
  assert.deepEqual(empty.breakdowns[0].groups, []);
});

test("multi-option normalization preserves option-label index order", () => {
  const model = build({ p_distribution: [["Train", 0.2], ["Bike", 0.3], ["Bus", 0.5]],
    option_breakdowns: [{ dimension: "income", groups: [group("q2", [0.2, 0.3, 0.5], 900, 31)] }] });
  assert.deepEqual(model.options, ["Train", "Bike", "Bus"]);
  assert.deepEqual(model.breakdowns[0].groups[0].shares, [0.2, 0.3, 0.5]);
  assert.match(render(model), /Train: 20.0%/);
  assert.match(render(model), /Bike: 30.0%/);
  assert.match(render(model), /Bus: 50.0%/);
  assert.deepEqual(build({ option_breakdowns: [{ dimension: "age", groups: [group("65+", [0.1, 0.2, 0.7])] }] }).options,
    ["Option 1", "Option 2", "Option 3"]);
});

test("ordering is canonical and independent of input map/array insertion order", () => {
  const input = { option_breakdowns: [
    { dimension: "z-custom", groups: [group("b"), group("a")] },
    { dimension: "geography", groups: [group("100"), group("20"), group("3")] },
    { dimension: "age", groups: [group("65+"), group("18-24"), group("u18")] },
    { dimension: "gender_x_age", groups: [group("men|u18"), group("women|65+"), group("women|u18")] },
  ] };
  const reordered = { option_breakdowns: input.option_breakdowns.toReversed().map((b) => ({ ...b, groups: b.groups.toReversed() })) };
  assert.deepEqual(build(input), build(reordered));
  assert.equal(render(build(input)), render(build(reordered)));
  assert.deepEqual(build(input).breakdowns[0].groups.map((g) => g.key), ["u18", "18-24", "65+"]);
  assert.deepEqual(build(input).breakdowns[1].groups.map((g) => g.key), ["3", "20", "100"]);
  assert.deepEqual(build(input).breakdowns[2].groups.map((g) => g.key), ["women|u18", "women|65+", "men|u18"]);
});

test("normalization and rendering do not mutate caller data or depend on clock", () => {
  const input = binary(), selection = selected();
  const original = structuredClone(input), saved = structuredClone(selection);
  const model = build(input), initial = structuredClone(model);
  assert.equal(render(model, selection), render(build(input), selection));
  assert.deepEqual(input, original);
  assert.deepEqual(selection, saved);
  assert.deepEqual(model, initial);
});

test("missing evidence never implies verification, including connected Hydra", () => {
  const model = build({ ...binary(), hydra: { enabled: true, status: "connected", chunks: 3,
    sources: [{ title: "Context document", type: "news" }] } });
  assert.equal(model.evidence.hasVerifiedSource, false);
  const html = render(model);
  assert.match(html, /Source details unavailable/);
  assert.match(html, /Simulated population/);
  assert.match(html, /Model-based inference/);
  assert.match(html, /Unknown/);
  assert.match(html, /Context document — news/);
  assert.match(html, /Hydra status: connected; chunks: 3/);
  assert.doesNotMatch(html, /Verified source data/);
});

test("complete attested source renders provenance and a source-only truth label", () => {
  const evidence = normalizeEvidence({ sources: [sourceRecord()], context_citations: [
    { title: "Background", type: "report", url: "https://example.org/context" },
  ] });
  const html = render({ ...build(binary()), evidence });
  assert.equal(evidence.hasVerifiedSource, true);
  assert.equal(sourceTruthLabel(evidence.sources[0]), "Verified source data");
  for (const text of ["Verified source data", "Fixture provider", "Fixture microdata", "2024",
    "https://example.org/data.csv", "2026-09-12T10:00:00Z", "data/fixture.csv", "PWGTP",
    "Synthetic fixture", "Background", "Simulated population", "Model-based inference"]) assert.ok(html.includes(text), text);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("every required metadata field must be present for verified label", () => {
  for (const key of ["provider", "dataset", "vintage", "direct_url", "retrieved_at", "local_snapshot", "weight_field", "limitations"]) {
    const raw = sourceRecord(); delete raw[key];
    const model = build({ evidence: { sources: [raw] } });
    assert.equal(model.evidence.hasVerifiedSource, false, key);
    assert.match(render(model), /Source details unavailable/, key);
  }
});

test("truth labels require explicit positive attestation and reject negatives/stale/unsafe sources", () => {
  for (const extra of [{ verified: undefined }, { verified: false }, { trusted: false },
    { stale: true }, { status: "stale" }, { conflicts: ["Conflicting vintage"] },
    { direct_url: "javascript:alert(1)" }, { verification_status: "unverified" }, { verification_status: "failed" },
    { verified: false, verification_status: "verified" }]) {
    assert.equal(normalizeEvidence({ sources: [sourceRecord(extra)] }).hasVerifiedSource, false, JSON.stringify(extra));
  }
  assert.equal(normalizeEvidence({ sources: [sourceRecord({ verified: undefined, verification_status: "verified" })] }).hasVerifiedSource, true);
  assert.equal(normalizeEvidence({ sources: [sourceRecord()], stale: true }).hasVerifiedSource, false);
  assert.equal(normalizeEvidence({ sources: [sourceRecord()], trusted: false }).hasVerifiedSource, false);
  assert.match(render(build({ evidence: { sources: [sourceRecord({ stale: true })] } })), /Stale source/);
});

test("conflicting source aliases and duplicate source identities cannot claim verification", () => {
  const alias = normalizeEvidence({ sources: [sourceRecord({ url: "https://example.net/other" })] });
  assert.equal(alias.hasVerifiedSource, false);
  assert.deepEqual(alias.sources[0].conflicts, ["Conflicting source URLs"]);
  const raw = [sourceRecord(), sourceRecord({ vintage: "2023" })];
  const evidence = normalizeEvidence({ sources: raw });
  assert.equal(evidence.hasVerifiedSource, false);
  assert.ok(evidence.sources.every((s) => s.conflicts.includes("Conflicting source metadata")));
  assert.deepEqual(evidence, normalizeEvidence({ sources: raw.toReversed() }));
  assert.match(render({ ...build(), evidence }), /Conflicting source metadata/);
  assert.equal(normalizeEvidence({ sources: [sourceRecord()], conflicts: ["Registry mismatch"] }).hasVerifiedSource, false);
});

test("single-source evidence adapters support explicit records without defaulting values", () => {
  assert.equal(normalizeEvidence({ population_source: sourceRecord() }).hasVerifiedSource, true);
  assert.equal(normalizeEvidence(sourceRecord({ direct_url: undefined, source_url: "https://example.org/source" })).hasVerifiedSource, true);
  assert.equal(normalizeEvidence({ provider: "Known provider" }).sources[0].weight_field, "");
});

test("only absolute http/https URLs become clickable", () => {
  for (const url of ["https://example.org/a?q=1&v=2", "http://example.org", "HTTPS://example.org"]) assert.ok(safeSourceUrl(url), url);
  for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://example.org",
    "//example.org", "/relative", "https://", "https://user:pass@example.org", "https:\\example.org",
    "https://example.org/\nfoo", "java\tscript:alert(1)", "not a URL", null]) assert.equal(safeSourceUrl(url), null, url);
  const model = build({ evidence: { sources: [sourceRecord({ direct_url: "javascript:alert(1)" })],
    context_citations: [{ title: "Unsafe context", url: "data:text/html,boom" },
      { title: "Safe context", url: "http://example.org/context" }] } });
  const html = render(model);
  assert.equal((html.match(/<a /g) || []).length, 1);
  assert.match(html, /href="http:\/\/example.org\/context"/);
  assert.match(html, /javascript:alert\(1\)/);
  assert.doesNotMatch(html, /href="(?:javascript|data):/);
});

test("all source/user text and tuple attributes are HTML escaped", () => {
  const hostile = '<img src=x onerror="boom">&\'quoted';
  const model = build({ question: hostile, p_distribution: [[hostile, 1], ["No", 0]],
    option_breakdowns: [{ dimension: hostile, groups: [group(hostile, [1, 0])] }],
    evidence: { sources: [sourceRecord({ provider: hostile, dataset: hostile, vintage: hostile,
      retrieved_at: hostile, local_snapshot: hostile, weight_field: hostile, limitations: [hostile], conflicts: [hostile] })],
      context_citations: [{ title: hostile, type: hostile }] }, hydra: { status: hostile } });
  const html = render(model, { segments: [{ dimension: hostile, key: hostile }] });
  assert.doesNotMatch(html, /<img|onerror="boom"/);
  assert.ok(html.includes(escapeHtml(hostile)));
  assert.ok(html.includes(`data-key="${escapeHtml(hostile)}"`));
  assert.ok(html.includes(`data-dimension="${escapeHtml(hostile)}"`));
  assert.equal(escapeHtml('&<>"\''), "&amp;&lt;&gt;&quot;&#39;");
});

test("segments are real buttons with pressed state, accessible labels, and live rule/count", () => {
  const html = render(build(binary()), selected());
  assert.equal((html.match(/<button type="button" data-dimension=/g) || []).length, 2);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.equal((html.match(/aria-pressed="false"/g) || []).length, 1);
  assert.match(html, /aria-label="age: 18-24. Yes: 60.0%; No: 40.0%/);
  assert.match(html, /✓ Selected: 18-24/);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /Active rule: age = 18-24. Weighted population selected: 1234.5./);
  assert.doesNotMatch(html, /onclick=|onkeydown=|tabindex="-1"/);
});

test("thin sample threshold uses raw n and empty groups remain selectable", () => {
  const model = build({ option_breakdowns: [{ dimension: "age", groups: [
    group("18-24", [0.5, 0.5], 1e6, 19), group("25-34", [0.5, 0.5], 1, 20),
    group("35-44", [0, 0], 0, 0), group("45-54", [0.5, 0.5], 100, null),
  ] }] });
  assert.deepEqual(model.breakdowns[0].groups.map((g) => g.thin), [true, false, false, false]);
  assert.equal(model.breakdowns[0].groups[2].empty, true);
  const html = render(model);
  assert.match(html, /Thin sample — fewer than 20 synthetic agents/);
  assert.match(html, /Empty group — percentage unavailable/);
  assert.match(html, /Raw synthetic-agent count: Unknown/);
  assert.doesNotMatch(html, /disabled/);
});

test("missing breakdowns and malformed inputs degrade without invented zeros", () => {
  for (const result of [undefined, null, {}, { option_breakdowns: null, breakdowns: [] }, { option_breakdowns: [null] }]) {
    assert.match(render(build(result)), /No demographic breakdowns available/);
  }
  const model = build({ option_breakdowns: [{ dimension: "age", groups: [null,
    { key: "65+", shares: [null, 1], weight: "100", n: -1 }] }] });
  assert.equal(model.breakdowns[0].groups[0].weight, null);
  assert.equal(model.breakdowns[0].groups[0].n, null);
  assert.match(render(model), /Unknown — incomplete or invalid option shares/);
  assert.match(render(build({ option_breakdowns: [{ dimension: "age", groups: [] }] })), /No groups available/);
});

test("invalid option distributions are not renormalized or shown as valid", () => {
  for (const shares of [[2, -1], [0.2, 0.2], [NaN, 1], [Infinity, 0], [0.5]]) {
    const model = build({ option_breakdowns: [{ dimension: "age", groups: [group("65+", shares, NaN, 1.5)] }] });
    const segment = model.breakdowns[0].groups[0];
    assert.deepEqual(segment.shares, [null, null]);
    assert.equal(segment.weight, null);
    assert.equal(segment.n, null);
    assert.doesNotMatch(render(model), /width:(?:NaN|Infinity|-)/);
  }
});

test("duplicate group conflicts are deterministic and never double-counted", () => {
  const groups = [group("65+"), group("65+", [0.5, 0.5], 999), group("65+")];
  const model = build({ option_breakdowns: [{ dimension: "age", groups }] });
  assert.equal(model.breakdowns[0].groups.length, 1);
  assert.equal(model.breakdowns[0].groups[0].conflicting, true);
  assert.equal(model.breakdowns[0].groups[0].weight, null);
  assert.deepEqual(model, build({ option_breakdowns: [{ dimension: "age", groups: groups.toReversed() }] }));
  assert.match(render(model), /Conflicting breakdown data/);
});

test("selection reducer replaces, combines idempotently, and clears without mutating input", () => {
  const model = build(binary()), first = selected();
  const combined = reduceEvidenceSelection(model, first, { type: "add", dimension: "age", key: "65+" });
  assert.equal(combined.segments.length, 2);
  assert.deepEqual(reduceEvidenceSelection(model, combined, { type: "add", dimension: "age", key: "65+" }), combined);
  assert.deepEqual(reduceEvidenceSelection(model, combined, { type: "select", dimension: "age", key: "65+" }), selected("age", "65+"));
  assert.deepEqual(reduceEvidenceSelection(model, combined, { type: "clear" }), { segments: [] });
  assert.deepEqual(first, selected());
  assert.deepEqual(normalizeSelection(model, { segments: [...first.segments, ...first.segments, { dimension: "bad", key: "bad" }] }), first.segments);
  assert.equal(reduceEvidenceSelection(model, { ...first, weightedCount: 99 }, { type: "add", dimension: "age", key: "65+" }).weightedCount, undefined);
});

test("summary sums disjoint same-dimension weights but never overlapping dimensions", () => {
  const input = binary();
  input.option_breakdowns.push({ dimension: "gender", groups: [group("women", [0.6, 0.4], 2000, 50)] });
  const model = build(input);
  const same = { segments: [...selected().segments, ...selected("age", "65+").segments] };
  assert.match(selectionSummary(model, same), /age = 18-24 OR age = 65\+.*1534.5/);
  const overlap = { segments: [...selected().segments, ...selected("gender", "women").segments] };
  assert.match(selectionSummary(model, overlap), /Weighted population selected: Unknown/);
  assert.doesNotMatch(selectionSummary(model, overlap), /3234.5/);
  assert.match(selectionSummary(model, { ...overlap, weightedCount: 2200 }), /Weighted population selected: 2200/);
  assert.match(selectionSummary(model, { ...overlap, weightedCount: 0 }), /Weighted population selected: 0/);
  assert.match(selectionSummary(model), /Active rule: none. Weighted population selected: 0/);
});

test("event actions cover click, Shift-click, Enter, Space, and Escape", () => {
  const segment = { dimension: "age", key: "18-24" };
  assert.deepEqual(evidenceChartAction({ type: "click" }, segment), { type: "select", ...segment });
  assert.deepEqual(evidenceChartAction({ type: "click", shiftKey: true }, segment), { type: "add", ...segment });
  for (const key of ["Enter", " "]) {
    assert.deepEqual(evidenceChartAction({ type: "keydown", key }, segment), { type: "select", ...segment });
    assert.deepEqual(evidenceChartAction({ type: "keydown", key, shiftKey: true }, segment), { type: "add", ...segment });
  }
  assert.deepEqual(evidenceChartAction({ type: "keydown", key: "Escape" }), { type: "clear" });
  assert.equal(evidenceChartAction({ type: "keydown", key: "Tab" }, segment), null);
});

test("malformed selection and extreme weights do not crash or produce Infinity", () => {
  const model = build(binary());
  assert.deepEqual(normalizeSelection(model, { segments: [null, {}, ...selected().segments] }), selected().segments);
  assert.match(selectionSummary(model, { segments: [null, ...selected().segments], weightedCount: 999 }), /1234.5/);
  const extreme = build({ option_breakdowns: [{ dimension: "age", groups: [
    group("18-24", [0.5, 0.5], Number.MAX_VALUE), group("65+", [0.5, 0.5], Number.MAX_VALUE),
  ] }] });
  assert.doesNotMatch(render(extreme, { segments: [...selected().segments, ...selected("age", "65+").segments] }), /Infinity|NaN/);
});

test("arrow navigation wraps across segments in all four directions", () => {
  assert.equal(nextSegmentIndex(3, 2, "ArrowRight"), 0);
  assert.equal(nextSegmentIndex(3, 0, "ArrowLeft"), 2);
  assert.equal(nextSegmentIndex(3, 1, "ArrowDown"), 2);
  assert.equal(nextSegmentIndex(3, 1, "ArrowUp"), 0);
  assert.equal(nextSegmentIndex(0, 0, "ArrowDown"), -1);
  assert.equal(nextSegmentIndex(3, 1, "Tab"), 1);
});

test("DOM adapter delegates, prevents duplicate key activation, restores focus, and disposes", () => {
  const model = build(binary()), listeners = new Map(), calls = [];
  let state = { segments: [] }, focused = null;
  const buttons = model.breakdowns[0].groups.map(({ dimension, key }) => ({
    dataset: { dimension, key }, closest() { return this; }, matches() { return true; }, focus() { focused = this; },
  }));
  const host = { addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { assert.equal(listeners.get(type), fn); listeners.delete(type); },
    contains(target) { return buttons.includes(target); }, querySelectorAll() { return buttons; } };
  const dispose = bindEvidenceChart(host, { getModel: () => model, getSelection: () => state,
    onSelectionChange(next, action) { state = next; calls.push(action); } });
  const fire = (type, target, extra = {}) => {
    let prevented = false;
    listeners.get(type)({ type, target, ...extra, preventDefault() { prevented = true; } });
    return prevented;
  };
  assert.equal(fire("click", buttons[0]), true);
  assert.equal(focused, buttons[0]);
  fire("click", buttons[1], { shiftKey: true });
  assert.equal(state.segments.length, 2);
  fire("keydown", buttons[1], { key: "ArrowDown" });
  assert.equal(focused, buttons[0]);
  assert.equal(calls.length, 2);
  assert.equal(fire("keydown", buttons[0], { key: " " }), true);
  assert.equal(calls.length, 3);
  fire("keydown", buttons[0], { key: " ", repeat: true });
  assert.equal(calls.length, 3);
  fire("keydown", buttons[0], { key: "Escape" });
  assert.deepEqual(state, { segments: [] });
  dispose(); assert.equal(listeners.size, 0);
});
