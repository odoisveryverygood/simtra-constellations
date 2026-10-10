# Simtra — Crafting Constellations

Independent hackathon starting copy of Simtra. The original local checkout is preserved. **Constellations are planned, not built yet.**

See [TEAM-TASKS.md](TEAM-TASKS.md) for the three-person split and interface contract.

## Local startup

Requirements: Python 3, Rust/Cargo, and platform libraries needed by the existing workspace. From this repository:

```sh
cp .env.example .env
# Set GEMINI_API_KEY and TYPESAFE_API_KEY privately in .env.
cargo run --locked -p simfrancisco --bin server
```

In another terminal:

```sh
python3 -m http.server 15175 --bind 127.0.0.1 --directory frontend
```

Open http://localhost:15175/?backend=local&port=8080&motion=on. If `.env` sets another PORT, use it in the URL. For frontend work you can also use `?demo=1`; it uses synthetic fixture outcomes and does not verify live predictions.

Gemini supports ordinary prediction and parsing. Jev's typed adapter exists for A/B comparisons; the current frontend selects Gemini for A/B too, so enabling a separate Jev path is teammate B's task. Brave is not wired into this starting copy. Resident memory and live news require their separate provider setup.

## Attribution

Based on the user's Simtra backup, derived from simfrancisco. Existing source comments, integration documentation, and asset credits are retained, including `frontend/assets/SPRITES-LICENSE.txt` and `crates/sim-maps/CREDITS.md`. This repository does not claim exclusive ownership of upstream work.

No private credentials, restored private settings, runtime state, model cache, or prior Git history are included.
