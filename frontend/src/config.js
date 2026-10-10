// ─────────────────────────────────────────────────────────────────────────
// SimFrancisco · pixel-map frontend · configuration
// ─────────────────────────────────────────────────────────────────────────

// Static frontend keeps using the public API. `?backend=local` works only when
// the page itself runs on localhost, so shared deployments never call a visitor's machine.
const LOCATION = globalThis.location;
const QUERY = new URLSearchParams(LOCATION?.search ?? "");
const LOCAL_HOST = ["localhost", "127.0.0.1", "::1"].includes(LOCATION?.hostname);
// Keep the public backend as the default, including for the static local frontend.
// `?backend=local` is an explicit opt-in and remains impossible on shared deployments.
const LOCAL_BACKEND = LOCAL_HOST && QUERY.get("backend") === "local";
// `?port=` lets a second local stack run alongside the default one without
// editing this file. Ignored unless the local backend is in use.
const LOCAL_PORT = (() => {
  const raw = Number(QUERY.get("port"));
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 8080;
})();
// A deployed frontend can point at its own backend: `frontend/backend-config.js`
// sets `window.SIMTRA_BACKEND` (edit it per deployment), or `?backend=https://…`
// picks one for a single visit. Only https origins are accepted for the override.
const CONFIGURED_BACKEND = (() => {
  const fromFile = typeof globalThis.SIMTRA_BACKEND === "string" ? globalThis.SIMTRA_BACKEND.trim() : "";
  const fromQuery = (QUERY.get("backend") || "").trim();
  const pick = /^https:\/\/[^\s/]+/.test(fromQuery) ? fromQuery : fromFile;
  return /^https:\/\/[^\s/]+/.test(pick) ? pick.replace(/\/+$/, "") : "";
})();
export const BASE = LOCAL_BACKEND
  ? `http://localhost:${LOCAL_PORT}`
  : CONFIGURED_BACKEND || "https://sf-digital-twin-tp.fly.dev";
// Treat a configured backend like local mode for defaults (today's date, Gemini),
// since it is our own server with the memory layer, not the original public one.
const OWN_BACKEND = LOCAL_BACKEND || !!CONFIGURED_BACKEND;

// Synthetic population to spin up on load. 5,000 agents → a denser, more diverse
// crowd; poll latency stays bounded because agents are clustered into ≤160 archetypes
// before the LLM is called, so the call count (not N) sets the wait.
export const SIM = {
  n: 10000,
  seed: 42,
  start_datetime: "2026-06-13T08:00:00Z",
  tick_seconds: 30,
};

// Today's date as YYYY-MM-DD (UTC).
export function today() {
  return new Date().toISOString().slice(0, 10);
}

// Local demo defaults to Gemini; callers can select another configured backend
// model with `?model=...`. Production keeps its existing model.
// The local as-of date is today (override with `?as_of=YYYY-MM-DD`): persona
// memory recalls only events dated on or before the poll date, so a live local
// poll must be dated today to see what was just posted. Production keeps its
// pinned date.
const AS_OF_OVERRIDE = /^\d{4}-\d{2}-\d{2}$/.test(QUERY.get("as_of") || "") ? QUERY.get("as_of") : null;
export const PREDICT = {
  branch_ticks: 2,
  as_of_date: AS_OF_OVERRIDE || (OWN_BACKEND ? today() : "2026-06-13"),
  model: QUERY.get("model") || (OWN_BACKEND ? "gemini-3.5-flash-lite" : "claude-sonnet-4-6"),
};

// Animation timing (ms).
export const TIMING = {
  revealMs: 3000,         // green/red verdicts accumulate over the crowd
  driftMs: 9000,
  fadeBackMs: 420,
};

// Pixel-art map base (whole-city render from the golden-future-map track) + the
// 16×16 RPG character sprite sheet (01-generic: 10 characters).
export const MAP = {
  base: "assets/sf_tiles.png",        // 2144×1920 whole-city LOD-4 tile render
  sprites: "assets/sprites.png",      // 240×128, 10 chars in 5×2 blocks of 48×64
  // WGS-84 bbox the base image spans (from tiles.db manifest).
  bbox: { west: -122.5247, east: -122.3366, south: 37.6983, north: 37.8312 },
  detailZoomMul: 6.5,                 // click-to-zoom factor over the fit-to-screen zoom
};

// Neutral palette (purple removed). Map colors now come from the pixel image;
// these drive UI chrome + the yes/no verdict markers.
export const COLORS = {
  water:   "#215C81",   // exact ocean color in sf_tiles.png → letterbox blends seamlessly
  ink:     "#141414",   // primary text / title — near-black
  inkSoft: "#6E7280",   // secondary text / neutral sprites
  accent:  "#141414",   // was violet — now neutral black
  yes:     "#2E9B4E",   // strong yes — green
  no:      "#C0352F",   // strong no — brick red
};
