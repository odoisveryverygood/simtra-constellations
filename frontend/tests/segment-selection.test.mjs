import test from "node:test";
import assert from "node:assert/strict";
import { createSegmentIndex, normalizeSegmentSelection, selectSegments } from "../src/segment-selection.js";
import { SFMap } from "../src/map.js";

const agents = [
  { id: 9, pums_weight: 123, segments: { age: "25-34", gender: "women", race: "asian", income: "q2", gender_x_age: "women|25-34" } },
  { id: 2, pums_weight: 7.25, segments: { age: "25-34", gender: "men", race: "asian", income: "q1", gender_x_age: "men|25-34" } },
  { id: 9, pums_weight: 0.5, segments: { age: "65+", gender: "women", race: "white", income: "q2", gender_x_age: "women|65+" } },
  { id: 4, pums_weight: 2, segments: {} },
  { id: 5, pums_weight: 3 },
];
const clause = (dimension, key) => ({ dimension, key });
const query = (clauses, operator = "and") => ({ clauses, operator });
const index = createSegmentIndex(agents);

test("single segment matches canonical keys and exact weighted total", () => {
  const result = selectSegments(index, query([clause("gender", "women")]));
  assert.deepEqual(result.matchingIndices, [0, 2]);
  assert.deepEqual(result.summary, { active: true, rawMatchingAgents: 2, weightedPumsCount: 123.5 });
});

test("cross-tab matches its canonical key, without deriving absent cross-tabs", () => {
  assert.deepEqual(selectSegments(index, query([clause("gender_x_age", "women|25-34")])).matchingIndices, [0]);
  const partial = createSegmentIndex([{ segments: { gender: "women", age: "25-34" } }]);
  assert.equal(selectSegments(partial, query([clause("gender_x_age", "women|25-34")])).summary.rawMatchingAgents, 0);
});

test("AND intersects while OR unions without double counting", () => {
  const clauses = [clause("gender", "women"), clause("age", "25-34")];
  assert.deepEqual(selectSegments(index, query(clauses)).matchingIndices, [0]);
  const union = selectSegments(index, query(clauses, "or"));
  assert.deepEqual(union.matchingIndices, [0, 1, 2]);
  assert.equal(union.summary.weightedPumsCount, 130.75);
  assert.deepEqual(selectSegments(index, query([...clauses, clauses[0]], "or")).matchingIndices, [0, 1, 2]);
  assert.deepEqual(selectSegments(index, query([clauses[0], clauses[0]])).matchingIndices, [0, 2]);
});

test("missing and unknown segments fail closed under both operators", () => {
  for (const dimension of ["age", "unknown", "__proto__", "constructor"]) {
    assert.equal(selectSegments(index, query([clause(dimension, "missing")])).summary.rawMatchingAgents, 0);
  }
  const clauses = [clause("gender", "women"), clause("unknown", "anything")];
  assert.deepEqual(selectSegments(index, query(clauses)).matchingIndices, []);
  assert.deepEqual(selectSegments(index, query(clauses, "or")).matchingIndices, [0, 2]);
  const inherited = createSegmentIndex([{ segments: Object.create({ age: "25-34" }) }]);
  assert.deepEqual(selectSegments(inherited, query([clause("age", "25-34")])).matchingIndices, []);
});

test("malformed selection fails closed instead of accidentally clearing", () => {
  for (const selection of [{}, "women", { clauses: null }, query([null]), query([{}]), query([], "xor")]) {
    assert.deepEqual(selectSegments(index, selection).summary, { active: true, rawMatchingAgents: 0, weightedPumsCount: 0 });
  }
});

test("clear restores all residents in source order and full weighted total", () => {
  selectSegments(index, query([clause("gender", "women")]));
  for (const selection of [null, undefined, query([]), query([], "or")]) {
    const result = selectSegments(index, selection);
    assert.deepEqual(result.matchingIndices, [0, 1, 2, 3, 4]);
    assert.deepEqual([...result.matchMask], [1, 1, 1, 1, 1]);
    assert.deepEqual(result.summary, { active: false, rawMatchingAgents: 5, weightedPumsCount: 135.75 });
  }
});

