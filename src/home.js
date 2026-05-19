const MODES = {
  single: 'Balanced solo sortie with hostiles, waypoints, fuel, weather, and scoring.',
  training: 'Safer flight school with combat pressure removed so you can learn controls.',
  mission: 'Higher-pressure sortie with stronger scoring and combat objectives.',
  freeflight: 'Open exploration mode for landing practice, camera work, and flight handling.',
  multiplayer: 'Create or join a two-player battle room. The other pilot appears as a remote radar contact in-game.'
};

const AIRCRAFT = {
  drone: 'MQ-9 Reaper: fixed-wing drone feel with higher speed and longer mission profile.',
  helicopter: 'MQ-8B Fire Scout: rotorcraft profile for hover, low-speed control, and landing practice.'
};

const AIRCRAFT_LABELS = {
  drone: 'MQ-9 Reaper',
  helicopter: 'MQ-8B Fire Scout'
};

const SUPABASE_CLIENT_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const ONLINE_CONFIG = {
  url: 'https://edmvtxoteltikuwjxdsf.supabase.co',
  key: 'sb_publishable_5OhCh1NLtCqrYjC6Y2AlOA_9zSA2K_8'
};

const TERMINAL_LINES = [
  '> tactical launcher armed',
  '> mission cards synced to cockpit rail',
  '> flight profile loaded and standing by',
  '> radar contacts: remote pilot channel ready',
  '> airframe selection locked for launch',
  '> webgl combat deck: green to go'
];

let selectedMode = 'single';
let selectedAircraft = 'drone';
let supabaseModulePromise = null;
let lastRoomCheck = { room: '', activePilots: 0, ok: false };

const $brief = document.getElementById('brief');
const $aircraftBrief = document.getElementById('aircraft-brief');
const $launchNote = document.getElementById('launch-note');
const $roomPanel = document.getElementById('room-panel');
const $roomCode = document.getElementById('room-code');
const $roomStatus = document.getElementById('room-status');
const $terminalFeed = document.getElementById('terminal-feed');
const $aircraftMenu = document.getElementById('aircraft-menu');

