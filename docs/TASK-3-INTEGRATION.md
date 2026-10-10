# City result integration

Simtra stays a single city experience. Prediction and A/B results automatically reveal a bounded layer of illustrative resident connections on the existing map. The city keeps all residents, motion, pan/zoom, inspection, and its original weighted result card. A small Show/Hide connections control appears only with a result. Dismissal, a new question, city changes, and verified-data queries clear connections.

Teammate B's model supplies weighted aggregate shares and illustrative memberships. Teammate A's normalization and rendering budgets are reused by `city-constellations.js`; A's standalone sky renderer remains available in its development harness. No real friendship or independent resident-vote claim is made. The notice reports the actual loaded sample size and explicitly labels offline fixtures.

The renderer draws at most 240 highlights on desktop / 110 on mobile and 60 short lines, retaining the complete city population. Connections use current projected resident positions and follow camera changes. Existing reduced-motion behavior is retained.

Integration PR #5 depends on teammate PRs #4 and #6. Test all three together before merging. No new provider, backend, or paid per-resident calls are added.

Validation: 103 frontend tests pass in the combined local branch, including 10,000-resident drawing bounds, lifecycle reset, and deterministic selection. Live Jev A/B verification remains a separate pending check recorded by teammate B.
