const MODES = {
  single: 'Balanced solo sortie with hostiles, waypoints, fuel, weather, and scoring.',
  training: 'Safer flight school with combat pressure removed so you can learn controls.',
  mission: 'Higher-pressure sortie with stronger scoring and combat objectives.',
  freeflight: 'Open exploration mode for landing practice, camera work, and flight handling.',
  multiplayer: 'Create or join a Supabase room-code session with synced remote ghost drones.'
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
  '> realtime link: standby',
  '> gps model: browser simulated',
  '> profile storage: local indexeddb',
  '> supabase presence: room-code ready',
  '> webgl cockpit: launch isolated',
  '> map sync: remote ghosts enabled'
];

let selectedMode = 'single';
let selectedAircraft = 'drone';
let supabaseModulePromise = null;

const $modeBrief = document.getElementById('mode-brief');
const $aircraftBrief = document.getElementById('aircraft-brief');
const $launchSummary = document.getElementById('launch-summary');
const $roomPanel = document.getElementById('room-panel');
const $roomCode = document.getElementById('room-code');
const $roomStatus = document.getElementById('room-status');
const $terminalFeed = document.getElementById('terminal-feed');

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
  $modeBrief.textContent = MODES[selectedMode];
  $aircraftBrief.textContent = AIRCRAFT[selectedAircraft];
  $launchSummary.textContent = `${selectedMode.replace(/flight$/, ' flight').toUpperCase()} | ${AIRCRAFT_LABELS[selectedAircraft]}`;
  $roomPanel.hidden = selectedMode !== 'multiplayer';
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

document.getElementById('mode-grid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-mode]');
  if (!button) return;
  selectedMode = button.dataset.mode;
  setActive('[data-mode]', 'mode', selectedMode);
  if (selectedMode === 'multiplayer' && !$roomCode.value) $roomCode.value = makeRoomCode();
  updateSummary();
});

document.getElementById('aircraft-grid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-aircraft]');
  if (!button) return;
  selectedAircraft = button.dataset.aircraft;
  setActive('[data-aircraft]', 'aircraft', selectedAircraft);
  updateSummary();
});

document.getElementById('btn-room-code').addEventListener('click', () => {
  $roomCode.value = makeRoomCode();
  $roomStatus.textContent = `Room ${$roomCode.value} ready. Share the link or launch now.`;
  pushTerminal(`> created room ${$roomCode.value}`);
});

document.getElementById('btn-join-room').addEventListener('click', async () => {
  const room = normalizeRoom($roomCode.value);
  if (!room) {
    $roomStatus.textContent = 'Enter a room code first.';
    pushTerminal('> room check failed: missing code');
    return;
  }
  $roomCode.value = room;
  $roomStatus.textContent = `Checking ${room}...`;
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
    $roomStatus.textContent = activePilots > 0
      ? `Active room found: ${activePilots} pilot(s) currently online.`
      : `Room ${room} is reachable. No active pilot is visible yet.`;
    pushTerminal(activePilots > 0 ? `> room active: ${activePilots} pilot(s)` : '> room reachable: waiting for pilot');
  } catch (_) {
    $roomStatus.textContent = 'Room check failed. Recheck network or Supabase realtime access.';
    pushTerminal('> room check failed: realtime error');
  }
});

document.getElementById('btn-copy-room').addEventListener('click', async () => {
  if (!$roomCode.value) $roomCode.value = makeRoomCode();
  const url = gameUrl().toString();
  try {
    await navigator.clipboard.writeText(url);
    $roomStatus.textContent = `Invite copied for ${normalizeRoom($roomCode.value)}.`;
    pushTerminal('> invite link copied');
  } catch (_) {
    $roomStatus.textContent = url;
    pushTerminal('> clipboard blocked: link printed');
  }
});

document.getElementById('btn-launch').addEventListener('click', () => {
  if (selectedMode === 'multiplayer' && !$roomCode.value) $roomCode.value = makeRoomCode();
  pushTerminal('> launching gameplay page');
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
  setActive('[data-aircraft]', 'aircraft', selectedAircraft);
}
if (bootParams.get('room')) $roomCode.value = normalizeRoom(bootParams.get('room'));

updateSummary();
