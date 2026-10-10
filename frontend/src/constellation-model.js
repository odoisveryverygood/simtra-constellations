// Aggregate model outputs support weighted shares, not independent resident
// votes or social relationships. Membership is a deterministic illustration.
function probability(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError("Constellation results require finite shares between 0 and 1");
  }
  return value;
}

function position(id) {
  let hash = 2166136261;
  for (const char of String(id)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967296;
}

export function buildConstellationModel(residents, result) {
  if (!Array.isArray(residents) || !result || typeof result !== "object") {
    throw new TypeError("Residents and a prediction or A/B result are required");
  }
  const ab = result.a_share !== undefined || result.b_share !== undefined;
  let entries;
  if (ab) entries = [["a", "Variant A", result.a_share], ["b", "Variant B", result.b_share]];
  else if (Array.isArray(result.p_distribution) && result.p_distribution.length) {
    entries = result.p_distribution.map(([label, share], i) => [`option-${i}`, String(label), share]);
  } else entries = [["yes", "Yes", result.p_yes], ["no", "No", 1 - probability(result.p_yes)]];
  const groups = entries.map(([id, label, share]) => ({ id, label, share: probability(share), members: [] }));
  const total = groups.reduce((sum, group) => sum + group.share, 0);
  if (Math.abs(total - 1) > 0.000001) throw new TypeError("Result shares must sum to 1");
  const seen = new Set();
  for (const resident of residents) {
    if (resident?.id == null || seen.has(String(resident.id))) {
      throw new TypeError("Every synthetic resident requires a distinct id");
    }
    seen.add(String(resident.id));
    const point = position(resident.id) * total;
    let boundary = 0;
    const group = groups.find((entry) => (boundary += entry.share) > point) || groups.at(-1);
    group.members.push({ ...resident, synthetic: true, illustrative: true });
  }
  const fixture = Boolean(result.preview_mode || result.fixture_mode);
  return {
    question: result.question || "",
    groups,
    illustrative: true,
    synthetic: true,
    notice: "Simulated results. Resident placements illustrate aggregate shares; they are not individual votes or actual social relationships. Star counts do not estimate weighted population shares.",
    provenance: {
      model: result.model ?? null,
      as_of_date: result.as_of_date ?? null,
      mode: fixture ? "fixture" : "simulation",
      label: fixture ? "Mock data — saved fixture" : `Simulated model result${result.model ? ` — ${result.model}` : ""}`,
      memory_test_id: result.memory_test_id ?? null,
    },
    // Sample explanations belong to the aggregate, never invented for a star.
    explanations: (result.sample_rationales || []).filter((value) => typeof value === "string" && value.trim()),
    statistics: {
      n_agents: result.n_agents ?? null,
      n_eff: result.n_eff ?? null,
      design_effect: result.design_effect ?? null,
      breakdowns: result.breakdowns ?? result.option_breakdowns ?? [],
    },
  };
}
