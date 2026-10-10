// Audience context belongs to the run, so later filter changes cannot relabel it.
const OCCUPATIONS = {
  management_business: "managers and business professionals",
  software_tech: "software and tech workers",
  engineer: "engineers",
  science_analysis: "scientists and analysts",
  social_services: "social-services workers",
  legal: "legal professionals",
  education: "educators",
  arts_media: "arts and media workers",
  healthcare: "healthcare professionals",
  service: "service workers",
  sales_office: "sales and office workers",
  construction_trades: "construction and trades workers",
  production_transportation: "production and transportation workers",
  military: "military personnel",
  unemployed: "unemployed residents",
  not_in_workforce: "residents outside the workforce",
  other: "workers in other occupations",
};
const EDUCATION = {
  lt_hs: "Without a high-school diploma",
  hs: "With a high-school diploma",
  some_college: "With some college or an associate degree",
  bachelors: "With a bachelor's degree",
  graduate: "With a graduate degree",
};
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
const count = (value) => Number.isInteger(value) && value >= 0 ? value : null;
const format = (value) => value.toLocaleString("en-US");

export function snapshotAudience({ city, filters = {}, sourceRecords, residents }) {
  const savedFilters = {};
  if (Number.isInteger(filters.age)) savedFilters.age = filters.age;
  if (Number.isInteger(filters.puma)) savedFilters.puma = filters.puma;
  if (filters.occupation) savedFilters.occupation = filters.occupation;
  if (filters.education) savedFilters.education = filters.education;
  return Object.freeze({
    city: city?.display || "Selected city",
    area: city?.neighborhoods?.find((area) => Number(area.puma) === filters.puma)?.label || null,
    filters: Object.freeze(savedFilters),
    sourceRecords: count(sourceRecords),
    residents: count(residents),
  });
}

export function describeAudience(audience) {
  if (!audience) return {
    title: "Audience definition unavailable", qualification: "", location: "",
    filterCount: 0, scope: "this sample", label: "Sampled audience",
  };
  const f = audience.filters || {};
  const filterCount = Object.keys(f).length;
  const noun = OCCUPATIONS[f.occupation] || "residents";
  let title = Number.isInteger(f.age) ? `${f.age}-year-old ${noun}` : noun;
  title = filterCount ? title[0].toUpperCase() + title.slice(1) : `${audience.city} residents`;
  const location = f.puma
    ? `${audience.area || `Census area ${f.puma}`} · ${audience.city}`
    : `Across ${audience.city}`;
  return {
    title, location, filterCount,
    qualification: EDUCATION[f.education] || "",
    scope: filterCount ? "this filtered audience" : "this city sample",
    label: filterCount ? "Filtered audience" : "Whole-city audience",
  };
}

export function audienceHeader(audience, sampleSize) {
  const info = describeAudience(audience);
  const n = count(sampleSize) ?? audience?.residents;
  const source = audience?.sourceRecords;
  const sourceKnown = source != null;
  const thin = sourceKnown && source < 100;
  let basis = "Responses are simulated from Census data. Percentages describe this sample.";
  if (source === 1) {
    basis = "All simulated residents come from one matching Census record. Broaden the filters to include more source data.";
  } else if (thin) {
    basis = `Small audience: only ${format(source)} matching Census ${source === 1 ? "record" : "records"}. Each one is polled individually and the interval reflects that; read the result as directional.`;
  } else if (sourceKnown && n > source) {
    basis = "Census records are reused to generate this sample. Simulated residents are not separate survey respondents.";
  }
  return `<section class="res-audience" aria-label="Audience for this result">
    <div class="audience-eyebrow"><span>${info.label}</span>${info.filterCount ? `<span class="audience-badge">${info.filterCount} filters applied</span>` : ""}</div>
    <h2 class="audience-title">${escape(info.title)}</h2>
    ${info.qualification ? `<p class="audience-qualification">${escape(info.qualification)}</p>` : ""}
    ${info.location ? `<p class="audience-location">${escape(info.location)}</p>` : ""}
    <div class="audience-sample" aria-label="Sample basis">
      <div><strong>${n == null ? "Unknown" : format(n)}</strong><span>simulated residents in ${info.filterCount ? "this audience" : "this sample"}</span></div>
      <div><strong>${sourceKnown ? format(source) : "Unavailable"}</strong><span>matching Census ${source === 1 ? "record" : "records"} available</span></div>
    </div>
    <p class="audience-basis${thin ? " audience-basis--limited" : ""}">${escape(basis)}</p>
  </section>`;
}

export function audienceScope(audience) {
  return `Percentages within ${describeAudience(audience).scope}`;
}
