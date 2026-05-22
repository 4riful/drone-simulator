# Drone Simulator

<p align="center">
  <img src="./logo.png" alt="Drone Simulator logo" width="120">
</p>

Browser-playable drone simulator prototype built with Three.js, a terminal-style cockpit UI, local pilot profiles, multiple game modes, and a roadmap toward a more physically correct flight model.

**Play now:** https://4riful.github.io/drone-simulator/

## Status

This project is playable today, but it is still a simulator-game prototype. The public homepage is separated from the gameplay page so the first screen stays clean, responsive, and does not load the WebGL runtime in the background. The current flight controller is assisted and partly game-like; `docs/FLIGHT_MODEL_PLAN.md` documents the next step toward a force/torque model.

## Current Features

- Playable directly from GitHub Pages with a dedicated terminal-themed landing page and gameplay page.
- Three.js city environment with buildings, roads, Kortoa River, 4th China Friendship Bridge, named districts, traffic, smoke, particles, and weather effects.
- Drone and helicopter vehicle modes.
- Game modes: Single, Training, Mission, Free Flight, and Online Battle.
- Pilot profiles stored locally with callsign, persona, preferred mode, sorties, score, range, kills, waypoints, and flight time, with optional Supabase cloud-sync tables documented.
- Profile personas: Recon Specialist, Combat Pilot, Test Pilot, and Instructor.
- Assisted flight systems with wind, gusts, turbulence, air-density loss, ground effect, fuel, battery voltage, signal strength, GPS status, and warning messages.
- Combat loop with hostile drones, lock/follow assist, projectiles, explosions, health, score, waypoints, orbs, and power-ups.
- Battle profile insight panel with previous records, recent performance, cloud-sync status, and profile stats.
- HUD instruments for heading, speed, altitude, attitude, hull, boost, fuel, battery, signal, GPS, air density, threats, mode, and mission warnings.
- Help screen with controls, mode explanations, profile notes, and simulator limitations.
- Keyboard, mouse, and gamepad support.

## Free Online Multiplayer Setup

GitHub Pages can host the static game, but it cannot run an authoritative multiplayer server by itself. The free path implemented here is **Supabase Realtime**: Broadcast carries fast drone state and hit events, while Presence tracks who is in the room.

The app is already configured with the project's public Supabase key.

Battle room networking uses Supabase Realtime. Battle profile cloud sync is optional and needs the SQL tables in `docs/SUPABASE_BATTLE_PROFILE_SETUP.md`; without those tables, records stay local and the UI reports cloud sync as pending.

1. Open the simulator and choose **Online Battle**.
2. Click **Create Battle** to generate a code such as `DRN-482K`.
3. Click **Copy Invite** and share it with player two.
4. Player two opens the invite URL or enters the same battle code and clicks **Join Battle**.
5. Both players launch the same battle room.
6. Both players see synced remote aircraft, HUD online count, and radar/minimap contacts.

Current Online Battle syncs callsign, persona, aircraft, position, rotation, velocity, health, fuel, and hit events as remote aircraft. Combat hit validation is still client-side prototype logic and should become authoritative later. The deeper create/join plan is documented in `docs/FREE_MULTIPLAYER_SETUP.md`.

## Controls

- `W/S` or arrow up/down: pitch forward/back.
- `A/D`: roll/strafe left/right.
- `Q/E` or arrow left/right: yaw.
- `Space`: climb.
- `Shift`: descend.
- `F` or mouse: fire.
- `Tab`: boost.
- `B` or `Ctrl`: emergency brake.
- `T`: lock target.
- `L`: follow locked target.
- `H`: help.
- `Esc` or `P`: pause.
- Gamepad Mode 2 is supported when connected.

## Development

Requirements:

- Node.js 18 or newer.
- A modern browser with WebGL support.

Install dependencies:

```bash
npm install
```

Run the local dev server:

```bash
npm run dev
```

Check the simulator module for JavaScript syntax errors:

```bash
npm run check
```

Preview a production-style local server:

```bash
npm run preview
```

## Project Shape

- `index.html`: standalone responsive landing page for mode, aircraft, launch, and build information.
- `game.html`: playable simulator page with menu screens, HUD, help, and runtime markup.
- `src/home.css`: landing page styling.
- `src/home.js`: landing page selection and launch-link logic.
- `src/styles.css`: terminal UI, cockpit HUD, menu, profile, help, and responsive styling.
- `src/main.js`: Three.js simulator logic, game state, world generation, flight loop, HUD, audio, storage, and input handling.
- `docs/FLIGHT_MODEL_PLAN.md`: engineering plan for replacing target-velocity movement with a physical force/torque model.
- `docs/FREE_MULTIPLAYER_SETUP.md`: free Supabase Realtime setup for Online Battle rooms.
- `docs/SUPABASE_BATTLE_PROFILE_SETUP.md`: optional Supabase SQL for battle profiles, runs, public leaderboards, and author/player pages.
- `check-module.mjs`: syntax check for the simulator module.
- `ROADMAP.md`: phased project direction.
- `ATTRIBUTIONS.md`: open-resource credits.

## Theme And Resources

- Clean terminal-command-center UI theme.
- JetBrains Mono font, licensed under OFL-1.1.
- Tabler Icons visual language, licensed under MIT.
- Three.js powers the procedural 3D graphics.
- Game visuals are generated procedurally in code.

## Roadmap

- Split `src/main.js` into focused modules for state, storage, input, UI, world, entities, and simulation.
- Install Three.js locally instead of importing it from a CDN.
- Replace the assisted target-velocity controller with a real force/torque flight model.
- Add training lessons, landing scoring, debriefs, telemetry replay, and better mission design.
- Connect a realtime backend for actual online rooms.
- Add automated browser smoke tests.

## Known Limitations

- The current flight loop still uses target horizontal and vertical velocities rather than full rigid-body physics.
- Online Battle uses Supabase Realtime presence, not an authoritative combat server.
- Profile data is local to the browser through IndexedDB/localStorage fallback.
- No official license file has been added yet.