function normalizeRoom(room) {
  return String(room || '').toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

function makeRoomCode() {
  return `DRN-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function gameUrl() {
  const url = new URL('./game.html', location.href);
  url.searchParams.set('mode', selectedMode);
  url.searchParams.set('aircraft', selectedAircraft);
  const room = normalizeRoom($roomCode?.value);
  if (selectedMode === 'multiplayer') {
    url.searchParams.set('room', room || makeRoomCode());
  }
  return url;
}

function updateSummary() {
  $brief.textContent = MODES[selectedMode];
  $launchNote.textContent = `${selectedMode.replace(/flight$/, ' flight').toUpperCase()} | ${AIRCRAFT_LABELS[selectedAircraft]}`;
  $aircraftBrief.textContent = AIRCRAFT[selectedAircraft];
  $roomPanel.classList.toggle('show', selectedMode === 'multiplayer');
}

function pushTerminal(line) {
  if (!$terminalFeed) return;
  const p = document.createElement('p');
  p.textContent = line;
  $terminalFeed.appendChild(p);
  while ($terminalFeed.children.length > 4) $terminalFeed.firstElementChild.remove();
}

function setActive(selector, attr, value) {
  document.querySelectorAll(selector).forEach((button) => {
    const active = button.dataset[attr] === value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function selectMode(mode) {
  selectedMode = mode;
  setActive('[data-mode]', 'mode', selectedMode);
  if (selectedMode === 'multiplayer' && !$roomCode.value) $roomCode.value = makeRoomCode();
  updateSummary();
}

document.getElementById('mode-grid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-mode]');
  if (!button) return;
  selectMode(button.dataset.mode);
});

$aircraftMenu.addEventListener('change', () => {
  selectedAircraft = $aircraftMenu.value;
  updateSummary();
});

document.getElementById('btn-room-code').addEventListener('click', () => {
  selectMode('multiplayer');
  $roomCode.value = makeRoomCode();
  lastRoomCheck = { room: $roomCode.value, activePilots: 0, ok: true };
  $roomStatus.textContent = `Room ${$roomCode.value} created. Share the code with player two.`;
  pushTerminal(`> created room ${$roomCode.value}`);
});

document.getElementById('btn-join-room').addEventListener('click', async () => {
  selectMode('multiplayer');
  const room = normalizeRoom($roomCode.value);
  if (!room) {
    $roomStatus.textContent = 'Enter a room code or press Create.';
    pushTerminal('> join blocked: missing code');
    return;
  }
  $roomCode.value = room;
  $roomStatus.textContent = `Checking room ${room}...`;
  pushTerminal(`> checking room ${room}`);
  try {
    if (!supabaseModulePromise) supabaseModulePromise = import(SUPABASE_CLIENT_URL);
    const { createClient } = await supabaseModulePromise;
    const client = createClient(ONLINE_CONFIG.url, ONLINE_CONFIG.key, { auth: { persistSession: false, autoRefreshToken: false } });
    const channel = client.channel(`drone-simulator:${room}`);
    let activePilots = 0;
    channel.on('presence', { event: 'sync' }, () => {
      activePilots = Object.values(channel.presenceState()).reduce((n, rows) => n + rows.length, 0);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1800);
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') return;
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          clearTimeout(timer);
          reject(new Error(status));
        }
      });
    });
    await channel.unsubscribe();
    lastRoomCheck = { room, activePilots, ok: true };
    $roomStatus.textContent = activePilots > 0
      ? `Room active - ${activePilots} pilot(s) online. Launch to join.`
      : `Room open. Launch and wait for player two.`;
    pushTerminal(activePilots > 0 ? `> room active: ${activePilots} pilot(s)` : '> room open: waiting for player');
  } catch (_) {
    lastRoomCheck = { room, activePilots: 0, ok: false };
    $roomStatus.textContent = 'Room check failed. Verify code and connection.';
    pushTerminal('> room check failed');
  }
});

document.getElementById('btn-copy-room').addEventListener('click', async () => {
  selectMode('multiplayer');
  if (!$roomCode.value) $roomCode.value = makeRoomCode();
  const url = gameUrl().toString();
  try {
    await navigator.clipboard.writeText(url);
    $roomStatus.textContent = `Invite copied. Player two opens the link and launches.`;
    pushTerminal('> invite link copied');
  } catch (_) {
    $roomStatus.textContent = url;
    pushTerminal('> clipboard blocked: link printed');
  }
});

document.getElementById('btn-launch').addEventListener('click', () => {
  if (selectedMode === 'multiplayer' && !$roomCode.value) $roomCode.value = makeRoomCode();
  if (selectedMode === 'multiplayer') {
    const room = normalizeRoom($roomCode.value);
    if (lastRoomCheck.room !== room || !lastRoomCheck.ok) {
      $roomStatus.textContent = `Launching room ${room}. Remote pilots appear as radar contacts.`;
    }
  }
  pushTerminal('> launching gameplay');
  location.href = gameUrl().toString();
});

let terminalIdx = 0;
setInterval(() => {
  pushTerminal(TERMINAL_LINES[terminalIdx % TERMINAL_LINES.length]);
  terminalIdx += 1;
}, 2800);

const bootParams = new URLSearchParams(location.search);
if (bootParams.get('mode') && MODES[bootParams.get('mode')]) {
  selectedMode = bootParams.get('mode');
  setActive('[data-mode]', 'mode', selectedMode);
}
if (bootParams.get('aircraft') && AIRCRAFT[bootParams.get('aircraft')]) {
  selectedAircraft = bootParams.get('aircraft');
  $aircraftMenu.value = selectedAircraft;
}
if (bootParams.get('room')) $roomCode.value = normalizeRoom(bootParams.get('room'));

updateSummary();
