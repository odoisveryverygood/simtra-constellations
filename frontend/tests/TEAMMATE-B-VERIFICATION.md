# Teammate B verification

Implemented `buildConstellationModel(residents, result)` in `src/constellation-model.js`.
It accepts binary `p_yes`, option `p_distribution`, and A/B `a_share` / `b_share`
responses. Backend survey-weighted shares are retained exactly. Every supplied
resident is retained with its metadata; membership is deterministic and explicitly
illustrative. Star counts are not weighted estimates or independent votes.
Sample rationales are exposed only at aggregate level, not attributed to residents.
Provenance carries the returned model, date, memory test id, and fixture status.

`api.abTest` defaults to `jev-latest` only when no model is supplied; an explicit
model remains supported. Integration must pass `{ ...payload, model: "jev-latest" }`
for Jev comparisons, independently of the Gemini prediction configuration.
No changes were made to app.js, config.js, index.html, or Teammate A's renderer.
The API no longer replaces 404 errors with saved preview results. Explicit offline
`?demo=1` fixtures are still available and identify their model as `offline-fixture`.

The existing backend typed Jev adapter is retained, including fail-closed response
validation, missing-key checks, the 36-archetype limit, and no automatic retries.

Validated locally:

```
node --test frontend/tests/*.test.mjs frontend/src/audience.test.mjs
```

80 tests passed, including 7 new grouping/client tests. Client transport tests
use mocked fetch; they do not verify TypeSafe access or a live backend.

Remaining acceptance check: a real local-backend A/B run. This environment has
no TYPESAFE_API_KEY and no cargo executable. No external model requests were made.
With a privately configured key and Rust available, start the local backend using
the repository's server instructions, create a simulation and branch, then POST
an A/B request to `/branches/<branch>/ab-test` with `model: "jev-latest"` and a
panel within 36 archetypes. Confirm the returned model is `jev-latest`, preserve
returned weighted shares, and feed that response into the grouping function.
Do not claim live verification from fixture or mocked transport results.
