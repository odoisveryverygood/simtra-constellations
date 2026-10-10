# Towncast

Towncast helps small and medium businesses explore decisions with a Census-backed synthetic community. A café can ask how residents might respond to a $1 price increase, compare two offers, and inspect simulated responses across demographic groups.

For the hackathon theme **Crafting Constellations**, result reveals connect shared perspectives across the existing moving city. Connections are illustrative, and responses are simulated estimates rather than observed customer behavior.

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

Gemini supports ordinary prediction and parsing. Jev provides typed A/B comparisons. Resident memory uses Neo4j and requires private configuration; live news also requires provider setup. Brave search is not yet wired into predictions. See [docs/DEMO.md](docs/DEMO.md) for the demo flow.

Legacy workspace headers and browser storage keys are retained so existing saved workspaces and memory remain accessible.

## Attribution

Based on the user's Simtra backup, derived from simfrancisco. Existing source comments, integration documentation, and asset credits are retained, including `frontend/assets/SPRITES-LICENSE.txt` and `crates/sim-maps/CREDITS.md`. This repository does not claim exclusive ownership of upstream work.

No private credentials, restored private settings, runtime state, model cache, or prior Git history are included.