test("input agents and selection are not mutated, and index snapshots keys/weights", () => {
  const source = structuredClone(agents);
  const before = structuredClone(source);
  const selection = query([Object.freeze(clause("gender", "women"))]);
  Object.freeze(selection.clauses); Object.freeze(selection);
  for (const agent of source) { if (agent.segments) Object.freeze(agent.segments); Object.freeze(agent); }
  Object.freeze(source);
  const snapshot = createSegmentIndex(source);
  selectSegments(snapshot, selection);
  assert.deepEqual(source, before);
  const mutable = structuredClone(agents);
  const independent = createSegmentIndex(mutable);
  mutable[0].segments.gender = "men"; mutable[0].pums_weight = 999;
  assert.equal(selectSegments(independent, selection).summary.weightedPumsCount, 123.5);
});

test("stable ordering does not depend on clause order or duplicate IDs", () => {
  const clauses = [clause("income", "q2"), clause("race", "asian")];
  assert.deepEqual(selectSegments(index, query(clauses, "or")).matchingIndices, [0, 1, 2]);
  assert.deepEqual(selectSegments(index, query([...clauses].reverse(), "or")).matchingIndices, [0, 1, 2]);
});

test("invalid weights contribute zero without hiding matching agents", () => {
  const weights = createSegmentIndex([{}, { pums_weight: NaN }, { pums_weight: Infinity }, { pums_weight: -1 }, { pums_weight: "3" }, { pums_weight: 0 }]);
  assert.deepEqual(selectSegments(weights).summary, { active: false, rawMatchingAgents: 6, weightedPumsCount: 0 });
  assert.deepEqual(selectSegments(createSegmentIndex([])).matchingIndices, []);
});

// Exercise the actual SFMap methods without loading images, network, or a DOM.
function makeMap(raw = agents) {
  const map = Object.create(SFMap.prototype);
  Object.assign(map, {
    _segmentSelection: normalizeSegmentSelection(null), imgW: 1000, imgH: 1000,
    landMask: null, cam: { x: 500, y: 500, zoom: 2 }, cssW: 1000, cssH: 1000,
    spriteReady: true, sprite: {}, mode: "results", clearFade: 1,
    zoomedIn: true, bubbleIdx: [],
  });
  map.setAgents(raw.map((agent) => ({ ...agent, lonlat: [-122.43, 37.765] })));
  return map;
}

function recordingContext() {
  const calls = [];
  const ctx = { globalAlpha: 1 };
  for (const method of ["drawImage", "fillRect", "strokeRect", "beginPath", "arc", "fill", "stroke"]) {
    ctx[method] = (...args) => calls.push({ method, args, alpha: ctx.globalAlpha, fill: ctx.fillStyle, stroke: ctx.strokeStyle, width: ctx.lineWidth });
  }
  return { ctx, calls };
}

test("SFMap clear preserves verdict state and restores original drawing", () => {
  for (const spriteReady of [true, false]) {
    const map = makeMap(); map.spriteReady = spriteReady;
    map.agents.forEach((a, i) => { a.verdict = i % 2 ? "yes" : "no"; a.activateAt = 0; a.turnClock = 10; a.rationale = "original"; });
    const verdicts = map.agents.map(({ verdict, activateAt, rationale }) => ({ verdict, activateAt, rationale }));
    let recording = recordingContext(); map.ctx = recording.ctx; map._drawSprites(1000, 0);
    const baseline = recording.calls;
    map.setSegmentSelection(query([clause("gender", "women")]));
    recording = recordingContext(); map.ctx = recording.ctx; map._drawSprites(1000, 0);
    assert.equal(recording.calls.filter((c) => c.method === "strokeRect" && c.stroke === "#22c55e").length, 2);
    const bodies = recording.calls.filter((c) => c.method === (spriteReady ? "drawImage" : "fillRect"));
    assert.equal(bodies[1].alpha, bodies[0].alpha * 0.25);
    assert.equal(recording.calls.filter((c) => c.method === "arc").length, 10); // yes/no markers retained
    assert.equal(map.ctx.globalAlpha, 1);
    assert.deepEqual(map.agents.map(({ verdict, activateAt, rationale }) => ({ verdict, activateAt, rationale })), verdicts);
    assert.equal(map.mode, "results");
    map.clearSegmentSelection();
    recording = recordingContext(); map.ctx = recording.ctx; map._drawSprites(1000, 0);
    assert.deepEqual(recording.calls, baseline);
  }
});

