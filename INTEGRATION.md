# SF Digital Twin — Frontend Integration Guide

Everything the map/sprite track needs to connect, with zero backend questions.

- **Base URL (production):** `https://sf-digital-twin-tp.fly.dev`
- **Auth:** none for clients. The model API key lives only as a server-side fly secret; you
  never send it. CORS is wide-open (`Access-Control-Allow-Origin: *`), so browser fetch/EventSource work directly.
- **Content type:** all POST bodies are JSON; all responses are JSON except the SSE stream.
- **Health:** `GET /health` → `200` with model/data status, including whether InsForge persistence and RocketRide routing are configured.
- **History:** successful polls are saved server-side in InsForge; `GET /prediction-results?city=sf&limit=25` reads the latest saved results.

The backend is two engines over one persona layer:
1. **Prediction engine** — `persona + as-of-date + event → weighted opinion / vote / market probability`. This is the scored core; it runs without the life-sim.
2. **Life simulation** — schedule-driven movement on the SF grid, collocated chatter, reactions, birth/death. Drives sprites + speech bubbles via the SSE stream.

### Optional RocketRide question routing

`POST /cities/{city}/parse` can use RocketRide as a drop-in question router. The Rust backend posts the raw request to the deployed RocketRide webhook and normalizes its response into the existing `supported`, `framing`, `question`, `description`, `options`, `reason`, and `examples` contract. The frontend and prediction endpoints do not change.

RocketRide is enabled only when `ROCKETRIDE_WEBHOOK_URL` is present. If the webhook times out, returns an error, or returns malformed JSON, the backend logs the failure and calls the existing local model router instead. This keeps the app usable while the pipeline is unavailable.

The importable pipeline template is [`pipelines/question-router.pipe`](pipelines/question-router.pipe). In RocketRide, import/deploy it, configure the LLM profile/key in the pipeline, then copy the generated webhook URL and private token into the server environment:

```bash
ROCKETRIDE_WEBHOOK_URL=https://<rocketride-webhook-url>
ROCKETRIDE_WEBHOOK_TOKEN=<private-token>
```

