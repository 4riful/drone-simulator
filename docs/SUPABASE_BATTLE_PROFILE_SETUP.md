# Supabase Battle Profile Setup

The simulator works on GitHub Pages with local IndexedDB records. These optional tables let the same browser client mirror battle profiles and mission runs to Supabase for public profile pages, leaderboards, and author/admin insight.

Do not add a service-role key to the frontend. Use the publishable/anon key only.

## Tables

Run this SQL in the Supabase SQL editor.

```sql
create table if not exists public.battle_profiles (
  id text primary key,
  local_id text,
  callsign text not null,
  persona text not null default 'recon',
  preferred_mode text not null default 'single',
  total_flights integer not null default 0,
  total_score integer not null default 0,
  best_score integer not null default 0,
  total_distance integer not null default 0,
  total_kills integer not null default 0,
  total_rings integer not null default 0,
  total_time integer not null default 0,
  last_played timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.battle_runs (
  id bigint generated always as identity primary key,
  profile_id text references public.battle_profiles(id) on delete cascade,
  callsign text not null,
  score integer not null default 0,
  distance integer not null default 0,
  kills integer not null default 0,
  rings integer not null default 0,
  game_mode text not null default 'single',
  persona text not null default 'recon',
  version text,
  played_at timestamptz not null default now()
);

create index if not exists battle_runs_profile_played_idx on public.battle_runs(profile_id, played_at desc);
create index if not exists battle_runs_score_idx on public.battle_runs(score desc);
```

## Prototype Policies

These policies allow the static GitHub Pages client to write public prototype records with the publishable key. This is fine for a public prototype, but not for cheat-proof competitive records.

```sql
alter table public.battle_profiles enable row level security;
alter table public.battle_runs enable row level security;

create policy "public read battle profiles"
on public.battle_profiles for select
using (true);

create policy "public upsert battle profiles"
on public.battle_profiles for insert
with check (true);

create policy "public update battle profiles"
on public.battle_profiles for update
using (true)
with check (true);

create policy "public read battle runs"
on public.battle_runs for select
using (true);

create policy "public insert battle runs"
on public.battle_runs for insert
with check (true);
```

## How The Game Uses It

- `battle_profiles` mirrors callsign, persona, preferred mode, totals, best score, and latest play time.
- `battle_runs` stores each previous record with score, distance, kills, rings, mode, persona, version, and timestamp.
- If these tables do not exist, the game keeps working locally and reports cloud sync as pending.
- A later author/player page can read these tables for leaderboard, profile cards, and battle insight.

## Production Upgrade

For trusted public leaderboards, move validation into Supabase Edge Functions or an authoritative game server. Browser clients can always fake scores.
