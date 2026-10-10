# Constellations renderer — teammate A

The optional starfield view of how the simulated residents grouped on one
question. Owned files: `frontend/src/constellations.js` and
`frontend/constellations.css`, plus the dev harness and tests listed below.
`app.js`, `config.js`, `index.html` and the city renderer are untouched.

## Interface

```js
import { initConstellations } from "./constellations.js";

const view = initConstellations(map, state);   // map/state are read-only here
view.setResult(model);                         // teammate B's model, or null to clear
view.setActive(true);                          // show · false restores the city
view.destroy();                                // remove everything
```

The model is the agreed shape:

```js
{ question: "…", illustrative: true, groups: [{ id, label, share, members }] }
```

Tolerated variations, so a real payload does not need reshaping: `share` as a
fraction or a percentage; `member_count` (or `count`) when the `members` array is
only a sample; a group with no `members` at all (aggregate-only); `explanation`
per group or per member; `provenance` and `mock` on the model. Anything
unusable returns an empty view rather than a half-drawn sky. An absent
`illustrative` flag is treated as `true`.

### Integration (owner's two lines)

The renderer injects its own stylesheet, so nothing else is strictly required.
Adding the link to `index.html` avoids a one-frame unstyled flash:

```html
<link rel="stylesheet" href="constellations.css" data-constellations />
```

The view mounts itself on `document.body` at `z-index: 3` — above the city
canvas, below the app's chrome. To stack it differently:
`view._view.els.root.style.zIndex = "…"`.

## What it draws, and what it refuses to imply

- A star is an **illustrative** placement of one simulated resident in a group.
  The backend returns weighted aggregate shares, not per-resident votes, so the
  view never calls a star an individual answer.
- Lines connect **nearby stars inside the same group**. They are never drawn
  across groups and never represent a relationship.
- Both statements stay on screen whenever the view is up, and again on every
  resident card.
- A star the result carried no persona for says exactly that instead of
  inventing one.
- A mock model (`mock: true`) is badged **MOCK DATA** in the header.

## Bounded by design

| Budget | Desktop | Mobile |
|---|---|---|
| stars drawn | 240 | 110 |
| connections | 420 total, 90 per group | same |

A group never draws more stars than it has personas for, so every star is
inspectable. The subset is evenly spaced across the group — a representative
sample, not the first N — and the **full population is retained**: each label
reads `34% · 60 of 3,400 drawn`, and the header states the whole population.

Per-frame work is the glowing stars alone; dust, connections and labels are
baked into a static layer on layout. Under `prefers-reduced-motion` there is no
animation loop at all — the sky is drawn once and redrawn on interaction.

## Accessibility

- Every cluster is directly labelled and a legend is always present, so identity
  is never carried by colour alone.
- The group shares are also rendered as a screen-reader list (the table view).
- The canvas is focusable: arrow keys walk the stars, Enter inspects, Escape
  closes — full parity with clicking.
- Colours are the validated dark categorical palette on the `#0a0f1f` sky
  (worst adjacent CVD ΔE 8.4, worst adjacent normal-vision ΔE 19.3, every slot
  ≥ 3:1 contrast). Slots are assigned per group id in first-seen order and
  **never cycled**: a ninth group renders neutral and relies on its label.
- `forced-colors` and mobile/short-viewport layouts are handled in the sheet.

## Running it

Standalone harness (mock data only, no backend, no model calls):

```sh
python3 -m http.server 5173 --directory frontend
# http://localhost:5173/constellations-demo.html
```

Tests:

```sh
cd frontend
node --test tests/constellations.test.mjs       # 17 pure-logic tests, no DOM
node tests/constellations-browser.mjs           # 11 Chromium tests (needs playwright)
```

The browser test drives the harness (star clicks, keyboard, resize, reduced
motion, teardown), then mounts the view over the real app in `?demo=1` with all
external requests blocked and asserts the city renderer, its population and its
camera are untouched. Set `PLAYWRIGHT_MODULE` if playwright is not resolvable
from `frontend/`.
