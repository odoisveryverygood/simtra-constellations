// Frozen /data-query schema 1.0. Only backend map_filter predicates select
// synthetic residents. Source statistics never use the resident index or weights.
import { escapeHtml as esc, safeSourceUrl, bindEvidenceChart,
  reduceEvidenceSelection } from './evidence-chart.js';
import { SEGMENT_DIMENSIONS, createSegmentIndex, selectSegments } from './segment-selection.js';

const obj = (x) => x && typeof x === 'object' && !Array.isArray(x) ? x : {};
const text = (x) => typeof x === 'string' ? x.trim() : '';
const nonnegative = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const stringList = (x) => Array.isArray(x) && x.every(v => typeof v === 'string');
const hash = (x) => typeof x === 'string' && /^[a-f0-9]{64}$/i.test(x);
const present = (x) => text(x) && !/^(unknown|unverified|n\/a)$/i.test(text(x));
export const formatDataNumber = (x) => nonnegative(x) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(x) : 'Unknown';
export const UNVERIFIABLE = 'This question cannot be verified with the available datasets';

function validFilter(filter) {
  return ['and', 'or'].includes(filter?.operator) && Array.isArray(filter?.clauses) &&
    filter.clauses.length > 0 && filter.clauses.every(c => SEGMENT_DIMENSIONS.includes(c?.dimension) && text(c?.key));
}
function officialSource(url) {
  const safe = safeSourceUrl(url);
  if (!safe) return null;
  const parsed = new URL(safe);
  return parsed.protocol === 'https:' && (parsed.hostname === 'census.gov' || parsed.hostname.endsWith('.census.gov')) ? safe : null;
}

export function buildVerifiedDataModel(response) {
  const r = obj(response), chart = obj(r.chart), spec = obj(r.query_spec), source = obj(r.source);
  const geography = obj(r.geography), method = obj(r.method);
  const rows = Array.isArray(chart.series) ? chart.series : [];
  const schema = spec.schema_version === '1.0' && spec.mode === 'verified_data' &&
    ['share', 'count', 'distribution'].includes(spec.intent) && present(spec.universe) &&
    SEGMENT_DIMENSIONS.includes(spec.group_by) && spec.weight_field === 'PWGTP';
  const fullSnapshot = method.estimator === 'sum_of_person_weights' &&
    method.scope === 'complete_committed_pums_snapshot' && method.weight_field === 'PWGTP' &&
    method.synthetic_residents_used === false;
  const validRows = rows.length > 0 && rows.every(s => text(s?.key) && text(s?.label) &&
    nonnegative(s?.value) && (chart.unit !== 'percent' || s.value <= 100) && nonnegative(s?.weighted_population) &&
    Number.isSafeInteger(s?.raw_records) && s.raw_records >= 0) && new Set(rows.map(s => s.key)).size === rows.length;
  const available = r.status === 'ok' && schema && fullSnapshot && chart.type === 'bar' &&
    ['percent', 'people', 'persons', 'weighted_population'].includes(chart.unit) && validRows && !!text(r.answer);
  const completeGeography = ['city_slug','label','state_fips','coverage_type'].every(k => present(geography[k])) &&
    stringList(geography.puma_codes) && geography.puma_codes.length > 0 &&
    typeof geography.exact_city_boundary === 'boolean' && stringList(geography.limitations);
  const completeMethod = fullSnapshot && nonnegative(method.numerator_weighted) && nonnegative(method.denominator_weighted) &&
    present(method.formula) && Number.isInteger(method.rounding_digits) && method.rounding_digits >= 0;
  const verified = available && source.verification_status === 'verified' &&
    ['provider','dataset','vintage','local_snapshot'].every(k => present(source[k])) &&
    officialSource(source.url) && /^\d{4}-\d{2}-\d{2}T/.test(source.retrieved_at || '') &&
    Number.isFinite(Date.parse(source.retrieved_at)) && source.weight_field === 'PWGTP' &&
    hash(source.raw_sha256) && hash(source.snapshot_sha256) && completeGeography && completeMethod && stringList(r.limitations);
  const normalizedRows = available ? rows.map(s => ({key:s.key,label:s.label,value:s.value,
    weighted_population:s.weighted_population,raw_records:s.raw_records,
    map_filter:validFilter(s.map_filter) ? {operator:s.map_filter.operator,clauses:s.map_filter.clauses.map(c => ({dimension:c.dimension,key:c.key}))} : null})) : [];
  return {
    available, unsupported:r.status === 'unsupported', question:text(r.question),
    answer:available ? text(r.answer) : '', title:text(chart.title), unit:text(chart.unit), rows:normalizedRows,
    // Internal button identity only; never interpreted as a demographic predicate.
    dimension:'verified_bar', breakdowns:available ? [{dimension:'verified_bar',groups:rows.map(s => ({dimension:'verified_bar',key:s.key}))}] : [],
    truthLabel:verified ? 'Verified source data' : 'Unknown', source:{...source}, geography:{...geography}, method:{...method},
    limitations:stringList(r.limitations) ? [...r.limitations] : null,
  };
}

export function verifiedMapSelection(model, selection, residents, citySlug) {
  const chosen = model.rows.filter(row => (selection.segments || []).some(s => s.key === row.key));
  const filters = chosen.map(row => row.map_filter);
  const dimensions = filters.flatMap(f => f?.clauses.map(c => c.dimension) || []);
  const ready = model.available && (!citySlug || model.geography.city_slug === citySlug) && residents.length > 0 &&
    filters.every(Boolean) && residents.every(r => dimensions.every(d => typeof r.segments?.[d] === 'string'));
  if (!chosen.length || !ready) return {ready,selection:null,count:ready ? residents.length : null};
  // OR across selected bars; each bar preserves its own AND/OR predicate.
  const filter = {groups:filters};
  const result = selectSegments(createSegmentIndex(residents), filter);
  return {ready,count:result.summary.rawMatchingAgents,selection:filter};
}

