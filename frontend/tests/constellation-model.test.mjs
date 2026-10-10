import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildConstellationModel } from "../src/constellation-model.js";
const demo = JSON.parse(await readFile(new URL('../fixtures/evidence-demo.json', import.meta.url)));
const ab = JSON.parse(await readFile(new URL('../fixtures/ab-sample.json', import.meta.url)));
const row = demo.cities[0];
for (const [name, result] of [["binary",row.binary],["options",row.options],["A/B",ab]]) {
  test(`${name}: shares and population survive grouping without mutation`, () => {
    const original = structuredClone({residents:row.agents,result});
    const model = buildConstellationModel(row.agents,result);
    const shares = name === "A/B" ? [ab.a_share,ab.b_share] : name === "options" ? result.p_distribution.map(([,p]) => p) : [result.p_yes,1-result.p_yes];
    assert.deepEqual(model.groups.map(g => g.share),shares);
    assert.equal(model.groups.flatMap(g => g.members).length,row.agents.length);
    assert.equal(new Set(model.groups.flatMap(g => g.members.map(r => r.id))).size,row.agents.length);
    assert.ok(model.groups.flatMap(g => g.members).every(r => r.synthetic && r.illustrative));
    assert.deepEqual({residents:row.agents,result},original);
    assert.deepEqual(buildConstellationModel(row.agents,result),model);
    const reordered = buildConstellationModel([...row.agents].reverse(),result);
    assert.deepEqual(reordered.groups.map(g => g.members.map(r => r.id).sort()),model.groups.map(g => g.members.map(r => r.id).sort()));
  });
}
test('provenance and rationales never pretend fixture output is live Jev', () => {
  const model = buildConstellationModel(row.agents,{...ab,preview_mode:true});
  assert.equal(model.provenance.mode,'fixture');
  assert.equal(model.provenance.model,ab.model);
  assert.deepEqual(model.explanations,ab.sample_rationales);
  assert.match(model.notice,/not individual votes/);
});
test('rejects invalid outputs and ambiguous resident identities', () => {
  for (const value of [NaN,Infinity,-1,2,null]) assert.throws(() => buildConstellationModel([],{p_yes:value}));
  assert.throws(() => buildConstellationModel([],{a_share:.3,b_share:.3}));
  assert.throws(() => buildConstellationModel([{id:1},{id:1}],{p_yes:.5}));
  assert.throws(() => buildConstellationModel([{}],{p_yes:.5}));
});
