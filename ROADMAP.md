# Roadmap

## Phase 1: Project Foundation

- Keep the current simulator playable while adding project metadata, scripts, checks, and documentation.
- Use the existing `index.html` as the source of truth until behavior is stable.
- Avoid large rewrites before there is a working development loop.

## Phase 2: Split The Single File

- [x] Move CSS into `src/styles.css`.
- [x] Move simulator JavaScript into `src/main.js`.
- Install `three` locally and import it from npm instead of a CDN.
- Split code into modules only after the first extraction is safe:
  - `src/core/state.js`
  - `src/core/constants.js`
  - `src/sim/flight.js`
  - `src/sim/collisions.js`
  - `src/world/city.js`
  - `src/world/traffic.js`
  - `src/entities/drone.js`
  - `src/entities/enemies.js`
  - `src/ui/hud.js`
  - `src/input/keyboard.js`
  - `src/input/gamepad.js`
  - `src/storage/db.js`
  - `src/audio/sound.js`

## Phase 3: Simulator Depth

- Replace the target-velocity controller with a force/torque based flight model.
- Add vehicle mass, thrust curves, rotor lag, drag coefficients, lift loss, prop wash, and payload weight.
- Add mission planning, takeoff/landing zones, return-to-base behavior, and failure modes.
- Add structured telemetry logs for replay and tuning.

## Phase 4: Game Shape

- Add a mission selector and clear objective flow.
- Add difficulty levels that affect wind, enemy count, fuel burn, damage, and navigation reliability.
- Add tutorial flights for takeoff, hover, waypoint navigation, combat, emergency landing, and RTB.
- Add post-flight debrief with route, fuel, damage, kills, warnings, and pilot performance.

## Phase 5: Quality

- Add unit tests for pure systems after modules exist.
- Add Playwright smoke tests for menu load, mission start, pause, restart, and game-over flow.
- Add performance budgets for frame time, object counts, particles, and collision checks.
- Add save-data migration if IndexedDB schemas change.
