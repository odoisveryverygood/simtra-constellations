import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildVerifiedDataModel as build, renderVerifiedData as render, verifiedMapSelection, verifiedSelectionSummary, reduceVerifiedSelection, UNVERIFIABLE} from '../src/verified-data.js';
import {createSegmentIndex,selectSegments} from '../src/segment-selection.js';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/verified-data-contract.json',import.meta.url)));
const unsupported=JSON.parse(readFileSync(new URL('../fixtures/verified-data-unsupported.json',import.meta.url)));
const fresh=()=>structuredClone(fixture);
const select=(model, ...keys)=>keys.reduce((selection,key)=>reduceVerifiedSelection(model,selection,{type:'add',dimension:'verified_bar',key}),{segments:[]});
const residents=[
  {id:1,pums_weight:1,segments:{education:'bachelors',gender:'women',geography:'7507'}},
  {id:2,pums_weight:2,segments:{education:'graduate',gender:'men',geography:'7508'}},
  {id:3,pums_weight:999,segments:{education:'hs',gender:'women',geography:'7507'}},
];

test('schema 1.0 percent is 0–100; PUMS numerator and record count are preserved',()=>{
  const m=build(fresh()); assert.equal(m.available,true); assert.equal(m.truthLabel,'Verified source data');
  assert.equal(m.rows[0].value,52.4);assert.equal(m.rows[0].weighted_population,123456);assert.equal(m.rows[0].raw_records,1234);
  const html=render(m,select(m,'bachelors_or_higher'),2,true);
  assert.match(html,/width:52.4%/);assert.match(html,/Chart scale: 0–100 percent/);
  for(const expected of ['52.4 percent','Full PUMS weighted estimate: 123,456','Full PUMS raw-record count: 1,234','Matching synthetic-map resident count: 2','complete PUMS snapshot'])assert.ok(html.includes(expected),expected);
});
test('complete provenance, hashes, geographic approximation, methodology and null license render',()=>{
  const html=render(build(fresh()));
  for(const expected of ['Dataset name','Vintage','Official source link','Retrieval date','Geographic coverage','Methodology','Limitations','07507, 07508','Exact city boundary: no','sum_of_person_weights','synthetic residents used: false','Raw source SHA-256','Snapshot SHA-256','<dt>License</dt><dd>Unknown</dd>']) assert.ok(html.includes(expected),expected);
});
test('each missing source field, coverage, method, hashes or attestation suppresses verification',()=>{
  for(const key of ['verification_status','provider','dataset','vintage','url','retrieved_at','local_snapshot','weight_field','raw_sha256','snapshot_sha256']){
    const f=fresh();delete f.source[key]; assert.equal(build(f).truthLabel,'Unknown',key);
  }
  for(const parent of ['geography','method','limitations']){const f=fresh();delete f[parent];assert.equal(build(f).truthLabel,'Unknown',parent);}
  for(const key of Object.keys(fixture.geography)){const f=fresh();delete f.geography[key];assert.equal(build(f).truthLabel,'Unknown',key);}
  for(const key of Object.keys(fixture.method)){const f=fresh();delete f.method[key];assert.equal(build(f).truthLabel,'Unknown',key);}
  const f=fresh();f.limitations=[];assert.equal(build(f).truthLabel,'Verified source data','explicitly empty limitations allowed by contract');
});
test('unverified, unsafe/unofficial sources and invalid hashes/dates stay Unknown',()=>{
  for(const changes of [{verification_status:'unknown'},{verified:true,verification_status:null},{url:'javascript:alert(1)'},{url:'https://census.gov.evil.example/data'},{url:'https://example.org'},{raw_sha256:'hex'},{snapshot_sha256:'x'.repeat(64)},{retrieved_at:'yesterday'}]){
    const f=fresh();Object.assign(f.source,changes);assert.equal(build(f).truthLabel,'Unknown');
  }
});
test('unsupported and malformed success never render answer/chart fallback',()=>{
  const bad=[unsupported,{},null,{...fresh(),status:'error'},...['chart','answer','query_spec','method'].map(k=>({...fresh(),[k]:null}))];
  for(const f of bad){const m=build(f);assert.equal(m.available,false);assert.doesNotMatch(render(m),/data-key=|verified-answer/);}
  assert.ok(render(build(unsupported)).includes(UNVERIFIABLE));
  for(const modify of [f=>f.query_spec.schema_version='2.0',f=>f.method.synthetic_residents_used=true,f=>f.method.scope='synthetic_sample',f=>f.chart.series[0].value=101,f=>f.chart.series[0].raw_records=-1,f=>f.chart.series[0].weighted_population=null,f=>f.chart.series.push(f.chart.series[0])]){const f=fresh();modify(f);assert.equal(build(f).available,false);}
});
test('canonical per-bar OR filters select exact residents independent of labels, group_by, or source statistics',()=>{
  const f=fresh(); f.chart.series[0].label='Women';f.query_spec.group_by='age';
  const m=build(f), result=verifiedMapSelection(m,select(m,'bachelors_or_higher'),residents,'sf');
  assert.equal(result.count,2);assert.deepEqual(selectSegments(createSegmentIndex(residents),result.selection).matchingIndices,[0,1]);
  assert.equal(m.rows[0].weighted_population,123456);assert.equal(m.rows[0].raw_records,1234);
});
test('combining overlapping bars deduplicates map residents and never sums source counts',()=>{
  const m=build(fresh()),selection=select(m,'bachelors_or_higher','graduate');
  assert.equal(verifiedMapSelection(m,selection,residents,'sf').count,2);
  const summary=verifiedSelectionSummary(m,selection,2);
  assert.match(summary,/123,456/);assert.match(summary,/49,948/);assert.doesNotMatch(summary,/173,404/);
});
test('OR across bars preserves each AND predicate, geography key padding and cross-tabs',()=>{
  const f=fresh(); f.chart.series[0].map_filter={operator:'and',clauses:[{dimension:'gender',key:'women'},{dimension:'geography',key:'7507'}]};
  f.chart.series[1].map_filter={operator:'and',clauses:[{dimension:'education',key:'graduate'},{dimension:'gender',key:'women'}]};
  const m=build(f), selection=select(m,'bachelors_or_higher','graduate');
  assert.equal(verifiedMapSelection(m,selection,residents,'sf').count,2);
  const grouped={groups:[{operator:'or',clauses:[{dimension:'gender_x_age',key:'women|25-34'}]}]};
  assert.equal(selectSegments(createSegmentIndex([{segments:{gender_x_age:'women|25-34'}}]),grouped).summary.rawMatchingAgents,1);
});
test('missing/unknown predicate, resident metadata, or mismatched city yields Unknown map count',()=>{
  for(const predicate of [null,{operator:'xor',clauses:[]},{operator:'and',clauses:[]},{operator:'or',clauses:[{dimension:'label',key:'Women'}]}]){
    const f=fresh();f.chart.series[0].map_filter=predicate;const m=build(f);
    const result=verifiedMapSelection(m,select(m,'bachelors_or_higher'),residents,'sf');assert.equal(result.count,null);assert.equal(result.selection,null);
  }
  const m=build(fresh()),sel=select(m,'graduate');
  assert.equal(verifiedMapSelection(m,sel,[{id:1}],'sf').count,null);
  assert.equal(verifiedMapSelection(m,sel,residents,'neu_york').count,null);
});
test('clear removes filters; immutable responses and deterministic rerenders',()=>{
  const f=fresh(),before=structuredClone(f),m=build(f),s=select(m,'graduate');
  const cleared=reduceVerifiedSelection(m,s,{type:'clear'});assert.deepEqual(cleared,{segments:[]});
  assert.equal(verifiedMapSelection(m,cleared,residents,'sf').selection,null);
  assert.equal(render(m,s,1,true),render(build(f),s,1,true));assert.deepEqual(f,before);
});
test('bar buttons have accessible labels, pressed state, live counts and escaped untrusted text',()=>{
  const f=fresh();f.answer='<img src=x onerror=alert(1)>';f.chart.series[0].label='<script>x</script>';
  const m=build(f),html=render(m,select(m,'bachelors_or_higher'),2,true);
  assert.match(html,/aria-pressed="true"/);assert.match(html,/aria-live="polite"/);assert.match(html,/aria-label="&lt;script&gt;/);
  assert.doesNotMatch(html,/<script>|<img/);assert.match(html,/&lt;img/);
});
test('dataQuery POSTs to /data-query with no parse/poll/fallback requests',async()=>{
  const previous=globalThis.fetch, calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return{ok:true,text:async()=>JSON.stringify(fixture)};};
  try{
    const api=await import('../src/api.js?verified-contract');const result=await api.dataQuery('sf','Question?');
    assert.deepEqual(result,fixture);assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/data-query'));
    assert.equal(calls[0].options.method,'POST');assert.deepEqual(JSON.parse(calls[0].options.body),{city:'sf',question:'Question?'});
    globalThis.fetch=async()=>({ok:false,status:404,text:async()=>'{"error":"not installed"}'});
    await assert.rejects(api.dataQuery('sf','Question?'),/404/);
  }finally{globalThis.fetch=previous;}
});

