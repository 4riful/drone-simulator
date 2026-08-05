/* Preflight page. Collects mode + airframe (+ battle code) and hands them to
 * game.html as query params; game.html's boot block takes it from there. */

const MODES = {
  campaign: {
    brief: 'Operation Andromeda: seven story sorties with a handler on the radio, briefed and debriefed.',
    /* The campaign is reached through the game's "mission" mode, which opens
     * the sortie select screen instead of dropping straight into a free flight. */
    launchAs: 'mission',
    label: 'Campaign',
  },
  single: {
    brief: 'Balanced solo sortie with hostiles, waypoints, fuel, weather, and scoring.',
    launchAs: 'single',
    label: 'Single',
  },
  training: {
    brief: 'Flight school. No hostiles and softer scoring so you can learn the controls.',
    launchAs: 'training',
    label: 'Training',
  },
  freeflight: {
    brief: 'Open city. Practice landings, camera work, and handling with nothing shooting back.',
    launchAs: 'freeflight',
    label: 'Free Flight',
  },
  multiplayer: {
    brief: 'Create or join a two-player battle room. The other pilot shows up as a radar contact.',
    launchAs: 'multiplayer',
    label: 'Online Battle',
  },
};

const AIRCRAFT = {
  drone: 'MQ-9 Reaper',
  helicopter: 'MQ-8B Fire Scout',
};

const SUPABASE_CLIENT_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const ONLINE_CONFIG = {
  url: 'https://edmvtxoteltikuwjxdsf.supabase.co',
  key: 'sb_publishable_5OhCh1NLtCqrYjC6Y2AlOA_9zSA2K_8',
};

let selectedMode = 'single';
let selectedAircraft = 'drone';
let supabaseModulePromise = null;
let lastRoomCheck = { room: '', ok: false };

const $brief = document.getElementById('brief');
const $launchNote = document.getElementById('launch-note');
const $roomPanel = document.getElementById('room-panel');
const $roomCode = document.getElementById('room-code');
const $roomStatus = document.getElementById('room-status');

const normalizeRoom = (room) =>
  String(room || '').toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

const makeRoomCode = () => `DRN-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

function gameUrl() {
  const url = new URL('./game.html', location.href);
  url.searchParams.set('mode', MODES[selectedMode].launchAs);
  url.searchParams.set('aircraft', selectedAircraft);
  if (selectedMode === 'multiplayer') {
    url.searchParams.set('room', normalizeRoom($roomCode.value) || makeRoomCode());
  }
  return url;
}

function setActive(group, attr, value) {
  document.querySelectorAll(`#${group} [data-${attr}]`).forEach((button) => {
    const active = button.dataset[attr] === value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function updateSummary() {
  $brief.textContent = MODES[selectedMode].brief;
  $launchNote.textContent = `${MODES[selectedMode].label} · ${AIRCRAFT[selectedAircraft]}`;
  $roomPanel.classList.toggle('show', selectedMode === 'multiplayer');
}

function selectMode(mode) {
  if (!MODES[mode]) return;
  selectedMode = mode;
  setActive('mode-grid', 'mode', mode);
  if (mode === 'multiplayer' && !$roomCode.value) $roomCode.value = makeRoomCode();
  updateSummary();
}

document.getElementById('mode-grid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-mode]');
  if (button) selectMode(button.dataset.mode);
});

document.getElementById('aircraft-grid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-aircraft]');
  if (!button) return;
  selectedAircraft = button.dataset.aircraft;
  setActive('aircraft-grid', 'aircraft', selectedAircraft);
  updateSummary();
});

document.getElementById('btn-room-code').addEventListener('click', () => {
  selectMode('multiplayer');
  $roomCode.value = makeRoomCode();
  lastRoomCheck = { room: $roomCode.value, ok: true };
  $roomStatus.textContent = `Room ${$roomCode.value} ready. Send the invite to player two.`;
});

/* Optional pre-launch check: subscribe to the room's presence channel just long
 * enough to see whether anyone is already sitting in it. */
document.getElementById('btn-join-room').addEventListener('click', async () => {
  selectMode('multiplayer');
  const room = normalizeRoom($roomCode.value);
  if (!room) {
    $roomStatus.textContent = 'Enter a code, or press New code.';
    return;
  }
  $roomCode.value = room;
  $roomStatus.textContent = `Checking ${room}…`;
  try {
    if (!supabaseModulePromise) supabaseModulePromise = import(SUPABASE_CLIENT_URL);
    const { createClient } = await supabaseModulePromise;
    const client = createClient(ONLINE_CONFIG.url, ONLINE_CONFIG.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const channel = client.channel(`drone-simulator:${room}`);
    let pilots = 0;
    channel.on('presence', { event: 'sync' }, () => {
      pilots = Object.values(channel.presenceState()).reduce((n, rows) => n + rows.length, 0);
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
    lastRoomCheck = { room, ok: true };
    $roomStatus.textContent = pilots > 0
      ? `${pilots} pilot(s) already in ${room}. Launch to join them.`
      : `${room} is open. Launch and wait for player two.`;
  } catch (_) {
    lastRoomCheck = { room, ok: false };
    $roomStatus.textContent = 'Could not reach the room. Check the code and your connection.';
  }
});

document.getElementById('btn-copy-room').addEventListener('click', async () => {
  selectMode('multiplayer');
  if (!$roomCode.value) $roomCode.value = makeRoomCode();
  const url = gameUrl().toString();
  try {
    await navigator.clipboard.writeText(url);
    $roomStatus.textContent = 'Invite copied. Player two opens the link and launches.';
  } catch (_) {
    $roomStatus.textContent = url;
  }
});

document.getElementById('btn-launch').addEventListener('click', () => {
  location.href = gameUrl().toString();
});

/* Deep links (shared invites) preselect the setup. */
const boot = new URLSearchParams(location.search);
const bootMode = boot.get('mode');
if (bootMode) {
  /* Accept either the page's own keys or the game's mode names, so an invite
   * built by game.html round-trips correctly. */
  const match = MODES[bootMode]
    ? bootMode
    : Object.keys(MODES).find((key) => MODES[key].launchAs === bootMode);
  if (match) selectMode(match);
}
if (AIRCRAFT[boot.get('aircraft')]) {
  selectedAircraft = boot.get('aircraft');
  setActive('aircraft-grid', 'aircraft', selectedAircraft);
}
if (boot.get('room')) {
  $roomCode.value = normalizeRoom(boot.get('room'));
  selectMode('multiplayer');
}

updateSummary();
