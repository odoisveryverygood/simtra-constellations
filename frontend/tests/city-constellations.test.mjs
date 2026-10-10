import test from 'node:test';
import assert from 'node:assert/strict';
import { planCityConnections, initConstellations } from '../src/city-constellations.js';
test('10,000 resident population remains intact while connection drawing is bounded',()=>{
 const agents=Array.from({length:10000},(_,seed)=>({seed,wx:seed%100*8,wy:Math.floor(seed/100)*6}));
 const model={groups:[{members:agents.map(a=>({id:a.seed}))}]};
 const layout=planCityConnections(model,agents,(x,y)=>({x,y}),900,700);
 assert.equal(agents.length,10000);assert.equal(model.groups[0].members.length,10000);
 assert.ok(layout.stars.length<=240);assert.ok(layout.edges.length<=60);
 assert.deepEqual(layout,planCityConnections(model,agents,(x,y)=>({x,y}),900,700));
 assert.ok(planCityConnections(model,agents,(x,y)=>({x,y}),390,844).stars.length<=110);
});
test('only visible grouped residents receive links; reset and destroy restore city hook',()=>{
 const agents=[{seed:1,wx:20,wy:20},{seed:2,wx:2000,wy:20},{seed:3,wx:40,wy:20}];
 const model={groups:[{members:[{id:1},{id:2}]}]};
 assert.deepEqual(planCityConnections(model,agents,(x,y)=>({x,y}),400,800).stars.map(s=>s.id),[1]);
 const previous=()=>{},map={drawConstellations:previous};const view=initConstellations(map);
 assert.notEqual(map.drawConstellations,previous);view.setResult(null);view.setActive(false);view.destroy();
 assert.equal(map.drawConstellations,previous);
});
