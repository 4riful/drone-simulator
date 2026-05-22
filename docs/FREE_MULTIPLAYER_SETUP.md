# Free Online Battle Setup

The project is hosted on GitHub Pages, which is free static hosting. Static hosting cannot run a WebSocket game server. The free solution used here is Supabase Realtime: Broadcast for fast gameplay packets and Presence for room membership.

## What Works Now

- Create Battle, Join Battle, and Copy Invite in the launcher/game menu.
- Join Battle verifies that Supabase Realtime is reachable for the code and reports whether any pilots are currently present.
- Project Supabase URL and publishable key are already configured in the frontend.
- Remote pilots appear as red enemy aircraft with HUD labels and radar/minimap contacts.
- In-game Battle Link panel shows room transport, packet counts, last received packet, and active enemy contacts.
- Broadcast sync includes callsign, persona, aircraft, position, rotation, velocity, hull, fuel, selected mode, and hit events.
- Presence tracks room membership and slow identity; it is not used as the high-frequency movement channel.
- Battle profile records stay local by default and can optionally sync through the Supabase tables documented in `docs/SUPABASE_BATTLE_PROFILE_SETUP.md`.

## Player Flow

1. Open `https://4riful.github.io/drone-simulator/`.
2. Select `Online Battle`.
3. Player one presses `Create Battle` to generate a code such as `DRN-482K`.
4. Player one presses `Copy Invite` and sends the invite URL to player two.
5. Player two opens the invite URL or selects `Online Battle`, enters the same code, and presses `Join Battle`.
6. If another pilot is already connected, the page reports the active pilot count. If nobody is connected yet, it reports that the battle room is open and waiting.
7. Both players launch the same battle room from their browsers/devices.

## Create And Join Plan

1. **Create Battle** generates a human-shareable code locally, for example `DRN-482K`. Supabase rooms do not need to be pre-created on the server.
2. **Copy Invite** builds a URL containing `mode=multiplayer`, the selected aircraft, and `room=DRN-482K`.
3. **Join Battle** connects briefly to the Supabase Realtime channel for that room code. A successful connection means the code is valid and reachable.
4. **Active pilot detection** reads Realtime Presence state. If presence rows exist, the battle room is active. If no rows exist, the code is still valid but player two may be first into the room.
5. **Launch** opens `game.html` with the same battle code. The game connects to `drone-simulator:<room>` and starts broadcasting the local aircraft state at gameplay rate.
6. **In-game visibility** uses Broadcast state for movement and Presence for membership cleanup. Remote players appear as enemy aircraft, labels, HUD online count, and radar/minimap contacts.
7. **Future improvement** should add a lobby panel before launch, showing callsigns and ready status before entering the 3D world.

## Why Supabase

- Has a generous free tier.
- Works from GitHub Pages because the browser connects directly to Supabase Realtime.
- Does not require running or paying for a custom Node server.
- Good enough for prototype same-room aircraft sync and client-side battle testing.

## Limits

- This is not authoritative multiplayer.
- Do not trust combat, score, or hit validation from the client.
- Do not put secret service-role keys in the browser. The configured browser key must stay publishable/anon only.
- For real combat multiplayer, add server-side validation later with Supabase Edge Functions, a small WebSocket server, Colyseus, or PartyKit.
