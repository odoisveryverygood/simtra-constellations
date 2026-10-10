// Run by the Rust integration test with freshly computed backend responses on stdin.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildVerifiedDataModel, renderVerifiedData, verifiedMapSelection } from '../src/verified-data.js';
const responses = JSON.parse(readFileSync(0, 'utf8'));
const demo = JSON.parse(readFileSync(new URL('../fixtures/evidence-demo.json', import.meta.url)));
for (const response of responses) {
  const model = buildVerifiedDataModel(response);
  if (response.status !== 'ok') {
    assert.equal(model.available, false);
    assert.equal(model.rows.length, 0);
    assert.equal(response.answer, null);
    continue;
  }
  assert.equal(model.available, true, `${response.question}: backend schema rejected`);
  assert.equal(model.truthLabel, 'Verified source data');
  assert.equal(model.geography.exact_city_boundary, false);
  const residents = demo.cities.find(c => c.city.slug === model.geography.city_slug).agents;
  assert.equal(model.rows.reduce((n,r) => n+r.weighted_population,0),response.method.weighted_population);
  for (const row of model.rows) {
    const selection = {segments:[{dimension:'verified_bar',key:row.key}]};
    const result = verifiedMapSelection(model,selection,residents,model.geography.city_slug);
    if (!row.map_filter) {
      assert.equal(result.ready,false);
      assert.equal(result.count,null);
      continue;
    }
    const expected = residents.filter(r => row.map_filter.clauses.every(c=>r.segments[c.dimension]===c.key)).length;
    assert.equal(result.ready,true);
    assert.equal(result.count,expected);
    const html=renderVerifiedData(model,selection,result.count,result.ready);
    for (const label of ['Full PUMS weighted estimate','Full PUMS raw-record count','Matching synthetic-map resident count','Dataset provenance']) assert.ok(html.includes(label));
  }
}
console.log(`${responses.length} actual backend responses accepted by frontend, with exact map predicates and fail-closed unsupported handling`);