RocketRide's webhook source receives the request as text, the prompt node adds the router instructions, the LLM emits strict JSON, and the response node returns the answer. The adapter accepts RocketRide's response-lane arrays and JSON-string answers. See the [RocketRide webhook documentation](https://docs.rocketride.org/source/web-hook/) and [response-node documentation](https://docs.rocketride.org/nodes/response/) for the endpoint credentials and response behavior.

---

## 1. Connect in 5 minutes

```js
const BASE = "https://sf-digital-twin-tp.fly.dev";

// 1) create a simulation (synthetic SF population sampled from real Census PUMS)
const sim = await (await fetch(`${BASE}/simulations`, {
  method: "POST", headers: {"content-type": "application/json"},
  body: JSON.stringify({ n: 1200, seed: 42, start_datetime: "2024-11-01T08:00:00Z", tick_seconds: 30 })
})).json();
const simId = sim.simulation_id;                 // e.g. "sim-42-1200-ab12cd34"

// 2) make a branch (optionally apply an event, run some ticks)
const branch = await (await fetch(`${BASE}/simulations/${simId}/branches`, {
  method: "POST", headers: {"content-type": "application/json"},
  body: JSON.stringify({ ticks: 5, event: { text: "A new transit measure is proposed.", progressive_coded: true } })
})).json();
const branchId = branch.branch_id;               // e.g. "sim-42-1200-ab12cd34:b1"

// 3) fetch agent positions for initial sprite placement
const page = await (await fetch(`${BASE}/branches/${branchId}/agents?limit=1000`)).json();
for (const a of page.agents) placeSprite(a.id, a.cell, a.lonlat, a.action);

// 4) live stream (movement, speech bubbles, reactions, births/deaths)
const es = new EventSource(`${BASE}/branches/${branchId}/stream`);
es.addEventListener("agent_moved", e => moveSprite(JSON.parse(e.data)));
es.addEventListener("agent_said",  e => showBubble(JSON.parse(e.data)));
es.addEventListener("agent_reacted", e => showReaction(JSON.parse(e.data)));   // 👍/👎
es.addEventListener("tick", e => setClock(JSON.parse(e.data).iso));

// 5) poll the electorate (weighted, with per-demographic breakdowns + CI)
const poll = await (await fetch(`${BASE}/branches/${branchId}/poll`, {
  method: "POST", headers: {"content-type": "application/json"},
  body: JSON.stringify({ question: "Do you support more public transit funding?", framing: "vote", as_of_date: "2024-11-01" })
})).json();
console.log(poll.p_yes, poll.ci_low, poll.ci_high, poll.breakdowns.age);
```

---

## 2. Coordinate contract (cell ↔ chunk ↔ UTM ↔ lat/long)

The map comes from `tiles.db` (the map track's artifact). Grid facts (from its `manifest`):

| quantity | value |
|---|---|
| chunks | **67 × 60** (cx 0..66 east, cy 0..59 south) |
| cells per chunk | **125 × 125** |
| meters per cell | **2.0** (LOD 0) |
| global cell grid | **8375 × 7500** cells |
| CRS | **UTM Zone 10N (EPSG:32610)** |
| UTM bbox | min (541825.66, 4172447.92) → max (558482.89, 4187293.87) |
| WGS84 bbox | W −122.5247, E −122.3366, S 37.6983, N 37.8312 |

**Cell (0,0) is the NW corner**, anchored at UTM `(min_x, max_y)`. `+x` is east, `+y` is south.

```
# global cell (gx, gy)  ->  UTM (meters), cell CENTER
utm_x = 541825.66 + (gx + 0.5) * 2.0
utm_y = 4187293.87 - (gy + 0.5) * 2.0
# UTM -> lon/lat: standard inverse transverse-Mercator, zone 10N (or just use the
# `lonlat` field the /agents endpoint already returns).

# global cell -> chunk + in-chunk index into the tiles.db collision grid
cx = gx / 125,  cy = gy / 125            # integer division
lx = gx % 125,  ly = gy % 125
collision_index = ly * 125 + lx          # row-major; chunks.collision is a zstd u8[15625]
```

Cost values in `chunks.collision`: `0` free (road/sidewalk/plaza), `1`–`4` increasing terrain
penalty, `8` stairs, `255` blocked (water/buildings/cliffs). Sprites only ever sit on cells with
cost `< 255`; pathfinding (A*) guarantees this.

Every agent in `/agents` includes both `cell: [gx, gy]` and `lonlat: [lon, lat]`, so you can
render in grid space or on a geographic map without doing the projection yourself.

---

## 3. Endpoints

### `GET /health`
```json
{ "status": "ok", "model_reachable": true, "has_key": true,
  "hydra_configured": true, "insforge_configured": true, "rocketride_configured": false,
  "memory_configured": false,
  "map_chunks": 4020, "sf_pums_records": 8485, "usage": { "calls": 0, "cache_hits": 0 } }
```
`model_reachable` is `null` for the first second or two after boot (checked in the background), then `true`/`false`. `memory_configured` is `true` when the Neo4j persona memory layer is enabled (`NEO4J_URI` set to an Aura `neo4j+s://` URI or an `http(s)://` endpoint; see `.env.example`).

### `POST /cities/{city}/events`
Throw an event into the world. Every persona in that city (present and future populations) remembers
it, and it is recalled into subsequent polls whose `as_of_date` is on or after the event date.
Requires the Neo4j memory layer; returns `503 {"error":"persona memory (Neo4j) is not configured"}` otherwise.

Request (`as_of_date` defaults to today, `kind` defaults to `"news"`):
```json
{ "text": "A political figure was shot at a rally downtown.", "as_of_date": "2026-09-10", "kind": "news" }
```
Response `201`:
```json
{ "event": { "id": "evt-9f1c2a3b4d5e6f70", "city": "sf", "kind": "news",
  "text": "A political figure was shot at a rally downtown.", "as_of_date": "2026-09-10",
  "created_at": "2026-09-12T18:04:11Z" } }
```
`404` unknown city; `400` empty text or malformed date.

### `GET /cities/{city}/events?limit=25`
Newest-first list of city-wide events (`limit` capped at 100). `503` when memory is not configured.
```json
{ "events": [ { "id": "evt-...", "city": "sf", "kind": "news", "text": "...", "as_of_date": "2026-09-10", "created_at": "..." } ] }
```

### `GET /branches/{id}/agents/{agent_id}/memory`
One persona's full memory: city events and targeted exposures (`via` is `"city"` or `"exposed"`),
plus every test it answered with the answer its archetype gave. `503` when memory is not configured;
`404` for an unknown branch or agent id.
```json
{ "persona": { "agent_id": 0, "name": "...", "occupation": "...", "neighborhood": "...",
    "archetype": "35-44|white|ba|q3|rent|cit", "population_key": "sf:42:1500" },
  "events": [ { "id": "evt-...", "kind": "news", "text": "...", "as_of_date": "2026-09-10", "via": "city" } ],
  "tests": [ { "id": "test-...", "kind": "poll", "question": "...", "framing": "vote",
    "as_of_date": "2026-09-12", "model": "claude-sonnet-4-6", "population_p_yes": 0.61,
    "my_p_yes": 0.72, "my_dist": [], "why": "cost of living", "options": [],
    "created_at": "...", "stimuli": [], "under_event": null } ] }
```

### `GET /prediction-results`
Returns the latest completed prediction records stored in InsForge's `prediction_results` table.
The optional `city` filter scopes results to one loaded city, and `limit` is capped at 100.

```json
{ "results": [
  { "id": "...", "created_at": "2026-07-28T21:05:00Z", "city": "sf",
    "question": "Do you support more public transit funding?", "framing": "vote",
    "p_yes": 0.64, "ci_low": 0.61, "ci_high": 0.67, "n_agents": 980,
    "hydra_evidence": { "enabled": true, "chunks": 3, "sources": [] } }
] }
```

The poll response is returned immediately even if the persistence request is temporarily unavailable;
the backend logs that condition and keeps the simulation usable. For local development, the linked
`.insforge/project.json` supplies the server-only key automatically. Fly deployments should set:

```bash
fly secrets set INSFORGE_URL=https://<project>.us-west.insforge.app INSFORGE_API_KEY=<server-only-project-key>
```

Never expose `INSFORGE_API_KEY` in frontend code or public environment variables.

### `POST /simulations`
Create a seeded synthetic population sampled from real ACS PUMS microdata for SF County.
```json
// request (all fields optional; defaults shown)
{ "n": 800, "seed": 42, "start_datetime": "2024-11-01T08:00:00Z",
  "tick_seconds": 30, "commit_every": 20, "distributional_params": null }
// response 201
{ "simulation_id": "sim-42-800-ab12cd34", "n": 800,
  "main_branch": "sim-42-800-ab12cd34:main", "start_datetime": "2024-11-01T08:00:00Z" }
```
`n` is clamped to 1..50000. `distributional_params` is accepted and reserved for per-demographic seeding.

### `GET /simulations/{id}/demographics`
Empirical (PUMS-weighted) marginals of the sampled population **vs target ACS marginals**, with
per-variable distance + pass/fail. (At `n ≥ ~1200` everything is within tolerance; small `n` may not be.)
```json
{ "simulation_id": "...", "n_agents": 1200, "total_weight": 485000.0,
  "variables": {
    "age_band": { "empirical": {"25-34": 0.21, ...}, "target_acs": {"25-34": 0.20, ...},
                  "tv_distance": 0.018, "pass": true, "tolerance": 0.05 },
    "race_eth": { ... }, "educ": { ... }, "sex": { ... }, "citizen": { ... } },
  "all_within_tolerance": true }
```

### `POST /simulations/{id}/branches`
Clone main's current state into a new branch, optionally broadcast an event, run `ticks` ticks.
```json
// request
{ "ticks": 20, "mode": "social",
  "event": { "text": "A major public-safety incident dominates the news.", "progressive_coded": false },
  "model": "gpt-4o", "name": "what-if-crime" }
// response 201
{ "branch_id": "sim-...:b1", "name": "what-if-crime", "ticks_run": 20,
  "reactions_emitted": 1198, "event": "A major public-safety incident...",
  "clock": "2024-11-01T08:10:00Z", "tick": 20 }
```
`progressive_coded` controls whether the 👍/👎 reactions skew toward progressive or moderate agents.

### `GET /branches/{id}`
```json
{ "branch_id": "...", "sim_id": "...", "name": "main", "kind": "main", "mode": "clean",
  "status": "ready", "tick": 20, "clock": "2024-11-01T08:10:00Z", "agents_alive": 1200 }
```

### `GET /branches/{id}/agents?filter=...&limit=500&offset=0`
Paginated agent snapshot for sprites. `filter` is `key=value` (comma-separated); keys:
`race`/`race_eth`, `educ`, `age_band`, `puma`, `tenure` (`own`|`rent`), `sex` (`1`|`2`), `religion`.
```json
{ "branch_id": "...", "total_matched": 742, "offset": 0, "count": 500,
  "agents": [
    { "id": 0, "name": "Mei Chen", "action": "commuting", "alive": true,
      "cell": [4210, 1875], "lonlat": [-122.476, 37.781], "neighborhood": "the Sunset",
      "age": 34, "race_eth": "asian", "educ": "graduate",
      "values": { "economic": -0.31, "social": -0.52, "trust": 0.04, "change": 0.12,
                  "s_housing": 0.78, "s_crime": 0.41, "s_homeless": 0.6, "s_cost": 0.82,
                  "s_environment": 0.66, "s_immigration": 0.35 } } ] }
```

### `POST /branches/{id}/poll`
Poll the synthetic electorate. One batched LLM pass per question; agents are archetype-clustered
and post-stratified with PUMS weights.
```json
// request
{ "question": "California Proposition 36 (2024): do you vote YES?",
  "description": "Increases penalties for certain theft/drug crimes. YES = tougher penalties.",
  "framing": "vote",                  // "vote" (their own ballot) | "belief" (forecast an event)
  "as_of_date": "2024-11-04",
  "model": "gpt-4o",                  // gpt-4o | gpt-5.5 | grok-4.3
  "population": "cvap_likely_voter",  // omit for "all"; cvap_likely_voter applies a turnout model
  "event": "optional broadcast event text the agents are aware of" }
// response 200
{ "question": "...", "as_of_date": "2024-11-04", "model": "gpt-4o",
  "p_yes": 0.642, "ci_low": 0.61, "ci_high": 0.67,
  "n_agents": 980, "n_eff": 612.4, "design_effect": 1.6,
  "n_archetypes": 142, "n_llm_calls": 12,
  "breakdowns": { "age": [ {"key":"65+","yes_share":0.71,"weight":120000,"n":210}, ... ],
                  "race": [...], "educ": [...], "income_q": [...], "puma": [...], "tenure": [...] },
  "sample_rationales": ["frustrated with retail theft", "..."] }
```
`p_yes` is the weighted share (binary yes) / Democratic two-party share (for the president question).
Missing `question` → `400`.

### `POST /branches/{id}/predict-market`
Map a market question to a pollable belief; `sim_probability_yes` is the panel's probability.
```json
// request
{ "question": "Will a Democrat win the 2024 California U.S. Senate seat?",
  "as_of_date": "2024-06-01", "bucket": "sf_opinion_informative", "model": "gpt-4o",
  "live_market_price": 0.94 }     // optional, echoed back for demo agreement
// response 200
{ "question": "...", "as_of_date": "2024-06-01", "bucket": "sf_opinion_informative",
  "sim_probability_yes": 0.97, "ci": [0.95, 0.99], "n_agents": 1200, "model": "gpt-4o",
  "live_market_price": 0.94,
  "note": "headline market number weights the sf_opinion_informative bucket; ..." }
```

### `POST /simulations/{id}/reset-to-main`
Drop all non-main branches and return to main HEAD.
```json
{ "reset_to": "sim-...:main", "dropped_branches": ["sim-...:b1"], "main_tick": 0 }
```

### `DELETE /branches/{id}`
Delete a (non-main) branch → `{ "deleted": "sim-...:b1" }`. Deleting main → `400`.

---

## 4. SSE stream — `GET /branches/{id}/stream`

`Content-Type: text/event-stream`. Each message has an `event:` name and JSON `data:`. The first
message is a `snapshot`; then live ticks every ~400 ms (bounded run). Event schemas:

```
event: snapshot       data: { "type":"snapshot", "tick":20, "clock":"2024-11-01T08:10:00Z", "agents_alive":1200 }
event: agent_moved    data: { "type":"agent_moved", "id":42, "from_cell":[4210,1875], "to_cell":[4214,1879] }
event: agent_said     data: { "type":"agent_said", "id":42, "text":"We need more housing, not less.", "target_id":77 }
event: agent_reacted  data: { "type":"agent_reacted", "id":42, "kind":"up", "event_id":"sim-...:b1" }   // kind: up|down
event: tick           data: { "type":"tick", "clock":1730450400, "tick":21, "iso":"2024-11-01T08:10:30Z" }
event: birth          data: { "type":"birth", "id":1201, "cell":[4100,1800] }
event: death          data: { "type":"death", "id":17 }
```

`from_cell`/`to_cell`/`cell` are `[gx, gy]` global cells (see §2). Speech bubbles come from `agent_said`
(`text`, optional `target_id`); reactions from `agent_reacted` (`kind` = `up`/`down`). Use `tick.iso`
for the in-world clock.

> Note: `agent_moved` reports the start/end cell of a multi-cell step. If you want the smooth
> intermediate path, run A* client-side over the cost grid, or interpolate linearly between cells
> (the backend guarantees both endpoints are walkable and close).

---

## 5. Models, modes, determinism

- **Models:** `gpt-4o` (default; earliest knowledge cutoff → used for counterfactuals + elections to avoid leakage), `gpt-5.5` (higher-stakes), `grok-4.3` (load-balance).
- **Modes:** `clean` (persona + broadcast event only — reproducible, used by `validate`) vs `social`
  (reflects post-conversation drift from the life-sim — richer, for exploration).
- **Determinism:** poll results are cached server-side by `(model, exact prompt)`, so repeating a poll
  is free and identical.

---

## 6. Validation status (for context)

`cargo run --bin validate` scores the prediction engine against real public ground truth (SF Dept of
Elections 2024 canvass, resolved Polymarket markets, counterfactual directions). Current weighted
headline **0.82** (gate 0.70). See `rubric.yaml` + `NOTES.md` for targets, sources, and methodology.

### Event reactions (social feed)

Residents can react to a city event like posts on a local social feed. Reactions are generated by the model for a diverse sample of the branch's population, stored on `REACTED_TO` edges in the Neo4j memory graph, and surfaced in the events feed. All three endpoints return `503` when `NEO4J_URI` is not configured.

Sentiment vocabulary: `support`, `oppose`, `worried`, `angry`, `sad`, `hopeful`, `indifferent`.

Reaction object:

```json
{"agent_id": 12, "name": "Nora Kim", "occupation": "nurse", "neighborhood": "the Sunset",
 "age": "55-64", "archetype": "55-64|asian|bachelors|q2|own|cit",
 "text": "A rally should never be a place you fear for your life.", "sentiment": "worried",
 "at": "2026-09-12T18:31:02Z"}
```

`GET /cities/{city}/events?limit=50` now returns each event with its reaction summary and the three most recent reactions:

```json
{"events": [{"id": "evt-…", "kind": "news", "text": "…", "as_of_date": "2026-09-12",
             "created_at": "…", "city": "sf", "reaction_count": 8,
             "sentiment": {"angry": 1, "sad": 2, "worried": 5}, "reactions": [ …up to 3… ]}]}
```

`GET /cities/{city}/events/{event_id}/reactions?limit=50` → `{"event": {…}, "reactions": [ …newest first… ], "sentiment": {…}}`; `404` when the event does not belong to that city.

`POST /branches/{id}/events/{event_id}/react` body `{"n": 12}` (optional, 1–24) → `{"event_id": "evt-…", "reactions": [ … ]}`. Picks `n` residents spread evenly across archetypes, asks the model (Gemini Flash when `GEMINI_API_KEY` is set, otherwise Claude Sonnet) for one in-character post and sentiment each, stores them (re-reacting overwrites), and returns them. `404` branch or event not found; `502 {"error":"reaction model request failed"}` when the model yields no reactions.

### Lineage (events, tests and data queries in order)

`GET /cities/{city}/lineage?limit=100` (1–500, keeps the most recent items) → `{"items": [...]}` in `created_at` ascending order: the wall-clock sequence of everything thrown into the world, everything asked of the residents, and every verified-data question answered from the PUMS snapshot. `503` when `NEO4J_URI` is not configured; `404` unknown city.

```json
{"items": [
  {"type": "event", "id": "evt-…", "kind": "news", "text": "A political figure was shot…",
   "as_of_date": "2026-09-12", "created_at": "2026-09-12T18:16:40Z",
   "reaction_count": 8, "sentiment": {"angry": 1, "sad": 2, "worried": 5}},
  {"type": "test", "id": "test-…", "kind": "poll", "question": "Should the city increase police funding by 10%?",
   "description": "…", "framing": "vote", "as_of_date": "2026-09-12", "model": "gemini-3.5-flash",
   "p_yes": 0.46, "options": [], "p_distribution": [], "n_agents": 300, "n_archetypes": 135,
   "simulation_id": "sim-sf-42-300-…", "branch_id": "sim-sf-42-300-…:main", "population_key": "sf:42:300",
   "created_at": "2026-09-12T18:24:03Z", "events_known": 2, "under_event": null, "stimuli": [],
   "previous_p_yes": null, "delta": null,
   "breakdowns": {"breakdowns": {"age": [{"key": "25-34", "yes_share": 0.41, "weight": 12345.0, "n": 40}]},
                  "option_breakdowns": [], "p_distribution": []}},
  {"type": "data_query", "id": "dq-…", "question": "Show the age distribution",
   "answer": "…", "status": "ok", "created_at": "2026-09-12T19:40:11Z",
   "response": {"status": "ok", "chart": {"type": "bar", "series": ["…"]}, "source": {"…": "…"}}}
]}
```

`breakdowns` on a test is the poll's stored demographic breakdowns in the exact shape `buildEvidenceChartModel` reads (`breakdowns`, `option_breakdowns`, `p_distribution`), or `null` for tests recorded before breakdowns were kept, so the timeline can re-open the evidence chart. A `data_query` item carries the full `/data-query` response so the verified chart can be re-rendered; only answered (`status: "ok"`) questions are remembered, and `POST /data-query` records them best-effort when memory is configured.

`events_known` is how many city events existed when the test was asked (what the residents could remember). `under_event` is the counterfactual stimulus text, if any; `stimuli` are A/B variants. `previous_p_yes`/`delta` link a test to the most recent earlier test in the same city with the same `question` and `framing`, so a before/after pair around an event shows the shift directly.

### Persona charts (per-resident answers behind a result)

Every poll, A/B test and counterfactual leg is written to persona memory with each
resident's inherited answer. The result JSON carries the Test id so a client can join
answers with the resident list it already holds:

- `POST /branches/{id}/poll`, `/ab-test`, `/counterfactual` responses include
  `"memory_test_id": "test-…"` (null when memory is off). The write is best-effort and
  in the background, so a client fetching answers immediately should tolerate one 404 and retry.
- `GET /tests/{test_id}` → the recorded test in the lineage item shape (`type: "test"`,
  question, framing, options, `p_distribution`, `p_yes`, `n_agents`, `model`, `population_key`,
  `events_known`, `under_event`, stored `breakdowns` or null). 404 unknown, 503 memory off.
- `GET /tests/{test_id}/answers` → `{"test_id", "answers": [{agent_id, p_yes, dist, why,
  personal_p_yes?, personal_dist?, personal_why?}]}` for every resident that answered (10,000
  rows for a full population). `p_yes`/`dist`/`why` are the archetype's answer that the resident
  inherited; the `personal_*` fields are present only once that resident has been asked
  individually (below). `dist` is empty for binary polls. 404 unknown, 503 memory off.
- `POST /tests/{test_id}/personal-answers` body `{"branch_id", "agent_ids": [..], "limit": 20}`
  → `{"test_id", "answers": [{agent_id, p_yes, dist, why, personal: true}]}`: each listed
  resident's OWN answer in their own words. Residents already asked come back from the graph;
  the rest (at most `limit`, 1..=40, default 20) are asked in one batched model call grounded in
  their persona and memory, then stored on their `ANSWERED` edge (`personal_p_yes`,
  `personal_dist`, `personal_why`). 404 branch/test unknown, 409 when the test was asked of a
  different population than the branch, 400 no valid ids, 502 model failure, 503 memory off.
- `GET /branches/{id}/agents/{agent_id}` → one resident's full persona: `name`, `persona` (prose),
  `occupation`, `neighborhood`, `age`, `sex`, `race_eth`, `educ`, `marital`, `nativity`,
  `employment`, `citizen`, `homeowner`, `religion`, `values`, `values_summary`, `pums_weight`,
  `segments`.
- `POST /data-query` accepts an extra `"record": false` field for lookups made only as tooltip
  source backing; such queries are answered but never recorded in the lineage.


## Workspaces

Residents (Persona/Population nodes) are shared by every workspace; only what a workspace posts and asks is private (`Test.workspace`, `Event.workspace`, and a per-workspace City node). A fresh workspace is seeded with a curated set of surveys and events copied from `public` onto the same residents. (per-browser memory)

Memory (events, reactions, asks and their answers, personal answers, data queries) is
scoped to a **workspace**. There are no accounts: the browser makes an id on first
visit (`localStorage` key `simtra.workspace`) and sends it on every request as

```
X-Simtra-Workspace: <id>      # [A-Za-z0-9_-]{1,32}
```

A missing or invalid header means workspace `public`, which holds everything written
before workspaces existed. `?ws=<id>` in the page URL adopts that workspace (and stores
it), so a workspace can be shared by link; the timeline's ··· menu has *Share timeline link* / *Start a new workspace*.
Simulations and populations are deterministic and shared across workspaces; only the
memory graph is partitioned (City nodes are keyed `"{ws}:{slug}"`, populations
`"{ws}:{city}:{seed}:{n}"`). The frontend also sends `ngrok-skip-browser-warning: 1`
so a tunnelled backend answers JSON instead of the ngrok interstitial.

`POST /workspace/seed` → fill a brand-new workspace with examples so it never opens
empty: the 3 most recent public surveys (polls with stored breakdowns, answers re-keyed
onto the workspace's own `sf` / seed 42 / 10,000 personas, personal answers included)
and the 3 most recent public news events with their reactions. Copied nodes get new
ids and `seeded: true` but keep their original dates. No-op for `public` and once the
workspace has any survey or event. The frontend calls it once, right after it mints a
new workspace id.

```json
{"workspace":"a1b2c3d4e5f6","seeded":true,"tests":3,"events":3}
```

`GET /workspace` → what the current workspace remembers:

```json
{"workspace":"a1b2c3d4e5f6","memory_configured":true,"events":3,"tests":2,"data_queries":0}
```

### Foundry audience conditioning for A/B tests

`GET /capabilities` advertises `features.audience_context_v1: true` and
`audience_context_max_bytes: 24000`. Capability lookup makes no model call.
Foundry checks this before sending a research-conditioned test; older servers
can continue to run demographic-only tests.

`POST /branches/:bid/ab-test` accepts optional `audience_context`:

```json
{
  "profile_id": "audience-id",
  "version": 1,
  "context_hash": "64-character-profile-context-hash",
  "snapshot_hash": "sha256-of-the-exact-utf8-snapshot-json-string",
  "snapshot_json": "{...full reviewed profile JSON...}"
}
```

The snapshot must be a JSON object containing matching `id`, `version`, and
`context_hash`. The server validates its byte limit and SHA-256 before model
work. It supplies the same snapshot as untrusted conditioning data to both
messages; unknown attributes and conflicting evidence remain in the prompt.
Because the snapshot participates in the exact prompt, changing it changes the
model-cache input. No demographic membership or population weight is changed.

Successful responses echo profile identity and both hashes in `audience_context`
with `usage: "conditioning-context-not-buyer-population"`. Foundry rejects a
missing or mismatched receipt rather than displaying an unconditioned result as
profile-specific. A matching receipt establishes which input was used, **not**
that the research is true or that Census residents are verified product buyers.
Synthetic preferences and intervals remain unvalidated estimates.

### Persistent panel sampling receipts

`POST /simulations` now returns `population_fingerprint` and `engine_fingerprint`
(SHA-256 strings). The population receipt covers the actual sampled records,
weights, synthetic personas, seeded attributes, geography, income cutoffs, and
filters. It excludes simulation IDs and mutable life-simulation clocks/state.
Recreating the same sample yields the same receipt, including after restart.

The engine receipt conservatively covers relevant compiled prediction/persona/
model/aggregation code, Cargo.lock, clustering and batching configuration,
provider transport configuration, and the city's actual option prompt. An engine
change can require an explicit new panel version even if it appears benign.
Credentials, request counters, and response-cache contents are excluded.

`GET /capabilities` advertises `features.persistent_panel_v1`. This is enabled only
when mutable Hydra retrieval and persona memory are disabled; A/B news injection
is already disabled. Foundry checks both receipts before sending a repeated
panel's A/B model request and refuses silently changed sampling or engine state.
These receipts do not lock a hosted model's undisclosed updates or stochastic
outputs, guarantee identical answers, or establish verified buyer membership.


## TypeSafe Jev for Foundry message comparisons

Set `TYPESAFE_API_KEY` server-side and request `model: "jev-latest"` on the
existing `/branches/{id}/ab-test` route. The native adapter sends typed Choice
questions to `https://api.typesafe.ai/v1/systemone`, one per archetype in batches
of at most 12. Each question contains its archetype explicitly; question IDs
alone are not model-visible. Both variants and the frozen research context are
shared state. Set `MAX_CLUSTERS=12` as the coarsening target. It is not a hard cluster cap.
Jev comparisons enforce a separate hard maximum of 36 archetypes / three batches;
larger comparisons fail before any model call.

Missing/invalid probabilities fail rather than introducing neutral votes. This
adapter does not retry or fall back to another model. Exact requests use the
existing local cache; usage reflects provider-reported input/output tokens.
Jev produces no prose rationales; the rationale array stays empty. Its choice
probabilities are model judgments, not validated customer preference shares.
`jev-latest` is a rolling alias, so even stable population/engine receipts cannot
freeze the provider's undisclosed model updates. Jev is intentionally unavailable
for text generation and general polls. Existing generative providers are unchanged.

Official contract: https://docs.typesafe.ai/api
