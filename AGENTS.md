# AGENTS.md

Repository-wide context for coding agents. Read this before changing code, data, prompts, deployment config, or Git history.

## 1. Current checkout state

Snapshot date: **2026-07-18**.

- This checkout is a full import of [`tejasprabhune/simfrancisco`](https://github.com/tejasprabhune/simfrancisco).
- Current `main` matches `upstream/main` at commit `77ecb08b0fd3b192722ae8e11c12c273a50f97be` (`news: in-process daily refresh (advance clock + pull NewsAPI headlines)`).
- `origin` is `https://github.com/abhaysudhir/voice-coding-hackathon.git`.
- `upstream` is `https://github.com/tejasprabhune/simfrancisco.git`.
- `origin/main` has different history. At this snapshot, local `main` is ahead 22 and behind 2 relative to `origin/main`.
- Source branches are available as `upstream/main`, `upstream/gh-pages`, and `upstream/monorepo-multicity`; tag `v0` is fetched.
- A local pre-import pointer exists at `backup/pre-simfrancisco-import-20260718-112811`.
- **Do not force-push, rewrite `origin`, delete the backup branch, or repoint remotes without explicit user approval.**

Git state changes over time. Verify `git status`, current commit, and remotes before relying on this section.

## 2. What this project is

**sim francisco** is a multi-city synthetic-population digital twin and prediction demo.

It samples agents from real ACS PUMS microdata, assigns deterministic synthetic personas and value vectors, places them on procedurally generated city maps, and exposes two related engines:

1. **Prediction engine**: `persona + as-of-date + event/question -> weighted opinion, vote share, option distribution, or probability`.
2. **Life simulation**: schedules, movement, deterministic pathfinding, chatter, reactions, births/deaths, branching, snapshots, and SSE events for the visual frontend.

Current city set:

- `sf` — San Francisco
- `neu_york` — New York City
- `synth_la` — Los Angeles
- `cybercago` — Chicago
- `simami` — Miami

Primary product surface is a full-screen pixel-art city map. Users switch cities, inspect synthetic residents, see current-news context, and ask prediction questions. Frontend classifies each question, creates a branch, polls the synthetic population, and visualizes the result over resident sprites.

Production URLs documented by the repo:

- Frontend: `https://simfrancisco.org`
- API: `https://sf-digital-twin-tp.fly.dev`
- Health: `GET https://sf-digital-twin-tp.fly.dev/health`

## 3. Architecture

### Shared persona layer

Agents originate from committed ACS PUMS subsets. Every agent retains a PUMS person weight (`PWGTP`), demographics, geography, deterministic persona, issue salience, and political/value vector. Religion is layered separately because Census PUMS does not include it.

Population estimates use survey weights, not raw agent counts:

```text
p_hat(k) = sum_i(w_i * answer_i(k)) / sum_i(w_i)
```

Election paths can additionally apply citizen-voting-age and likely-voter weighting.

### Prediction engine

Core implementation is under `crates/sim-core/src/predict.rs`.

- Supports `vote`, `belief`, and multi-option framing.
- Clusters agents into demographic archetypes before model calls.
- Bounds cluster count through `MAX_CLUSTERS`.
- Batches archetypes into model prompts, then post-stratifies answers with PUMS weights.
- Produces `p_yes`, option distributions, weighted confidence intervals, demographic breakdowns, effective sample size, design effect, model-call counts, and sample rationales.
- Supports baseline/event counterfactual comparisons.
- Uses city-specific vote, belief, and options prompts from `CityProfile`.

The prediction engine must run independently from the life simulation. Do not create a dependency where polling requires active movement/SSE loops.

### Life simulation

Core implementation is under `crates/sim-core/src/sim.rs`, `state.rs`, `agent.rs`, `lifestyle.rs`, and `pathfind.rs`.

- Daily behavior is mostly deterministic/schedule-driven.
- Pathfinding is deterministic A*, never an LLM call per movement step.
- LLM use is reserved for polling, sparse chatter, reactions, and similar high-value moments.
- Mutable state can be snapshotted and branched.
- Branch operations must not mutate `main`.
- SSE exposes typed movement, speech, reaction, tick, birth, and death events.

### State and persistence

Three SQLite roles are distinct:

- `tiles.db` or `server_tiles/<city>.db`: map/collision data.
- `cache.db`: exact-prompt model response cache.
- `state.db`: simulations, branches, and mutable snapshots.

`Store` in `crates/sim-core/src/store.rs` owns simulation snapshots and branch heads. Tests enforce bit-for-bit snapshot restoration, branch isolation, and reset correctness.

### Persona memory layer (Neo4j)

Memory is partitioned per **workspace** (header `X-Simtra-Workspace`, `?ws=` in the frontend; missing = `public`). City nodes are keyed `"{ws}:{slug}"` and population keys are prefixed with the workspace, so events, tests, answers and data queries never leak between browsers. See INTEGRATION.md "Workspaces".

`crates/sim-core/src/memory.rs` gives every synthetic resident a durable memory of
events thrown into the world, the tests it took part in, and the stimuli it was shown.
It is opt-in (set `NEO4J_URI`) and best-effort: a missing or unreachable Neo4j never
turns a successful prediction into a failure.

Graph shape:

```text
(:City {key, slug, workspace})   key = slug for the public workspace, "{ws}:{slug}" otherwise
(:Population {key, city, seed, n})-[:IN_CITY]->(:City)
(:Persona {key, agent_id, name, ...})-[:MEMBER_OF]->(:Population)   shared by every workspace; Test.workspace / Event.workspace scope memory
(:Event {id, kind, text, as_of_date})-[:HAPPENED_IN]->(:City)     city-wide news
(:Persona)-[:EXPOSED_TO {at}]->(:Event)                            targeted exposure / stimulus
(:Test {id, kind, question, framing, as_of_date, model, p_yes, ...})-[:RAN_ON]->(:Population)
(:Persona)-[:ANSWERED {p_yes, dist, why, archetype, at}]->(:Test)
(:Test)-[:UNDER_EVENT]->(:Event)                                   the poll's stimulus event
(:Test)-[:USED_STIMULUS]->(:Stimulus {id, label, text})            A/B variants
(:DataQuery {id, question, answer, response_json})-[:ASKED_IN]->(:City)  verified-data questions
```

`Test` nodes also carry `breakdowns_json` (the poll's demographic breakdowns) so the
timeline can reopen the evidence chart; `DataQuery` nodes keep the full `/data-query`
response for the verified chart.

Identity is deterministic: `population_key = <city>:<seed>:<n>` and
`persona_key = <population_key>:<agent_id>`, so memory survives server restarts and
new simulations built from the same seed.

Recall into prompts:

- Before each poll, `Engine` recalls memory for every archetype representative and
  appends a ` Memory: ...` fragment to that representative's profile line, so the
  whole archetype reasons with it. Applies to polls, A/B tests, counterfactuals.
- Only events and tests with `as_of_date <= poll.as_of_date` are recalled, so
  historical backtests stay leakage-free unless the user deliberately dates an
  event earlier.
- Capped (`RECALL_EVENTS`, `RECALL_TESTS`, ~520 chars) and ordered by date then id,
  so prompt text and therefore model cache keys stay stable across runs.
- Stimuli are labelled "was shown (hypothetical)" so the model does not mistake a
  past test scenario for a real event.

Writes:

- `POST /simulations` registers the population's personas in the background.
- After each test, the Test node and one `ANSWERED` edge per persona are written in a
  background task; every member of an answered archetype inherits the representative's
  answer. A poll `event` becomes a `stimulus` Event with `EXPOSED_TO` edges; A/B
  variants become `Stimulus` nodes.
- `POST /cities/:city/events` creates a city-wide Event every present and future
  persona in that city remembers (recall traverses Persona -> Population -> City).

Environment: `NEO4J_URI` (`http(s)://host:7474` or an Aura `neo4j+s://host` URI,
which maps to `https://host`; plain `bolt://` is rejected), `NEO4J_USERNAME` (alias
`NEO4J_USER`, default `neo4j`), `NEO4J_PASSWORD`, `NEO4J_DATABASE` (default `neo4j`;
on Aura free instances this is the instance id),
`NEO4J_HTTP_API` (`query` = HTTP Query API v2 for Neo4j 5.x/Aura, the default; `tx` =
legacy `/tx/commit` for 4.x). No driver crate; raw `reqwest` like the other clients.

### Multi-city loading

`api::build_state` always loads San Francisco from the root `tiles.db` path and `data/sf_pums.csv`.

Other cities load only when all expected assets exist:

- `data/cities/<slug>.toml`
- PUMS CSV named by that profile
- tile database named by that profile, normally under `server_tiles/`

Missing secondary-city assets cause that city to be skipped rather than crashing the server.

### Map pipeline

`crates/sim-maps` is a separate GIS/procedural-rendering crate. It converts OSM + DEM inputs into chunked, compressed SQLite tile maps and visual atlases.

Key spatial defaults from `config/pipeline.toml`:

- CRS: UTM Zone 10N / EPSG:32610
- 2 meters per cell
- 250 meters per chunk
- 125 x 125 cells per chunk
- six LOD levels
- San Francisco WGS84 bbox: west `-122.5247`, east `-122.3366`, south `37.6983`, north `37.8312`

The backend uses collision costs and global cells; the frontend also receives lon/lat positions.

## 4. Technology stack

### Backend

- Rust 2021, minimum Rust `1.80`
- Tokio async runtime
- Axum `0.7`
- Tower HTTP CORS/tracing
- Reqwest with Rustls
- Serde JSON/YAML/TOML
- Rusqlite with bundled SQLite
- Zstd compression
- Rand + ChaCha for deterministic seeded sampling
- Clap for binaries
- Chrono for time
- Tracing / tracing-subscriber

### Map pipeline

- Rust
- `geo`, `geo-types`, `proj`
- `osmpbf`
- `tiff`, `image`
- Rayon
- SQLite + zstd

### Frontend

- Static HTML/CSS/vanilla JavaScript
- ES modules
- Canvas rendering
- No package manager, bundler, framework, or build step
- Google Fonts + Adobe Typekit loaded over network
- Direct browser calls to public production API with wide-open CORS

### Deployment

- Multi-stage Docker build
- Debian Bookworm slim runtime
- Fly.io app `sf-digital-twin-tp`
- Primary Fly region `sjc`
- Server listens on `$PORT`, default `8080`
- GitHub Pages hosts frontend from `gh-pages`

## 5. Repository map

```text
Cargo.toml                     Rust workspace
crates/sim-core/               Backend, prediction engine, life sim, API, tests
  src/bin/server.rs            Axum server
  src/bin/validate.rs          Rubric scorer / completion gate
  src/bin/ingest_pums.rs       PUMS ingest utility
  src/bin/daemon.rs            Simulation daemon
  tests/contract.rs            Local-offline and live endpoint contract test
crates/sim-maps/               OSM/DEM -> tile database and atlas pipeline
frontend/                      Static browser application
  index.html                   Page shell and UI
  styles.css                   Full visual system
  src/app.js                   App state machine and prediction flow
  src/api.js                   Timed/abortable backend client
  src/config.js                Backend, population, model, date, map settings
  src/map.js                   Canvas map/sprite renderer
  src/verdict.js               Per-dot visualization matching aggregate result
  assets/                      City maps and sprite sheet
data/                          PUMS subsets, city profiles, news, survey inputs
server_tiles/                  Slim per-city backend tile databases
assets/                        Map-pipeline atlases
config/                        Map pipeline and related city build config
rubric*.yaml                   Validation targets for SF and other contexts
BRIEF.md                       Original architecture/build brief
INTEGRATION.md                 Backend API and coordinate contract
NOTES.md                       Failure -> fix -> general-rule tuning log
Dockerfile                     Production server image
fly.toml                       Fly deployment settings
.githooks/pre-push             Test + validation smoke gate
tools/                         Verification, centroid, baseline, tile utilities
scripts/                       City build helpers
```

## 6. Important backend modules

- `api.rs`: Axum state, routes, simulations, branches, agents, polling, SSE, city parse/news endpoints.
- `model.rs`: raw HTTP model client, provider routing, retries, bounded concurrency, usage, SQLite cache.
- `predict.rs`: question framing, archetype clustering, weighted polling, counterfactuals, chatter.
- `persona.rs`: deterministic population/persona construction.
- `pums.rs`: PUMS loading and demographic records.
- `aggregate.rs`: weighted aggregation and confidence calculations.
- `city.rs`: city profiles and city-specific prompts.
- `sim.rs`: life-simulation ticks and events.
- `pathfind.rs`: deterministic pathfinding.
- `state.rs`: mutable simulation state.
- `store.rs`: SQLite snapshots and branches.
- `geo.rs`: tile DB/cell/geographic conversion.
- `news.rs`: city-news cache and optional NewsAPI refresh.
- `memory.rs`: Neo4j persona memory (events, tests, stimuli) recalled into prompts and written after tests.
- `parse.rs`: free-text question parsing into supported poll shapes.
- `rubric.rs`: validation rubric loading/scoring.

## 7. Model providers and credentials

`Model` currently maps to:

| Model input | Provider path | Credential |
|---|---|---|
| `gpt-4o` | Azure AI Foundry `/responses` | `MODEL_API_KEY` |
| `gpt-5.5` | Azure AI Foundry `/responses` | `MODEL_API_KEY` |
| `grok-4.3` | Azure AI Foundry `/chat/completions` | `MODEL_API_KEY` |
| any `claude*` / `sonnet` | Anthropic `/v1/messages`; current ID `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |

Model requests use raw `reqwest`, not provider SDKs.

Cache key is SHA-256 over exact `(model, system, user, max_tokens)`. Preserve exact prompt determinism. A byte change intentionally invalidates cache; unstable ordering unintentionally invalidates it.

### Environment variables

Core variables read by code/config:

| Variable | Purpose | Default/notes |
|---|---|---|
| `PORT` | Server port | `8080` |
| `TILES_DB` | SF tile DB | `tiles.db`; Fly uses `server_tiles/sf.db` |
| `CACHE_DB` | LLM response cache | `cache.db` |
| `STATE_DB` | Simulation snapshot DB | `state.db` |
| `MODEL_API_KEY` | Azure AI Foundry credential | Empty means Azure live calls fail unless cached/offline |
| `OPENAI_API_URL` | Azure API URL/base | Code strips `/responses` or `/chat/completions` |
| `MODEL_MAX_INFLIGHT` | Concurrent model request cap | `8`; Fly uses `16` |
| `MODEL_OFFLINE` | Disable network; cache-only model calls | Set to `1` in local contract tests |
| `MAX_CLUSTERS` | Max archetype clusters | Fly uses `160` |
| `ANTHROPIC_API_KEY` | Direct Anthropic credential | Required for Sonnet live calls |
| `ANTHROPIC_API_URL` | Anthropic Messages endpoint | `https://api.anthropic.com/v1/messages` |
| `NEWS_API_KEY` | Optional live headline refresh | Fly secret |
| `NEWS_REFRESH_HOURS` | Enable in-process refresh loop | Unset locally; Fly uses `6` |
| `RUST_LOG` | Logging filter | `info` in Fly/Docker |
| `CONTRACT_BASE_URL` | Run contract test against live server | Otherwise in-process offline server |
| `NEO4J_URI` | Enable Neo4j persona memory | Unset disables the layer; `http(s)://` or Aura `neo4j+s://`; plain `bolt://` rejected |
| `NEO4J_USERNAME` | Neo4j username (`NEO4J_USER` alias) | `neo4j` |
| `NEO4J_PASSWORD` | Neo4j password | Empty |
| `NEO4J_DATABASE` | Neo4j database name | `neo4j`; Aura free instances use the instance id |
| `NEO4J_HTTP_API` | `query` (5.x/Aura Query API) or `tx` (4.x tx/commit) | `query` |

`.env` is loaded manually by `load_dotenv` and **overrides inherited shell variables**. Never commit it.

Current `.env.example` is incomplete: it documents Azure variables only. It does not mention Anthropic/news/runtime variables, and `GROK_API_URL` appears unused by current `ModelClient`. Verify code before treating `.env.example` as authoritative.

## 8. API surface

Current router exposes:

```text
GET    /
GET    /health
GET    /cities
POST   /cities/:city/parse
GET    /cities/:city/news
POST   /cities/:city/events
GET    /cities/:city/events
POST   /simulations
GET    /simulations/:id/demographics
POST   /simulations/:id/branches
POST   /simulations/:id/reset-to-main
GET    /branches/:bid
DELETE /branches/:bid
GET    /branches/:bid/agents
GET    /branches/:bid/agents/:id/memory
POST   /branches/:bid/chatter
POST   /branches/:bid/poll
POST   /branches/:bid/predict-market
GET    /branches/:bid/stream
```

Use `INTEGRATION.md` and `crates/sim-core/tests/contract.rs` for payload examples, but prefer router/handler code when documentation conflicts.

## 9. Frontend runtime and data flow

Canonical local frontend command, verified on this checkout:

```bash
python3 -m http.server 5173 --directory frontend
```

Open `http://localhost:5173`.

No install/build step exists. By default this is **local frontend + production backend**, because `frontend/src/config.js` sets:

```js
BASE = "https://sf-digital-twin-tp.fly.dev"
SIM.n = 10000
PREDICT.model = "claude-sonnet-4-6"
PREDICT.as_of_date = "2026-06-13"
```

Initial boot flow:

1. `GET /cities`
2. `POST /simulations`
3. Page through `GET /branches/<main>/agents`
4. `GET /cities/<city>/news`
5. Render map and resident sprites

Prediction flow in `frontend/src/app.js`:

1. `POST /cities/<city>/parse`
2. Reject unsupported questions or fall back to heuristic binary framing if parsing is unavailable
3. `POST /simulations/<id>/branches`
4. `POST /branches/<id>/poll`
5. Convert aggregate `p_yes`/distribution into a deterministic-looking dot visualization
6. Show result card and sample rationales
7. Best-effort delete temporary branch on cleanup

Submitting a prediction performs paid/external model work on the configured public backend. Do not run repeated predictions as a casual smoke test.

## 10. Running backend locally

Run commands from workspace root. Many paths are CWD-relative.

### Static frontend only

```bash
python3 -m http.server 5173 --directory frontend
```

### Backend server

```bash
cp .env.example .env
# Fill required credentials. Add ANTHROPIC_API_KEY if using Sonnet.
cargo run --bin server
```

Default backend URL: `http://localhost:8080`.

To make frontend use local backend, change `BASE` in `frontend/src/config.js` deliberately. Do not silently change production defaults while only trying to run the demo.

### Validation

```bash
cargo run --bin validate
cargo run --release --bin validate -- --smoke
```

Validation can spend model credits on cache misses. Inspect `.env`, model choice, cache state, and rubric before running large/full validation.

### PUMS ingest

```bash
cargo run --bin ingest_pums
```

This is a data-generation operation. Do not overwrite committed PUMS subsets unless the task explicitly requires regeneration and sources/vintage are verified.

## 11. Tests and checks

Minimum backend checks:

```bash
cargo test --workspace
cargo build --release --bin validate
```

Contract test behavior:

```bash
cargo test -p simfrancisco --test contract
CONTRACT_BASE_URL=https://sf-digital-twin-tp.fly.dev cargo test -p simfrancisco --test contract
```

- Local contract mode starts Axum in process, sets `MODEL_OFFLINE=1`, and avoids live LLM calls.
- Live contract mode also exercises real poll and market endpoints.

Pre-push gate can be enabled with:

```bash
git config core.hooksPath .githooks
```

It runs workspace tests, builds `validate`, and runs `validate --smoke` when a `.env` or model key is present.

For documentation-only changes, do not spend model credits. Validate paths/commands and run cheap checks such as `cargo metadata --no-deps` or `git diff --check`.

## 12. Data, generated assets, and licensing constraints

- PUMS data is anonymized public Census microdata. Personas are fabricated; no PII should enter the system.
- Map inputs derive from public OSM/DEM sources.
- Sprite/map assets have credits/licenses under the relevant asset directories.
- Raw GIS inputs and generated intermediates are ignored by `.gitignore`.
- Committed `.db`, CSV, PNG, and baseline hash files may be source artifacts, not disposable build output.
- Do not regenerate or replace large binary artifacts casually. Identify producer command, expected deterministic baseline, and downstream consumers first.
- Never commit secrets, `.env`, API keys, auth headers, or copied production data containing secrets.

## 13. Load-bearing correctness rules

These rules come from `BRIEF.md`, tests, and the tuning history in `NOTES.md`.

### Preserve methodological integrity

- No post-`as_of_date` or post-model-cutoff facts in validation prompts.
- Historical context must be true, public, balanced, and available before cutoff.
- Never hint at target outcomes through campaign coalitions or outcome-shaped wording.
- Never fabricate ground truth.
- Rubric targets, weights, tolerances, and validation slices are frozen unless the user explicitly asks to redesign evaluation.
- Prompt/persona/aggregation/turnout changes must not game one rubric entry.

### Preserve weighted population semantics

- Use PUMS weights for population estimates.
- Keep citizen-voting-age and likely-voter logic explicit where required.
- Do not replace weighted aggregation with raw synthetic-agent counts.
- Maintain demographic breakdowns and confidence bounds when changing poll outputs.

### Preserve determinism

- Persona generation, sampling, pathfinding, prompt batching, and clean-mode validation are seeded/deterministic.
- Never allow `HashMap` iteration order or unstable tie sorting to affect prompt composition, cache keys, or results.
- Cache hits should reproduce clean-mode results byte-for-byte for identical inputs.
- Branch/reset operations must preserve exact state hashes and isolation.

### Preserve cost controls

- Do not introduce one LLM call per agent or per movement step.
- Keep archetype clustering/batching.
- Keep bounded concurrency and retry/backoff.
- Treat paid validation and public prediction endpoints as external side effects.

### Preserve engine separation

- Prediction engine must work without life simulation.
- Frontend visual behavior must degrade clearly when backend is unavailable.
- Do not make map rendering or polling depend on optional chatter/news refresh.

## 14. Deployment context

Fly config:

- App: `sf-digital-twin-tp`
- Region: `sjc`
- Internal port: `8080`
- Health check: `GET /health`
- VM: shared CPU, 2 GB RAM
- Minimum one machine running
- Auto-start enabled, auto-stop via suspend

Docker builds only `simfrancisco`'s `server` binary; it intentionally does not compile heavy `sim-maps` dependencies. Survey CSV files must exist during compilation because lifestyle code embeds them with `include_str!`.

Runtime image includes:

- slim city tile DBs
- city profiles
- city PUMS subsets
- committed news cache

Deployment requires explicit approval. Do not run `fly deploy`, change Fly secrets, or publish GitHub Pages without user instruction.

## 15. Documentation conflicts and stale context

Several documents describe earlier states. Resolve conflicts using this order:

1. Current code and tests
2. Current manifests/config files
3. `AGENTS.md` repository rules
4. `INTEGRATION.md`
5. `README.md`, `BRIEF.md`, `NOTES.md`, and frontend README as historical/design context

Known conflicts at this snapshot:

- Root README says frontend uses `gpt-5.5`; `frontend/src/config.js` uses `claude-sonnet-4-6`.
- Root README serves frontend on port `8123`; `frontend/README.md` says `5173`. Port is arbitrary, but `5173` is the verified local convention here.
- `frontend/README.md` describes an older/simpler outline frontend and roughly 1,200 dots; current frontend is pixel-map based and requests 10,000 residents.
- `INTEGRATION.md` model list omits direct Anthropic Sonnet support and does not fully cover newer `/cities`, `/parse`, `/news`, and `/chatter` routes.
- `.env.example` omits `ANTHROPIC_API_KEY`, `ANTHROPIC_API_URL`, `NEWS_API_KEY`, and several runtime tuning variables.
- Historical validation numbers vary (`~0.82`, `~0.84`, `0.8490`). Latest detailed verified score recorded in `NOTES.md` is `0.8490`, but rerun before making a current performance claim.
- Comments/docs may call the repo SF-only even though runtime is multi-city.

Do not “fix” historical docs or model choices as incidental cleanup. Make scoped documentation updates only when requested.

## 16. Agent operating procedure

Before editing:

1. Read this file.
2. Run `git status --short --branch`.
3. Verify current remotes/branch before Git operations.
4. Identify whether task touches prediction methodology, paid model calls, generated data, deployment, or large binaries.
5. Read source and tests for target subsystem; do not rely on README alone.

While editing:

- Match surrounding Rust/JS style.
- Keep diff minimal and scoped.
- Do not add frameworks or dependencies when existing stack handles the task.
- Add/adjust smallest meaningful test for non-trivial logic.
- Never expose secrets in logs, docs, fixtures, or commands.
- Avoid paid/external calls unless needed and authorized.

Before reporting completion:

1. Run relevant cheap tests/checks.
2. For runtime code, exercise affected flow end-to-end when practical.
3. Report exact failures or skipped checks.
4. Show `git status` and distinguish pre-existing changes from your changes.
5. Do not commit, push, deploy, or open a PR unless asked.

<!-- INSFORGE:START -->
## InsForge backend

This project uses [InsForge](https://insforge.dev): an all-in-one, open-source Postgres-based backend (BaaS) that gives this app a database, authentication, file storage, edge functions, realtime, an AI model gateway, and payments through one platform.

- **Project:** **sim-francisco** (API base `https://9ds84cpq.us-west.insforge.app`)
- **Skills:** these InsForge skills are installed for supported coding agents. Reach for them before implementing any InsForge feature instead of guessing the API:
  - `insforge`: app code with the `@insforge/sdk` client (database CRUD, auth, storage, edge functions, realtime, AI, email, and Stripe payments).
  - `insforge-cli`: backend and infrastructure via the `insforge` CLI (projects, SQL, migrations, RLS policies, storage buckets, functions, secrets, payment setup, schedules, deploys).
  - `insforge-debug`: diagnosing failures (SDK/HTTP errors, RLS denials, auth and OAuth issues) and running security or performance audits.
  - `insforge-integrations`: wiring external auth providers (Clerk, Auth0, WorkOS, Better Auth, etc.) for JWT-based RLS, or the OKX x402 payment facilitator.
  - `find-skills`: discovering additional skills on demand.
- **Credentials:** app code reads keys from `.env.local`; the CLI reads `.insforge/project.json`. Never hardcode or commit keys.

Key patterns:

- Database inserts take an array: `insert([{ ... }])`.
- Reference users with `auth.users(id)`; use `auth.uid()` in RLS policies.
- For storage uploads, persist both the returned `url` and `key`.
<!-- INSFORGE:END -->
