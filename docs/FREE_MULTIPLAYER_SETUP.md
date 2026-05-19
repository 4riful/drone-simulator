# Free Multiplayer Setup

The project is hosted on GitHub Pages, which is free static hosting. Static hosting cannot run a WebSocket game server. The free solution used here is Supabase Realtime presence.

## What Works Now

- Create Room, Join Room, and Copy Link in the game menu.
- Homepage room check verifies that Supabase Realtime is reachable for the code and reports whether any pilots are currently present.
- Project Supabase URL and publishable key are already configured in the frontend.
- Remote pilots appear as blue wireframe ghost drones and cyan markers on the minimap.
- Presence sync includes callsign, persona, aircraft, position, rotation, velocity, hull, fuel, and selected mode.

## Player Flow

1. Open `https://4riful.github.io/drone-simulator/`.
2. Select `Online Lab`.
3. Press `Create Room` to generate a code such as `DRN-482K`.
4. Press `Copy Link` and share the invite URL with another player.
5. The second player opens the invite URL or selects `Online Lab`, enters the same code, and presses `Check`.
6. If another pilot is already connected, the page reports the active pilot count. If nobody is connected yet, it reports that the room is reachable and waiting.
7. Both players launch Online Lab from their browsers/devices.

## Create And Join Plan

1. **Create Room** generates a human-shareable code locally, for example `DRN-482K`. Supabase rooms do not need to be pre-created on the server.
2. **Copy Link** builds a URL containing `mode=multiplayer`, the selected aircraft, and `room=DRN-482K`.
3. **Join / Check Room** connects briefly to the Supabase Realtime channel for that room code. A successful connection means the code is valid and reachable.
4. **Active pilot detection** reads Realtime Presence state. If presence rows exist, the room is active. If no rows exist, the code is still valid but no pilot is currently online.
5. **Launch** opens `game.html` with the same room code. The game connects to `drone-simulator:<room>` and starts broadcasting the local aircraft state.
6. **In-game visibility** uses both Presence sync and broadcast state. Remote players appear as ghost aircraft, labels, HUD online count, and minimap markers.
7. **Future improvement** should add a lobby panel before launch, showing callsigns and ready status before entering the 3D world.

## Why Supabase

- Has a generous free tier.
- Works from GitHub Pages because the browser connects directly to Supabase Realtime.
- Does not require running or paying for a custom Node server.
- Good enough for ghost/co-op presence and early prototype testing.

## Limits

- This is not authoritative multiplayer.
- Do not trust combat, score, or hit validation from the client.
- Do not put secret service-role keys in the browser. The configured browser key must stay publishable/anon only.
- For real combat multiplayer, add server-side validation later with Supabase Edge Functions, a small WebSocket server, Colyseus, or PartyKit.
