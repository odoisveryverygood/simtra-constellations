# Simtra interactive evidence integration

Integration checkout: `/Users/aradhyamishra/Documents/ChatGPT/hackathon/simtra-evidence-chart`.
Local branch: `aradhya`. No push, deployment, or modification of `main` was performed.

## Reviewed lane inputs and Git handling

All three source commits have parent `eca0073ab0fb177824edf2d84401e427b53c57b3`:

| Lane | Reviewed source SHA | Cherry-pick on integration branch |
| --- | --- | --- |
| Backend | `871274dd327c37bf8b9a208c90e754728b7b1893` | `c97a682` |
| Map | `c0128fe5abc3112f55fcff06814677b89597e3d0` | `0c3a59a` |
| Chart | `66bdb949fd37a5eefe2658c4c5324e9632cb7d43` | `75c3873` |

The backend and map lane task handoffs and local commits were inspected before integration. Both source worktrees were clean. All cherry-picks succeeded without conflicts. Git cannot hold both `aradhya` and `aradhya/evidence-chart` in one repository, so the original chart pointer was preserved by renaming it to `codex/evidence-chart`, then `aradhya` was created at the required base. No lane work was discarded.

## Behavior

Normal questions retain the existing parse, prediction and map reveal flow. Every result mode adds an expandable demographic evidence chart. Binary and multi-option modes use PollResult breakdowns directly; A/B adapts its existing transport; counterfactual uses the exposed arm. The chart and map share canonical demographic keys. Multiple clauses combine with explicitly labeled OR, with deduplicated raw resident and original PWGTP totals. Clear and exact active-rule totals remain visible while scrolling the chart.

Selecting a map resident focuses its group in the active chart dimension. A labeled resident selector provides keyboard/screen-reader access to the same action. Closing the chart or resident card, dismissal, beginning another question, city changes and branch deletion clear selection. Missing resident keys/weights disable exact matching and display unknown counts.

Truth labels distinguish Census/PUMS demographic inputs, synthetic residents, model-based poll outcomes and contextual Hydra sources. Missing vintage, URL, retrieval time and license are not invented. Original PWGTP selection totals can differ from poll-response weights because of eligibility, turnout weighting or unanswered archetypes; the UI states this explicitly.

## Minimal lane-owned fixes, proved by failing tests first

1. `frontend/src/segment-selection.js`: the map initially indexed five dimensions while PollResult/chart exposed fourteen. The integration test failed for Education: actual count/weight `0 / 0`, expected `1 / 125`. Only the canonical dimension list and its complexity comment were extended. All fourteen dimensions and the original map suite now pass.
2. `frontend/src/map.js`: reduced-motion preference was ignored by the draw/reveal pipeline. The integration test observed animation delta `0.05` instead of `0`. Added reduced-motion handling for frozen resident time, immediate camera/reveal/clear, static verdict scale and no breathing/bubble cycling. Existing normal-motion rendering tests still pass; actual browser resident positions/frame clocks remain unchanged under reduced motion.

No backend or chart-lane files were edited after cherry-picking. The before-fix failure output is retained in `integration-evidence.json`.

## Commands and results

Rust was available at `/Users/aradhyamishra/.rustup/toolchains/stable-aarch64-apple-darwin/bin`, outside the original PATH. This directory was prepended only for test/build processes. Existing backend target artifacts were reused through `CARGO_TARGET_DIR`; compiled code came from this integration checkout. `CONTRACT_BASE_URL` was unset. Contract tests use loopback fixtures and disable external integrations.

| Command | Result |
| --- | --- |
| `node --test frontend/tests/*.test.mjs` | Exit 0, 43 passed: chart 25, map 13, integration 5 |
| `cargo fmt --check` | Exit 1; 44 files fail, each byte-identical to required base |
| `cargo test -p sim-core` | Exit 101; no package named sim-core |
| `cargo test --offline -p simfrancisco` | Exit 0; 67 passed |
| `cargo test --offline --workspace` | Exit 0; 162 passed |
| `cargo build --offline --release --locked --bin validate` | Exit 0 |
| `node --check` for modified application JS | Passed |
| `git diff --check` | Passed |
| `python3 -m http.server 5173 --directory frontend` | Static server started and served the browser runs |

The pre-existing formatting failures were deliberately not repaired outside ownership. The nonexistent package command was run as requested, followed by the correct package test. Exact Rust/Node output, formatting file inventory, and browser assertions are in `integration-evidence.json`.

## Actual browser evidence

Chromium was driven with Playwright CLI against `http://localhost:5173/?demo=1`. The 24 main cases and 5 touch/legacy cases all passed. Final runs recorded zero page/console errors and zero external requests. Assertions inspect actual DOM state and instrument the real canvas methods for one frame; they are not screenshot-only checks.

