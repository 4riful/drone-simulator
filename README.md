# Drone Simulator

A browser-based drone simulator game built with Three.js. The current app is now split into an HTML shell, stylesheet, and simulator module, with a local development workflow around it.

## Current Features

- Three.js city environment with buildings, roads, water, traffic, smoke, particles, and weather effects.
- Drone and helicopter vehicle modes.
- Assisted real-world flight controller with wind, gusts, turbulence, air-density loss, ground effect, fuel, battery voltage, signal strength, and GPS status.
- Combat loop with hostile drones, lock/follow assist, projectiles, explosions, health, score, waypoints, orbs, and power-ups.
- HUD instruments for heading, speed, altitude, attitude, hull, boost, fuel, battery, signal, GPS, air density, threats, and mission warnings.
- IndexedDB-backed pilot profiles, run history, settings, and statistics.
- Keyboard, mouse, and gamepad support.

## Requirements

- Node.js 18 or newer.
- A modern browser with WebGL support.

## Development

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

## Controls

- `W/S` or arrow up/down: pitch forward/back.
- `A/D`: roll/strafe left/right.
- `Q/E` or arrow left/right: yaw.
- `Space`: climb.
- `Shift`: descend.
- `F` or mouse: fire.
- `Tab`: boost.
- `B` or `Ctrl`: emergency brake.
- Gamepad Mode 2 is supported when connected.

## Project Shape

- `index.html`: the playable simulator document shell.
- `src/styles.css`: visual design, HUD, menu, and screen styling.
- `src/main.js`: Three.js simulator logic, game state, world generation, flight model, HUD updates, audio, storage, and input handling.
- `package.json`: local dev, preview, and check scripts.
- `check-module.mjs`: runs `node --check` against the simulator module.
- `ROADMAP.md`: technical direction for turning the prototype into a maintainable simulator project.

## Notes

The app currently imports Three.js from a CDN inside `src/main.js`. A future refactor should install Three.js locally and convert the simulator into separate systems for physics, world generation, HUD, audio, persistence, and input.
