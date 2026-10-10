import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceChartModel } from '../src/evidence-chart.js';
import { createSegmentIndex, selectSegments } from '../src/segment-selection.js';

test('every PollResult dimension can select the same canonical resident on the map', () => {
  const segments = { age:'25-34', gender:'women', race:'asian', education:'bachelors', income:'q2', tenure:'rent', marital:'married', nativity:'us_born', employment:'employed', citizenship:'citizen', geography:'7510', gender_x_age:'women|25-34', race_x_income:'asian|q2', education_x_income:'bachelors|q2' };
  const resident = { id:1, pums_weight:125, segments };
  const model = buildEvidenceChartModel({ option_breakdowns:Object.entries(segments).map(([dimension,key]) => ({dimension,groups:[{key,n:1,weight:125,shares:[.6,.4]}]})) });
  const index = createSegmentIndex([resident]);
  for (const { dimension, groups } of model.breakdowns) {
    const result = selectSegments(index,{clauses:[{dimension,key:groups[0].key}],operator:'or'});
    assert.deepEqual(result.summary,{active:true,rawMatchingAgents:1,weightedPumsCount:125},dimension);
  }
});

import { SFMap } from '../src/map.js';
test('reduced motion stops resident time, snaps camera and completes reveal', () => {
  const map = Object.create(SFMap.prototype);
  let dt, finished=0;
  Object.assign(map,{reducedMotion:true,ctx:{setTransform(){},fillRect(){}},dpr:1,cssW:100,cssH:100,baseReady:false,lastT:0,cam:{x:0,y:0,zoom:1},camTarget:{x:10,y:20,zoom:2},mode:'reveal',agents:[],revealCount:0,revealT0:100,revealDur:10000,
    _drawSprites(now,elapsed){dt=elapsed;},_updateBubbles(){},_drawBubbles(){},onRevealComplete(){finished++;}});
  map._draw(200);
  assert.equal(dt,0,'resident animation time must freeze');
  assert.deepEqual(map.cam,map.camTarget,'camera must not animate');
  assert.equal(finished,1,'reveal must finish without waiting for animation');
});

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/evidence-demo.json',import.meta.url)));
test('offline fixture hashes match committed snapshots and every bar matches exact resident PWGTP', () => {
  assert.equal(fixture.cities.length,5);
  for (const row of fixture.cities) {
    const snapshot = readFileSync(new URL('../../'+row.binary.evidence.population_source.local_snapshot,import.meta.url));
    assert.equal(createHash('sha256').update(snapshot).digest('hex'),row.snapshot_sha256);
    const index = createSegmentIndex(row.agents);
    for (const poll of [row.binary,row.options]) {
      assert.equal(poll.fixture_mode,true);
      for (const field of ['vintage','url','retrieved_at']) assert.equal(poll.evidence.population_source[field],null);
      for (const breakdown of poll.option_breakdowns) for (const group of breakdown.groups) {
        const result = selectSegments(index,{clauses:[{dimension:breakdown.dimension,key:group.key}],operator:'or'});
        assert.equal(result.summary.rawMatchingAgents,group.n,`${row.city.slug} ${breakdown.dimension} ${group.key} count`);
        assert.equal(result.summary.weightedPumsCount,group.weight,`${row.city.slug} ${breakdown.dimension} ${group.key} weight`);
      }
    }
  }
});
test('combined groups across dimensions count each resident once', () => {
  const row=fixture.cities.find((r)=>r.city.slug==='sf');
  const expected=row.agents.filter((a)=>a.segments.gender==='women'||a.segments.age==='25-34');
  const result=selectSegments(createSegmentIndex(row.agents),{clauses:[{dimension:'gender',key:'women'},{dimension:'age',key:'25-34'}],operator:'or'});
  assert.equal(result.summary.rawMatchingAgents,expected.length);
  assert.equal(result.summary.weightedPumsCount,expected.reduce((s,a)=>s+a.pums_weight,0));
});

test('offline API exercises all result transports without calling external services', async () => {
  const previousFetch=globalThis.fetch, previousLocation=globalThis.location;
  const requests=[];
  globalThis.location=new URL('http://localhost:5173/?demo=1');
  globalThis.fetch=async (url)=>{requests.push(String(url));return {ok:true,json:async()=>structuredClone(fixture)};};
  try {
    const api=await import('../src/api.js?offline-contract-test');
    assert.equal(api.isDemo,true);
    const sim=await api.createSimulation({city:'sf'});
    const agents=await api.getAllAgents(sim.main_branch);
    assert.equal(agents.length,256);
    const branch=await api.createBranch(sim.simulation_id);
    const binary=await api.poll(branch.branch_id,{framing:'vote'});
    assert.equal(binary.fixture_mode,true);
    const multi=await api.poll(branch.branch_id,{framing:'options'});
    assert.deepEqual(multi.p_distribution.map(([label])=>label),['Parks','Transit','Housing']);
    const ab=await api.abTest(branch.branch_id,{question:'Fixture',variant_a:'A',variant_b:'B'});
    assert.equal(ab.breakdowns[0].groups[0].a_share,binary.option_breakdowns[0].groups[0].shares[0]);
    const cf=await api.counterfactual(branch.branch_id,{});
    assert.deepEqual(cf.baseline,cf.exposed);assert.equal(cf.delta,0);
    const abort=new AbortController();abort.abort();
    await assert.rejects(api.poll(branch.branch_id,{},abort.signal));
    await api.deleteBranch(branch.branch_id);
    assert.equal(requests.length,1);
    assert.ok(requests[0].endsWith('/frontend/fixtures/evidence-demo.json'));
  } finally {globalThis.fetch=previousFetch;globalThis.location=previousLocation;}
});
