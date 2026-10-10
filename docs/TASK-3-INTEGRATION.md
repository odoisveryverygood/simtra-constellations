# Task 3 integration handoff

Branch: `integration/city-constellations`. The city interface remains the default. Task 3 owns the view toggle, lifecycle bridge, prediction configuration, and demo. A and B retain their existing file ownership.

## Renderer contract — teammate A

`frontend/src/constellations.js` exports `initConstellations(map, state)` synchronously, returning `{ setActive(boolean), setResult(modelOrNull), destroy() }`. `setActive` may return a Promise. Initialization must leave the renderer hidden; `setActive(false)` must hide its canvas and overlays. `destroy()` must remove listeners/animation loops. Scope styles to your renderer, not the existing city UI. The integration loads `frontend/constellations.css` when your module loads. Do not create your own City/Constellations toggle.

`setResult(null)` means clear the prior question and all group assignments. Show resident stars without response group claims, or a neutral invitation to ask a question. The shared `map` and `state` references change as cities/audiences load. Refresh your star sample from `state.rawResidents` on activation; do not retain the old city's population. The integration hides the city canvas only after your activation succeeds. Keep your canvas behind `#ui` so the prediction composer remains usable. Integration owns the explanatory caption and global active class `simtra-constellations-active`.

## Model contract — teammate B

`frontend/src/constellation-model.js` exports synchronous `buildConstellationModel(residents, result)`. Result is the actual successful prediction or A/B payload with `audience` included. Return `{ question, groups: [{ id, label, share, members }], illustrative: true }`. Preserve weighted aggregate shares from the backend; do not recompute the headline share from synthetic resident counts. Agree with A whether `members` contains resident objects or stable IDs before merging.

The bridge hydrates the latest result when the view opens, updates when predictions/A/B succeed, and clears on city/audience reload or a verified Census result. Marketing counterfactuals are deliberately excluded until B supports their two-leg semantics.

Config: `PREDICT.model` selects free-text parsing/ordinary predictions. `PREDICT.ab_model` selects A/B only, default `jev-latest` (the actual Rust parser identifier). `?ab_model=gemini-3.5-flash-lite` explicitly overrides A/B for diagnosis. Do not globally switch `?model=jev-latest`; Jev does not generate parser text. B still owns verifying actual Jev completion, archetype budget handling, and any backend/API fixes.

## Current verification boundary

Task 3's unit tests exercise activation, return to city, latest-result hydration, city-reset races, missing modules, and renderer failures. The teammate files are not on this branch, so a full constellation experience cannot be certified until both teammates' PRs are merged. Missing files produce a short notice while the city stays usable; they do not silently substitute fake results.

Run `node --test frontend/tests/*.test.mjs`. Frontend preview: `python3 -m http.server 15175 --bind 127.0.0.1 --directory frontend`; use `http://localhost:15175/?backend=local&port=8088&motion=on` with a backend on 8088. No secrets are included.

Verified: all 76 frontend tests passed. Browser contract tests with isolated, non-shipping fixtures verified activation, propagation of the latest question, and return to the city without clearing the composer. The real branch was checked with missing teammate modules to verify the safe fallback. This is integration verification, not certification of A/B provider completion or the final teammate renderer.
