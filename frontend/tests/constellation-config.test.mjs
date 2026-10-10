import test from 'node:test';
import assert from 'node:assert/strict';
test('local Gemini predictions and Jev A/B have independent model defaults',async()=>{
  globalThis.location={hostname:'localhost',search:'?backend=local&port=8088'};
  const {PREDICT}=await import('../src/config.js?test-defaults');
  assert.equal(PREDICT.model,'gemini-3.5-flash-lite');assert.equal(PREDICT.ab_model,'jev-latest');
});
test('an A/B model override does not change parsing or prediction model',async()=>{
  globalThis.location={hostname:'localhost',search:'?backend=local&ab_model=gemini-3.5-flash-lite'};
  const {PREDICT}=await import('../src/config.js?test-override');
  assert.equal(PREDICT.model,'gemini-3.5-flash-lite');assert.equal(PREDICT.ab_model,'gemini-3.5-flash-lite');
});
