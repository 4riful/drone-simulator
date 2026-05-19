# Flight Model Plan

The simulator is playable, but the current flight logic is not yet physically correct. It smooths player input, computes target horizontal/vertical velocities, and pushes the drone toward those targets. That feels stable for a game, but it is not how a real drone or rotorcraft moves.

## Current Logical Issues

- Horizontal and vertical motion are mostly independent, so tilt does not fully produce thrust-vector acceleration.
- Orientation is partly visual; the aircraft does not yet integrate angular velocity from torque.
- Throttle, motor lag, drag, battery voltage, air density, fuel, and wind are connected visually, but not through a full physical energy model.
- Hard landings and building hits are improved, but collision damage should use impact normal, vertical speed, kinetic energy, and airframe limits.
- Speed readouts do not fully distinguish airspeed, groundspeed, climb rate, and wind-relative flow.

## Target Model

Move the simulator toward a small rigid-body flight model:

- State: position, velocity, quaternion orientation, angular velocity, fuel mass, battery voltage, damage state.
- Inputs: collective/throttle, pitch, roll, yaw, brake/assist, boost, vehicle type, payload.
- Forces: gravity, thrust vector, drag, induced drag, wind-relative airflow, ground effect, turbulence, settling-with-power loss.
- Torques: pitch, roll, yaw, rotor response lag, angular damping.
- Instruments: airspeed, groundspeed, vertical speed, AGL altitude, MSL altitude, heading, attitude, throttle, battery sag, link quality, GPS fix.
- Damage: landing load, impact speed, impact angle, obstacle normal, rotor failure, link degradation, engine-out state.

## Proposed Modules

- `src/sim/airframe.js`: vehicle definitions, mass, rotor count, thrust curve, drag area, failure thresholds.
- `src/sim/environment.js`: wind, turbulence, air density, ground effect, signal/GPS estimation.
- `src/sim/flightModel.js`: force/torque integration and control mixing.
- `src/sim/collisions.js`: collision resolution, impact severity, landing scoring.
- `src/sim/autopilot.js`: assisted mode, follow mode, training stabilization.
- `src/ui/instruments.js`: HUD values derived from physical state instead of game shortcuts.

## Implementation Order

1. Extract constants/state from `src/main.js` without behavior changes.
2. Move current target-velocity controller into `src/sim/flightModel.js` as `updateAssistedFlight()`.
3. Add a second `updateRigidBodyFlight()` behind a feature flag.
4. Introduce physical state object and instrument outputs while keeping visuals stable.
5. Replace horizontal target velocity with thrust-vector acceleration.
6. Replace yaw/tilt shortcuts with angular velocity and torque.
7. Replace collision damage with kinetic-energy and vertical-load damage.
8. Add training missions for hover, climb, turn, approach, landing, and emergency descent.

## Multiplayer Fit

The authoritative network state should not sync every particle or bullet. It should sync the physical aircraft state and mission events:

- room id, pilot id, callsign, persona, aircraft type;
- position, quaternion, velocity, angular velocity;
- health, fuel, selected mode, mission objective state;
- compact event messages for shots, hits, crashes, waypoint captures.

This keeps browser multiplayer feasible on a realtime backend while preserving local prediction for the player aircraft.
