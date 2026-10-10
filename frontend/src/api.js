// ─────────────────────────────────────────────────────────────────────────
// Thin client over the SF Digital Twin backend (see INTEGRATION.md).
// Every call has a timeout and throws a readable Error on non-2xx.
// ─────────────────────────────────────────────────────────────────────────

import { BASE, SIM, PREDICT } from "./config.js";
import { workspaceHeaders } from "./workspace.js?v=2";

async function req(path, { method = "GET", body, timeout = 30000, signal } = {}) {
  if (isDemo && path === "/data-query") return {
    status:"unsupported", question:body.question, answer:null, chart:null, query_spec:null,
    geography:null, source:null, method:null,
    limitations:["Offline simulation demo has no verified-data query service."],
  };
  if (isDemo) return demoRequest(path, { method, body, signal });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  // honor an external abort signal (user cancellation) in addition to the timeout
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...workspaceHeaders(), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = data?.error || data?.message || text || res.statusText;
      const error = new Error(`${method} ${path} → ${res.status}: ${msg}`);
      error.status = res.status;
      error.path = path;
      throw error;
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`${method} ${path} timed out`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Schema 1.0 statistical queries never call parse/poll or use preview fixtures.
export const dataQuery = (city, question, signal, { record = true } = {}) =>
  req("/data-query", { method:"POST", body:{city, question, ...(record ? {} : { record: false })}, signal, timeout:60000 });

export const health = () => req("/health", { timeout: 8000 });
export const seedWorkspace = () => req("/workspace/seed", { method: "POST", body: {}, timeout: 90000 });

// Persisted prediction history from InsForge. The Rust backend keeps the
// InsForge admin key server-side and returns only stored result data here.
export const getPredictionResults = (city, limit = 25) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (city) params.set("city", city);
  return req(`/prediction-results?${params.toString()}`, { timeout: 12000 });
};

// Multi-city catalog. Returns { cities: [{slug, display, prompt_name, bbox, n_pums, knowledge_date, default}] }.
export const getCities = () => req("/cities", { timeout: 12000 });

// Recent news for a city's bubble. Returns { city, date, articles:[{headline, summary, url}] }.
export const getNews = (city) =>
  req(`/cities/${encodeURIComponent(city)}/news`, { timeout: 10000 });

// Ambient LLM chatter for the residents currently on screen (sparse + batched).
// Returns { chatter: { "<agentId>": "<thought>", ... } }.
export const getChatter = (branchId, ids) =>
  req(`/branches/${encodeURIComponent(branchId)}/chatter`, {
    method: "POST",
    body: { ids },
    timeout: 15000,
  });

// Classify a free-form question for a city before polling. Returns either
// { supported:true, framing, question, description, options } or
// { supported:false, reason, examples }.
export const parseQuestion = (city, question, signal) =>
  req(`/cities/${encodeURIComponent(city)}/parse`, {
    method: "POST",
    body: { question, model: PREDICT.model },
    timeout: 60000,
    signal,
  });

// `city` rides along in the body (defaults to "sf" server-side when omitted).
export const createSimulation = (overrides = {}) =>
  req("/simulations", { method: "POST", body: { ...SIM, ...overrides }, timeout: 60000 });

// Page through every alive agent on a branch. Returns [{id, name, lonlat, values, ...}].
// `cap` is only a runaway guard; the real bound is the branch's total_matched,
// which we learn from the first page — so we never silently drop agents.
export async function getAllAgents(branchId, onProgress, cap = 50000) {
  const limit = 1000;
  let offset = 0;
  const out = [];
  while (offset < cap) {
    const page = await req(`/branches/${encodeURIComponent(branchId)}/agents?limit=${limit}&offset=${offset}`, { timeout: 30000 });
    const batch = page.agents || [];
    out.push(...batch);
    const total = page.total_matched ?? out.length;
    offset += limit;
    if (onProgress) onProgress(out.length, total);
    if (out.length >= total || batch.length < limit) break;
  }
  return out;
}

