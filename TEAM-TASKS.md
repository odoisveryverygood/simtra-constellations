# Crafting Constellations — three-person build split

Starting point: existing Simtra, copied into this independent repository. The constellation feature is not implemented. Keep the city UI and prediction behavior intact.

## Teammate A — constellation renderer and resident interactions

Own `frontend/src/constellations.js` (new) and `frontend/constellations.css` (new). Build an optional starfield canvas view with glowing resident stars, bounded connections, grouped layouts, readable labels, and click-to-inspect synthetic personas. Respect reduced motion, resize, and mobile layouts. Draw a bounded representative subset to keep performance predictable; retain the full population.

Export `initConstellations(map, state)` returning `{ setActive(active), setResult(model), destroy() }`. Do not edit `app.js`, `config.js`, or `index.html`; the owner will integrate those. Input model: `{ question, groups: [{ id, label, share, members }], illustrative: true }`. Use stub inputs during development and label them as mock data. Acceptance: standalone renderer responds to fixtures, star clicks work, resizing works, city renderer remains untouched.

## Teammate B — response grouping and Jev A/B flow

Own `frontend/src/constellation-model.js` (new), `frontend/src/api.js`, and any needed backend changes under `crates/sim-core/src/`. Build `buildConstellationModel(residents, result)` to transform actual prediction/A/B output into the agreed groups. Keep survey weighting and aggregate shares intact. Existing aggregate outputs do not establish individual independent votes: mark illustrative individual placements and never imply actual social relationships.

Verify TypeSafe/Jev typed A/B comparisons against the local backend with your own private key. Keep Gemini for free-text parsing and ordinary predictions. Pass an explicit Jev model only to supported A/B paths; do not select Jev globally for text generation. Existing Jev budget is 36 archetypes; surface budget errors clearly. Return group labels, shares, explanations where supported, and synthetic persona metadata. Do not edit `app.js`, `config.js`, `index.html`, or A's renderer. Acceptance: real A/B result uses Jev, result provenance is visible, missing keys and budget errors are handled, grouping is tested with both prediction and A/B payloads.

## You — integration, city-preserving UX, and demo

Own `frontend/src/app.js`, `frontend/src/config.js`, `frontend/index.html`, and demo/pitch materials. Add City / Constellations toggle; initialize A's renderer and feed B's model after successful predictions or A/B comparisons. Restore the original city immediately when toggled back. Keep city switching, resident movement, demographic charts, and the prediction composer working. Separate Gemini prediction configuration from Jev A/B configuration.

Demo: ask a question → inspect shared opinion patterns → compare messages → explore a resident → return to the same city. State that residents and results are simulated. Pitch: Simtra connects simulated community perspectives into constellations of shared beliefs.

## Collaboration

A branch: `teammate-a/constellation-view`; B branch: `teammate-b/jev-grouping`; your branch: `integration/city-constellations`. Open PRs against main. Agree on the model above before changing it. Never commit `.env`, keys, state/cache databases, or local logs. Each teammate supplies their own credentials privately. GitHub issues track each workstream; named GitHub assignees require the teammates' usernames.
