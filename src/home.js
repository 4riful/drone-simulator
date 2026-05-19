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

let selectedMode = 'single';
let selectedAircraft = 'drone';

const $modeBrief = document.getElementById('mode-brief');
const $aircraftBrief = document.getElementById('aircraft-brief');
const $launchSummary = document.getElementById('launch-summary');
const $roomPanel = document.getElementById('room-panel');
const $roomCode = document.getElementById('room-code');
const $roomStatus = document.getElementById('room-status');

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
});

document.getElementById('btn-copy-room').addEventListener('click', async () => {
  if (!$roomCode.value) $roomCode.value = makeRoomCode();
  const url = gameUrl().toString();
  try {
    await navigator.clipboard.writeText(url);
    $roomStatus.textContent = `Invite copied for ${normalizeRoom($roomCode.value)}.`;
  } catch (_) {
    $roomStatus.textContent = url;
  }
});

document.getElementById('btn-launch').addEventListener('click', () => {
  if (selectedMode === 'multiplayer' && !$roomCode.value) $roomCode.value = makeRoomCode();
  location.href = gameUrl().toString();
});

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
