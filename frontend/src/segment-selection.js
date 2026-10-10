// DOM-free selection over canonical backend keys. No demographic inference.
export const SEGMENT_DIMENSIONS = Object.freeze(["age", "gender", "race", "education", "income", "tenure", "marital", "nativity", "employment", "citizenship", "geography", "gender_x_age", "race_x_income", "education_x_income"]);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Copy the request so subsequent caller edits cannot change an active selection.
// Malformed requests remain active but match nothing; only null/empty clears.
export function normalizeSegmentSelection(selection) {
  if (selection == null) return { clauses: [], operator: "and" };
  if (Array.isArray(selection.groups)) {
    if (!selection.groups.length) return { clauses: [], operator: "and" };
    return { groups: selection.groups.map(group => normalizeSegmentSelection({
      clauses: group?.clauses, operator: group?.operator,
    })) };
  }
  const operator = selection.operator ?? "and";
  if (!Array.isArray(selection.clauses) || (operator !== "and" && operator !== "or")) {
    return { clauses: [{ dimension: null, key: null }], operator: "and" };
  }
  return {
    clauses: selection.clauses.map((clause) => ({
      dimension: typeof clause?.dimension === "string" ? clause.dimension : null,
      key: typeof clause?.key === "string" ? clause.key : null,
    })),
    operator,
  };
}

// O(N * number of dimensions) once per population replacement. Row indices (not IDs) preserve
// duplicates and source ordering. Snapshot keys/weights without mutating agents.
// Missing, negative, or nonfinite weights contribute zero, never an invented 1.
export function createSegmentIndex(agents) {
  const postings = new Map(SEGMENT_DIMENSIONS.map((dimension) => [dimension, new Map()]));
  const weights = new Float64Array(agents.length);
  const segments = agents.map((agent, i) => {
    const canonical = {};
    const source = agent?.segments;
    const weight = agent?.pums_weight;
    weights[i] = Number.isFinite(weight) && weight >= 0 ? weight : 0;
    for (const dimension of SEGMENT_DIMENSIONS) {
      if (!source || !own(source, dimension) || typeof source[dimension] !== "string") continue;
      const key = source[dimension];
      canonical[dimension] = key;
      const values = postings.get(dimension);
      if (!values.has(key)) values.set(key, []);
      values.get(key).push(i);
    }
    return Object.freeze(canonical);
  });
  return { postings, weights, segments, size: agents.length };
}

// Pure query: never mutates the index/request. Unknown or missing keys are false
// clauses, including in OR. Empty selection matches the whole raw population.
// O(N + sum of clause posting lengths); called on selection changes, never frames.
export function selectSegments(index, selection = null) {
  const normalized = normalizeSegmentSelection(selection);
  if (normalized.groups) {
    const matchMask = new Uint8Array(index.size);
    for (const group of normalized.groups) {
      const result = selectSegments(index, group);
      for (const i of result.matchingIndices) matchMask[i] = 1;
    }
    const matchingIndices = [];
    let weightedPumsCount = 0;
    for (let i = 0; i < index.size; i++) if (matchMask[i]) {
      matchingIndices.push(i); weightedPumsCount += index.weights[i];
    }
    return { matchMask, matchingIndices, summary: {
      active:true, rawMatchingAgents:matchingIndices.length, weightedPumsCount,
    } };
  }
  const { clauses, operator } = normalized;
  const active = clauses.length > 0;
  const hits = new Uint32Array(index.size);
  for (const { dimension, key } of clauses) {
    const rows = index.postings.get(dimension)?.get(key);
    if (rows) for (const i of rows) hits[i]++;
  }
  const matchMask = new Uint8Array(index.size);
  const matchingIndices = [];
  let weightedPumsCount = 0, correction = 0;
  for (let i = 0; i < index.size; i++) {
    if (active && (operator === "and" ? hits[i] !== clauses.length : hits[i] === 0)) continue;
    matchMask[i] = 1;
    matchingIndices.push(i);
    // Compensated summation reduces floating-point loss for disparate weights.
    const adjusted = index.weights[i] - correction;
    const total = weightedPumsCount + adjusted;
    correction = (total - weightedPumsCount) - adjusted;
    weightedPumsCount = total;
  }
  return {
    matchMask,
    matchingIndices,
    summary: { active, rawMatchingAgents: matchingIndices.length, weightedPumsCount },
  };
}
