# Local verified-data integration

Integrated only in `simtra-evidence-chart` on existing branch `aradhya` from base
`be91d3dadf6481a3a52078c2ccfc69d4ead5f07c`:

- Backend: `3e331c48b98e9c1b5430dca32e918d79e88d4bc7`
- Frontend: `78555093007dba619067a7e5a5e2a007de16839a`

Both changes applied without conflicts using `git cherry-pick --no-commit`.
No checkout, edit, commit, merge, or push to Git branch `main`; no push or deployment.

## Integration blocker fixed

The completed lanes used incompatible response contracts. The frontend rejected
actual backend results because the backend returned an object answer, different
query/provenance/method fields, and no map filters. The backend now serializes the
frontend's schema 1.0 after its existing integrity verification. Numeric answer
fields remain available as `answer_statistics`; original source arithmetic and
allowlisted questions are unchanged. Source metadata is copied from the validated
manifest, not inferred from filenames or dates.

Only exactly equivalent canonical resident segments receive map predicates.
The under-3 and less-than-high-school source categories cannot be distinguished
by the existing coarser synthetic education segment, so their map count stays
Unknown. Similarly, synthetic income quintiles and simulated tenure do not stand
in for observed source categories. No source bins, data, or resident segments were
changed to hide those limitations.

`actual_backend_responses_satisfy_frontend_contract` invokes the real JS adapter
with 15 newly computed backend responses: education, age and an unsupported
question for each of five cities. It checks source totals, provenance, independent
resident matching, and fail-closed handling. Existing arithmetic/integrity tests
continue to check complete CSVs; expected response fields were updated to the
shared contract.

## Final checks

| Command | Result |
| --- | --- |
| `node --test frontend/tests/*.test.mjs` | Exit 0; 59 passed, 0 failed, 0 skipped |
| `cargo test --offline --workspace` | Exit 0; 169 passed, 0 failed, 0 ignored |
| `cargo build --offline --release --locked --bin validate` | Exit 0 |
| `git diff --check` and `git diff --cached --check` | Exit 0 |

Cargo was initially absent from PATH. The installed stable Rust toolchain at
`/Users/aradhyamishra/.rustup/toolchains/stable-aarch64-apple-darwin/bin` was
prepended for these commands; build artifacts stayed in this checkout's `target`.
The release validator was built, not run. No model credits were spent.
Compiler warnings remain, including a release debug-stripping warning because
`rust-objcopy` could not load `libLLVM.dylib`; Cargo still exited 0 and produced
the release executable. Unrelated toolchain repair/cleanup was not performed.

## Browser checks

The existing runner passed 24 simulation, 5 simulation touch, 8 verified desktop,
and 8 verified touch cases (45 total). These use local contract fixtures and test
keyboard navigation/selection/clear, focus, live announcements, touch selection
and Combine, mobile geometry, forced colors, provenance, unavailable/error states,
stale-response cancellation, count separation and green canvas rendering.

`browser-backend-integration.js` additionally queried the actual local Rust API,
using the existing `fixture-server.rs` helper and 256 newly generated synthetic
residents. No saved statistical responses were used. The static frontend ran on
5194 with `?backend=local&port=5188`. All three cases passed with zero page errors
and exactly three `/data-query` requests; no parse, poll or prediction-branch calls.

| Question / selected bar | Result | Full PUMS weighted estimate | Full PUMS records | Matching synthetic residents / green outlines |
| --- | --- | ---: | ---: | ---: |
| Show the education distribution / bachelor's | 6 bars | 243,007 | 2,672 | 88 / 88 |
| Show the age distribution / age 25–34 | 7 bars | 158,486 | 1,700 | 66 / 66 |
| Who will win the next election? | Unsupported; answer null; no chart | — | — | — |

Both distributions use all 8,485 SF PUMS records and total PWGTP 809,226.
The 256 synthetic residents remain separately labeled. Keyboard Escape, Space,
arrows and Enter passed on actual results; both fit a 390px mobile viewport.
The education mobile screenshot was visually inspected. Green outline counts above were
measured at desktop overview, where every resident is in view; a mobile viewport
can naturally clip sprites without changing the selected resident count.

Reproduce fixture browser tests using `frontend/tests/run-browser-tests.mjs`.
For the real backend check, start the existing local fixture-server helper on
5188 and a static frontend server on 5194, then from `frontend/` run:

```sh
playwright-cli -s=simtra-real-integration open about:blank
playwright-cli -s=simtra-real-integration run-code --filename tests/browser-backend-integration.js
playwright-cli -s=simtra-real-integration close
```

Detailed logs, result JSON and screenshots from this run are local ignored
artifacts in `frontend/output/playwright/`.

## Honest limits retained

2023 ACS estimates over listed PUMA unions; exact municipal boundaries are not
established. No margins of error, historical ingestion timestamps, new datasets,
broader question grammar, or deployment packaging were added. Original archive
ZIPs were not downloaded/re-audited during integration; the optional raw-archive
test returns without auditing when `SIMTRA_CENSUS_RAW_DIR` is unset. Snapshot and
context integrity and complete-CSV arithmetic were tested. Browser accessibility
semantics and emulated touch were checked; no physical-device or human
screen-reader session is claimed.
