// Pure-logic tests for the constellation renderer: model normalization, the
// bounded layout, and hit testing. No DOM — constellations.js keeps every
// document access inside the renderer class, so these run under `node --test`.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeModel, planLayout, hitTestStars, createMockModel, BUDGET } from "../src/constellations.js";

const members = (n, offset = 0) => Array.from({ length: n }, (_, i) => ({ id: offset + i, name: `R${offset + i}` }));
const desktop = { width: 1440, height: 900 };

test("normalizeModel keeps backend shares and the full population", () => {
  const model = normalizeModel({
    question: "Should the city expand transit?",
    illustrative: true,
    groups: [
      { id: "yes", label: "Yes", share: 0.62, member_count: 6200, members: members(40) },
      { id: "no", label: "No", share: 0.38, member_count: 3800, members: members(40, 100) },
    ],
  });
  assert.equal(model.groups.length, 2);
  assert.deepEqual(model.groups.map((g) => g.share), [0.62, 0.38]);
  assert.deepEqual(model.groups.map((g) => g.count), [6200, 3800]);
  assert.equal(model.totalMembers, 10000);
  assert.equal(model.illustrative, true);
});

test("normalizeModel accepts percentage shares, derives shares from counts, and rejects junk", () => {
  assert.equal(normalizeModel({ groups: [{ id: "a", share: 62, members: members(2) }] }).groups[0].share, 0.62);
  const derived = normalizeModel({ groups: [{ id: "a", members: members(30) }, { id: "b", members: members(10, 50) }] });
  assert.equal(derived.groups[0].share, null);                 // no invented share
  assert.equal(Math.round(derived.groups[0].weight * 100), 75); // drawing weight only
  for (const junk of [null, undefined, {}, { groups: [] }, { groups: [{}] }, { groups: "nope" }]) {
    assert.equal(normalizeModel(junk), null);
  }
});

test("an absent illustrative flag is treated as illustrative", () => {
  assert.equal(normalizeModel({ groups: [{ id: "a", members: members(3) }] }).illustrative, true);
  assert.equal(normalizeModel({ illustrative: false, groups: [{ id: "a", members: members(3) }] }).illustrative, false);
});

test("duplicate group ids stay distinct so colour slots cannot collide", () => {
  const model = normalizeModel({ groups: [{ id: "same", members: members(3) }, { id: "same", members: members(3, 9) }] });
  assert.equal(model.groups.length, 2);
  assert.notEqual(model.groups[0].id, model.groups[1].id);
});

test("layout draws a bounded subset while retaining the whole population", () => {
  const model = createMockModel({ groups: 5, population: 10000 });
  const layout = planLayout(model, desktop);
  assert.ok(layout.totalShown <= BUDGET.starsDesktop, `stars ${layout.totalShown}`);
  assert.equal(layout.totalMembers, 10000);
  assert.ok(layout.totalShown < layout.totalMembers);
  for (const g of layout.groups) {
    assert.ok(g.shown <= g.count);
    assert.ok(g.shown >= 1);
  }
  // Bigger share, more stars — the sky reflects the weighting it was given.
  const shares = layout.groups.map((g) => g.share);
  const shown = layout.groups.map((g) => g.shown);
  for (let i = 1; i < shares.length; i++) {
    if (shares[i] < shares[i - 1]) assert.ok(shown[i] <= shown[i - 1]);
  }
});

test("mobile viewports get a smaller subset and stay inside the canvas", () => {
  const model = createMockModel({ groups: 5 });
  const mobile = planLayout(model, { width: 390, height: 844 });
  assert.ok(mobile.mobile);
  assert.ok(mobile.totalShown <= BUDGET.starsMobile, `stars ${mobile.totalShown}`);
  for (const s of mobile.stars) {
    assert.ok(s.x > -40 && s.x < 430, `x ${s.x}`);
    assert.ok(s.y > -40 && s.y < 884, `y ${s.y}`);
  }
});

test("connections are bounded and never cross groups", () => {
  const layout = planLayout(createMockModel({ groups: 5 }), desktop);
  assert.ok(layout.edgeCount <= BUDGET.edgesTotal);
  for (const g of layout.groups) {
    assert.ok(g.edges.length <= BUDGET.edgesPerGroup);
    const own = new Set(g.stars.map((s) => `${s.x},${s.y}`));
    for (const e of g.edges) {
      assert.ok(own.has(`${e.ax},${e.ay}`) && own.has(`${e.bx},${e.by}`), "edge endpoint outside its group");
    }
  }
});

