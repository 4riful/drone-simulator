# Free Multiplayer Setup

The project is hosted on GitHub Pages, which is free static hosting. Static hosting cannot run a WebSocket game server. The free solution used here is Supabase Realtime presence.

## What Works Now

- Create Room, Join Room, and Copy Link in the game menu.
- Project Supabase URL and publishable key are already configured in the frontend.
- Remote pilots appear as blue wireframe ghost drones.
- Presence sync includes callsign, persona, aircraft, position, rotation, velocity, hull, fuel, and selected mode.

## Setup

1. Open `https://4riful.github.io/drone-simulator/`.
2. Select `Online Lab`.
3. Press `Create Room` to generate a code such as `DRN-482K`.
4. Press `Copy Link` and share the invite URL with another player.
5. The second player opens the URL, selects `Online Lab`, and presses `Join Room`.
6. Launch Online Lab from both browsers/devices.

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
