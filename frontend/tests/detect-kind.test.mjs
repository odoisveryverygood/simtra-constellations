import test from "node:test";
import assert from "node:assert/strict";
import { detectKind, nextKind, KINDS } from "../src/detect-kind.js";

const cases = [
  ["SFUSD announces a four-day school week starting in January", "policy"],
  ["The Board of Supervisors passes a 25% BART fare hike", "policy"],
  ["A 6.1 earthquake hit the Marina this morning", "incident"],
  ["A prominent political figure was shot at a campaign rally", "incident"],
  ["Sources say the Giants might leave Oracle Park", "rumor"],
  ["The mayor reportedly plans to resign", "rumor"],
  ["New Claude Mythos just launched", "news"],
  ["", "news"],
];

for (const [text, kind] of cases) {
  test(`detectKind: ${text || "(empty)"} -> ${kind}`, () => {
    assert.equal(detectKind(text), kind);
  });
}

test("nextKind cycles through every kind", () => {
  let k = "news";
  const seen = [];
  for (let i = 0; i < KINDS.length; i++) { seen.push(k); k = nextKind(k); }
  assert.deepEqual(seen, KINDS);
  assert.equal(k, "news");
});
