import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstellationBridge } from '../src/constellation-bridge.js';
function fixture(overrides = {}) {
  const calls = [], states = [];
  const state = { rawResidents:[{id:1}], phase:'idle', switching:false };
  const renderer = { setActive:v=>calls.push(['active',v]), setResult:v=>calls.push(['result',v]), destroy:()=>calls.push(['destroy']) };
  const bridge = createConstellationBridge({map:{},state,
    loadRenderer:async()=>({initConstellations:()=>renderer}),
    loadModel:async()=>({buildConstellationModel:(residents,result)=>({residents,result})}),
    onChange:s=>states.push(s),...overrides});
  return {bridge,calls,states,state,renderer};
}
test('hydrates newest result and reuses renderer across round trips', async()=>{
  const f=fixture();f.bridge.setResult({p_yes:.7});await f.bridge.setActive(true);
  assert.deepEqual(f.calls[0][1].result,{p_yes:.7});
  await f.bridge.setActive(false);await f.bridge.setActive(true);
  assert.equal(f.states.at(-1).active,true);assert.equal(f.states.at(-1).busy,false);
});
test('missing teammate modules preserves the city and allows retry', async()=>{
  let tries=0;const f=fixture({loadRenderer:async()=>{if(++tries===1)throw Error('missing');return {initConstellations:()=>f.renderer};}});
  assert.equal(await f.bridge.setActive(true),false);assert.equal(f.states.at(-1).active,false);
  assert.equal(await f.bridge.setActive(true),true);
});
test('city reset during loading prevents a stale view from opening',async()=>{
  let resolve;const f=fixture({loadModel:()=>new Promise(r=>resolve=r)});
  const pending=f.bridge.setActive(true);f.bridge.reset();resolve({buildConstellationModel:()=>({})});
  assert.equal(await pending,false);assert.ok(!f.calls.some(c=>c[0]==='active'&&c[1]===true));
});
test('population changes clear the old result',async()=>{
  const f=fixture();f.bridge.setResult({p_yes:.9});await f.bridge.setActive(true);f.bridge.reset();
  assert.deepEqual(f.calls.at(-1),['result',null]);assert.equal(f.states.at(-1).active,false);
});
test('renderer errors cannot strand the user outside city mode',async()=>{
  const f=fixture();f.renderer.setActive=v=>{if(v)throw Error('render failed');};
  assert.equal(await f.bridge.setActive(true),false);assert.equal(f.states.at(-1).active,false);
});
test('loading city refuses constellation activation without fetching modules',async()=>{
  const f=fixture({loadRenderer:()=>{throw Error('must not load');}});f.state.phase='booting';
  assert.equal(await f.bridge.setActive(true),false);assert.equal(f.calls.length,0);
});