test("SFMap reindexes on setAgents and counts unplaced raw residents", () => {
  const map = makeMap();
  const selection = query([clause("gender", "women")]);
  map.setSegmentSelection(selection);
  selection.clauses[0].key = "men";
  const savedIndex = map._segmentIndex;
  map.ctx = recordingContext().ctx;
  map._drawSprites(1000, 0);
  assert.equal(map._segmentIndex, savedIndex);
  map.setAgents([agents[0], { ...agents[2], lonlat: [-122.43, 37.765] }]);
  assert.notEqual(map._segmentIndex, savedIndex);
  assert.equal(map.agents.length, 1);
  assert.equal(map.agents[0].segmentIndex, 1);
  assert.deepEqual(map.getSegmentSelectionSummary(), { active: true, rawMatchingAgents: 2, weightedPumsCount: 123.5 });
  const summary = map.getSegmentSelectionSummary(); summary.rawMatchingAgents = 999;
  assert.equal(map.getSegmentSelectionSummary().rawMatchingAgents, 2);
});

test("mouse/touch resident taps expose canonical segments and preserve detail; cancel/drag do not select", () => {
  const map = makeMap([agents[0]]);
  const handlers = {};
  map.canvas = { style: {}, addEventListener: (name, fn) => { handlers[name] = fn; }, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  map._setupPointer();
  const sprite = map.agents[0];
  const point = map.worldToScreen(sprite.wx, sprite.wy);
  const event = { pointerId: 1, clientX: point.x, clientY: point.y - 22 };
  const details = [], residents = [];
  map.onSpriteTap = (hit) => details.push(hit);
  map.onResidentSelect = (resident) => residents.push(resident);
  for (const pointerType of ["mouse", "touch"]) {
    handlers.pointerdown({ ...event, pointerType });
    handlers.pointerup({ ...event, pointerType, type: "pointerup" });
  }
  assert.deepEqual(details, [sprite, sprite]);
  assert.deepEqual(residents, [{ id: 9, segments: agents[0].segments }, { id: 9, segments: agents[0].segments }]);
  residents[0].segments.gender = "changed";
  assert.equal(sprite.segments.gender, "women");
  handlers.pointerdown(event); handlers.pointercancel({ ...event, type: "pointercancel" });
  map.zoomedIn = false;
  handlers.pointerdown(event); handlers.pointermove({ ...event, clientX: point.x + 30 }); handlers.pointerup({ ...event, type: "pointerup" });
  assert.equal(residents.length, 2);
  map.cam.zoom = 0.46;
  const overview = map.worldToScreen(sprite.wx, sprite.wy);
  const tap = { pointerId: 1, clientX: overview.x, clientY: overview.y - 22 * map.cam.zoom / 2 };
  let zooms = 0;
  map.zoomTo = () => zooms++;
  handlers.pointerdown(tap); handlers.pointerup({ ...tap, type: "pointerup" });
  assert.equal(residents.length, 3);
  assert.equal(details.length, 2);
  assert.equal(zooms, 1);
  // Two fingers resting on the map must not become a tap on the final release.
  handlers.pointerdown(tap); handlers.pointerdown({ ...tap, pointerId: 2 });
  handlers.pointerup({ ...tap, pointerId: 2, type: "pointerup" }); handlers.pointerup({ ...tap, type: "pointerup" });
  assert.equal(residents.length, 3);
});

test("10,000 residents retain deterministic counts across repeated queries", () => {
  const population = Array.from({ length: 10000 }, (_, i) => ({ pums_weight: 1.25, segments: { gender: i % 2 ? "men" : "women", age: i % 4 ? "25-34" : "65+" } }));
  const large = createSegmentIndex(population);
  const selection = query([clause("gender", "women"), clause("age", "25-34")]);
  const first = selectSegments(large, selection);
  assert.deepEqual(first.summary, { active: true, rawMatchingAgents: 2500, weightedPumsCount: 3125 });
  assert.deepEqual(selectSegments(large, selection), first);
});