import {SFMap} from '../src/map.js';
test('map preserves copied grouped predicates and clears them',()=>{
  const map=Object.create(SFMap.prototype);
  Object.assign(map,{_segmentIndex:createSegmentIndex(residents),_segmentSelection:null});
  const m=build(fresh()),filter=verifiedMapSelection(m,select(m,'bachelors_or_higher','graduate'),residents,'sf').selection;
  assert.equal(map.setSegmentSelection(filter).rawMatchingAgents,2);
  filter.groups[0].clauses[0].key='hs';
  assert.equal(map.getSegmentSelectionSummary().rawMatchingAgents,2,'caller mutation does not change selection');
  assert.equal(map.clearSegmentSelection().rawMatchingAgents,3);
  assert.equal(map.getSegmentSelectionSummary().active,false);
});

test('missing frozen field names cannot be replaced by convenient aliases',()=>{
  const f=fresh();f.source.direct_url=f.source.url;delete f.source.url;
  assert.equal(build(f).truthLabel,'Unknown');
  const g=fresh();g.chart.series[0].filter=g.chart.series[0].map_filter;delete g.chart.series[0].map_filter;
  const m=build(g);assert.equal(verifiedMapSelection(m,select(m,'bachelors_or_higher'),residents,'sf').count,null);
});

test('explicit offline demo never reuses statistical fixture for arbitrary questions',async()=>{
  const previousLocation=globalThis.location,previousFetch=globalThis.fetch;
  globalThis.location=new URL('http://localhost/?demo=1');globalThis.fetch=()=>{throw Error('Must not load chart fixture');};
  try{const api=await import('../src/api.js?verified-offline');const response=await api.dataQuery('sf','An arbitrary question');assert.equal(response.status,'unsupported');assert.equal(response.chart,null);}
  finally{globalThis.location=previousLocation;globalThis.fetch=previousFetch;}
});

test('zero estimates stay zero and population charts use backend weighted values',()=>{
  const f=fresh(); f.chart.unit='people';f.query_spec.intent='count';
  f.chart.series[0].value=123456;f.chart.series[1].value=0;
  f.chart.series[1].weighted_population=0;f.chart.series[1].raw_records=0;
  const m=build(f);assert.equal(m.available,true);const html=render(m,select(m,'graduate'),0,true);
  assert.match(html,/Chart scale: 0–123,456 people/);assert.match(html,/Full PUMS weighted estimate: 0/);
  assert.match(html,/Full PUMS raw-record count: 0/);assert.match(html,/resident count: 0/);
});
