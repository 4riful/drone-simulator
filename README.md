<img src="assets/logo.svg" align="right" width="112" alt="">

# Drone Simulator

A browser flight sim: fly a quadcopter or a scout helicopter over a procedural
city, run a 7-mission story campaign, and shoot at hostile drones. Three.js for
rendering, Vite for the dev server, no engine and no asset pipeline — the whole
world is generated in code.

**Play:** https://4riful.github.io/drone-simulator/ (see [Deploying](#deploying) — the
Pages build is currently broken)

It is a *game* with simulator ambitions, not a trainer. The flight controller is
assisted and the combat is client-authoritative. Both are documented below so you
know what you are getting.

## Run it

Node 18+, a WebGL2 browser.

```bash
npm install
npm run dev      # vite dev server on 0.0.0.0
npm run check    # parse src/main.js and report syntax errors
npm run preview  # production-style static preview
```

`index.html` is the landing page (mode + aircraft pick, no WebGL). `game.html` is
the simulator. They are separate documents so the first paint never pays for the
renderer.

## Flight model

The controller is a **per-axis target-velocity integrator**, not rigid-body
physics. Stick input picks a target velocity in the yaw frame; the drone
accelerates toward it at a fixed rate. Pitch and roll are *visual* — the airframe
banks to sell the motion, it does not generate it. Yaw is the only axis with real
angular velocity and damping.

Tuning lives in `C` at the top of `src/main.js`:

| | |
|---|---|
| Max thrust | 42 m/s² (~4.3 : 1 thrust/weight) |
| Top speed | 48 m/s horizontal (~173 km/h), 20 m/s vertical |
| Max tilt | 0.78 rad (~45°) |
| Yaw | 3.5 rad/s, accel 12, damping 5 |
| Motor lag | 40 ms input smoothing |
| Ground effect | +20% lift below 5 m |

Layered on top: wind, gusts, turbulence, air density falling with altitude
(1.0 → 0.82), fuel burn scaled by throttle and boost, battery voltage derived
from fuel and load (25.2 → 18.0 V), signal strength that decays with distance
from base and low altitude, and a GPS fix that drops 3D → 2D → NO FIX as signal
degrades. Running the tank dry triggers a 5-second engine-failure countdown and
then an unpowered fall.

`docs/FLIGHT_MODEL_PLAN.md` is the plan for replacing this with force/torque.

Two airframes, defined by multipliers on the same controller: **MQ-9 Reaper**
(baseline) and **MQ-8B Fire Scout** (0.82× speed, 0.65× tilt, heavier throttle
response).

## Controls

| Key | | Key | |
|---|---|---|---|
| `W` `S` / `↑` `↓` | forward / back | `F` / mouse | fire |
| `A` `D` | strafe left / right | `Tab` | boost |
| `Q` `E` / `←` `→` | yaw | `B` / `Ctrl` | emergency brake |
| `Space` | climb | `T` | lock target |
| `Shift` | descend | `L` | follow assist (needs a lock) |
| `R` `V` | pitch trim | `C` | camera distance |
| `H` | help | `Esc` / `P` | pause |

Gamepad (Mode 2) is picked up when connected, with deadzone/expo/sensitivity and
per-axis inversion in the control settings. Touch builds get dual sticks plus
fire / boost / up / down / lock / brake buttons.

## What's in the build

- **City** — 500 m grid, 84 m blocks, procedural buildings, roads, two waterways
  and a bridge, four named districts, an airstrip and a harbor yard, moving
  traffic, neon signage, rain, smoke and particles, and a time-of-day atmosphere
  with post-processing.
- **Campaign** — *Operation Andromeda*, 7 missions in 3 acts, gated by progress,
  driven by an objective state machine (`src/story/campaign.js`) with two
  handlers on the radio, per-mission briefs and debriefs, and saved best scores.
- **Free modes** — Single, Training (no hostiles, 0.35× score), Mission
  (1.25× score), Free Flight, Online Battle.
- **Combat** — 7 hostile drones, 260 m/s projectiles, 110 ms fire rate, 150 HP,
  lock-on and follow assist, rings, orbs, power-ups, explosions.
- **Pilots** — local profiles with callsign, sorties, score, range, kills and
  flight time, plus four personas (Recon / Combat / Test / Instructor) that
  trade score multiplier against fuel burn and signal.
- **HUD** — heading, speed, altitude, attitude, hull, boost, fuel, battery,
  signal, GPS, air density, threats, radar/minimap, kill feed, warnings.

## Online Battle

Two-player rooms over **Supabase Realtime**: Broadcast carries drone state and
hit events, Presence tracks who is in the room. GitHub Pages cannot host an
authoritative server, so this is the free path.

Create a battle → copy the invite (`DRN-482K`) → the other pilot joins with the
link or the code. Synced: callsign, persona, aircraft, position, rotation,
velocity, health, fuel, hits.

**Hit validation is client-side.** Anyone can edit their own damage. Making it
authoritative is a to-do, not a shipped feature. Setup notes are in
`docs/FREE_MULTIPLAYER_SETUP.md`; the optional cloud-sync tables for battle
profiles are in `docs/SUPABASE_BATTLE_PROFILE_SETUP.md` (without them, records
stay local and the UI reports sync as pending).

## Deploying

The pages import a bare specifier (`import * as THREE from 'three'`), which only
resolves through Vite. Nothing in this repo builds or publishes, so GitHub Pages
serves the raw sources and the module graph fails to load in the browser. Fixing
it means either shipping `vite build` output or adding an import map to
`game.html`. That is the top item on the list below.

## Layout

```
index.html            landing page          src/home.js, src/home.css
game.html             simulator shell       src/styles.css
src/main.js           5k lines: state, world gen, flight loop, HUD, audio,
                      input, storage, networking — not yet split
src/render/           atmosphere + post-processing
src/story/campaign.js campaign data and the MissionDirector
check-module.mjs      syntax check for npm run check
docs/                 flight model plan, multiplayer setup, Supabase SQL
```

## Known gaps

- No build or deploy step; the live Pages site is broken (see above).
- `src/main.js` is one 5,000-line module. Splitting it into state / input / world
  / entities / sim / UI is the next structural job.
- Flight is target-velocity, not rigid-body. No torque, no per-motor thrust.
- Multiplayer hit detection is client-authoritative.
- Profiles are browser-local (IndexedDB with a localStorage fallback).
- No automated tests — `npm run check` only parses.
- No LICENSE file yet.

`ROADMAP.md` has the phased plan. `ATTRIBUTIONS.md` credits JetBrains Mono
(OFL-1.1), Tabler Icons (MIT), and Three.js.