test("the drawn subset is spread across the group, not its first members", () => {
  const model = { question: "q", illustrative: true, groups: [{ id: "one", label: "One", member_count: 600, members: members(600) }] };
  const layout = planLayout(model, { ...desktop, maxStars: 20 });
  const indices = layout.groups[0].stars.map((s) => s.memberIndex);
  assert.equal(new Set(indices).size, indices.length);
  assert.ok(Math.max(...indices) > 500, `max index ${Math.max(...indices)}`);
  assert.ok(Math.min(...indices) < 50);
});

test("a short persona sample caps the stars, so every star can be inspected", () => {
  const layout = planLayout({ groups: [{ id: "sparse", label: "Sparse", member_count: 5000, members: members(4) }] }, desktop);
  assert.equal(layout.totalShown, 4);
  assert.equal(layout.groups[0].count, 5000, "the full population is still reported");
  assert.ok(layout.stars.every((s) => s.member !== null), "no star without a persona behind it");
});

test("an aggregate-only group still gets weighted stars, with no invented personas", () => {
  const layout = planLayout({
    groups: [
      { id: "yes", label: "Yes", share: 0.7, member_count: 7000 },
      { id: "no", label: "No", share: 0.3, member_count: 3000 },
    ],
  }, desktop);
  const [yes, no] = layout.groups;
  assert.ok(yes.shown > no.shown, `weighted star counts ${yes.shown}/${no.shown}`);
  assert.ok(layout.totalShown > 10);
  assert.ok(layout.stars.every((s) => s.member === null), "aggregate groups carry no persona");
});

test("layout is deterministic for the same model and viewport", () => {
  const model = createMockModel({ groups: 4 });
  const a = planLayout(model, desktop);
  const b = planLayout(model, desktop);
  assert.deepEqual(a.stars.map((s) => [s.x, s.y]), b.stars.map((s) => [s.x, s.y]));
});

test("resizing relayouts into the new viewport", () => {
  const model = createMockModel({ groups: 4 });
  const wide = planLayout(model, { width: 1600, height: 900 });
  const narrow = planLayout(model, { width: 700, height: 900 });
  assert.notDeepEqual(wide.groups.map((g) => g.cx), narrow.groups.map((g) => g.cx));
  for (const s of narrow.stars) assert.ok(s.x >= 0 && s.x <= 700, `x ${s.x}`);
});

test("degenerate viewports and empty models produce an empty layout, not a throw", () => {
  for (const size of [{ width: 0, height: 0 }, { width: 1, height: 400 }]) {
    const layout = planLayout(createMockModel({ groups: 3 }), size);
    assert.deepEqual(layout.stars, []);
  }
  assert.deepEqual(planLayout(null, desktop).groups, []);
});

test("hit testing finds the tapped star and misses empty sky", () => {
  const layout = planLayout(createMockModel({ groups: 3 }), desktop);
  const star = layout.stars[7];
  assert.equal(hitTestStars(layout, star.x, star.y), star);
  assert.equal(hitTestStars(layout, star.x + 3, star.y - 2), star);     // near enough counts
  assert.equal(hitTestStars(layout, -500, -500), null);
  assert.equal(hitTestStars(null, 0, 0), null);
});

test("a coarse-pointer tolerance widens the target without inventing one", () => {
  // One sparse group, so the nearest star to the probe is unambiguous.
  const layout = planLayout({ groups: [{ id: "one", label: "One", member_count: 3, members: members(3) }] }, { ...desktop, maxStars: 3 });
  const star = layout.stars[0];
  assert.equal(hitTestStars(layout, star.x + 18, star.y), null);          // out of reach by default
  assert.equal(hitTestStars(layout, star.x + 18, star.y, 22), star);      // in reach for a finger
  assert.equal(hitTestStars(layout, star.x + 400, star.y, 22), null);
});

test("every star carries its group and a persona slot for the inspector", () => {
  const layout = planLayout(createMockModel({ groups: 3 }), desktop);
  const ids = new Set(layout.groups.map((g) => g.id));
  for (const s of layout.stars) {
    assert.ok(ids.has(s.groupId));
    assert.ok(s.member === null || typeof s.member === "object");
  }
});

test("the mock model is labelled as mock", () => {
  const model = normalizeModel(createMockModel());
  assert.equal(model.mock, true);
  assert.equal(model.illustrative, true);
  assert.match(model.provenance, /mock/i);
  assert.match(model.question, /mock/i);
});