export function verifiedSelectionSummary(model, selection, mapCount) {
  const chosen = model.rows.filter(row => (selection.segments || []).some(s => s.key === row.key));
  const statistics = chosen.length ? chosen.map(row => `${row.label} — Full PUMS weighted estimate: ${formatDataNumber(row.weighted_population)}; Full PUMS raw-record count: ${formatDataNumber(row.raw_records)}.`).join(' ') :
    'Select a bar to inspect its Full PUMS weighted estimate and Full PUMS raw-record count.';
  return `${statistics} Matching synthetic-map resident count: ${formatDataNumber(mapCount)}${chosen.length ? ' (selected bars combined with OR)' : ' (no filter)'}.`;
}

export function renderVerifiedData(model, selection = {segments:[]}, mapCount = null, mapReady = false) {
  const source = model.source || {};
  const url = officialSource(source.url);
  const fields = [
    ['Provider', source.provider], ['Dataset name', source.dataset], ['Vintage', source.vintage],
    ['Official source link', url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>` : 'Unknown', true],
    ['Retrieval date', source.retrieved_at], ['Geographic coverage', [model.geography.label, model.geography.city_slug, model.geography.state_fips ? `State FIPS ${model.geography.state_fips}` : '', Array.isArray(model.geography.puma_codes) ? `PUMAs ${model.geography.puma_codes.join(', ')}` : '', model.geography.coverage_type, typeof model.geography.exact_city_boundary === 'boolean' ? `Exact city boundary: ${model.geography.exact_city_boundary ? 'yes' : 'no'}` : ''].filter(Boolean).join('; ')],
    ['Methodology', ['estimator','scope','weight_field','numerator_weighted','denominator_weighted','formula','rounding_digits','synthetic_residents_used'].map(key => `${key.replaceAll('_',' ')}: ${model.method[key] == null ? 'Unknown' : model.method[key]}`).join('; ')], ['Local snapshot', source.local_snapshot], ['Weight field', source.weight_field], ['Raw source SHA-256', source.raw_sha256], ['Snapshot SHA-256', source.snapshot_sha256], ['License', source.license],
  ];
  const max = model.unit === "percent" ? 100 : Math.max(0, ...model.rows.map(r => r.value));
  return `<section id="verified-panel" class="evidence-chart" aria-label="Verified data result">
    <h2 tabindex="-1" id="verified-heading">${esc(model.question || 'Verified data')}</h2>
    <p><strong>${esc(model.truthLabel)}</strong></p>
    ${model.available ? `<p class="verified-answer">${esc(model.answer)}</p>
      <p>These estimates come from the complete PUMS snapshot, using survey weights. Synthetic map residents illustrate matching groups; they are not the source of the statistic.</p>
      <h3>${esc(model.title)} (${esc(model.unit)})</h3>
      <p>Chart scale: 0–${formatDataNumber(max)} ${esc(model.unit)}.</p>
      <p>Click, tap, Enter or Space selects a bar. Shift adds groups with OR. Arrow keys move between bars. Escape clears.</p>
      <label class="combine-control"><input type="checkbox" id="verified-combine"> Combine groups (OR)</label>
      <button type="button" data-evidence-action="clear">Clear selection</button>
      <p role="status" aria-live="polite" aria-atomic="true" data-verified-summary>${esc(verifiedSelectionSummary(model, selection, mapCount))}</p>
      ${!mapReady ? '<p>Unknown — matching synthetic-map counts unavailable because canonical map metadata or query filters are unavailable.</p>' : ''}
      <div class="verified-bars" role="group" aria-label="Full PUMS weighted estimates">${model.rows.map(row => {
        const active = selection.segments.some(s => s.key === row.key);
        const label = `${row.label}: ${formatDataNumber(row.value)} ${model.unit}. Full PUMS weighted estimate: ${formatDataNumber(row.weighted_population)}. Full PUMS raw-record count: ${formatDataNumber(row.raw_records)}.`;
        return `<button type="button" data-dimension="${esc(model.dimension)}" data-key="${esc(row.key)}" aria-pressed="${active}" aria-label="${esc(label)}">
          <span>${active ? '✓ Selected: ' : 'Select: '}${esc(row.label)}</span>
          <span>${formatDataNumber(row.value)} ${esc(model.unit)}</span>
          <span class="verified-track" aria-hidden="true"><span style="width:${model.unit === 'percent' ? row.value : max ? row.value / max * 100 : 0}%"></span></span>
          <span>Full PUMS weighted estimate: ${formatDataNumber(row.weighted_population)}</span>
          <span>Full PUMS raw-record count: ${formatDataNumber(row.raw_records)}</span>
        </button>`;
      }).join('')}</div>` : `<p role="status">${model.unsupported ? UNVERIFIABLE : 'Unknown — a complete statistical response is unavailable. No chart can be shown.'}</p>`}
    <h3>Dataset provenance</h3><dl>${fields.map(([label,value,html]) => `<dt>${label}</dt><dd>${html ? value : esc(value || 'Unknown')}</dd>`).join('')}
    <dt>Limitations</dt><dd>${model.limitations === null ? 'Unknown' : model.limitations.length ? model.limitations.map(esc).join('; ') : 'No additional limitations supplied'}<br>${Array.isArray(model.geography.limitations) ? model.geography.limitations.map(esc).join('; ') : 'Geographic limitations: Unknown'}</dd></dl>
  </section>`;
}

export { bindEvidenceChart as bindVerifiedData, reduceEvidenceSelection as reduceVerifiedSelection };