| Case | Functional evidence |
| --- | --- |
| Boot and normal question | Local fixture loaded; all 256 residents received reveal verdicts; map reached results |
| Chart open / Women bar | 117 raw matching residents; PWGTP sum 10,750; DOM totals agree |
| Green and dim canvas rendering | 117 green outline draw calls; 117 full-alpha bodies; 139 dimmed bodies; 256 bodies total |
| Clear | Inactive selection; 256 raw residents; PWGTP 25,388 |
| Women OR Age 25–34 | 148 distinct residents; PWGTP 14,620, independently calculated from raw fixture records |
| Shift-click / Combine checkbox | Both produce the same deduplicated OR union |
| Map resident click | Actual pointer click selects resident's group in active Age dimension and focuses its bar |
| Keyboard | Enter, Space, arrows and Escape work; Escape clears without dismissing the result |
| Focus / screen-reader labels | Visible 3px outline; descriptive accessible label, pressed state and live count summary |
| Lifecycle | Closing chart, dismissing, new question, switching city and deleting branch clear stale selection |
| Result modes | Binary, three-option, A/B and counterfactual cards and evidence charts work |
| Reduced motion | Resident coordinates and frame clocks remain frozen; reveal completes |
| Forced colors | Selected bar retains checkmark, pressed state and 3px border |
| Narrow viewport | 390×844; document width 390; card within viewport, no internal horizontal overflow; segment target height 166px |
| Actual touchscreen | Touch-enabled mobile context: bar tap, Combine tap and Clear tap give exact expected totals |
| Resident selector | Keyboard-accessible resident selection uses active age dimension |
| Legacy resident schema | Missing canonical keys/weights displays unknown counts and disables bars, including cross-tabs, without errors |

Scripts: `browser-smoke.js` and `browser-touch-smoke.js`. Run each with `playwright-cli -s=simtra-integration run-code --filename <script>`. Results are placed on the test page as `window.__smokeEvidence` / `window.__touchEvidence`; CLI `eval` retrieves them. This is test instrumentation, not an application UI dependency.

## Offline fixture and reproduction

Open `http://localhost:5173/?demo=1`. Demo mode makes no external requests; committed map images and the committed evidence fixture are served locally. Production API configuration is unchanged. The regular application also uses local map tiles instead of live satellite sources.

`frontend/fixtures/evidence-demo.json` contains 256 backend-generated synthetic residents per city, original PWGTP values and actual serialized binary/multi-option PollResult breakdowns. Seed is 42. The simulation/poll date `2024-11-01` is a test input, not dataset vintage. The loopback response model returns fixed `[0.6, 0.4]` or `[0.5, 0.3, 0.2]` distributions for every archetype; there are no live model predictions. New questions do not change the saved outcomes. A/B and counterfactual fixture adapters explicitly reuse these test distributions.

Each city fixture includes a SHA-256 of its committed PUMS CSV. Integration tests verify all hashes and every bar's raw count and PWGTP sum against the resident records. No committed PUMS source data was changed.

To reproduce, create a temporary Rust binary package with the same existing `tokio` (1, full), `axum` (0.7), and `serde_json` (1) dependencies and a path dependency on this checkout's `crates/sim-core`. Use `fixture-server.rs` as its main source, set `SIMTRA_FIXTURE_DIR` to an empty temporary directory, and run it from the repository root. It binds only `127.0.0.1:5188`, uses a loopback-only model fixture and disables external integrations. Then run `python3 frontend/tests/export-evidence-fixture.py` and the Node suite. No `.env` is loaded, no paid calls are made, and no source datasets are regenerated.

## Limits and readiness

Ready for Qoder to review and push the local integration, with the two existing check exceptions above explicitly documented. No push was performed. Source vintage, citation URL, retrieval date and license remain unknown where repository metadata cannot establish them. Real-world prediction accuracy and production deployment were not tested. Screen-reader semantics were asserted in the browser; a human screen-reader session and physical mobile device were not used. Touch behavior was exercised in a touch-enabled Chromium context. Cross-browser and physical-device performance are not established.

The final diff contains only the reviewed lane changes, authorized integration files, necessary fixture, integration tests and this evidence. No unrelated source, lockfile, deployment or secret changes were introduced.

## All changed files relative to the required base

- `crates/sim-core/src/api.rs`
- `crates/sim-core/src/evidence.rs`
- `crates/sim-core/src/lib.rs`
- `crates/sim-core/src/predict.rs`
- `crates/sim-core/tests/contract.rs`
- `frontend/fixtures/evidence-demo.json`
- `frontend/index.html`
- `frontend/src/api.js`
- `frontend/src/app.js`
- `frontend/src/evidence-chart.js`
- `frontend/src/map.js`
- `frontend/src/segment-selection.js`
- `frontend/styles.css`
- `frontend/tests/INTEGRATION-EVIDENCE.md`
- `frontend/tests/browser-smoke.js`
- `frontend/tests/browser-touch-smoke.js`
- `frontend/tests/evidence-chart.test.mjs`
- `frontend/tests/evidence-integration.test.mjs`
- `frontend/tests/export-evidence-fixture.py`
- `frontend/tests/fixture-server.rs`
- `frontend/tests/integration-evidence.json`
- `frontend/tests/segment-selection.test.mjs`
