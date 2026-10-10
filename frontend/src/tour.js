// First-run tour: four quiet callouts, one at a time, shown once per browser.
// Each stop points at a real control and steps aside the moment the user uses it.
const KEY = "simtra.tour";
const REDUCED = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

const STOPS = [
  { find: () => document.getElementById("ask-input"), text: "Ask the city anything. 10,000 Census-based residents answer.", events: ["input", "focus"] },
  { find: () => document.getElementById("audience-chip"), text: "Narrow who answers, for example 25-year-old tech workers.", events: ["click"] },
  { find: () => document.querySelector("#feed-panel .fp-form-post textarea"), text: "Post news or events. Residents react and remember them in later surveys.", events: ["input", "focus"] },
  { find: () => document.querySelector("#evidence-panel") || [...document.querySelectorAll("#feed-panel .fp-link")].find((b) => /Explore demographic evidence/.test(b.textContent)), text: "See who’s behind every number, down to individual residents.", events: ["click"] },
];

let tip = null, current = -1, cleanup = null;

function done() {
  try { localStorage.setItem(KEY, "done"); } catch { /* private mode */ }
  hideTip();
  current = -1;
}
function hideTip() {
  cleanup?.(); cleanup = null;
  if (tip) { tip.remove(); tip = null; }
}
function place(target) {
  if (!tip) return;
  const r = target.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const above = r.top > h + 24;
  const top = above ? r.top - h - 12 : r.bottom + 12;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
  tip.dataset.side = above ? "above" : "below";
  const ax = Math.round(r.left + r.width / 2 - left);
  tip.style.setProperty("--tour-arrow-x", `${Math.max(16, Math.min(ax, w - 16))}px`);
}
function show(i) {
  hideTip();
  while (i < STOPS.length && !STOPS[i].find()) i += 1;
  if (i >= STOPS.length) { done(); return; }
  current = i;
  const stop = STOPS[i], target = stop.find();
  tip = document.createElement("div");
  tip.className = "tour-tip";
  tip.setAttribute("role", "dialog");
  tip.setAttribute("aria-label", "Tip");
  tip.innerHTML = `<p></p><div class="tour-actions"><button type="button" class="tour-skip">Skip</button><button type="button" class="tour-next">${i === STOPS.length - 1 ? "Done" : "Next"}</button></div><i class="tour-arrow"></i>`;
  tip.querySelector("p").textContent = stop.text;
  tip.querySelector(".tour-skip").addEventListener("click", done);
  tip.querySelector(".tour-next").addEventListener("click", () => (i === STOPS.length - 1 ? done() : show(i + 1)));
  document.body.appendChild(tip);
  if (!REDUCED) requestAnimationFrame(() => tip && tip.classList.add("in")); else tip.classList.add("in");
  place(target);
  const onUse = () => (i === STOPS.length - 1 ? done() : show(i + 1));
  for (const ev of stop.events) target.addEventListener(ev, onUse, { once: true });
  const onLayout = () => { if (tip && target.isConnected) place(target); };
  window.addEventListener("resize", onLayout);
  window.addEventListener("scroll", onLayout, true);
  cleanup = () => {
    for (const ev of stop.events) target.removeEventListener(ev, onUse);
    window.removeEventListener("resize", onLayout);
    window.removeEventListener("scroll", onLayout, true);
  };
}

/** Start the tour now (used by "Show tips again"). */
export function startTour() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } show(0); }

/** Run the tour once per browser, after the city is ready. */
export function initTour() {
  let seen = false;
  try { seen = localStorage.getItem(KEY) === "done"; } catch { seen = true; }
  if (seen) return;
  setTimeout(() => show(0), 900);
}

export const tourActive = () => current >= 0;
