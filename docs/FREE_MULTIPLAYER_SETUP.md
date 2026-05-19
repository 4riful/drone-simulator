# Free Multiplayer Setup

The project is hosted on GitHub Pages, which is free static hosting. Static hosting cannot run a WebSocket game server. The free solution used here is Supabase Realtime presence.

## What Works Now

- Free room code in the game menu.
- Supabase URL and anon public key stored locally in the browser.
- Remote pilots appear as blue wireframe ghost drones.
- Presence sync includes callsign, persona, aircraft, position, rotation, velocity, hull, fuel, and selected mode.

## Setup

1. Create a free Supabase project at `https://supabase.com/`.
2. Open `Project Settings -> API`.
3. Copy the project URL.
4. Copy the `anon public` key.
5. Open `https://4riful.github.io/drone-simulator/`.
6. Select `Online Lab`.
7. Enter a room code, Supabase URL, and anon key.
8. Press `Save Online`.
9. Launch Online Lab from two browsers or devices using the same room code.

## Why Supabase

- Has a generous free tier.
- Works from GitHub Pages because the browser connects directly to Supabase Realtime.
- Does not require running or paying for a custom Node server.
- Good enough for ghost/co-op presence and early prototype testing.

## Limits

- This is not authoritative multiplayer.
- Do not trust combat, score, or hit validation from the client.
- Do not put secret service-role keys in the browser. Use only the Supabase anon public key.
- For real combat multiplayer, add server-side validation later with Supabase Edge Functions, a small WebSocket server, Colyseus, or PartyKit.
