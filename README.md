# Drone Simulator

Browser-playable drone simulator prototype built with Three.js, a terminal-style cockpit UI, local pilot profiles, multiple game modes, and a roadmap toward a more physically correct flight model.

**Play now:** https://4riful.github.io/drone-simulator/

**Repository:** https://github.com/4riful/drone-simulator

**Author:** [Ariful Anik / 4riful](https://github.com/4riful)

## Status

This project is playable today, but it is still a simulator-game prototype. The UI now separates the product concepts clearly: single-player, training, mission, free-flight, profile personas, and an experimental online lab. The current flight controller is assisted and partly game-like; `docs/FLIGHT_MODEL_PLAN.md` documents the next step toward a force/torque model.

## Current Features

- Playable directly from GitHub Pages.
- Three.js city environment with buildings, roads, water, traffic, smoke, particles, and weather effects.
- Drone and helicopter vehicle modes.
- Game modes: Single, Training, Mission, Free Flight, and Online Lab.
- Pilot profiles stored locally with callsign, persona, preferred mode, sorties, score, range, kills, waypoints, and flight time.
- Profile personas: Recon Specialist, Combat Pilot, Test Pilot, and Instructor.
- Assisted flight systems with wind, gusts, turbulence, air-density loss, ground effect, fuel, battery voltage, signal strength, GPS status, and warning messages.
- Combat loop with hostile drones, lock/follow assist, projectiles, explosions, health, score, waypoints, orbs, and power-ups.
- HUD instruments for heading, speed, altitude, attitude, hull, boost, fuel, battery, signal, GPS, air density, threats, mode, and mission warnings.
- Help screen with controls, mode explanations, profile notes, and simulator limitations.
- Keyboard, mouse, and gamepad support.

## Free Online Multiplayer Setup

GitHub Pages can host the static game, but it cannot run an authoritative multiplayer server by itself. The free path implemented here is **Supabase Realtime presence**. It gives Online Lab shared rooms and synced ghost/co-op drones without paying for a server.

1. Create a free project at https://supabase.com/.
2. In Supabase, open **Project Settings -> API**.
3. Copy the project URL and `anon public` key.
4. Open the simulator, choose **Online Lab**, and paste the URL/key into **Free Online Setup**.
5. Pick a room code such as `alpha-room`, save, then launch Online Lab on two browsers/devices with the same room code.

Current Online Lab syncs callsign, persona, aircraft, position, rotation, velocity, health, fuel, and room presence as remote ghost drones. Combat synchronization and authoritative validation should come later.

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

- `index.html`: playable document shell, menu screens, HUD, help, and static markup.
- `src/styles.css`: terminal UI, cockpit HUD, menu, profile, help, and responsive styling.
- `src/main.js`: Three.js simulator logic, game state, world generation, flight loop, HUD, audio, storage, and input handling.
- `docs/FLIGHT_MODEL_PLAN.md`: engineering plan for replacing target-velocity movement with a physical force/torque model.
- `docs/FREE_MULTIPLAYER_SETUP.md`: free Supabase Realtime setup for Online Lab rooms.
- `check-module.mjs`: syntax check for the simulator module.
- `ROADMAP.md`: phased project direction.
- `ATTRIBUTIONS.md`: author and open-resource credits.

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
- Online Lab uses Supabase Realtime presence, not an authoritative combat server.
- Profile data is local to the browser through IndexedDB/localStorage fallback.
- No official license file has been added yet.