// "Trigger the branching": clone main, optionally broadcast an event, run a
// couple ticks so the branch reflects it.
export const createBranch = (simId, { ticks = PREDICT.branch_ticks, event, name, signal } = {}) =>
  req(`/simulations/${encodeURIComponent(simId)}/branches`, {
    method: "POST",
    body: { ticks, ...(event ? { event } : {}), ...(name ? { name } : {}) },
    timeout: 90000,
    signal,
  });

// Poll the synthetic electorate. The LLM pass takes ~5-15s.
export const poll = (branchId, payload, signal) =>
  req(`/branches/${encodeURIComponent(branchId)}/poll`, {
    method: "POST",
    body: payload,
    timeout: 180000,
    signal,
  });

function previewFingerprint(payload) {
  const text = `${payload.question}\n${payload.variant_a}\n${payload.variant_b}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function swapPreviewBreakdowns(breakdowns) {
  return (breakdowns || []).map((breakdown) => ({
    ...breakdown,
    groups: (breakdown.groups || []).map((group) => ({
      ...group,
      a_share: group.b_share,
      b_share: group.a_share,
    })),
  }));
}

function transitPreviewRationales(payload) {
  const transitQuestion = /public transit/i.test(payload.question);
  const commuteMessage = /shorter commutes|fewer cars/i.test(payload.variant_a);
  const affordabilityMessage = /fares affordable|workers, students, and families/i.test(payload.variant_b);
  if (!transitQuestion || !commuteMessage || !affordabilityMessage) return null;
  return [
    "Variant B feels more inclusive because it speaks directly to workers, students, and families.",
    "Keeping fares affordable matters more to me than the broader promise of a connected city.",
    "Variant A's shorter commutes and fewer cars are compelling, but Variant B makes the benefit feel more immediate.",
    "Expanded service and affordable fares sound like practical improvements I would use every week.",
    "I prefer the message that combines wider service with a clear commitment to affordability.",
  ];
}

async function previewAbResult(payload, signal) {
  const fixtureUrl = new URL("../fixtures/ab-sample.json", import.meta.url);
  const response = await fetch(fixtureUrl, { signal });
  if (!response.ok) throw new Error(`A/B preview fixture unavailable → ${response.status}`);
  const fixture = await response.json();
  const tailoredRationales = transitPreviewRationales(payload);
  const swap = tailoredRationales ? true : previewFingerprint(payload) % 2 === 1;
  const aShare = swap ? fixture.b_share : fixture.a_share;
  const bShare = swap ? fixture.a_share : fixture.b_share;
  const margin = aShare - bShare;

  return {
    ...fixture,
    question: payload.question,
    variant_a: payload.variant_a,
    variant_b: payload.variant_b,
    as_of_date: payload.as_of_date,
    model: payload.model,
    a_share: aShare,
    b_share: bShare,
    margin_pp: margin * 100,
    winner: Math.abs(margin) < 0.005 ? "tie" : margin > 0 ? "a" : "b",
    a_ci: swap ? fixture.b_ci : fixture.a_ci,
    b_ci: swap ? fixture.a_ci : fixture.b_ci,
    breakdowns: swap ? swapPreviewBreakdowns(fixture.breakdowns) : fixture.breakdowns,
    sample_rationales: tailoredRationales || fixture.sample_rationales,
    preview_mode: true,
  };
}

export async function abTest(branchId, payload, signal) {
  try {
    return await req(`/branches/${encodeURIComponent(branchId)}/ab-test`, {
      method: "POST",
      body: payload,
      timeout: 180000,
      signal,
    });
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  // Temporary demo path for deployments that do not have /ab-test yet.
  // Keep this internal marker so the saved result can be found and removed later.
  console.warn("A/B endpoint missing; using saved preview data.");
  return previewAbResult(payload, signal);
}

// Compare a baseline binary poll with simulated exposure to planned marketing copy.
// Returns { baseline, exposed, delta } where delta is exposed.p_yes - baseline.p_yes.
export const counterfactual = (branchId, payload, signal) =>
  req(`/branches/${encodeURIComponent(branchId)}/counterfactual`, {
    method: "POST",
    body: payload,
    timeout: 360000,
    signal,
  });

// persona memory: a recorded test, every resident's answer to it, one resident's full persona
export const getTest = (testId) => req(`/tests/${encodeURIComponent(testId)}`, { timeout: 20000 });
export const getTestAnswers = (testId) => req(`/tests/${encodeURIComponent(testId)}/answers`, { timeout: 30000 });
export const postPersonalAnswers = (testId, body) =>
  req(`/tests/${encodeURIComponent(testId)}/personal-answers`, { method: "POST", body, timeout: 90000 });
export const getAgentDetail = (branchId, agentId) => req(`/branches/${branchId}/agents/${agentId}`, { timeout: 12000 });

export const deleteBranch = (branchId) => {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("simtra:branch-deleted", { detail: { branchId } }));
  return req(`/branches/${encodeURIComponent(branchId)}`, { method: "DELETE", timeout: 15000 })
    .catch(() => {}); // best-effort cleanup
};

// Explicit offline demo. Every demographic and PWGTP value is from the saved
// backend response; probabilities are fixed test responses, never live answers.
export const isDemo = typeof location !== "undefined" && new URLSearchParams(location.search).get("demo") === "1";
let demoData, demoSequence = 0;
async function demoRequest(path, { method, body, signal }) {
  signal?.throwIfAborted();
  demoData ||= fetch(new URL("../fixtures/evidence-demo.json", import.meta.url)).then(async (r) => {
    if (!r.ok) throw new Error(`Demo fixture unavailable: ${r.status}`);
    return r.json();
  });
  const data = await demoData;
  signal?.throwIfAborted();
  const url = new URL(path, "http://local.invalid");
  const route = decodeURIComponent(url.pathname);
  const slug = route.match(/demo:([^/:]+)/)?.[1] || body?.city || "sf";
  const row = data.cities.find((entry) => entry.city.slug === slug);
  if (!row) throw new Error(`No committed demo snapshot for ${slug}`);
  let result;
  if (route === "/cities") result = { cities: data.cities.map((r) => r.city) };
  else if (route.endsWith("/news")) result = { articles: [] };
  else if (route.endsWith("/chatter")) result = { chatter: {} };
  else if (route.endsWith("/parse")) {
    const options = /which|choose|prioriti[sz]e/i.test(body.question);
    result = { supported: true, framing: options ? "options" : "vote", question: body.question,
      description: "Offline fixture demonstration; saved outcomes do not answer this question.",
      ...(options ? { options: row.options.p_distribution.map(([label]) => label) } : {}) };
  } else if (route === "/simulations") result = { simulation_id: `demo:${slug}`, main_branch: `demo:${slug}:main` };
  else if (route.startsWith("/simulations/") && route.endsWith("/branches")) result = { branch_id: `demo:${slug}:prediction:${++demoSequence}` };
  else if (route.endsWith("/agents")) {
    const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 1000);
    result = { agents: row.agents.slice(offset, offset + limit), total_matched: row.agents.length };
  } else if (route.endsWith("/poll")) result = body.framing === "options" ? row.options : row.binary;
  else if (route.endsWith("/counterfactual")) result = { baseline: row.binary, exposed: row.binary, delta: 0, fixture_mode: true };
  else if (route.endsWith("/ab-test")) result = { ...row.binary, ...body, a_share: row.binary.p_yes, b_share: 1-row.binary.p_yes,
    a_ci: [row.binary.ci_low,row.binary.ci_high], b_ci: [1-row.binary.ci_high,1-row.binary.ci_low], winner: "a", margin_pp: (2*row.binary.p_yes-1)*100,
    breakdowns: row.binary.option_breakdowns.map((b) => ({ ...b, groups: b.groups.map((g) => ({ ...g, a_share:g.shares[0], b_share:g.shares[1] })) })) };
  else if (method === "DELETE") result = { deleted: true };
  else throw new Error(`Unsupported offline fixture route: ${method} ${route}`);
  return structuredClone(result);
}
