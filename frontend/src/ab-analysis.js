// ─────────────────────────────────────────────────────────────────────────
// A/B advanced breakdown · pure analysis
//
// No DOM, no app state — just the reshaping between the `/ab-test` response and
// what the result card draws. Kept separate so it can be exercised directly.
// ─────────────────────────────────────────────────────────────────────────

/** Composite-key separator used by cross-tab group keys (`hispanic|q1`). */
export const AB_CROSS_KEY_SEP = "|";

/**
 * Segments thinner than this still appear in their dimension list, but are never
 * ranked as a "top mover" — small cells swing wildly and would dominate.
 */
export const AB_MIN_SEGMENT_N = 20;
export const AB_TOP_MOVERS = 6;

export const isCrossBreakdown = (breakdown) => (breakdown?.kind || "single") === "cross";

/** Dimension-name separator for an intersectional cut (`race_x_income`). */
const CROSS_DIM_SEP = "_x_";

/**
 * Normalize breakdowns to one shape.
 *
 * `/ab-test` already maps each group to `a_share`/`b_share` and tags the
 * breakdown with `kind`/`axes`. `/poll` serializes the engine type directly, so
 * groups arrive as a raw `shares` array with no kind. Accept either.
 */
export function normalizeBreakdowns(raw) {
  return (raw || []).map((breakdown) => {
    const axisSplit = String(breakdown.dimension || "").split(CROSS_DIM_SEP);
    const isCross = axisSplit.length === 2;
    return {
      dimension: breakdown.dimension,
      kind: breakdown.kind || (isCross ? "cross" : "single"),
      axes: breakdown.axes || (isCross ? axisSplit : undefined),
      groups: (breakdown.groups || []).map((group) => ({
        key: group.key,
        a_share: group.a_share ?? group.shares?.[0] ?? 0,
        b_share: group.b_share ?? group.shares?.[1] ?? 0,
        weight: group.weight || 0,
        n: group.n || 0,
      })),
    };
  });
}

/**
 * Flatten every breakdown group into one comparable segment list, annotated with
 * its swing against the city-wide A share. `swingPp > 0` means the segment leans
 * more toward Variant A than the population as a whole.
 *
 * @param {Array} breakdowns  `breakdowns` from the /ab-test response
 * @param {number} overallAShare  city-wide Variant A share, 0..1
 * @param {(breakdown, key) => string} labelFor  produces a display label per group
 */
export function abSegments(breakdowns, overallAShare, labelFor) {
  return (breakdowns || []).flatMap((breakdown) =>
    (breakdown.groups || []).map((group) => ({
      dimension: breakdown.dimension,
      kind: breakdown.kind || "single",
      key: group.key,
      label: labelFor(breakdown, group.key),
      aShare: group.a_share,
      bShare: group.b_share,
      weight: group.weight || 0,
      n: group.n || 0,
      swingPp: (group.a_share - overallAShare) * 100,
    })));
}

/**
 * Segments that diverge most from the overall result, biggest gap first. Ties
 * break on label so the ranking is stable for identical inputs.
 */
export function abTopMovers(segments, limit = AB_TOP_MOVERS, minN = AB_MIN_SEGMENT_N) {
  return (segments || [])
    .filter((segment) => segment.n >= minN)
    .slice()
    .sort((a, b) => Math.abs(b.swingPp) - Math.abs(a.swingPp) || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/**
 * Reshape a cross-tab breakdown into a dense matrix. Row/column order follows the
 * backend's canonical group order, so the matrix reads the same way every run.
 * Cells absent from the response stay absent — callers render them as empty.
 */
export function abCrossMatrix(breakdown) {
  const rows = [];
  const cols = [];
  const cells = new Map();
  for (const group of breakdown?.groups || []) {
    const [row, col] = String(group.key).split(AB_CROSS_KEY_SEP);
    if (!rows.includes(row)) rows.push(row);
    if (!cols.includes(col)) cols.push(col);
    cells.set(`${row}${AB_CROSS_KEY_SEP}${col}`, group);
  }
  return { rows, cols, cells };
}

/**
 * Intensity of a heatmap cell's tint. The ceiling is deliberately low: the cell
 * carries dark text, and a heavier wash drops it below readable contrast.
 */
export function abLeanAlpha(swingPp) {
  const SATURATE_AT_PP = 18;
  const MAX_TINT = 0.42;
  return 0.08 + (MAX_TINT - 0.08) * Math.min(1, Math.abs(swingPp) / SATURATE_AT_PP);
}

export const pct = (value) => Math.round((Number(value) || 0) * 100);

/** Signed percentage-point label; uses ± for an exact zero so it never reads bare. */
export const signedPp = (points) =>
  `${points > 0 ? "+" : points < 0 ? "−" : "±"}${Math.abs(points).toFixed(1)}`;
