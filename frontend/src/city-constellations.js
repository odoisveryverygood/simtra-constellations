import { normalizeModel, BUDGET } from './constellations.js';

// Select only a bounded, visible illustration. All residents remain on the map;
// shares come from the weighted model, never the number of visible connections.
export function planCityConnections(model, agents, project, width, height) {
  const membership = new Map();
  for (const [slot, group] of (model?.groups || []).entries()) {
    for (const member of group.members) membership.set(String(member?.id ?? member), slot);
  }
  const limit = width < 700 ? BUDGET.starsMobile : BUDGET.starsDesktop;
  const groups = new Map();
  // Stable IDs keep the same sample as residents move or the camera pans.
  for (const agent of agents) {
    const slot = membership.get(String(agent.seed));
    if (slot === undefined) continue;
    const point = project(agent.wx, agent.wy);
    if (point.x < 0 || point.x > width || point.y < 0 || point.y > height) continue;
    if (!groups.has(slot)) groups.set(slot, []);
    groups.get(slot).push({ ...point, id: agent.seed });
  }
  const stars = [], edges = [];
  const allowance = Math.max(1, Math.floor(limit / Math.max(1, groups.size)));
  for (const [slot, points] of groups) {
    points.sort((a,b) => String(a.id).localeCompare(String(b.id), 'en', {numeric:true}));
    const selected = points.slice(0, allowance).sort((a,b) => a.x - b.x || a.y - b.y);
    stars.push(...selected.map(p => ({...p, slot})));
    for (let i = 1; i < selected.length && edges.length < 60; i++) {
      const a = selected[i-1], b = selected[i];
      const distance = Math.hypot(a.x-b.x, a.y-b.y);
      if (distance > 12 && distance < 120) edges.push({a,b,slot});
    }
  }
  return {stars, edges};
}

export function initConstellations(map) {
  let model = null, active = false, cached = null, lastPlan = -Infinity;
  const previous = map.drawConstellations;
  const colors = ['#79b6ff','#ffd18a','#80e6be','#d2baff','#ffaacb'];
  function draw(ctx, now) {
    previous?.(ctx, now);
    if (!active || !model) return;
    if (!cached || now-lastPlan > 100) {
      cached = planCityConnections(model, map.agents, (x,y)=>map.worldToScreen(x,y), map.cssW, map.cssH);
      lastPlan = now;
    }
    ctx.save();
    ctx.fillStyle = '#101b32'; ctx.globalAlpha = .18;
    ctx.fillRect(0,0,map.cssW,map.cssH);
    ctx.globalAlpha = .7; ctx.lineWidth = 1.35;
    for (const {a,b,slot} of cached.edges) {
      ctx.strokeStyle = colors[slot % colors.length];
      ctx.beginPath();ctx.moveTo(a.x,a.y-3);ctx.lineTo(b.x,b.y-3);ctx.stroke();
    }
    ctx.globalAlpha = .9;
    for (const star of cached.stars) {
      ctx.fillStyle = colors[star.slot % colors.length];
      ctx.globalAlpha = .18;
      ctx.beginPath(); ctx.arc(star.x,star.y-3,4.5,0,Math.PI*2);ctx.fill();
      ctx.globalAlpha = .95;
      ctx.beginPath(); ctx.arc(star.x,star.y-3,2.6,0,Math.PI*2);ctx.fill();
    }
    ctx.restore();
  }
  map.drawConstellations = draw;
  return {
    setActive(value) { active = Boolean(value && model); map.constellationActive = active; cached = null; },
    setResult(value) { model = normalizeModel(value); cached = null; if (!model) { active = false; map.constellationActive = false; } },
    destroy() { active = false; map.constellationActive = false; model = null; if (map.drawConstellations === draw) map.drawConstellations = previous; },
  };
}
