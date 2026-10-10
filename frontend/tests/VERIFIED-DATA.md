# Verified data frontend — schema 1.0

This frontend-only change is based on `be91d3dadf6481a3a52078c2ccfc69d4ead5f07c` on local branch `codex/verified-data-frontend`. It does not change Rust, source datasets, production configuration, or `main`.

## Statistical contract and boundaries

The mode selector explicitly separates **Simulation prediction** from **Verified data**. Verified questions POST `{city, question}` to `/data-query`. They never call the prediction parser, create a prediction branch, run a poll, or fall back to simulated results. The statistical path remains usable if simulation creation fails. The explicit offline simulation demo returns an unsupported statistical response rather than using a saved chart to answer arbitrary questions.

`fixtures/verified-data-contract.json` and `fixtures/verified-data-unsupported.json` exercise the user-supplied frozen response schema. Field names are used exactly: `query_spec.schema_version`, `chart.series[].map_filter`, `source.url`, and the supplied geography/method fields. There are no provenance aliases or label-derived predicates. These fixtures contain intentionally invented test values and hashes, clearly identified as fixtures; they are not evidence about Census estimates. Runtime production code never imports them.

The chart uses the backend's `value`, `weighted_population`, and `raw_records`. A percent value is 0–100 and is drawn on a fixed 0–100 scale. Source statistics are accepted only for an `ok` schema 1.0 response describing the complete committed PUMS snapshot and explicitly excluding synthetic residents. The frontend does not recompute source statistics from its resident sample.

Each bar's `map_filter` is evaluated against canonical resident segments, preserving its AND/OR operator. Combining bars ORs these predicates and deduplicates residents. Cross-tab and geography keys remain byte-for-byte canonical. Missing map metadata, a missing/invalid filter, or a city mismatch produces an Unknown map count without inventing matches. Potentially overlapping bars retain their separate source estimates and raw-record counts; no combined source statistic is inferred. The map's internal synthetic weight totals are never displayed as real statistics in this mode.

The **Verified source data** label requires backend `verification_status: "verified"`, complete dataset/vintage/retrieval/snapshot/weight metadata, a safe HTTPS Census source URL, both SHA-256 fields, geographic coverage, complete methodology, and an explicitly supplied limitations array (which may be empty). The frontend checks metadata completeness and digest syntax; the backend is responsible for validating the official source and actual digest values. Missing provenance shows **Unknown**. A null license stays Unknown. Unsupported, malformed, unavailable, and network-error responses never receive an invented chart.

## Interaction and regression coverage

Native radio inputs, buttons and a Submit button support keyboard and touch. Bars expose accessible names and pressed state; a persistent live region announces the distinct counts. Arrow keys navigate, Enter/Space select, Shift adds, Combine enables touch OR selection, and Escape/Clear resets. Green frames highlight matching sprites while nonmatches dim. Selection does not add animation. Mode changes, dismissal, another question, and city changes clear the selection; request IDs and cancellation prevent stale responses from returning. Existing simulation chart, A/B, marketing, resident inspection, reduced-motion and forced-color behavior is covered by the regression scripts.

Browser testing uncovered a composer race: clearing the textarea in the next animation frame could erase text entered immediately after opening. Clearing now happens synchronously; deferred focus cannot erase typed input.

## Reproduce

From the worktree root:

```sh
node --test frontend/tests/*.test.mjs
python3 -m http.server 5194 --bind 127.0.0.1 --directory frontend
```

In another terminal, from `frontend/`, with an installed Playwright CLI (or the Codex skill wrapper):

```sh
PLAYWRIGHT_CLI=/path/to/playwright_cli.sh \
SIMTRA_TEST_BASE=http://localhost:5194 \
node tests/run-browser-tests.mjs
```

The browser runner executes the existing simulation and touch scripts, the verified-data script, and the verified-data script in a touch-enabled mobile context with actual bar/Combine taps. All application API traffic is fulfilled locally; no model calls or source-data queries reach production. Results and mobile screenshots are saved to ignored `frontend/output/playwright/`.

Validation for the final change: 59 Node tests passed; browser results are recorded by the runner (24 simulation, 5 simulation touch, 8 verified desktop, 8 verified touch). JavaScript syntax checks and `git diff --check` passed. Browser assertions verify actual canvas drawing, DOM semantics, fixed fixtures and viewport geometry. No human screen-reader session, physical device, live dataset/hash verification, or deployed backend integration is claimed.
