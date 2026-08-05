
import * as THREE from 'three';
import { createAtmosphere, TIME_PRESETS } from './render/atmosphere.js';
import { createPostFX } from './render/postfx.js';
import {
    CAMPAIGN, CHARACTERS, handlerFor, missionById, MissionDirector,
    STORY_LOCATIONS, normalizeProgress, isUnlocked, markComplete, defaultProgress,
} from './story/campaign.js';

const SUPABASE_CLIENT_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const C = {
    /* Larger blocks => far fewer streets. The old 44m grid produced a 12x12
     * lattice of identical roads that read as graph paper from the air; real
     * cities have a few arterials and big built-up blocks between them. */
    citySize: 500, blockSize: 84, buildChance: 0.92,
    enemyCount: 7, ringCount: 22, orbCount: 18,
    /* Physics (racing quadcopter — thrust/weight ~4:1) */
    gravity: -9.81,
    maxThrust: 42.0,          /* m/s^2 — ~4.3x gravity (racing drone power) */
    hoverThrottle: 0.24,      /* throttle to hover: gravity/maxThrust ≈ 0.234 */
    maxTiltAngle: 0.78,       /* ~45 deg max tilt (aggressive racing angle) */
    motorLag: 0.04,           /* motor response time (s) — low = snappy, high = sluggish */
    tiltSpeed: 12.0,          /* how fast drone tilts (rad/s) — snappy like a real 5" quad */
    tiltReturn: 7.0,          /* self-level speed on stick release (rad/s) */
    yawRate: 3.5,             /* max yaw speed (rad/s) */
    yawAccel: 12.0,           /* yaw angular accel */
    dragYaw: 5.0,             /* yaw damping */
    dragLin: 0.45,            /* linear air drag (lower = faster top speed) */
    dragVert: 0.6,            /* vertical air drag */
    maxSpeedH: 48,            /* ~173 km/h (fast racing drone) */
    maxSpeedV: 20,            /* ~72 km/h vertical */
    vertAccel: 18.0,          /* vertical accel from Space/Shift (m/s²) */
    hAccel: 90.0,             /* horizontal acceleration toward target velocity */
    hDecel: 70.0,             /* horizontal deceleration when changing direction */
    hCoast: 20.0,             /* passive drag-like slowdown when no input */
    vAccelUp: 28.0,           /* climb acceleration */
    vAccelDown: 24.0,         /* descend acceleration */
    vStabilize: 16.0,         /* vertical stabilization toward hover */
    brakeDrag: 10.0,          /* emergency brake damping */
    groundEffectH: 5,         /* ground effect zone (meters) */
    groundEffectMult: 0.2,    /* extra thrust from ground effect */
    boostMult: 1.6,
    /* Combat */
    bulletSpeed: 260, fireRate: 0.11,
    maxHP: 150, bldgDmg: 15, enemyDmg: 12, multiplayerDmg: 18, orbHeal: 35,
    ringPts: 100, killPts: 250,
};
const CITY_MAP = {
    name: 'Andromeda Harbor Grid',
    waterways: [
        { id:'main-river', name:'Main River', axis:'x', offset:-0.18, width:34, lengthMul:1.48, color:'#2a4850' },
        { id:'north-canal', name:'North Canal', axis:'z', offset:0.18, width:22, lengthMul:0.78, color:'#1e4355' },
    ],
    bridges: [
        { id:'central-river-bridge', name:'Central River Bridge', waterway:'main-river', xOffset:0.09 },
    ],
    districts: [
        { id:'command-base', name:'Command Base', x:-0.38, z:0.34, radius:42, color:0x63ff9c },
        { id:'downtown', name:'Downtown Core', x:-0.16, z:-0.02, radius:58, color:0x26d9ff },
        { id:'riverfront', name:'Riverfront District', x:0.18, z:-0.24, radius:46, color:0xffb84d },
        { id:'industrial', name:'Industrial Yard', x:0.34, z:0.22, radius:50, color:0xff5f5f },
    ],
    landmarks: [
        { id:'airstrip', name:'Forward Airstrip', x:-0.36, z:0.38, w:58, d:10, color:0x5b6468 },
        { id:'harbor-yard', name:'Harbor Yard', x:0.28, z:0.44, w:58, d:28, color:0x6b6258 },
    ],
    harbor: { offset:0.5, depth:260 },
};
/* Replace CITY_MAP later with user-provided districts, waterways, bridges, and landmarks. */
const S = { mode:'menu', gameMode:'single', hp:C.maxHP, score:0, kills:0, rings:0, dist:0, boost:100, boosting:false, invTimer:0 };
const WORLD = { fuel:100, windSpeed:0, windDir:0, missionSec:0, batteryV:25.2, signal:100, gps:'3D', airDensity:1, gust:0, turbulence:0, warning:'' };
let activeProfileId = 'pilot_guest';
let activeProfile = { id:'pilot_guest', name:'Viper-1', persona:'recon', preferredMode:'single' };
let selectedPersona = 'recon';
let fuelWarned = false;
let fuelEmpty = false;
let fuelCountdown = -1;
let fuelFalling = false;
let lastImpactAt = 0;
const GAME_META = {
    version: 'v3.2.0',
    note: 'Free online lab and realism roadmap'
};
const GAME_MODES = {
    single: { label:'Single', brief:'Single pilot combat sortie. Existing systems stay enabled.', enemies:true, scoreMul:1, fuelStart:100, objective:true },
    training: { label:'Training', brief:'Flight school mode: no hostile drones, slower scoring, safer fuel reserve.', enemies:false, scoreMul:0.35, fuelStart:100, objective:false },
    mission: { label:'Campaign', brief:'Operation Andromeda — seven story sorties. Opens the sortie select screen.', enemies:true, scoreMul:1.25, fuelStart:100, objective:true },
    freeflight: { label:'Free Flight', brief:'Open practice mode: explore, land, and tune controls without combat.', enemies:false, scoreMul:0, fuelStart:100, objective:false },
    multiplayer: { label:'Online Battle', brief:'Create a two-player battle room, share the invite, and fight with remote radar contacts.', enemies:false, scoreMul:1, fuelStart:100, objective:false, experimental:true }
};
const ONLINE_DEFAULTS = {
    room:'',
    url:'https://edmvtxoteltikuwjxdsf.supabase.co',
    key:'sb_publishable_5OhCh1NLtCqrYjC6Y2AlOA_9zSA2K_8'
};
const PERSONAS = {
    recon: { label:'Recon Specialist', rank:'ISR-2', badge:'RECON', brief:'Stable sensor-first pilot. Better signal discipline, lighter combat bonus.', signalBonus:8, scoreMul:0.95, fuelMul:0.96 },
    combat: { label:'Combat Pilot', rank:'CMB-3', badge:'STRIKE', brief:'Aggressive weapons pilot. Higher kill score, heavier fuel burn.', signalBonus:0, scoreMul:1.12, fuelMul:1.08 },
    test: { label:'Test Pilot', rank:'X-1', badge:'TEST', brief:'Experimental airframe evaluator. Better speed envelope, rougher turbulence exposure.', signalBonus:2, scoreMul:1.0, fuelMul:1.02 },
    instructor: { label:'Instructor', rank:'IP-1', badge:'TRAIN', brief:'Training-focused operator. Smoother missions and stronger learning profile.', signalBonus:5, scoreMul:0.9, fuelMul:0.92 }
};
function activeCallsign(){
    if(S.gameMode==='multiplayer') return multiplayerCallsign();
    return String(activeProfile?.name || 'Viper-1').trim() || 'Viper-1';
}
function expandRadioLine(line){
    const call = activeCallsign().toUpperCase();
    const wing = S.gameMode==='multiplayer' ? 'online wing' : 'flight';
    return String(line||'').replaceAll('{CALL}', call).replaceAll('{WING}', wing);
}
const CONTROL_DEFAULT = {
    deadzone: 0.08,
    expo: 0.35,
    sensPitch: 1.0,
    sensRoll: 1.0,
    sensYaw: 1.0,
    sensThrottle: 1.0,
    invertLX: false,
    invertLY: false,
    invertRX: false,
    invertRY: false,
    centerLX: 0,
    centerLY: 0,
    centerRX: 0,
    centerRY: 0,
    vehicleMode: 'drone',
};
const controlCfg = {...CONTROL_DEFAULT};
const VEHICLE_PROFILES = {
    drone: {
        name: 'MQ-9 Reaper',
        yawMul: 1.0, tiltMul: 1.0, maxHMul: 1.0, maxVMul: 1.0,
        hAccelMul: 1.0, hDecelMul: 1.0, hCoastMul: 1.0,
        vUpMul: 1.0, vDownMul: 1.0, vStabMul: 1.0, rollVisualMul: 1.0, pitchVisualMul: 1.0,
        rotorMul: 1.0
    },
    helicopter: {
        name: 'MQ-8B Fire Scout',
        yawMul: 0.8, tiltMul: 0.65, maxHMul: 0.82, maxVMul: 0.9,
        hAccelMul: 0.62, hDecelMul: 0.7, hCoastMul: 0.5,
        vUpMul: 1.2, vDownMul: 1.05, vStabMul: 0.9, rollVisualMul: 0.65, pitchVisualMul: 0.78,
        rotorMul: 1.9
    }
};

let gameDB = null;
let cloudSyncState = { enabled:false, ok:false, last:'local only', syncedRuns:0 };
function dbReqToPromise(req){
    return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
}
function dbTxDone(tx){
    return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
}
async function initDB(){
    return new Promise((resolve)=>{
        const req = indexedDB.open('xettasDroneDB', 2);
        req.onupgradeneeded = () => {
            const db = req.result;
            if(!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', {keyPath:'id'});
            if(!db.objectStoreNames.contains('runs')) db.createObjectStore('runs', {keyPath:'id', autoIncrement:true});
            if(!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', {keyPath:'id'});
        };
        req.onsuccess = ()=>{gameDB=req.result;resolve();};
        req.onerror = ()=>resolve();
    });
}
async function dbSetSetting(id, value){
    if(!gameDB){
        localStorage.setItem(`xettas.setting.${id}`, JSON.stringify(value));
        return;
    }
    const tx = gameDB.transaction('settings','readwrite');
    tx.objectStore('settings').put({id, value});
    await dbTxDone(tx);
}
async function dbGetSetting(id){
    if(!gameDB){
        const raw = localStorage.getItem(`xettas.setting.${id}`);
        return raw ? JSON.parse(raw) : null;
    }
    const tx = gameDB.transaction('settings','readonly');
    const req = tx.objectStore('settings').get(id);
    const r = await dbReqToPromise(req);
    return r ? r.value : null;
}
async function dbAddRun(run){
    if(!gameDB){
        const raw = localStorage.getItem('xettas.runs');
        const rows = raw ? JSON.parse(raw) : [];
        rows.push(run);
        localStorage.setItem('xettas.runs', JSON.stringify(rows.slice(-200)));
        return;
    }
    const tx = gameDB.transaction('runs','readwrite');
    tx.objectStore('runs').add(run);
    await dbTxDone(tx);
}
function publicProfileId(profile){
    return `web_${hashString(String(profile?.id || profile?.name || 'pilot')).toString(36)}`;
}
function profilePayload(profile){
    return {
        id: publicProfileId(profile),
        local_id: profile.id,
        callsign: profile.name,
        persona: profile.persona || 'recon',
        preferred_mode: profile.preferredMode || 'single',
        total_flights: profile.totalFlights || 0,
        total_score: profile.totalScore || 0,
        best_score: profile.bestScore || 0,
        total_distance: profile.totalDistance || 0,
        total_kills: profile.totalKills || 0,
        total_rings: profile.totalRings || 0,
        total_time: profile.totalTime || 0,
        last_played: new Date(profile.lastPlayed || Date.now()).toISOString(),
        updated_at: new Date().toISOString()
    };
}
function runPayload(run, profile){
    return {
        profile_id: publicProfileId(profile || activeProfile),
        callsign: profile?.name || activeProfile?.name || 'Viper-1',
        score: Math.round(run.score || 0),
        distance: Math.round(run.dist || 0),
        kills: Math.round(run.kills || 0),
        rings: Math.round(run.rings || 0),
        game_mode: run.gameMode || 'single',
        persona: run.persona || selectedPersona || 'recon',
        version: run.version || GAME_META.version,
        played_at: new Date(run.ts || Date.now()).toISOString()
    };
}
async function syncBattleProfileToCloud(profile=activeProfile, run=null){
    if(!profile || !ONLINE_DEFAULTS.url || !ONLINE_DEFAULTS.key) return false;
    try{
        if(!supabaseModulePromise) supabaseModulePromise = import(SUPABASE_CLIENT_URL);
        const { createClient } = await supabaseModulePromise;
        const client = supabaseClient || createClient(ONLINE_DEFAULTS.url, ONLINE_DEFAULTS.key, { auth:{ persistSession:false, autoRefreshToken:false } });
        const profileResult = await client.from('battle_profiles').upsert(profilePayload(profile), { onConflict:'id' });
        if(profileResult.error) throw profileResult.error;
        if(run){
            const runResult = await client.from('battle_runs').insert(runPayload(run, profile));
            if(runResult.error) throw runResult.error;
        }
        cloudSyncState = { enabled:true, ok:true, last:`cloud synced ${new Date().toLocaleTimeString()}`, syncedRuns:cloudSyncState.syncedRuns + (run?1:0) };
        return true;
    }catch(err){
        cloudSyncState = { ...cloudSyncState, enabled:true, ok:false, last:`cloud sync pending: ${err?.message || 'setup required'}` };
        return false;
    }
}
async function dbTopRuns(limit=5, profileId=null){
    if(!gameDB){
        const raw = localStorage.getItem('xettas.runs');
        const rows = raw ? JSON.parse(raw) : [];
        const filtered = profileId ? rows.filter(r=>r.profileId===profileId) : rows;
        return filtered.sort((a,b)=>b.score-a.score).slice(0, limit);
    }
    const tx = gameDB.transaction('runs','readonly');
    const req = tx.objectStore('runs').getAll();
    const rows = await dbReqToPromise(req);
    const filtered = profileId ? rows.filter(r=>r.profileId===profileId) : rows;
    return filtered.sort((a,b)=>b.score-a.score).slice(0, limit);
}
async function dbRecentRuns(limit=5, profileId=null){
    let rows = [];
    if(!gameDB){
        const raw = localStorage.getItem('xettas.runs');
        rows = raw ? JSON.parse(raw) : [];
    }else{
        const tx = gameDB.transaction('runs','readonly');
        const req = tx.objectStore('runs').getAll();
        rows = await dbReqToPromise(req);
    }
    const filtered = profileId ? rows.filter(r=>r.profileId===profileId) : rows;
    return filtered.sort((a,b)=>(b.ts||0)-(a.ts||0)).slice(0, limit);
}
async function dbGetProfiles(){
    if(!gameDB){
        const raw = localStorage.getItem('xettas.profiles');
        return raw ? JSON.parse(raw) : [];
    }
    const tx = gameDB.transaction('profiles','readonly');
    const req = tx.objectStore('profiles').getAll();
    return await dbReqToPromise(req);
}
async function dbSaveProfile(profile){
    if(!gameDB){
        const rows = await dbGetProfiles();
        const idx = rows.findIndex(p=>p.id===profile.id);
        if(idx>=0) rows[idx]=profile; else rows.push(profile);
        localStorage.setItem('xettas.profiles', JSON.stringify(rows));
        return;
    }
    const tx = gameDB.transaction('profiles','readwrite');
    tx.objectStore('profiles').put(profile);
    await dbTxDone(tx);
}
async function dbGetProfileById(id){
    const rows = await dbGetProfiles();
    return rows.find(p=>p.id===id) || null;
}
async function ensureDefaultProfile(){
    const profiles = await dbGetProfiles();
    if(profiles.length) return profiles;
    const p = {
        id: 'pilot_guest',
        name: 'Viper-1',
        createdAt: Date.now(),
        lastPlayed: Date.now(),
        totalFlights: 0,
        totalScore: 0,
        bestScore: 0,
        totalDistance: 0,
        totalKills: 0,
        totalRings: 0,
        totalTime: 0,
        persona: 'recon',
        preferredMode: 'single'
    };
    await dbSaveProfile(p);
    await dbSetSetting('activeProfileId', p.id);
    return [p];
}
const SPAWN = new THREE.Vector3(0, 30, 0);
const vel = new THREE.Vector3(0,0,0);
let yawVel = 0;
/* Smoothed physical tilt angles (these ARE the physics, not just visuals) */
let tiltPitch = 0;   /* forward/back tilt (rad) -- positive = nose down = forward */
let tiltRoll  = 0;   /* left/right tilt (rad)  -- positive = right side down = strafe right */
let throttle  = 0.46; /* current throttle (0-1), starts at hover */
document.getElementById('game-meta').textContent = `${GAME_META.version} | ${GAME_META.note}`;
/* Smoothed input values (motor lag simulation) */
let sInput = { fwd:0, side:0, yaw:0, vert:0, pitch:0 };
function resetState() {
    S.hp=C.maxHP; S.score=0; S.kills=0; S.rings=0; S.dist=0; S.boost=100; S.boosting=false; S.invTimer=0;
    vel.set(0,0,0); yawVel=0; tiltPitch=0; tiltRoll=0; throttle=C.hoverThrottle;
    sInput={fwd:0,side:0,yaw:0,vert:0,pitch:0};
    WORLD.fuel = 100;
    WORLD.windSpeed = 1.5 + Math.random()*4.5;
    WORLD.windDir = Math.random()*Math.PI*2;
    WORLD.missionSec = 0;
    WORLD.batteryV = 25.2;
    WORLD.signal = 100;
    WORLD.gps = '3D';
    WORLD.airDensity = 1;
    WORLD.gust = 0;
    WORLD.turbulence = 0;
    WORLD.warning = '';
    lastImpactAt = 0;
    fuelWarned = false;
    fuelEmpty = false;
    fuelCountdown = -1;
    fuelFalling = false;
}

/* ===== AUDIO ===== */
let actx;
try{actx=new (window.AudioContext||window.webkitAudioContext)();}catch(_){actx={state:'closed',currentTime:0,sampleRate:44100,destination:{},createOscillator:()=>({connect:()=>({connect:()=>({connect:()=>({})})}),start:()=>{},stop:()=>{},frequency:{value:0,setValueAtTime:()=>{},setTargetAtTime:()=>{},exponentialRampToValueAtTime:()=>{}},type:'sine',onended:null}),createGain:()=>({connect:()=>({connect:()=>({connect:()=>({})})}),gain:{value:0,setValueAtTime:()=>{},setTargetAtTime:()=>{},linearRampToValueAtTime:()=>{},exponentialRampToValueAtTime:()=>{}}}),createBuffer:(_c,l,r)=>{const b={getChannelData:()=>new Float32Array(l),length:l,sampleRate:r};return b;},createBufferSource:()=>({connect:()=>({connect:()=>({connect:()=>({})})}),start:()=>{},stop:()=>{},buffer:null,loop:false,onended:null}),createBiquadFilter:()=>({connect:()=>({connect:()=>({connect:()=>({})})}),type:'lowpass',frequency:{value:0,setValueAtTime:()=>{},setTargetAtTime:()=>{},exponentialRampToValueAtTime:()=>{}},Q:{value:0},gain:{value:0}}),resume:()=>Promise.resolve()};}
function resumeAudio() {
    try{if(actx.state==='suspended')actx.resume();}catch(_){}
    const m=document.getElementById('menu-screen'),p=document.getElementById('pause-screen'),s=document.getElementById('settings-screen');
    if((m && !m.classList.contains('hidden')) || (p && !p.classList.contains('hidden')) || (s && !s.classList.contains('hidden'))){
        startUiAmbience();
    }
}
window.addEventListener('keydown', resumeAudio);
window.addEventListener('pointerdown', resumeAudio);
if('speechSynthesis' in window){
    speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged=()=>speechSynthesis.getVoices();
}

let sndActive=0;
let uiAmbStarted=false, uiAmbNodes=[];
function stopUiAmbience(){
    for(const n of uiAmbNodes){
        try{ n.stop?.(); }catch(_){}
        try{ n.disconnect?.(); }catch(_){}
    }
    uiAmbNodes.length=0; uiAmbStarted=false;
}
function startUiAmbience(){
    try{if(uiAmbStarted || actx.state!=='running') return;}catch(_){return;}
    uiAmbStarted=true;
    const t=actx.currentTime;
    const g=actx.createGain(); g.gain.value=0.0; g.connect(actx.destination);
    g.gain.linearRampToValueAtTime(0.03, t+1.2);
    const hum=actx.createOscillator(); hum.type='triangle'; hum.frequency.value=56;
    const hum2=actx.createOscillator(); hum2.type='sine'; hum2.frequency.value=112;
    const lfo=actx.createOscillator(); lfo.type='sine'; lfo.frequency.value=0.12;
    const lfoG=actx.createGain(); lfoG.gain.value=10;
    const f=actx.createBiquadFilter(); f.type='lowpass'; f.frequency.value=420;
    hum.connect(f); hum2.connect(f); f.connect(g);
    lfo.connect(lfoG); lfoG.connect(hum.frequency);
    hum.start(); hum2.start(); lfo.start();
    uiAmbNodes.push(hum, hum2, lfo, g, f, lfoG);
}
function sndUiClick(){
    try{if(actx.state!=='running') return;
    const t=actx.currentTime, o=actx.createOscillator(), g=actx.createGain();
    o.type='triangle'; o.frequency.setValueAtTime(420,t); o.frequency.exponentialRampToValueAtTime(220,t+.08);
    g.gain.setValueAtTime(.04,t); g.gain.exponentialRampToValueAtTime(.001,t+.1);
    o.connect(g).connect(actx.destination); o.start(); o.stop(t+.1);
    }catch(_){}
}
function sndUiHover(){
    try{if(actx.state!=='running') return;
    const t=actx.currentTime, o=actx.createOscillator(), g=actx.createGain();
    o.type='sine'; o.frequency.setValueAtTime(280,t); o.frequency.exponentialRampToValueAtTime(340,t+.04);
    g.gain.setValueAtTime(.018,t); g.gain.exponentialRampToValueAtTime(.001,t+.05);
    o.connect(g).connect(actx.destination); o.start(); o.stop(t+.05);
    }catch(_){}
}
/* Pre-generated audio buffers — eliminates heavy 20K-float allocation per explosion */
const _boomBufBig=(()=>{const dur=.5,len=Math.ceil(actx.sampleRate*dur),buf=actx.createBuffer(1,len,actx.sampleRate),d=buf.getChannelData(0);for(let i=0;i<len;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/len,1.4);return buf;})();
const _boomBufSmall=(()=>{const dur=.28,len=Math.ceil(actx.sampleRate*dur),buf=actx.createBuffer(1,len,actx.sampleRate),d=buf.getChannelData(0);for(let i=0;i<len;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/len,2.0);return buf;})();
const _impactBuf=(()=>{const dur=.15,len=Math.ceil(actx.sampleRate*dur),buf=actx.createBuffer(1,len,actx.sampleRate),d=buf.getChannelData(0);for(let i=0;i<len;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/len,3.0);return buf;})();
const _crklBuf=(()=>{const dur=.35,len=Math.ceil(actx.sampleRate*dur),buf=actx.createBuffer(1,len,actx.sampleRate),d=buf.getChannelData(0);for(let i=0;i<len;i++){const env=Math.pow(1-i/len,1.8);d[i]=(Math.random()*2-1)*env*(Math.random()>.7?1.5:0.4);}return buf;})();

/* Realistic automatic gunfire sound (minigun/autocannon) */
const _gunBuf=(()=>{const dur=.08,len=Math.ceil(actx.sampleRate*dur),buf=actx.createBuffer(1,len,actx.sampleRate),d=buf.getChannelData(0);for(let i=0;i<len;i++){const env=Math.pow(1-i/len,2.5);d[i]=(Math.random()*2-1)*env*(i<len*0.05?2.5:1);}return buf;})();
const _mechBuf=(()=>{const dur=.04,len=Math.ceil(actx.sampleRate*dur),buf=actx.createBuffer(1,len,actx.sampleRate),d=buf.getChannelData(0);for(let i=0;i<len;i++){d[i]=(Math.random()*2-1)*Math.pow(1-i/len,4);}return buf;})();
function sndLaser() {
    if(sndActive>=8) return; sndActive++;
    const t=actx.currentTime;
    /* Gunshot crack (broadband transient) */
    const shot=actx.createBufferSource();shot.buffer=_gunBuf;
    const sg=actx.createGain();sg.gain.setValueAtTime(.55,t);sg.gain.exponentialRampToValueAtTime(.001,t+.10);
    const sf=actx.createBiquadFilter();sf.type='highpass';sf.frequency.value=600;
    const sf2=actx.createBiquadFilter();sf2.type='peaking';sf2.frequency.value=2200;sf2.gain.value=8;sf2.Q.value=1.5;
    shot.connect(sf).connect(sf2).connect(sg).connect(actx.destination);shot.start(t);shot.stop(t+.10);
    /* Low-freq thump (body of the shot) */
    const thump=actx.createOscillator(),tg=actx.createGain();
    thump.type='sine';thump.frequency.setValueAtTime(90+Math.random()*30,t);thump.frequency.exponentialRampToValueAtTime(25,t+.08);
    tg.gain.setValueAtTime(.35,t);tg.gain.exponentialRampToValueAtTime(.001,t+.08);
    thump.connect(tg).connect(actx.destination);thump.start(t);thump.stop(t+.08);
    /* Mechanical click (bolt cycling) */
    const mech=actx.createBufferSource();mech.buffer=_mechBuf;
    const mg=actx.createGain();mg.gain.setValueAtTime(.12,t+.015);mg.gain.exponentialRampToValueAtTime(.001,t+.06);
    const mf=actx.createBiquadFilter();mf.type='highpass';mf.frequency.value=2500;
    mech.connect(mf).connect(mg).connect(actx.destination);mech.start(t+.015);mech.stop(t+.05);
    shot.onended=()=>{sndActive--;};
}
function sndBoom(big) {
    const t=actx.currentTime, dur=big?.7:.35;
    const s=actx.createBufferSource(); s.buffer=big?_boomBufBig:_boomBufSmall;
    const g=actx.createGain(); g.gain.setValueAtTime(big?.55:.32,t); g.gain.exponentialRampToValueAtTime(.001,t+dur);
    const f=actx.createBiquadFilter(); f.type='lowpass'; f.frequency.setValueAtTime(big?800:1200,t); f.frequency.exponentialRampToValueAtTime(35,t+dur);
    s.connect(f).connect(g).connect(actx.destination); s.start(); s.stop(t+dur);
    if(big){
        /* Deep bass thud */
        const o=actx.createOscillator(),og=actx.createGain();
        o.type='sine';o.frequency.setValueAtTime(80,t);o.frequency.exponentialRampToValueAtTime(12,t+dur);
        og.gain.setValueAtTime(.45,t);og.gain.exponentialRampToValueAtTime(.001,t+dur);
        o.connect(og).connect(actx.destination);o.start();o.stop(t+dur);
        /* Debris/shrapnel crackle */
        const cr=actx.createBufferSource();cr.buffer=_crklBuf;
        const cg=actx.createGain();cg.gain.setValueAtTime(.15,t+.03);cg.gain.exponentialRampToValueAtTime(.001,t+dur);
        const cf=actx.createBiquadFilter();cf.type='highpass';cf.frequency.value=1500;
        cr.connect(cf).connect(cg).connect(actx.destination);cr.start(t+.03);cr.stop(t+dur);
        /* Secondary delayed boom (echo/reverb feel) */
        const s2=actx.createBufferSource();s2.buffer=_boomBufBig;
        const g2=actx.createGain();g2.gain.setValueAtTime(.12,t+.15);g2.gain.exponentialRampToValueAtTime(.001,t+dur+.2);
        const f2=actx.createBiquadFilter();f2.type='lowpass';f2.frequency.value=300;
        s2.connect(f2).connect(g2).connect(actx.destination);s2.start(t+.15);s2.stop(t+dur+.2);
    }
}
function sndImpact(){
    const t=actx.currentTime;
    const s=actx.createBufferSource();s.buffer=_impactBuf;
    const g=actx.createGain();g.gain.setValueAtTime(.16,t);g.gain.exponentialRampToValueAtTime(.001,t+.12);
    const f=actx.createBiquadFilter();f.type='lowpass';f.frequency.value=2200;
    s.connect(f).connect(g).connect(actx.destination);s.start();s.stop(t+.15);
}
function sndBoost(on){
    const t=actx.currentTime;
    const o=actx.createOscillator(),g=actx.createGain();
    const f=actx.createBiquadFilter();f.type='lowpass';f.frequency.value=400;
    if(on){o.type='sawtooth';o.frequency.setValueAtTime(100,t);o.frequency.exponentialRampToValueAtTime(260,t+.15);g.gain.setValueAtTime(.06,t);g.gain.exponentialRampToValueAtTime(.02,t+.15);}
    else{o.type='sawtooth';o.frequency.setValueAtTime(260,t);o.frequency.exponentialRampToValueAtTime(70,t+.2);g.gain.setValueAtTime(.04,t);g.gain.exponentialRampToValueAtTime(.001,t+.2);}
    o.connect(f).connect(g).connect(actx.destination);o.start();o.stop(t+(on?.15:.2));
}
function sndPickup(){
    const t=actx.currentTime;
    const o=actx.createOscillator(),g=actx.createGain();
    o.type='sine';o.frequency.setValueAtTime(523,t);o.frequency.setValueAtTime(659,t+.06);o.frequency.setValueAtTime(784,t+.12);
    g.gain.setValueAtTime(.12,t);g.gain.exponentialRampToValueAtTime(.001,t+.22);
    o.connect(g).connect(actx.destination);o.start();o.stop(t+.22);
    const o2=actx.createOscillator(),g2=actx.createGain();
    o2.type='triangle';o2.frequency.setValueAtTime(1047,t+.04);o2.frequency.setValueAtTime(1318,t+.1);
    g2.gain.setValueAtTime(.035,t+.04);g2.gain.exponentialRampToValueAtTime(.001,t+.2);
    o2.connect(g2).connect(actx.destination);o2.start(t+.04);o2.stop(t+.2);
}
function sndRing(){
    const t=actx.currentTime;
    /* Double military beep (positive confirmation) */
    const o=actx.createOscillator(),g=actx.createGain();
    o.type='sine';o.frequency.setValueAtTime(800,t);
    g.gain.setValueAtTime(.12,t);g.gain.setValueAtTime(.001,t+.08);g.gain.setValueAtTime(.12,t+.12);g.gain.exponentialRampToValueAtTime(.001,t+.22);
    o.connect(g).connect(actx.destination);o.start();o.stop(t+.22);
    const o2=actx.createOscillator(),g2=actx.createGain();
    o2.type='sine';o2.frequency.setValueAtTime(1000,t+.12);
    g2.gain.setValueAtTime(0,t);g2.gain.setValueAtTime(.1,t+.12);g2.gain.exponentialRampToValueAtTime(.001,t+.2);
    o2.connect(g2).connect(actx.destination);o2.start();o2.stop(t+.2);
}

/* ===== PILOT RADIO COMMS SYSTEM ===== */
const _radioBuf=(()=>{const dur=.8,len=Math.ceil(actx.sampleRate*dur),buf=actx.createBuffer(1,len,actx.sampleRate),d=buf.getChannelData(0);for(let i=0;i<len;i++){d[i]=(Math.random()*2-1)*0.45*(Math.random()>.5?1.5:0.6);}return buf;})();
let radioPlaying=false;
const RADIO_LINES = {
    kill: [
        '{CALL}, splash one hostile. Good effect on target.',
        'Copy {CALL}, target neutralized. BDA confirms kill.',
        'Hostile down. TOC confirms kill for {CALL}.',
        'Direct hit, {CALL}. Enemy drone destroyed.',
        '{CALL}, Reaper feed has eyes on the wreckage.',
    ],
    damage: [
        '{CALL} taking fire. Break and mask behind cover.',
        'Warning, incoming! Break break break!',
        '{CALL} is hit. Checking propulsion and link status.',
        'Damage sustained. {WING} check hull and battery state.',
        'Launch warning. {CALL}, descend or use buildings for cover.',
    ],
    lowFuel: [
        '{CALL}, bingo fuel. Return to base recommended.',
        '{CALL}, fuel state critical. Request vector to recovery.',
        'TOC, {CALL} is low fuel. Immediate recovery advised.',
    ],
    objective: [
        '{CALL}, objective complete. Proceed to next waypoint.',
        'Good copy {CALL}. Target area secured. Moving on.',
        'All stations, {CALL} reports objective achieved.',
    ],
    ring: [
        '{CALL}, waypoint confirmed. Continue on course.',
        'Checkpoint logged. Good positioning, {CALL}.',
        'Copy {CALL}, waypoint cleared. Maintain safe altitude.',
    ],
    startup: [
        'TOC, {CALL} is airborne. Proceeding to area of operations.',
        'All stations, {CALL} is wheels up. Sensors online.',
        '{CALL} entering theater. Link active, weapons hot.',
    ],
    lowHP: [
        '{CALL} is critical. Multiple system failures.',
        'Mayday, mayday, {CALL} has heavy damage.',
    ],
    combo: [
        'Multiple kills confirmed. {CALL} is on a streak.',
        'Splash two. Keep pressure on them, {CALL}.',
    ],
    periodic: [
        'TOC, {CALL} on station. Area looks active.',
        '{CALL}, scan sector. Multiple signatures possible.',
        '{CALL}, maintain altitude. Thermals are building.',
        'Copy command, {CALL} holding pattern over target area.',
        'ISR sweep complete. Hostile movement remains possible.',
        '{CALL}, weather advisory. Gust front building west.',
    ],
};
let lastRadioTime=0, radioQueue=[], periodicTimer=0;
function sndRadioStatic(dur=0.3, vol=0.5){
    try{ if(actx.state!=='running') return; }catch(_){ return; }
    const t=actx.currentTime;
    const s=actx.createBufferSource();s.buffer=_radioBuf;
    const g=actx.createGain();
    g.gain.setValueAtTime(vol,t);
    g.gain.setValueAtTime(vol*0.7,t+dur*0.15);
    g.gain.linearRampToValueAtTime(vol*0.5,t+dur*0.7);
    g.gain.exponentialRampToValueAtTime(0.001,t+dur);
    const hp=actx.createBiquadFilter();hp.type='highpass';hp.frequency.value=300;
    const lp=actx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=5000;
    s.connect(hp).connect(lp).connect(g).connect(actx.destination);s.start(t);s.stop(t+dur);
}
function sndRadioBeep(freq=1200,dur=0.08){
    try{ if(actx.state!=='running') return; }catch(_){ return; }
    const t=actx.currentTime;
    const o=actx.createOscillator(),g=actx.createGain();
    o.type='sine';o.frequency.value=freq;
    g.gain.setValueAtTime(0.35,t);g.gain.exponentialRampToValueAtTime(0.001,t+dur);
    o.connect(g).connect(actx.destination);o.start(t);o.stop(t+dur);
}
let _radioChannelNoise=null;
function startRadioChannelNoise(){
    try{
        if(actx.state!=='running'||_radioChannelNoise) return;
        const len=actx.sampleRate*3;
        const buf=actx.createBuffer(1,len,actx.sampleRate);
        const d=buf.getChannelData(0);
        for(let i=0;i<len;i++) d[i]=(Math.random()*2-1)*0.2*(Math.random()>.5?1.2:0.6);
        const s=actx.createBufferSource();s.buffer=buf;s.loop=true;
        const g=actx.createGain();g.gain.value=0.25;
        const lp=actx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=4500;
        s.connect(lp).connect(g).connect(actx.destination);s.start();
        _radioChannelNoise={src:s,gain:g};
    }catch(_){}
}
function stopRadioChannelNoise(){
    try{
        if(_radioChannelNoise){
            _radioChannelNoise.gain.gain.setTargetAtTime(0,actx.currentTime,0.15);
            const n=_radioChannelNoise;
            setTimeout(()=>{try{n.src.stop();}catch(_){}},500);
            _radioChannelNoise=null;
        }
    }catch(_){}
}
/* Speech synthesis for radio voice */
let _speechAvail = 'speechSynthesis' in window;
function speakRadio(text){
    if(!_speechAvail) return;
    try{
        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = 1.1;
        utter.pitch = 0.85;
        utter.volume = 0.9;
        const voices = speechSynthesis.getVoices();
        const maleVoice = voices.find(v => /male|david|james|daniel|mark/i.test(v.name) && /en/i.test(v.lang));
        if(maleVoice) utter.voice = maleVoice;
        else {
            const enVoice = voices.find(v => /en/i.test(v.lang));
            if(enVoice) utter.voice = enVoice;
        }
        speechSynthesis.cancel();
        speechSynthesis.speak(utter);
    }catch(_){}
}
function radioSpeak(category){
    if(radioPlaying) return;
    const now=performance.now();
    if(now-lastRadioTime<3000) return;
    const lines=RADIO_LINES[category];
    if(!lines||!lines.length) return;
    const text=expandRadioLine(lines[Math.floor(Math.random()*lines.length)]);
    lastRadioTime=now;
    radioPlaying=true;
    const msgDur=1500+text.length*50;
    try{
        sndRadioBeep(1400,0.15);
        setTimeout(()=>sndRadioStatic(0.4,0.5),80);
        setTimeout(()=>{
            startRadioChannelNoise();
            sndRadioStatic(0.6+Math.random()*0.3,0.3);
            speakRadio(text);
        },250);
        setTimeout(()=>{
            try{
                sndRadioStatic(0.3,0.4);
                setTimeout(()=>sndRadioBeep(1000,0.12),120);
                stopRadioChannelNoise();
            }catch(_){}
            setTimeout(()=>{radioPlaying=false;},600);
        },msgDur);
    }catch(_){radioPlaying=false;}
    showRadioMsg(text,msgDur+1000);
}
function showRadioMsg(text,dur){
    const el=document.getElementById('radio-panel');
    if(el){el.textContent=text;el.classList.add('active');
    setTimeout(()=>el.classList.remove('active'),dur||5000);}
    notify(text,'radio-note');
}
function updRadio(dt){
    periodicTimer-=dt;
    if(periodicTimer<=0){
        periodicTimer=25+Math.random()*35;
        radioSpeak('periodic');
    }
}

/* ===== HAPTICS ===== */
function vib(dur,weak,strong){if(gpIdx===null)return;const gp=navigator.getGamepads()?.[gpIdx];if(!gp)return;const a=gp.vibrationActuator||gp.hapticActuators?.[0];if(!a)return;(a.playEffect?a.playEffect('dual-rumble',{startDelay:0,duration:dur,weakMagnitude:weak,strongMagnitude:strong}):a.pulse?.(strong,dur))?.catch(()=>{});}

let shakeI=0,shakeD=0;
function shake(i,d){shakeI=i;shakeD=d;}

/* ===== SCENE ===== */
const scene = new THREE.Scene();
/* Background, fog and all lighting are owned by the atmosphere rig below. */

/* far must clear the star shell and cloud sheets; near is raised off 0.1 to buy
 * back depth precision now that decals sit coplanar with the roads. */
const camera = new THREE.PerspectiveCamera(62, innerWidth/innerHeight, 0.5, 5000);
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio||1, 1.5));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
renderer.domElement.addEventListener('webglcontextlost',(e)=>{e.preventDefault();console.warn('WebGL context lost');});
renderer.domElement.addEventListener('webglcontextrestored',()=>{console.log('WebGL context restored');});

const isMobileGPU = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const atmo = createAtmosphere(scene, renderer, {
    shadowRadius: 170,
    shadowMapSize: isMobileGPU ? 1024 : 2048,
    cloudAltitude: 320,
});
const postfx = createPostFX(renderer, scene, camera, { quality: isMobileGPU ? 'low' : 'high' });

/** Cast/receive flags, set explicitly per site — never via scene.traverse. */
function tagShadows(obj, cast, receive){
    obj.castShadow = !!cast;
    obj.receiveShadow = !!receive;
    return obj;
}

/* Render diagnostics. `window.__perf` is read by the screenshot harness; F3
 * toggles the on-screen overlay. */
const __perf = window.__perf = { calls:0, tris:0, textures:0, geometries:0, fps:0, shadowMeshes:0, tod:'dusk' };
let __perfEl = null, __perfShown = false, __frameAccum = 0, __frameCount = 0;
/* The composer resets renderer.info on every pass, so totals have to be
 * accumulated manually across the shadow pass, scene pass and post chain. */
renderer.info.autoReset = false;
function updatePerf(dt){
    const info = renderer.info;
    __perf.calls = info.render.calls;
    __perf.tris = info.render.triangles;
    __perf.textures = info.memory.textures;
    __perf.geometries = info.memory.geometries;
    __frameAccum += dt; __frameCount++;
    if(__frameAccum >= 0.5){ __perf.fps = Math.round(__frameCount/__frameAccum); __frameAccum = 0; __frameCount = 0; }
    if(__perfShown && __perfEl){
        __perfEl.textContent = `calls ${__perf.calls} | tris ${(__perf.tris/1000).toFixed(0)}k | tex ${__perf.textures} | geo ${__perf.geometries} | ${__perf.fps}fps | ${__perf.tod}`;
    }
}
window.addEventListener('keydown',e=>{
    if(e.code!=='F3') return;
    __perfShown = !__perfShown;
    if(!__perfEl){
        __perfEl = document.createElement('div');
        __perfEl.style.cssText='position:fixed;top:4px;left:50%;transform:translateX(-50%);z-index:9999;font:11px monospace;color:#9fe8b0;background:rgba(0,0,0,.7);padding:3px 8px;pointer-events:none';
        document.body.appendChild(__perfEl);
    }
    __perfEl.style.display = __perfShown ? 'block' : 'none';
});

/** Time of day drives sky, lighting, grade, and artificial-light intensity. */
const facadeMaterials = [];
const lampMaterials = [];
function applyTimeOfDay(key){
    atmo.setTimeOfDay(key);
    postfx.applyPreset(key);
    for(const m of facadeMaterials){
        if(m.userData.baseEmissive === undefined) m.userData.baseEmissive = m.emissiveIntensity;
        m.emissiveIntensity = m.userData.baseEmissive * atmo.windowLights;
    }
    for(const m of lampMaterials){
        if(m.userData.baseOpacity === undefined) m.userData.baseOpacity = m.opacity ?? 1;
        m.opacity = m.userData.baseOpacity * Math.max(0.15, atmo.streetLights);
    }
    __perf.tod = key;
}
window.__setTOD = applyTimeOfDay;
window.__atmo = atmo;
window.__renderer = renderer;
window.__scene = scene;

/* ===== DAMAGE / BOOST OVERLAYS ===== */
const dmgFlash = document.getElementById('dmg-flash');
const boostLines = document.getElementById('boost-lines');
const killFeed = document.getElementById('kill-feed');
const lowHpWarn = document.getElementById('low-hp-warn');
function notify(msg, cls='kill-note'){
    const el=document.createElement('div'); el.className=cls; el.textContent=msg;
    killFeed.appendChild(el); setTimeout(()=>el.remove(), 2000);
}

let supabaseModulePromise = null;
let supabaseClient = null;
let onlineChannel = null;
let onlineConnected = false;
let onlineLastBroadcast = 0;
let onlineLastPresence = 0;
let onlinePresenceCount = 0;
let onlineReconnectTimer = null;
let onlineReconnectAttempts = 0;
const onlineStats = { sent:0, received:0, joins:0, hits:0, lastReceiveAt:0, lastStatus:'OFF' };
let onlineConfig = {...ONLINE_DEFAULTS};
const onlineClientId = `pilot_${(globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`).replace(/[^a-zA-Z0-9_-]/g,'')}`;
const onlineCallsign = `RAVEN-${hashString(onlineClientId).toString(36).slice(-3).toUpperCase()}`;
const remotePilots = new Map();
const receivedOnlineHits = new Set();
let localRoomChannel = null;
let localRoomKey = '';
let localRoomConnected = false;
let localRoomStorageHandler = null;
function normalizeRoomId(room){
    return String(room||'').toUpperCase().replace(/[^A-Z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,24);
}
function makeRoomCode(){
    return `DRN-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
}
function hashString(text){
    let h = 2166136261;
    for(const ch of String(text||'')){
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}
function seededRandom(seedText){
    let seed = hashString(seedText) || 1;
    return () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
    };
}
function withSeededRandom(seedText, fn){
    const originalRandom = Math.random;
    Math.random = seededRandom(seedText);
    try { return fn(); }
    finally { Math.random = originalRandom; }
}
function getRoomFromUrl(){
    return normalizeRoomId(new URLSearchParams(location.search).get('room'));
}
function getBootParams(){
    const params = new URLSearchParams(location.search);
    return {
        mode: params.get('mode') || '',
        aircraft: params.get('aircraft') || '',
        room: normalizeRoomId(params.get('room'))
    };
}
function roomInviteUrl(){
    const room = normalizeRoomId(onlineConfig.room);
    const url = new URL('./game.html', location.href);
    url.searchParams.set('mode', 'multiplayer');
    url.searchParams.set('aircraft', controlCfg.vehicleMode === 'helicopter' ? 'helicopter' : 'drone');
    url.searchParams.set('room', room || makeRoomCode());
    return url.toString();
}
function multiplayerCallsign(){
    const base = String(activeProfile?.name || '').trim();
    if(S.gameMode!=='multiplayer') return base || 'Viper-1';
    if(!base || /^viper-?1$/i.test(base)) return onlineCallsign;
    const cleanBase = base.toUpperCase().replace(/[^A-Z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,12) || 'PILOT';
    return `${cleanBase}-${onlineCallsign.slice(-3)}`;
}
function setOnlineStatus(text, kind='warn'){
    const el=document.getElementById('online-status');
    if(el){el.textContent=text;el.classList.remove('online-good','online-warn','online-bad');el.classList.add(`online-${kind}`);}
    onlineStats.lastStatus = text;
    const count = Math.max(remotePilots.size + 1, onlinePresenceCount || 0);
    if(ssOnline){ssOnline.textContent = (onlineConnected || localRoomConnected) ? `${count}` : 'OFF';ssOnline.classList.toggle('warn-sys', kind==='warn');ssOnline.classList.toggle('bad-sys', kind==='bad');}
}
async function loadOnlineConfig(){
    const saved = await dbGetSetting('onlineConfig');
    onlineConfig = {...ONLINE_DEFAULTS, ...(saved||{})};
    onlineConfig.url = ONLINE_DEFAULTS.url;
    onlineConfig.key = ONLINE_DEFAULTS.key;
    onlineConfig.room = getRoomFromUrl() || normalizeRoomId(onlineConfig.room) || makeRoomCode();
    const roomEl=document.getElementById('online-room');
    if(roomEl) roomEl.value=onlineConfig.room;
    setOnlineStatus(`Ready. Room ${onlineConfig.room}`, 'good');
}
async function saveOnlineRoom(room=null){
    const roomEl=document.getElementById('online-room');
    onlineConfig = {
        ...onlineConfig,
        room: normalizeRoomId(room || roomEl?.value || onlineConfig.room || makeRoomCode()),
        url: ONLINE_DEFAULTS.url,
        key: ONLINE_DEFAULTS.key
    };
    if(roomEl) roomEl.value=onlineConfig.room;
    await dbSetSetting('onlineConfig', onlineConfig);
    setOnlineStatus(`Ready. Room ${onlineConfig.room}`, 'good');
    return onlineConfig.room;
}
async function createOnlineRoom(){
    const room = await saveOnlineRoom(makeRoomCode());
    setGameMode('multiplayer');
    notify(`ROOM ${room} CREATED`,'ring-note');
}
async function joinOnlineRoom(){
    const room = await saveOnlineRoom();
    setGameMode('multiplayer');
    setOnlineStatus(`Checking room ${room}...`, 'warn');
    try{
        const activePilots = await checkOnlineRoomPresence(room);
        setOnlineStatus(activePilots>0 ? `Active room found: ${activePilots} pilot(s) online` : `Room ${room} reachable - waiting for pilot`, activePilots>0?'good':'warn');
        notify(activePilots>0 ? `JOIN ROOM ${room}` : `ROOM ${room} READY`,'ring-note');
    }catch(_){
        setOnlineStatus('Room check failed. Recheck network or code.', 'bad');
        notify('ROOM CHECK FAILED','kill-note');
    }
}
async function copyOnlineInvite(){
    const room = await saveOnlineRoom();
    const url = roomInviteUrl();
    try{
        await navigator.clipboard.writeText(url);
        setOnlineStatus(`Invite copied for ${room}`, 'good');
        notify('INVITE LINK COPIED','ring-note');
    }catch(_){
        setOnlineStatus(url, 'good');
        notify('COPY LINK FROM ROOM STATUS','ring-note');
    }
}
function getOnlineStateLabel(){
    if(onlineConnected) return `Room ${onlineConfig.room}: ${Math.max(remotePilots.size+1, onlinePresenceCount||0)} pilot(s) via Supabase`;
    if(localRoomConnected) return `Room ${onlineConfig.room}: local tab fallback only`;
    return onlineConfig.room ? `Ready. Battle ${onlineConfig.room}` : 'Ready. Create or join a battle.';
}
async function checkOnlineRoomPresence(room){
    const checkedRoom = normalizeRoomId(room);
    if(!checkedRoom) throw new Error('missing room');
    if(!supabaseModulePromise) supabaseModulePromise = import(SUPABASE_CLIENT_URL);
    const { createClient } = await supabaseModulePromise;
    const client = supabaseClient || createClient(onlineConfig.url, onlineConfig.key, { auth:{ persistSession:false, autoRefreshToken:false } });
    const channel = client.channel(`drone-simulator:${checkedRoom}`);
    let activePilots = 0;
    channel.on('presence',{event:'sync'},()=>{
        activePilots = Object.values(channel.presenceState()).reduce((n,rows)=>n+rows.length,0);
    });
    await new Promise((resolve,reject)=>{
        const timer=setTimeout(resolve,1800);
        channel.subscribe(status=>{
            if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED'){
                clearTimeout(timer);reject(new Error(status));
            }
        });
    });
    try{await channel.unsubscribe();}catch(_){}
    return activePilots;
}
function updateOnlineStatus(){
    if(!onlineConnected){ setOnlineStatus(getOnlineStateLabel(), localRoomConnected ? 'warn' : 'good'); return; }
    const remoteCount = remotePilots.size;
    const pilotCount = Math.max(remoteCount + 1, onlinePresenceCount || 0);
    const txt = remoteCount ? `Room ${onlineConfig.room}: ${pilotCount} pilot(s) - ${remoteCount} battle contact(s)` : `Room ${onlineConfig.room}: ${pilotCount} pilot(s), waiting for battle packets`;
    setOnlineStatus(txt, remoteCount ? 'good' : 'warn');
}
function scheduleOnlineReconnect(reason='closed'){
    if(S.gameMode!=='multiplayer' || S.mode!=='playing' || !onlineConfig.room) return;
    if(onlineReconnectTimer) return;
    onlineConnected=false;
    const delay = Math.min(8000, 1200 + onlineReconnectAttempts * 900);
    onlineReconnectAttempts++;
    setOnlineStatus(`Room ${onlineConfig.room}: Supabase ${reason.toLowerCase()} - reconnecting`, 'warn');
    onlineReconnectTimer = setTimeout(()=>{
        onlineReconnectTimer=null;
        connectOnlineRoom({ preserveLocal:true }).catch(()=>scheduleOnlineReconnect('failed'));
    }, delay);
}
function makeRemoteDrone(){
    const g = new THREE.Group();
    const rMat = new THREE.MeshStandardMaterial({color:0xcc1a2a,emissive:0xff2638,emissiveIntensity:.35,roughness:.35,metalness:.8});
    const rShellMat = new THREE.MeshStandardMaterial({color:0xdd2a3a,roughness:.38,metalness:.75});
    const rArmMat = new THREE.MeshStandardMaterial({color:0xaa1828,roughness:.35,metalness:.8});
    const rMotorMat = new THREE.MeshStandardMaterial({color:0xbb2030,roughness:.3,metalness:.85});
    const rAccentMat = new THREE.MeshStandardMaterial({color:0xff3348,emissive:0xff2638,emissiveIntensity:.6,roughness:.3});
    const rGuardMat = new THREE.MeshStandardMaterial({color:0xaa1828,roughness:.38,metalness:.78});
    const rGunMat = new THREE.MeshStandardMaterial({color:0x882030,emissive:0x101010,emissiveIntensity:.05,roughness:.25,metalness:.92});
    const rDiscMat = new THREE.MeshBasicMaterial({color:0xff3348,transparent:true,opacity:.18,side:THREE.DoubleSide,depthWrite:false});
    const rBladeMat = new THREE.MeshBasicMaterial({color:0xff3348,transparent:true,opacity:.35,side:THREE.DoubleSide,depthWrite:false});
    const rSkidMat = new THREE.MeshStandardMaterial({color:0xaa2030,roughness:.5,metalness:.8});
    const rHPBarMat = new THREE.MeshBasicMaterial({color:0x49ff9a});
    const armGeo = new THREE.BoxGeometry(.22,.08,2.8);
    const guardGeo = new THREE.TorusGeometry(.92,.035,6,20);
    const bladeMat2 = new THREE.MeshBasicMaterial({color:0xff3348,transparent:true,opacity:.3,side:THREE.DoubleSide,depthWrite:false});
    const armTips = [
        {x:2,z:-2,front:true},{x:-2,z:-2,front:true},
        {x:2,z:2,front:false},{x:-2,z:2,front:false}
    ];
    armTips.forEach(tip=>{
        const angle=Math.atan2(tip.x,tip.z);
        const dist=Math.sqrt(tip.x*tip.x+tip.z*tip.z);
        const midX=tip.x*.55,midZ=tip.z*.55;
        const arm=new THREE.Mesh(armGeo,rArmMat);
        arm.position.set(midX,.02,midZ);arm.rotation.y=-angle;g.add(arm);
        const ledStrip=new THREE.Mesh(new THREE.BoxGeometry(.1,.015,2.5),rAccentMat);
        ledStrip.position.set(midX,.065,midZ);ledStrip.rotation.y=-angle;g.add(ledStrip);
        const motor=new THREE.Mesh(new THREE.CylinderGeometry(.3,.34,.2,10),rMotorMat);
        motor.position.set(tip.x,.12,tip.z);g.add(motor);
        const motorCap=new THREE.Mesh(new THREE.CylinderGeometry(.15,.3,.1,10),rMotorMat);
        motorCap.position.set(tip.x,.24,tip.z);g.add(motorCap);
        const disc=new THREE.Mesh(new THREE.CircleGeometry(.85,20),rDiscMat);
        disc.rotation.x=-Math.PI/2;disc.position.set(tip.x,.3,tip.z);g.add(disc);
        for(let b=0;b<2;b++){
            const blade=new THREE.Mesh(new THREE.PlaneGeometry(.12,.8),rBladeMat);
            blade.rotation.x=-Math.PI/2;blade.rotation.z=b*Math.PI/2;blade.position.set(tip.x,.31,tip.z);g.add(blade);
        }
        const guard=new THREE.Mesh(guardGeo,rGuardMat);
        guard.rotation.x=-Math.PI/2;guard.position.set(tip.x,.2,tip.z);g.add(guard);
        for(let s=0;s<4;s++){
            const sa=s*Math.PI/2;
            const strut=new THREE.Mesh(new THREE.BoxGeometry(.03,.04,.6),rGuardMat);
            strut.position.set(tip.x+Math.cos(sa)*.46,.2,tip.z+Math.sin(sa)*.46);
            strut.rotation.y=sa;g.add(strut);
        }
        const ledColor=tip.front?0xff4080:0xff4040;
        const led=new THREE.Mesh(new THREE.SphereGeometry(.06,6,6),new THREE.MeshBasicMaterial({color:ledColor}));
        led.position.set(tip.x,.08,tip.z+(tip.front?-.35:.35));g.add(led);
    });
    const bodyLower=new THREE.Mesh(new THREE.CylinderGeometry(1.3,1.5,.35,6),rMat);
    g.add(bodyLower);
    const bodyUpper=new THREE.Mesh(new THREE.CylinderGeometry(.75,1.3,.22,6),rShellMat);
    bodyUpper.position.y=.28;g.add(bodyUpper);
    const bodyTop=new THREE.Mesh(new THREE.CylinderGeometry(.3,.75,.12,6),rShellMat);
    bodyTop.position.y=.4;g.add(bodyTop);
    const camDome=new THREE.Mesh(new THREE.SphereGeometry(.2,10,8,0,Math.PI*2,0,Math.PI/2),
        new THREE.MeshStandardMaterial({color:0x151a20,roughness:.08,metalness:1,emissive:0x532f2f,emissiveIntensity:.3}));
    camDome.rotation.x=Math.PI;camDome.position.set(0,-.22,-1.1);g.add(camDome);
    const battery=new THREE.Mesh(new THREE.BoxGeometry(.7,.12,1.3),new THREE.MeshStandardMaterial({color:0x381a1a,roughness:.5,metalness:.7}));
    battery.position.set(0,-.22,0);g.add(battery);
    [-0.55,0.55].forEach(xo=>{
        const skid=new THREE.Mesh(new THREE.BoxGeometry(.05,.3,1.4),rSkidMat);
        skid.position.set(xo,-.38,0);g.add(skid);
        [-.5,.5].forEach(zo=>{
            const strut=new THREE.Mesh(new THREE.BoxGeometry(.04,.25,.04),rSkidMat);
            strut.position.set(xo,-.25,zo);strut.rotation.z=xo>0?-.2:.2;g.add(strut);
        });
    });
    const gunPosL=new THREE.Vector3(-1.2,-.12,-2.0);
    const gunPosR=new THREE.Vector3(1.2,-.12,-2.0);
    [gunPosL,gunPosR].forEach(gp=>{
        const barrel=new THREE.Mesh(new THREE.CylinderGeometry(.07,.07,1.2,6),rGunMat);
        barrel.rotation.x=Math.PI/2;barrel.position.copy(gp);g.add(barrel);
        const muzzle=new THREE.Mesh(new THREE.CylinderGeometry(.09,.07,.15,6),rAccentMat);
        muzzle.rotation.x=Math.PI/2;muzzle.position.set(gp.x,gp.y,gp.z-.65);g.add(muzzle);
    });
    const navLightL=new THREE.Mesh(new THREE.SphereGeometry(.1,6,6),new THREE.MeshBasicMaterial({color:0xff0000}));
    navLightL.position.set(-1.85,.05,0);g.add(navLightL);
    const navLightR=new THREE.Mesh(new THREE.SphereGeometry(.1,6,6),new THREE.MeshBasicMaterial({color:0x00ff00}));
    navLightR.position.set(1.85,.05,0);g.add(navLightR);
    const strobeTop=new THREE.Mesh(new THREE.SphereGeometry(.07,6,6),new THREE.MeshBasicMaterial({color:0xffffff}));
    strobeTop.position.set(0,.35,.3);g.add(strobeTop);
    const strobeBtm=new THREE.Mesh(new THREE.SphereGeometry(.07,6,6),new THREE.MeshBasicMaterial({color:0xffffff}));
    strobeBtm.position.set(0,-.35,.3);g.add(strobeBtm);
    const tailLight=new THREE.Mesh(new THREE.SphereGeometry(.1,6,6),new THREE.MeshBasicMaterial({color:0xff2200}));
    tailLight.position.set(0,.08,1.6);g.add(tailLight);
    const hpBar=new THREE.Mesh(new THREE.BoxGeometry(2.6,.08,.12),rHPBarMat);
    hpBar.position.set(0,2.0,0);
    const label=document.createElement('div');label.className='remote-drone-label';label.textContent='ENEMY';label.style.display='none';document.body.appendChild(label);
    g.add(hpBar);g.userData.label=label;g.userData.hpBar=hpBar;g.visible=false;scene.add(g);return g;
}
function ensureRemotePilot(id,state){
    const isNew = !remotePilots.has(id);
    if(isNew) remotePilots.set(id,{mesh:makeRemoteDrone(),lastSeen:performance.now(),state:null,hp:C.maxHP,hitUntil:0});
    if(isNew) notify(`ENEMY JOINED ${state.name||'REMOTE'}`,'kill-note');
    const rp=remotePilots.get(id);rp.lastSeen=performance.now();rp.state=state;rp.hp=Number.isFinite(state.hp)?state.hp:rp.hp;return rp;
}
function handleRemoteState(state){
    if(!state || state.id===onlineClientId || !Array.isArray(state.p) || !Array.isArray(state.q)) return;
    onlineStats.received++;
    onlineStats.lastReceiveAt = performance.now();
    ensureRemotePilot(state.id, state);
    updateOnlineStatus();
}
function removeRemotePilot(id){
    const rp=remotePilots.get(id);if(!rp)return;
    scene.remove(rp.mesh);rp.mesh.userData.label?.remove();remotePilots.delete(id);updateOnlineStatus();
}
function cleanupRemotePilots(){
    for(const id of [...remotePilots.keys()]) removeRemotePilot(id);
}
function updateRemotePilots(dt){
    const now=performance.now();
    for(const [id,rp] of remotePilots){
        if(now-rp.lastSeen>45000){removeRemotePilot(id);continue;}
        const s=rp.state;if(!s)continue;
        rp.mesh.visible=true;
        rp.mesh.position.lerp(new THREE.Vector3(s.p[0],s.p[1],s.p[2]),Math.min(1,dt*8));
        rp.mesh.quaternion.slerp(new THREE.Quaternion(s.q[0],s.q[1],s.q[2],s.q[3]),Math.min(1,dt*8));
        if(rp.mesh.userData.hpBar){
            const hpPct = THREE.MathUtils.clamp((rp.hp ?? C.maxHP) / C.maxHP, 0, 1);
            rp.mesh.userData.hpBar.scale.x = Math.max(.05, hpPct);
            rp.mesh.userData.hpBar.material.color.setHex(hpPct > .5 ? 0x49ff9a : (hpPct > .25 ? 0xffd166 : 0xff4b6e));
        }
        const isHit = now < rp.hitUntil;
        for(const child of rp.mesh.children){
            if(child.material && child !== rp.mesh.userData.hpBar){
                if(child.material.emissive) child.material.emissive.setHex(isHit ? 0xffffff : 0x440000);
                if(child.material.color) child.material.color.setHex(isHit ? 0xffffff : 0xcc1a2a);
            }
        }
        const label=rp.mesh.userData.label;
        if(label){
            const v=rp.mesh.position.clone().project(camera);
            const on=v.z<1&&Math.abs(v.x)<1.2&&Math.abs(v.y)<1.2;
            label.style.display=on?'block':'none';
            if(on){
                label.style.left=((v.x*.5+.5)*innerWidth)+'px';
                label.style.top=((-v.y*.5+.5)*innerHeight-28)+'px';
                label.style.opacity='0.45';
                label.style.fontSize='8px';
                label.style.padding='2px 4px';
                label.textContent=`${s.name||'REMOTE'} ${Math.max(0,Math.round(rp.hp ?? C.maxHP))}HP`;
            }
        }
    }
}
function nearestRemotePilot(maxDist=500){
    let best=null, bestD=maxDist;
    let bestId='';
    for(const [id,rp] of remotePilots){
        if(!rp.mesh.visible || (rp.hp ?? C.maxHP) <= 0) continue;
        const d=drone.position.distanceTo(rp.mesh.position);
        if(d<bestD){best=rp;bestD=d;bestId=id;}
    }
    return best ? { id:bestId, rp:best, d:bestD } : null;
}
function remoteLockInfo(){
    if(S.gameMode!=='multiplayer' || !lockTarget) return null;
    for(const [id,rp] of remotePilots){
        if(rp.mesh===lockTarget && rp.mesh.visible && (rp.hp ?? C.maxHP) > 0) return { id, rp };
    }
    return null;
}
function applyRemoteHit(id, damage=C.multiplayerDmg){
    const rp=remotePilots.get(id);
    if(!rp) return;
    rp.hp = Math.max(0, (rp.hp ?? C.maxHP) - damage);
    rp.hitUntil = performance.now() + 180;
    boom(rp.mesh.position.clone(), rp.hp > 0);
}
function sendOnlineBroadcast(event, payload){
    if(!onlineConnected || !onlineChannel) return;
    try{
        onlineStats.sent++;
        onlineChannel.send({ type:'broadcast', event, payload }).catch(()=>{});
    }catch(_){}
}
function sendOnlineHit(targetId, pos){
    if(!targetId) return;
    const hit = { hitId:`${onlineClientId}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, from:onlineClientId, target:targetId, damage:C.multiplayerDmg, p:[pos.x,pos.y,pos.z], ts:Date.now() };
    sendLocalRoomMessage('hit', hit);
    sendOnlineBroadcast('hit', hit);
}
function receiveOnlineHit(hit){
    if(!hit || hit.target !== onlineClientId || receivedOnlineHits.has(hit.hitId)) return;
    receivedOnlineHits.add(hit.hitId);
    onlineStats.hits++;
    if(receivedOnlineHits.size > 80) receivedOnlineHits.delete(receivedOnlineHits.values().next().value);
    if(Array.isArray(hit.p)) boom(new THREE.Vector3(hit.p[0], hit.p[1], hit.p[2]), true);
    takeDmg(Number(hit.damage) || C.multiplayerDmg, `${hit.from||'REMOTE'} HIT`);
}
function localRoomMessage(room, type, payload){
    return { room:normalizeRoomId(room), type, payload, source:onlineClientId, ts:Date.now() };
}
function handleLocalRoomMessage(msg){
    if(!msg || msg.source===onlineClientId || normalizeRoomId(msg.room)!==normalizeRoomId(onlineConfig.room)) return;
    if(msg.type==='state'){
        const s=msg.payload;
        handleRemoteState(s);
    }else if(msg.type==='hit'){
        receiveOnlineHit(msg.payload);
    }
}
function sendLocalRoomMessage(type, payload){
    const msg = localRoomMessage(onlineConfig.room, type, payload);
    if(localRoomConnected && localRoomKey){
        try{localRoomChannel?.postMessage(msg);}catch(_){}
        try{localStorage.setItem(localRoomKey, JSON.stringify(msg));}catch(_){}
    }
}
function startLocalRoom(room){
    stopLocalRoom();
    const normalizedRoom = normalizeRoomId(room);
    if(!normalizedRoom) return;
    localRoomKey = `drone-simulator-room:${normalizedRoom}`;
    localRoomConnected = true;
    if('BroadcastChannel' in globalThis){
        localRoomChannel = new BroadcastChannel(localRoomKey);
        localRoomChannel.onmessage = e => handleLocalRoomMessage(e.data);
    }
    localRoomStorageHandler = e => {
        if(e.key!==localRoomKey || !e.newValue) return;
        try{handleLocalRoomMessage(JSON.parse(e.newValue));}catch(_){}
    };
    window.addEventListener('storage', localRoomStorageHandler);
}
function stopLocalRoom(){
    if(localRoomChannel){try{localRoomChannel.close();}catch(_){} localRoomChannel=null;}
    if(localRoomStorageHandler){window.removeEventListener('storage', localRoomStorageHandler);localRoomStorageHandler=null;}
    localRoomKey='';localRoomConnected=false;
}
async function connectOnlineRoom(options={}){
    const preserveLocal = !!options.preserveLocal;
    if(S.gameMode!=='multiplayer') return;
    await saveOnlineRoom();
    if(!onlineConfig.room){setOnlineStatus('Create or enter a battle code first.', 'bad');notify('CREATE OR JOIN BATTLE','kill-note');return;}
    if(onlineReconnectTimer){clearTimeout(onlineReconnectTimer);onlineReconnectTimer=null;}
    if(onlineChannel){try{await onlineChannel.unsubscribe();}catch(_){} onlineChannel=null;onlineConnected=false;}
    if(!preserveLocal && localRoomConnected) await disconnectOnlineRoom();
    const room = normalizeRoomId(onlineConfig.room);
    if(!localRoomConnected) startLocalRoom(room);
    setOnlineStatus(`Connecting Supabase room ${room}...`, 'warn');
    if(!onlineConfig.url||!onlineConfig.key){setOnlineStatus(`Room ${room}: local tab fallback only - Supabase config missing`, 'bad');notify('SUPABASE CONFIG MISSING','kill-note');return;}
    try{
        if(!supabaseModulePromise) supabaseModulePromise = import(SUPABASE_CLIENT_URL);
        const { createClient } = await supabaseModulePromise;
        if(!supabaseClient) supabaseClient = createClient(onlineConfig.url, onlineConfig.key, { auth:{ persistSession:false, autoRefreshToken:false } });
        onlineChannel = supabaseClient.channel(`drone-simulator:${room}`, { config:{ broadcast:{ self:false }, presence:{ key: onlineClientId } } });
        onlineChannel.on('presence',{event:'sync'},()=>{
            const state=onlineChannel.presenceState();
            onlinePresenceCount = Object.values(state).reduce((n,rows)=>n+(Array.isArray(rows)?rows.length:0),0);
            updateOnlineStatus();
        });
        onlineChannel.on('broadcast',{event:'state'},payload=>{
            handleRemoteState(payload.payload);
        });
        onlineChannel.on('broadcast',{event:'join'},payload=>{
            const join = payload.payload;
            if(!join || join.id===onlineClientId) return;
            onlineStats.joins++;
            sendOnlineBroadcast('state', onlinePayload());
            notify(`ROOM CONTACT ${join.name||'REMOTE'}`,'ring-note');
        });
        onlineChannel.on('broadcast',{event:'hit'},payload=>receiveOnlineHit(payload.payload));
        onlineChannel.subscribe(async status=>{
            if(status==='SUBSCRIBED'){
                onlineConnected=true;onlineReconnectAttempts=0;onlineLastBroadcast=0;onlineLastPresence=0;updateOnlineStatus();notify(`SUPABASE ROOM ${room}`,'ring-note');
                await trackOnlineState(true);
                sendOnlineBroadcast('join', { id:onlineClientId, name:multiplayerCallsign(), room, ts:Date.now() });
                for(let i=1;i<=5;i++) setTimeout(()=>trackOnlineState(true).catch(()=>{}), i*250);
            }else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED'){
                scheduleOnlineReconnect(status);
            }
        });
    }catch(e){console.warn('Online connect failed',e);onlineConnected=false;scheduleOnlineReconnect('failed');notify('SUPABASE CONNECT FAILED','kill-note');}
}
async function disconnectOnlineRoom(){
    if(onlineReconnectTimer){clearTimeout(onlineReconnectTimer);onlineReconnectTimer=null;}
    if(onlineChannel){try{await onlineChannel.untrack();await onlineChannel.unsubscribe();}catch(_){}}
    stopLocalRoom();onlineChannel=null;onlineConnected=false;onlinePresenceCount=0;onlineReconnectAttempts=0;cleanupRemotePilots();setOnlineStatus(getOnlineStateLabel(), 'good');
}
function onlinePayload(){
    return { id:onlineClientId, profileId:activeProfileId, name:multiplayerCallsign(), team:'enemy', persona:selectedPersona, aircraft:controlCfg.vehicleMode, hp:Math.round(S.hp), maxHp:C.maxHP, fuel:Math.round(WORLD.fuel), mode:S.gameMode, p:[drone.position.x,drone.position.y,drone.position.z], q:[drone.quaternion.x,drone.quaternion.y,drone.quaternion.z,drone.quaternion.w], v:[vel.x,vel.y,vel.z], ts:Date.now() };
}
async function trackOnlineState(force=false){
    if(S.gameMode!=='multiplayer' || (!localRoomConnected && (!onlineConnected||!onlineChannel))) return;
    const now=performance.now();
    if(!force&&now-onlineLastBroadcast<100) return;
    onlineLastBroadcast=now;
    const payload=onlinePayload();
    sendLocalRoomMessage('state', payload);
    if(onlineConnected&&onlineChannel){
        try{
            sendOnlineBroadcast('state', payload);
            if(force || now-onlineLastPresence>2000){onlineLastPresence=now;await onlineChannel.track(payload);}
        }catch(e){console.warn('Online track failed',e);}
    }
}

/* Sky, stars and clouds come from the atmosphere rig (src/render/atmosphere.js). */

/* Ground */
const gnd=new THREE.Mesh(new THREE.PlaneGeometry(3000,3000),new THREE.MeshStandardMaterial({color:0x3a3830,roughness:0.95}));
gnd.rotation.x=-Math.PI/2; gnd.position.y=-0.1; tagShadows(gnd,false,true); scene.add(gnd);

/* ===== WINDOW TEXTURE GENERATOR (HD) ===== */
const winTextures = [];
function initWinTex(count) {
    const warmPal=['#c8a878','#d8bc90','#b09058','#c8b088','#a08850'];
    const coolPal=['#8fa8c0','#7c98b4','#98b0c4','#88a0b8','#7088a0'];
    const neonPal=['#ffdd99','#ffe4aa','#ffd980','#ffe8bb','#ffe0aa','#f0cc88'];
    for(let n=0;n<count;n++){
        /* Two canvases per family: albedo (what the surface looks like unlit)
         * and emissive (ONLY the lit window panes — the old code reused the
         * albedo as its own emissiveMap, which made the concrete glow). */
        const cv=document.createElement('canvas'); cv.width=256; cv.height=512;
        const cx=cv.getContext('2d');
        const ev=document.createElement('canvas'); ev.width=256; ev.height=512;
        const ex=ev.getContext('2d');
        ex.fillStyle='#000'; ex.fillRect(0,0,256,512);

        const bs=88+Math.floor(Math.random()*38);
        cx.fillStyle=`rgb(${bs+8},${bs+5},${bs-2})`; cx.fillRect(0,0,256,512);
        /* Concrete mottling so the facade isn't a flat colour between windows. */
        for(let i=0;i<1400;i++){
            const v=bs+10+Math.floor(Math.random()*40);
            cx.fillStyle=`rgba(${v},${v-2},${v-6},${.05+Math.random()*.12})`;
            cx.fillRect(Math.random()*256,Math.random()*512,1+Math.random()*5,1+Math.random()*3);
        }
        const cols=4+Math.floor(Math.random()*4), rows=8+Math.floor(Math.random()*8);
        const ww=Math.floor(200/cols), wh=Math.floor(440/rows);
        const gx=Math.floor((256-cols*ww)/(cols+1)), gy=Math.floor((512-rows*wh)/(rows+1));
        const pal=Math.random()<.5?warmPal:coolPal;
        for(let r=0;r<rows;r++){for(let c=0;c<cols;c++){
            if(Math.random()<.18) continue;
            const wx=gx+c*(ww+gx), wy=gy+r*(wh+gy);
            /* Recessed mullion frame */
            cx.fillStyle='#2a2a30'; cx.fillRect(wx-2,wy-2,ww+4,wh+4);
            /* Most panes are unlit glass with only slight variation — a facade
             * where every window is a different bright colour reads as a
             * checkerboard, not a building. Lit windows stay the minority. */
            const bright=Math.random();
            let lit=null;
            if(bright>.94){
                lit=neonPal[Math.floor(Math.random()*neonPal.length)];
                cx.fillStyle=lit; cx.globalAlpha=.7;
            } else if(bright>.78){
                lit=pal[Math.floor(Math.random()*pal.length)];
                cx.fillStyle=lit; cx.globalAlpha=.4+Math.random()*.25;
            } else {
                /* Unlit glass: dark, reflective, no emission. Tight value range
                 * so the wall reads as one continuous curtain of glazing. */
                const g=36+Math.floor(Math.random()*14);
                cx.fillStyle=`rgb(${g-6},${g},${g+8})`; cx.globalAlpha=.95;
            }
            cx.fillRect(wx,wy,ww,wh);
            cx.globalAlpha=1;

            if(lit){
                ex.fillStyle=lit;
                ex.globalAlpha=bright>.86?1:.55+Math.random()*.3;
                ex.fillRect(wx,wy,ww,wh);
                ex.globalAlpha=1;
            }
            /* Blinds cover part of the pane in both maps. */
            if(Math.random()<.25 && lit){
                const bh=wh*(0.3+Math.random()*.5);
                cx.fillStyle='rgba(18,18,22,.55)'; cx.fillRect(wx,wy,ww,bh);
                ex.fillStyle='#000'; ex.fillRect(wx,wy,ww,bh);
            }
        }}
        /* Horizontal floor-slab shadow bands */
        cx.fillStyle='rgba(24,24,28,0.45)';
        for(let r=0;r<rows;r++){
            const by=gy+r*(wh+gy)+wh;
            cx.fillRect(0,by,256,Math.max(1,gy-1));
        }

        const tex=new THREE.CanvasTexture(cv);
        tex.wrapS=tex.wrapT=THREE.RepeatWrapping;
        tex.minFilter=THREE.LinearMipmapLinearFilter;
        tex.colorSpace=THREE.SRGBColorSpace;   /* albedo is authored in sRGB */
        const emi=new THREE.CanvasTexture(ev);
        emi.wrapS=emi.wrapT=THREE.RepeatWrapping;
        emi.minFilter=THREE.LinearMipmapLinearFilter;
        emi.colorSpace=THREE.SRGBColorSpace;
        winTextures.push({tex, emi});
    }
}
initWinTex(10);

const roofMat = new THREE.MeshStandardMaterial({color:0x606868, roughness:.85, metalness:.12});

const bldgBaseColors = [
    0x8a8a88, 0x989088, 0x7a8088, 0xa09888, 0x909098,
    0x988880, 0x808890, 0x908878, 0x788888, 0xa08878,
    0x8890a0, 0x909888, 0xa08878, 0x789080, 0x988888,
    0x88a090, 0x8888a0, 0xa09870, 0x809888, 0x908898,
    0xb0a898, 0x889098, 0xa09080, 0x98a0a0, 0x8a8080,
];
const bldgEmissiveColors = [
    0x1a2028, 0x201818, 0x182020, 0x201c18, 0x181c28,
    0x201818, 0x1a2020, 0x1c1818, 0x182018, 0x201c18,
];
/* Facade materials are keyed by (texture family, tiling) and cached, so dozens
 * of buildings share a handful of materials instead of cloning a texture each.
 * Tiling is quantised to keep the cache small. */
const bldgMatCache = new Map();
function mkBldgMat(w, h) {
    const idx = Math.floor(Math.random()*winTextures.length);
    const rx = Math.max(1, Math.round(w/10));
    const ry = Math.max(1, Math.round(h/10));
    const key = `${idx}:${rx}:${ry}`;
    const hit = bldgMatCache.get(key);
    if(hit) return hit;

    const src = winTextures[idx];
    /* Distinct Texture objects sharing one canvas image — cheap, and unlike
     * clone() they don't re-upload the bitmap to the GPU. */
    const tex = src.tex.clone(); tex.repeat.set(rx, ry); tex.needsUpdate = true;
    const emi = src.emi.clone(); emi.repeat.set(rx, ry); emi.needsUpdate = true;

    const baseCol = bldgBaseColors[Math.floor(Math.random()*bldgBaseColors.length)];
    const mat = new THREE.MeshStandardMaterial({
        color: baseCol,
        map: tex,
        emissive: 0xffffff,
        emissiveMap: emi,      /* lit panes only — not the concrete between them */
        emissiveIntensity: 0.9,
        roughness: .72+Math.random()*.16,
        metalness: .08+Math.random()*.12,
    });
    facadeMaterials.push(mat);
    bldgMatCache.set(key, mat);
    return mat;
}

/* ===== CITY ===== */
const buildings = [];
const neonSigns = [];
/* ===== SPATIAL GRID for fast building collision ===== */
const GRID_CELL=50;
const bldgGrid=new Map();
function bldgGridKey(x,z){return(Math.floor(x/GRID_CELL)+500)+','+(Math.floor(z/GRID_CELL)+500);}
function buildSpatialGrid(){
    bldgGrid.clear();
    for(const b of buildings){
        const p=b.mesh.position;
        const hw=b.bbox.max.x-b.bbox.min.x, hd=b.bbox.max.z-b.bbox.min.z;
        const minCX=Math.floor((p.x-hw/2)/GRID_CELL), maxCX=Math.floor((p.x+hw/2)/GRID_CELL);
        const minCZ=Math.floor((p.z-hd/2)/GRID_CELL), maxCZ=Math.floor((p.z+hd/2)/GRID_CELL);
        for(let cx=minCX;cx<=maxCX;cx++){for(let cz=minCZ;cz<=maxCZ;cz++){
            const key=(cx+500)+','+(cz+500);
            if(!bldgGrid.has(key)) bldgGrid.set(key,[]);
            bldgGrid.get(key).push(b);
        }}
    }
}
function getNearbyBuildings(x,z,radiusCells=1){
    const cx=Math.floor(x/GRID_CELL), cz=Math.floor(z/GRID_CELL);
    if(radiusCells<=0) return bldgGrid.get((cx+500)+','+(cz+500))||[];
    const out=[], seen=new Set();
    for(let gx=cx-radiusCells; gx<=cx+radiusCells; gx++){
        for(let gz=cz-radiusCells; gz<=cz+radiusCells; gz++){
            const list=bldgGrid.get((gx+500)+','+(gz+500));
            if(!list) continue;
            for(const b of list){ if(!seen.has(b)){ seen.add(b); out.push(b); } }
        }
    }
    return out;
}
const neonCols = [0x4488cc,0xe05030,0x40b868,0xddaa30,0xcc4488,0x40aacc,0x88cc40,0xe08030,0x7060cc,0x40ccaa,0xcc5070,0x5588cc];
let bldgLightCount = 0;
const waterAnims = [];
function makeWaterTex(tint='#0a1828'){
    const cv=document.createElement('canvas'); cv.width=256; cv.height=256;
    const cx=cv.getContext('2d');
    const g=cx.createLinearGradient(0,0,0,256);
    g.addColorStop(0,'#1a3040'); g.addColorStop(0.5,tint); g.addColorStop(1,'#142838');
    cx.fillStyle=g; cx.fillRect(0,0,256,256);
    cx.strokeStyle='rgba(210,230,240,.09)';
    for(let i=0;i<28;i++){
        const y=Math.random()*256;
        cx.beginPath(); cx.moveTo(0,y); cx.bezierCurveTo(80,y+Math.random()*8-4,170,y+Math.random()*8-4,256,y);
        cx.stroke();
    }
    const tex=new THREE.CanvasTexture(cv); tex.wrapS=tex.wrapT=THREE.RepeatWrapping; tex.repeat.set(8,3);
    return tex;
}

function makeGroundTex(){
    const cv=document.createElement('canvas'); cv.width=512; cv.height=512;
    const cx=cv.getContext('2d');
    cx.fillStyle='#4c4a41'; cx.fillRect(0,0,512,512);
    for(let i=0;i<1800;i++){
        const v=48+Math.floor(Math.random()*42);
        const a=.08+Math.random()*.2;
        cx.fillStyle=`rgba(${v},${v-3},${v-10},${a})`;
        cx.fillRect(Math.random()*512,Math.random()*512,1+Math.random()*6,1+Math.random()*4);
    }
    for(let i=0;i<130;i++){
        cx.strokeStyle=`rgba(28,28,24,${.08+Math.random()*.12})`;
        cx.lineWidth=.5+Math.random()*1.4;
        cx.beginPath();
        const x=Math.random()*512,y=Math.random()*512;
        cx.moveTo(x,y); cx.lineTo(x+(Math.random()-.5)*60,y+(Math.random()-.5)*36); cx.stroke();
    }
    for(let i=0;i<60;i++){
        cx.fillStyle=`rgba(70,62,45,${.08+Math.random()*.12})`;
        cx.beginPath(); cx.ellipse(Math.random()*512,Math.random()*512,8+Math.random()*28,4+Math.random()*18,Math.random()*Math.PI,0,Math.PI*2); cx.fill();
    }
    const tex=new THREE.CanvasTexture(cv); tex.wrapS=tex.wrapT=THREE.RepeatWrapping; tex.repeat.set(18,18);
    return tex;
}

function makeConcreteTex(){
    const cv=document.createElement('canvas'); cv.width=256; cv.height=256;
    const cx=cv.getContext('2d');
    cx.fillStyle='#6d6d66'; cx.fillRect(0,0,256,256);
    for(let i=0;i<850;i++){
        const v=82+Math.floor(Math.random()*55);
        cx.fillStyle=`rgba(${v},${v},${v-4},${.08+Math.random()*.18})`;
        cx.fillRect(Math.random()*256,Math.random()*256,1+Math.random()*4,1+Math.random()*3);
    }
    cx.strokeStyle='rgba(35,35,35,.22)'; cx.lineWidth=1;
    for(let x=0;x<256;x+=64){cx.beginPath();cx.moveTo(x,0);cx.lineTo(x,256);cx.stroke();}
    for(let y=0;y<256;y+=64){cx.beginPath();cx.moveTo(0,y);cx.lineTo(256,y);cx.stroke();}
    const tex=new THREE.CanvasTexture(cv); tex.wrapS=tex.wrapT=THREE.RepeatWrapping; tex.repeat.set(3,3);
    return tex;
}

function makeMapLabelTex(title, subtitle='', tint='#8fd8ff'){
    const cv=document.createElement('canvas'); cv.width=768; cv.height=192;
    const cx=cv.getContext('2d');
    cx.clearRect(0,0,cv.width,cv.height);
    cx.fillStyle='rgba(4,12,24,.72)'; cx.fillRect(0,0,cv.width,cv.height);
    cx.strokeStyle=tint; cx.lineWidth=4; cx.strokeRect(8,8,cv.width-16,cv.height-16);
    cx.font='bold 44px "Courier New", monospace'; cx.textAlign='center'; cx.textBaseline='middle';
    cx.shadowColor=tint; cx.shadowBlur=18; cx.fillStyle=tint; cx.fillText(title.toUpperCase(),cv.width/2,78);
    if(subtitle){ cx.shadowBlur=8; cx.font='bold 22px "Courier New", monospace'; cx.fillStyle='rgba(220,245,255,.9)'; cx.fillText(subtitle.toUpperCase(),cv.width/2,130); }
    cx.shadowBlur=0;
    const tex=new THREE.CanvasTexture(cv); tex.minFilter=THREE.LinearFilter; tex.magFilter=THREE.LinearFilter;
    return tex;
}

function addMapLabel(title, subtitle, position, rotationY=0, width=34){
    const tex=makeMapLabelTex(title, subtitle);
    const mat=new THREE.MeshBasicMaterial({map:tex,transparent:true,side:THREE.DoubleSide,depthWrite:false});
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(width,width/4),mat);
    mesh.position.copy(position); mesh.rotation.y=rotationY; scene.add(mesh);
    return mesh;
}

function generateCity() {
    const blocks=Math.floor(C.citySize/C.blockSize), half=blocks/2;

    /* Layered city ground: dirty soil/concrete texture instead of a clean flat plane. */
    const groundGeo = new THREE.PlaneGeometry(C.citySize+200, C.citySize+200);
    const groundMat = new THREE.MeshStandardMaterial({color:0x58554b, map:makeGroundTex(), roughness:.96, metalness:.03});
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI/2; ground.position.y = -0.05;
    tagShadows(ground,false,true); scene.add(ground);
    const concreteTex=makeConcreteTex();
    const concreteMat=new THREE.MeshStandardMaterial({color:0x6a6a62,map:concreteTex,roughness:.92,metalness:.04});
    const dirtMat=new THREE.MeshStandardMaterial({color:0x66523a,roughness:.96,metalness:.02});
    const stainMat=new THREE.MeshBasicMaterial({color:0x171818,transparent:true,opacity:.22,depthWrite:false});
    const grassStripMat=new THREE.MeshStandardMaterial({color:0x2f4b2d,roughness:.96});

    /* River and coastal water planes */
    const riverTex=makeWaterTex('#2a4850');
    const oceanTex=makeWaterTex('#1a3848');
    const waterMatR=new THREE.MeshStandardMaterial({color:0x2a5058,map:riverTex,roughness:.15,metalness:.5,transparent:true,opacity:.8});
    const waterMatO=new THREE.MeshStandardMaterial({color:0x1a3848,map:oceanTex,roughness:.2,metalness:.45,transparent:true,opacity:.75});
    const riverCfg=CITY_MAP.waterways.find(w=>w.id==='main-river')||CITY_MAP.waterways[0];
    const canalCfg=CITY_MAP.waterways.find(w=>w.id==='north-canal')||CITY_MAP.waterways[1];
    const bridgeCfg=CITY_MAP.bridges.find(b=>b.id==='central-river-bridge')||CITY_MAP.bridges[0];
    const riverW=riverCfg.width;
    const riverZ=C.citySize*riverCfg.offset;
    const river=new THREE.Mesh(new THREE.PlaneGeometry(C.citySize+240,riverW),waterMatR);
    river.rotation.x=-Math.PI/2; river.position.set(0,-0.09,riverZ); scene.add(river);
    waterAnims.push({tex:riverTex,sx:0.008,sy:0.001});

    const canalW=canalCfg.width;
    const canalX=C.citySize*canalCfg.offset;
    const canal=new THREE.Mesh(new THREE.PlaneGeometry(canalW,C.citySize*.86),waterMatR);
    canal.rotation.x=-Math.PI/2; canal.position.set(canalX,-0.085,C.citySize*.05); scene.add(canal);
    function cityWaterAt(x,z,pad=0){
        const inRiver = Math.abs(z-riverZ) < riverW/2 + pad;
        const inCanal = Math.abs(x-canalX) < canalW/2 + pad && z > -C.citySize*.38 && z < C.citySize*.48;
        const inHarbor = z > C.citySize*.5 - pad;
        return inRiver || inCanal || inHarbor;
    }

    /* Block-level surface patches make the underside of the city feel occupied. */
    for(let gx=0;gx<blocks;gx++){for(let gz=0;gz<blocks;gz++){
        const x=(gx-half+.5)*C.blockSize;
        const z=(gz-half+.5)*C.blockSize;
        if(cityWaterAt(x,z,8) || Math.abs(x)<30&&Math.abs(z)<30) continue;
        const roll=Math.random();
        const w=C.blockSize-11-Math.random()*8;
        const d=C.blockSize-11-Math.random()*8;
        if(roll<.42){
            const slab=new THREE.Mesh(new THREE.PlaneGeometry(w,d),concreteMat);
            slab.rotation.x=-Math.PI/2; slab.rotation.z=(Math.random()-.5)*.02; slab.position.set(x,.006,z); scene.add(slab);
        }else if(roll<.58){
            const lot=new THREE.Mesh(new THREE.PlaneGeometry(w,d),new THREE.MeshStandardMaterial({color:0x3d3f3d,roughness:.9,metalness:.05}));
            lot.rotation.x=-Math.PI/2; lot.position.set(x,.007,z); scene.add(lot);
            const lineMat=new THREE.MeshBasicMaterial({color:0xd8d2aa,transparent:true,opacity:.42});
            const slots=3+Math.floor(Math.random()*3);
            for(let p=0;p<slots;p++){
                const stripe=new THREE.Mesh(new THREE.PlaneGeometry(.18,d*.72),lineMat);
                stripe.rotation.x=-Math.PI/2; stripe.position.set(x-w*.35+p*(w*.7/Math.max(1,slots-1)),.014,z); scene.add(stripe);
            }
        }else if(roll<.68){
            const dirt=new THREE.Mesh(new THREE.PlaneGeometry(w,d),dirtMat);
            dirt.rotation.x=-Math.PI/2; dirt.position.set(x,.005,z); scene.add(dirt);
        }else if(roll<.75){
            const grass=new THREE.Mesh(new THREE.PlaneGeometry(w*.9,d*.9),grassStripMat);
            grass.rotation.x=-Math.PI/2; grass.position.set(x,.008,z); scene.add(grass);
        }
        if(Math.random()<.35){
            const stain=new THREE.Mesh(new THREE.CircleGeometry(2+Math.random()*6,14),stainMat);
            stain.rotation.x=-Math.PI/2; stain.scale.set(1+Math.random()*1.6,.45+Math.random()*.8,1); stain.rotation.z=Math.random()*Math.PI;
            stain.position.set(x+(Math.random()-.5)*w*.55,.018,z+(Math.random()-.5)*d*.55); scene.add(stain);
        }
    }}

    const coast=new THREE.Mesh(new THREE.PlaneGeometry(C.citySize+420,260),waterMatO);
    coast.rotation.x=-Math.PI/2; coast.position.set(0,-0.11,C.citySize/2+120); scene.add(coast);
    waterAnims.push({tex:oceanTex,sx:0.004,sy:0.002});

    const embankMat=new THREE.MeshStandardMaterial({color:0x706860,roughness:.85,metalness:.1});
    const embL=new THREE.Mesh(new THREE.BoxGeometry(C.citySize+220,1.2,2),embankMat);
    embL.position.set(0,0.45,riverZ-riverW/2); scene.add(embL);
    const embR=new THREE.Mesh(new THREE.BoxGeometry(C.citySize+220,1.2,2),embankMat);
    embR.position.set(0,0.45,riverZ+riverW/2); scene.add(embR);
    [-1,1].forEach(side=>{
        const bank=new THREE.Mesh(new THREE.PlaneGeometry(C.citySize+210,7),dirtMat);
        bank.rotation.x=-Math.PI/2; bank.position.set(0,.012,riverZ+side*(riverW/2+4.4)); scene.add(bank);
        const grass=new THREE.Mesh(new THREE.PlaneGeometry(C.citySize+210,2.6),grassStripMat);
        grass.rotation.x=-Math.PI/2; grass.position.set(0,.018,riverZ+side*(riverW/2+8.4)); scene.add(grass);
    });
    [-1,1].forEach(side=>{
        const emb=new THREE.Mesh(new THREE.BoxGeometry(2,1.2,C.citySize*.86),embankMat);
        emb.position.set(canalX+side*(canalW/2),0.45,C.citySize*.05); scene.add(emb);
        const bank=new THREE.Mesh(new THREE.PlaneGeometry(5,C.citySize*.84),dirtMat);
        bank.rotation.x=-Math.PI/2; bank.position.set(canalX+side*(canalW/2+3.6),.012,C.citySize*.05); scene.add(bank);
    });

    /* Road asphalt texture */
    const rdCv=document.createElement('canvas');rdCv.width=128;rdCv.height=128;
    const rdCx=rdCv.getContext('2d');
    rdCx.fillStyle='#484848';rdCx.fillRect(0,0,128,128);
    for(let i=0;i<300;i++){const v=42+Math.floor(Math.random()*30);rdCx.fillStyle=`rgba(${v},${v},${v+2},${0.2+Math.random()*0.25})`;rdCx.fillRect(Math.random()*128,Math.random()*128,1+Math.random()*3,1+Math.random()*2);}
    for(let i=0;i<8;i++){rdCx.strokeStyle=`rgba(35,35,38,${0.3+Math.random()*0.3})`;rdCx.lineWidth=.5;rdCx.beginPath();rdCx.moveTo(Math.random()*128,Math.random()*128);rdCx.lineTo(Math.random()*128,Math.random()*128);rdCx.stroke();}
    const rdTex=new THREE.CanvasTexture(rdCv);rdTex.wrapS=rdTex.wrapT=THREE.RepeatWrapping;

    /* Roads */
    for(let i=0;i<=blocks;i++){
        const pos=(i-half)*C.blockSize;
        const rtH=rdTex.clone();rtH.repeat.set(Math.ceil((C.citySize+80)/10),1);rtH.needsUpdate=true;
        const rmH=new THREE.MeshStandardMaterial({color:0x505050,map:rtH,roughness:.8,metalness:.05});
        const rH=new THREE.Mesh(new THREE.PlaneGeometry(C.citySize+80,7),rmH);
        rH.rotation.x=-Math.PI/2; rH.position.set(0,.01,pos); tagShadows(rH,false,true); scene.add(rH);
        const rtV=rdTex.clone();rtV.repeat.set(1,Math.ceil((C.citySize+80)/10));rtV.needsUpdate=true;
        const rmV=new THREE.MeshStandardMaterial({color:0x505050,map:rtV,roughness:.8,metalness:.05});
        const rV=new THREE.Mesh(new THREE.PlaneGeometry(7,C.citySize+80),rmV);
        rV.rotation.x=-Math.PI/2; rV.position.set(pos,.01,0); tagShadows(rV,false,true); scene.add(rV);
    }

    /* Bridge decks where N/S roads cross the river */
    const bridgeMat=new THREE.MeshStandardMaterial({color:0x787068,roughness:.78,metalness:.15});
    const namedBridgeX=C.citySize*(bridgeCfg?.xOffset ?? 0.09);
    let namedBridge=null;
    let namedBridgeDist=Infinity;
    for(let i=0;i<=blocks;i++){
        const x=(i-half)*C.blockSize;
        const bridge=new THREE.Mesh(new THREE.BoxGeometry(8,0.65,riverW+5),bridgeMat);
        bridge.position.set(x,0.42,riverZ); scene.add(bridge);
        const d=Math.abs(x-namedBridgeX);
        if(d<namedBridgeDist){ namedBridgeDist=d; namedBridge=bridge; }
        const railMat=new THREE.MeshStandardMaterial({color:0x909088,roughness:.55,metalness:.4});
        const railL=new THREE.Mesh(new THREE.BoxGeometry(0.2,0.4,riverW+5),railMat);
        railL.position.set(x-3.75,0.9,riverZ); scene.add(railL);
        const railR=new THREE.Mesh(new THREE.BoxGeometry(0.2,0.4,riverW+5),railMat);
        railR.position.set(x+3.75,0.9,riverZ); scene.add(railR);
    }
    if(namedBridge){

    }

    /* Bridge decks where E/W roads cross the canal */
    for(let i=0;i<=blocks;i++){
        const z=(i-half)*C.blockSize;
        if(z < -C.citySize*.38 || z > C.citySize*.48) continue;
        const bridge=new THREE.Mesh(new THREE.BoxGeometry(canalW+5,0.65,8),bridgeMat);
        bridge.position.set(canalX,0.42,z); scene.add(bridge);
        const railMat=new THREE.MeshStandardMaterial({color:0x909088,roughness:.55,metalness:.4});
        const railL=new THREE.Mesh(new THREE.BoxGeometry(canalW+5,0.4,0.2),railMat);
        railL.position.set(canalX,0.9,z-3.75); scene.add(railL);
        const railR=new THREE.Mesh(new THREE.BoxGeometry(canalW+5,0.4,0.2),railMat);
        railR.position.set(canalX,0.9,z+3.75); scene.add(railR);
    }

    /* Map-driven districts and landmarks. These are the placeholders that a supplied user map can replace. */
    const districtRingMat=new THREE.MeshBasicMaterial({color:0x63ff9c,transparent:true,opacity:.18,side:THREE.DoubleSide,depthWrite:false});
    for(const d of CITY_MAP.districts){
        const x=C.citySize*d.x, z=C.citySize*d.z;
        const ring=new THREE.Mesh(new THREE.RingGeometry(d.radius*.92,d.radius,48),districtRingMat.clone());
        ring.material.color.setHex(d.color||0x63ff9c); ring.rotation.x=-Math.PI/2; ring.position.set(x,.04,z); scene.add(ring);

    }
    for(const lm of CITY_MAP.landmarks){
        const x=C.citySize*lm.x, z=C.citySize*lm.z;
        const pad=new THREE.Mesh(new THREE.BoxGeometry(lm.w,.22,lm.d),new THREE.MeshStandardMaterial({color:lm.color||0x606870,roughness:.82,metalness:.12}));
        pad.position.set(x,.16,z); scene.add(pad);
        const stripeMat=new THREE.MeshBasicMaterial({color:0xc8d8dc,transparent:true,opacity:.7});
        const stripe=new THREE.Mesh(new THREE.PlaneGeometry(lm.w*.82,.45),stripeMat);
        stripe.rotation.x=-Math.PI/2; stripe.position.set(x,.31,z); scene.add(stripe);

    }

    /* Lane markings (dashed center line) */
    const dashMat=new THREE.MeshBasicMaterial({color:0xc0c8d0,transparent:true,opacity:.65});
    const dashGeo=new THREE.PlaneGeometry(.25,2.2);
    for(let i=0;i<=blocks;i++){
        const pos=(i-half)*C.blockSize;
        for(let d=-C.citySize/2;d<C.citySize/2;d+=7){
            const dH=new THREE.Mesh(dashGeo,dashMat);
            dH.rotation.x=-Math.PI/2;dH.position.set(d,.02,pos);scene.add(dH);
            const dV=new THREE.Mesh(dashGeo,dashMat);
            dV.rotation.x=-Math.PI/2;dV.rotation.z=Math.PI/2;dV.position.set(pos,.02,d);scene.add(dV);
        }
    }

    /* Road edge lines (solid white at road edges) */
    const edgeMat=new THREE.MeshBasicMaterial({color:0xb0b8c0,transparent:true,opacity:.5});
    for(let i=0;i<=blocks;i++){
        const pos=(i-half)*C.blockSize;
        [-3.3,3.3].forEach(off=>{
            const eH=new THREE.Mesh(new THREE.PlaneGeometry(C.citySize+80,.12),edgeMat);
            eH.rotation.x=-Math.PI/2;eH.position.set(0,.02,pos+off);scene.add(eH);
            const eV=new THREE.Mesh(new THREE.PlaneGeometry(.12,C.citySize+80),edgeMat);
            eV.rotation.x=-Math.PI/2;eV.position.set(pos+off,.02,0);scene.add(eV);
        });
    }

    /* Crosswalk markings at intersections */
    const cwMat=new THREE.MeshBasicMaterial({color:0xd0d8e0,transparent:true,opacity:.55});
    const cwStripe=new THREE.PlaneGeometry(3.5,.45);
    for(let i=0;i<=blocks;i++){for(let j=0;j<=blocks;j++){
        const ix=(i-half)*C.blockSize, iz=(j-half)*C.blockSize;
        /* 4 crosswalks per intersection (N/S/E/W) */
        [[ix,iz-4.5,0],[ix,iz+4.5,0],[ix-4.5,iz,Math.PI/2],[ix+4.5,iz,Math.PI/2]].forEach(cw=>{
            for(let s=-2;s<=2;s++){
                const stripe=new THREE.Mesh(cwStripe,cwMat);
                stripe.rotation.x=-Math.PI/2;stripe.rotation.z=cw[2];
                if(cw[2]===0) stripe.position.set(cw[0]+s*1,0.025,cw[1]);
                else stripe.position.set(cw[0],0.025,cw[1]+s*1);
                scene.add(stripe);
            }
        });
    }}

    /* Puddles (reflective patches on ground/roads) */
    const puddleMat=new THREE.MeshStandardMaterial({color:0x303838,roughness:.05,metalness:.85,transparent:true,opacity:.5});
    let puddleCount=0;
    for(let i=0;i<blocks&&puddleCount<35;i++){for(let j=0;j<blocks&&puddleCount<35;j++){
        if(Math.random()>.1) continue;
        const px=(i-half)*C.blockSize+(Math.random()-.5)*C.blockSize*.8;
        const pz=(j-half)*C.blockSize+(Math.random()-.5)*C.blockSize*.8;
        const pw=1+Math.random()*3, ph=.8+Math.random()*2;
        const puddle=new THREE.Mesh(new THREE.PlaneGeometry(pw,ph),puddleMat);
        puddle.rotation.x=-Math.PI/2;puddle.rotation.z=Math.random()*Math.PI;
        puddle.position.set(px,.015,pz);scene.add(puddle);
        puddleCount++;
    }}

    /* Steam vents (glowing cracks in ground) */
    const steamMat=new THREE.MeshBasicMaterial({color:0x1a3050,transparent:true,opacity:.3});
    let steamCount=0;
    for(let i=0;i<blocks&&steamCount<12;i++){for(let j=0;j<blocks&&steamCount<12;j++){
        if(Math.random()>.06) continue;
        const sx=(i-half)*C.blockSize+(Math.random()-.5)*6;
        const sz=(j-half)*C.blockSize+(Math.random()-.5)*6;
        const grate=new THREE.Mesh(new THREE.PlaneGeometry(.8,.8),new THREE.MeshStandardMaterial({color:0x585858,roughness:.55,metalness:.7}));
        grate.rotation.x=-Math.PI/2;grate.position.set(sx,.018,sz);scene.add(grate);
        /* Glow underneath */
        const glow=new THREE.Mesh(new THREE.PlaneGeometry(.6,.6),new THREE.MeshBasicMaterial({color:0x223344,transparent:true,opacity:.3}));
        glow.rotation.x=-Math.PI/2;glow.position.set(sx,.02,sz);scene.add(glow);
        steamCount++;
    }}

    /* Street debris / trash bags */
    const trashMat=new THREE.MeshStandardMaterial({color:0x585850,roughness:.9});
    let trashCount=0;
    for(let i=0;i<blocks&&trashCount<30;i++){for(let j=0;j<blocks&&trashCount<30;j++){
        if(Math.random()>.08) continue;
        const tx=(i-half)*C.blockSize+(Math.random()>.5?5.2:-5.2)+(Math.random()-.5);
        const tz=(j-half)*C.blockSize+(Math.random()-.5)*18;
        if(Math.random()>.5){
            /* Trash bag */
            const bag=new THREE.Mesh(new THREE.SphereGeometry(.25+Math.random()*.15,5,4),trashMat);
            bag.scale.y=.7;bag.position.set(tx,.18,tz);scene.add(bag);
        }else{
            /* Cardboard box */
            const box=new THREE.Mesh(new THREE.BoxGeometry(.4+Math.random()*.3,.3+Math.random()*.2,.4+Math.random()*.3),
                new THREE.MeshStandardMaterial({color:0x786040,roughness:.85}));
            box.position.set(tx,.15+Math.random()*.1,tz);box.rotation.y=Math.random()*Math.PI;scene.add(box);
        }
        trashCount++;
    }}

    /* Bollards / posts along sidewalks */
    const bollardMat=new THREE.MeshStandardMaterial({color:0x888880,roughness:.4,metalness:.7});
    const bollardGeo=new THREE.CylinderGeometry(.06,.07,.7,6);
    let bollardCount=0;
    for(let i=0;i<=blocks&&bollardCount<60;i++){for(let j=0;j<=blocks&&bollardCount<60;j++){
        if(Math.random()>.12) continue;
        const bx=(i-half)*C.blockSize+(Math.random()>.5?3.9:-3.9);
        const bz=(j-half)*C.blockSize+(Math.random()-.5)*20;
        const b=new THREE.Mesh(bollardGeo,bollardMat);b.position.set(bx,.35,bz);scene.add(b);
        const cap=new THREE.Mesh(new THREE.SphereGeometry(.07,6,4),new THREE.MeshBasicMaterial({color:0xffaa00,transparent:true,opacity:.5}));
        cap.position.set(bx,.72,bz);scene.add(cap);
        bollardCount++;
    }}

    /* Road signs / stop signs */
    const signPoleMat=new THREE.MeshStandardMaterial({color:0x888888,roughness:.4,metalness:.75});
    const signPoleGeo=new THREE.CylinderGeometry(.03,.03,3,4);
    let signCount=0;
    for(let i=0;i<=blocks&&signCount<20;i++){for(let j=0;j<=blocks&&signCount<20;j++){
        if(Math.random()>.1) continue;
        const sx=(i-half)*C.blockSize+4.2, sz=(j-half)*C.blockSize+4.2;
        const pole=new THREE.Mesh(signPoleGeo,signPoleMat);pole.position.set(sx,1.5,sz);scene.add(pole);
        if(Math.random()>.5){
            /* Stop sign (octagon approximated as circle) */
            const sign=new THREE.Mesh(new THREE.CircleGeometry(.35,8),new THREE.MeshBasicMaterial({color:0xcc0000,side:THREE.DoubleSide}));
            sign.position.set(sx,3.1,sz);sign.rotation.y=Math.random()*Math.PI;scene.add(sign);
        }else{
            /* Direction sign */
            const sign=new THREE.Mesh(new THREE.PlaneGeometry(.8,.35),new THREE.MeshBasicMaterial({color:0x004488,side:THREE.DoubleSide}));
            sign.position.set(sx,3.1,sz);sign.rotation.y=Math.random()*Math.PI;scene.add(sign);
        }
        signCount++;
    }}

    /* Construction barriers (orange/white) */
    let barrierCount=0;
    for(let i=0;i<blocks&&barrierCount<8;i++){for(let j=0;j<blocks&&barrierCount<8;j++){
        if(Math.random()>.03) continue;
        const bx=(i-half)*C.blockSize+(Math.random()-.5)*8;
        const bz=(j-half)*C.blockSize+(Math.random()-.5)*8;
        for(let bi=0;bi<3;bi++){
            const bar=new THREE.Mesh(new THREE.BoxGeometry(1.5,.6,.15),new THREE.MeshStandardMaterial({color:bi%2===0?0xff6600:0xeeeeee,roughness:.7}));
            bar.position.set(bx+bi*1.6,.3,bz);scene.add(bar);
        }
        barrierCount++;
    }}

    /* Storefront awnings + shop windows at building bases */
    const awningCols=[0x802020,0x204060,0x206030,0x806030,0x604040,0x306060,0xa05020,0x205040,0x504060,0x606020];
    const shopGlowMat=new THREE.MeshBasicMaterial({color:0xddcc88,transparent:true,opacity:.2,side:THREE.DoubleSide});

    /* Street lamps */
    const poleMat = new THREE.MeshStandardMaterial({color:0x808078,roughness:.5,metalness:.7});
    const poleGeo = new THREE.CylinderGeometry(.06,.08,7,6);
    const lampGeo = new THREE.SphereGeometry(.25,8,6);
    let lampCount = 0;
    for(let i=0;i<=blocks&&lampCount<8;i++){
        for(let j=0;j<=blocks&&lampCount<8;j++){
            if(Math.random()>.15) continue;
            const lx=(i-half)*C.blockSize+4, lz=(j-half)*C.blockSize+4;
            const pole=new THREE.Mesh(poleGeo,poleMat); pole.position.set(lx,3.5,lz); scene.add(pole);
            const nc=neonCols[Math.floor(Math.random()*neonCols.length)];
            const lamp=new THREE.Mesh(lampGeo,new THREE.MeshBasicMaterial({color:nc}));
            lamp.position.set(lx,7.2,lz); scene.add(lamp);
            const pl=new THREE.PointLight(nc,1.5,30); pl.position.set(lx,7,lz); scene.add(pl);
            lampCount++;
        }
    }

    /* Sidewalks (raised curb along roads) */
    const swMat=new THREE.MeshStandardMaterial({color:0x787870,roughness:.88,metalness:.05});
    const swGeo=new THREE.BoxGeometry(1,.15,1);
    for(let i=0;i<=blocks;i++){
        const pos=(i-half)*C.blockSize;
        for(let d=-C.citySize/2;d<C.citySize/2;d+=4){
            [4.2,-4.2].forEach(off=>{
                const sH=new THREE.Mesh(swGeo,swMat); sH.scale.set(4,1,1);
                sH.position.set(d,.08,pos+off); scene.add(sH);
                const sV=new THREE.Mesh(swGeo,swMat); sV.scale.set(1,1,4);
                sV.position.set(pos+off,.08,d); scene.add(sV);
            });
        }
    }

    /* Parked cars (colored boxes on roads) */
    const carCols=[0xc0c0c0,0x404040,0x2050a0,0xa02020,0xe0e0e0,0x808080,0x183070,0x606060,0x802020,0xa0a098,0x305028,0xb8a070];
    const carGeo=new THREE.BoxGeometry(1.8,.8,3.6);
    const carTopGeo=new THREE.BoxGeometry(1.5,.65,2.0);
    let carCount=0;
    for(let i=0;i<blocks&&carCount<40;i++){for(let j=0;j<blocks&&carCount<40;j++){
        if(Math.random()>.12) continue;
        const cx=(i-half)*C.blockSize+(Math.random()>.5?2.5:-2.5);
        const cz=(j-half)*C.blockSize+(Math.random()-.5)*C.blockSize*.6;
        const cc=carCols[Math.floor(Math.random()*carCols.length)];
        const cMat=new THREE.MeshStandardMaterial({color:cc,roughness:.4,metalness:.6});
        const car=new THREE.Mesh(carGeo,cMat);
        car.position.set(cx,.4,cz); scene.add(car);
        const top=new THREE.Mesh(carTopGeo,cMat);
        top.position.set(cx,.95,cz-.2); scene.add(top);
        /* Tail lights */
        const tlMat=new THREE.MeshBasicMaterial({color:0xff2200});
        const tlGeo=new THREE.BoxGeometry(.3,.15,.05);
        [-.65,.65].forEach(xo=>{
            const tl=new THREE.Mesh(tlGeo,tlMat);
            tl.position.set(cx+xo,.35,cz+1.82); scene.add(tl);
        });
        /* Headlights */
        const hlMat=new THREE.MeshBasicMaterial({color:0xffffcc});
        [-.6,.6].forEach(xo=>{
            const hl=new THREE.Mesh(new THREE.BoxGeometry(.35,.2,.05),hlMat);
            hl.position.set(cx+xo,.4,cz-1.82); scene.add(hl);
        });
        carCount++;
    }}

    /* Traffic lights at intersections */
    const tlPoleMat=new THREE.MeshStandardMaterial({color:0x686868,roughness:.45,metalness:.7});
    const tlPoleGeo=new THREE.CylinderGeometry(.05,.06,4.5,6);
    const tlBoxGeo=new THREE.BoxGeometry(.35,.9,.25);
    const tlBoxMat=new THREE.MeshStandardMaterial({color:0x404040,roughness:.55,metalness:.5});
    let tlCount=0;
    for(let i=0;i<=blocks&&tlCount<28;i++){for(let j=0;j<=blocks&&tlCount<28;j++){
        if(Math.random()>.25) continue;
        const tx=(i-half)*C.blockSize+3.8, tz=(j-half)*C.blockSize+3.8;
        const pole=new THREE.Mesh(tlPoleGeo,tlPoleMat); pole.position.set(tx,2.25,tz); scene.add(pole);
        const box=new THREE.Mesh(tlBoxGeo,tlBoxMat); box.position.set(tx,4.7,tz); scene.add(box);
        const colors=[0xff0000,0xffaa00,0x00ff00];
        colors.forEach((c,ci)=>{
            const bulb=new THREE.Mesh(new THREE.SphereGeometry(.06,6,6),new THREE.MeshBasicMaterial({color:c,transparent:true,opacity:ci===2?.8:.2}));
            bulb.position.set(tx,5+ci*-.25,tz+.14); scene.add(bulb);
        });
        tlCount++;
    }}

    /* Dumpsters */
    const dumpMat=new THREE.MeshStandardMaterial({color:0x3a6838,roughness:.78,metalness:.3});
    const dumpGeo=new THREE.BoxGeometry(1.6,.9,1);
    let dumpCount=0;
    for(let i=0;i<blocks&&dumpCount<25;i++){for(let j=0;j<blocks&&dumpCount<25;j++){
        if(Math.random()>.08) continue;
        const dx=(i-half)*C.blockSize+5.5+(Math.random()-.5)*2;
        const dz=(j-half)*C.blockSize+(Math.random()-.5)*20;
        const dump=new THREE.Mesh(dumpGeo,dumpMat);
        dump.position.set(dx,.45,dz); dump.rotation.y=Math.random()*Math.PI; scene.add(dump);
        const lid=new THREE.Mesh(new THREE.BoxGeometry(1.6,.06,1.05),new THREE.MeshStandardMaterial({color:0x305828,roughness:.72,metalness:.35}));
        lid.position.set(dx,.92,dz); lid.rotation.z=(Math.random()-.5)*.3; scene.add(lid);
        dumpCount++;
    }}

    /* Bus stops / shelters */
    const busMat=new THREE.MeshStandardMaterial({color:0x808888,roughness:.35,metalness:.7});
    let busCount=0;
    for(let i=0;i<blocks&&busCount<12;i++){for(let j=0;j<blocks&&busCount<12;j++){
        if(Math.random()>.06) continue;
        const bx=(i-half)*C.blockSize+5, bz=(j-half)*C.blockSize+(Math.random()-.5)*15;
        /* Poles */
        [-.8,.8].forEach(ox=>{
            const p=new THREE.Mesh(new THREE.CylinderGeometry(.04,.04,2.8,4),busMat);
            p.position.set(bx+ox,1.4,bz); scene.add(p);
        });
        /* Roof */
        const roof=new THREE.Mesh(new THREE.BoxGeometry(2.2,.06,1.2),busMat);
        roof.position.set(bx,2.82,bz); scene.add(roof);
        /* Back panel (glass look) */
        const glass=new THREE.Mesh(new THREE.PlaneGeometry(2,.8),
            new THREE.MeshBasicMaterial({color:0x113344,transparent:true,opacity:.4,side:THREE.DoubleSide}));
        glass.position.set(bx,2,bz+.59); scene.add(glass);
        /* Bench */
        const bench=new THREE.Mesh(new THREE.BoxGeometry(1.4,.08,.35),new THREE.MeshStandardMaterial({color:0x888880,roughness:.6}));
        bench.position.set(bx,.55,bz+.3); scene.add(bench);
        busCount++;
    }}

    /* Phone booths / kiosks */
    const boothMat=new THREE.MeshStandardMaterial({color:0xb03030,roughness:.5,metalness:.5});
    let boothCount=0;
    for(let i=0;i<blocks&&boothCount<15;i++){for(let j=0;j<blocks&&boothCount<15;j++){
        if(Math.random()>.05) continue;
        const px=(i-half)*C.blockSize-5, pz=(j-half)*C.blockSize+(Math.random()-.5)*20;
        const booth=new THREE.Mesh(new THREE.BoxGeometry(.9,2.2,.9),boothMat);
        booth.position.set(px,1.1,pz); scene.add(booth);
        const top=new THREE.Mesh(new THREE.BoxGeometry(1,.15,1),new THREE.MeshBasicMaterial({color:0xff4444,transparent:true,opacity:.6}));
        top.position.set(px,2.28,pz); scene.add(top);
        boothCount++;
    }}

    /* Vending machines */
    const vendCols=[0x0044cc,0xcc2200,0x00aa44,0xff6600];
    let vendCount=0;
    for(let i=0;i<blocks&&vendCount<20;i++){for(let j=0;j<blocks&&vendCount<20;j++){
        if(Math.random()>.06) continue;
        const vx=(i-half)*C.blockSize-5.5, vz=(j-half)*C.blockSize+(Math.random()-.5)*16;
        const vc=vendCols[Math.floor(Math.random()*vendCols.length)];
        const vend=new THREE.Mesh(new THREE.BoxGeometry(.7,1.6,.6),new THREE.MeshStandardMaterial({color:vc,roughness:.4,metalness:.6}));
        vend.position.set(vx,.8,vz); scene.add(vend);
        /* Screen/display */
        const screen=new THREE.Mesh(new THREE.PlaneGeometry(.5,.6),new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.3}));
        screen.position.set(vx,.95,vz-.31); scene.add(screen);
        vendCount++;
    }}

    /* ===== VARIED TREE TYPES ===== */
    const treeTrunkMat=new THREE.MeshStandardMaterial({color:0x5a4430,roughness:.9});
    const treeTrunkDarkMat=new THREE.MeshStandardMaterial({color:0x3a2818,roughness:.92});
    const treeTrunkBirch=new THREE.MeshStandardMaterial({color:0xc0b898,roughness:.82});
    const leafCols=[0x3a6830,0x4a7838,0x306028,0x3a5828,0x2e5024,0x4a7830,0x386028];
    function mkLeafMat(ci){return new THREE.MeshStandardMaterial({color:leafCols[ci%leafCols.length],roughness:.88,metalness:.03});}

    function mkTree(x,z,type){
        /* type: 0=round, 1=cone(pine), 2=wide oak, 3=birch, 4=palm, 5=bush */
        const ci=Math.floor(Math.random()*leafCols.length);
        const lm=mkLeafMat(ci);
        const tH=1.8+Math.random()*2.5;
        const trunkR=.08+Math.random()*.08;
        const tm=(type===3)?treeTrunkBirch:(Math.random()>.5?treeTrunkMat:treeTrunkDarkMat);
        const trunk=new THREE.Mesh(new THREE.CylinderGeometry(trunkR*.7,trunkR,tH,6),tm);
        trunk.position.set(x,tH/2,z); scene.add(trunk);

        if(type===0){/* Round deciduous */
            const r=1.0+Math.random()*.8;
            const top=new THREE.Mesh(new THREE.SphereGeometry(r,8,6),lm);
            top.position.set(x,tH+r*.6+Math.random()*.3,z); scene.add(top);
            if(Math.random()>.4){const t2=new THREE.Mesh(new THREE.SphereGeometry(r*.65,7,5),lm);
            t2.position.set(x+(Math.random()-.5)*r*.6,tH+r*1.1,z+(Math.random()-.5)*r*.6);scene.add(t2);}
        }else if(type===1){/* Conifer / pine */
            const layers=2+Math.floor(Math.random()*2);
            for(let l=0;l<layers;l++){
                const lr=1.6-l*.4+Math.random()*.2; const lh=1.0+Math.random()*.3;
                const cone=new THREE.Mesh(new THREE.ConeGeometry(lr,lh,7),
                    new THREE.MeshStandardMaterial({color:0x2a5a20+l*0x060806,roughness:.88}));
                cone.position.set(x,tH+l*.7+lh/2,z); scene.add(cone);
            }
        }else if(type===2){/* Wide oak */
            const r=1.5+Math.random()*.6;
            const top=new THREE.Mesh(new THREE.SphereGeometry(r,8,6),lm);
            top.scale.set(1.3,.8,1.3);
            top.position.set(x,tH+r*.4,z); scene.add(top);
            if(Math.random()>.3){const b=new THREE.Mesh(new THREE.SphereGeometry(r*.5,6,5),lm);
            b.position.set(x+r*.5,tH+r*.1,z+r*.3);scene.add(b);}
        }else if(type===3){/* Birch -- slender */
            const r=.7+Math.random()*.4;
            const top=new THREE.Mesh(new THREE.SphereGeometry(r,7,5),
                new THREE.MeshStandardMaterial({color:0x4a7a38,roughness:.84}));
            top.scale.set(.8,1.2,.8);
            top.position.set(x,tH+r*.7,z); scene.add(top);
        }else if(type===4){/* Palm */
            const frondMat=new THREE.MeshStandardMaterial({color:0x387828,roughness:.84,side:THREE.DoubleSide});
            for(let f=0;f<6;f++){
                const frond=new THREE.Mesh(new THREE.PlaneGeometry(.4,2.5),frondMat);
                frond.position.set(x,tH+.3,z);
                frond.rotation.y=f*(Math.PI/3)+Math.random()*.2;
                frond.rotation.x=-.5-Math.random()*.3;
                scene.add(frond);
            }
            const nut=new THREE.Mesh(new THREE.SphereGeometry(.18,5,4),new THREE.MeshStandardMaterial({color:0x785028}));
            nut.position.set(x,tH+.1,z); scene.add(nut);
        }else{/* Bush */
            const r=.6+Math.random()*.4;
            const bush=new THREE.Mesh(new THREE.SphereGeometry(r,6,5),lm);
            bush.position.set(x,r*.7,z); scene.add(bush);
        }
    }

    /* Park areas (green patches with varied trees) */
    let parkCount=0;
    for(let i=0;i<blocks&&parkCount<14;i++){for(let j=0;j<blocks&&parkCount<14;j++){
        if(Math.random()>.06) continue;
        const px=(i-half)*C.blockSize, pz=(j-half)*C.blockSize;
        if(Math.abs(px)<40&&Math.abs(pz)<40) continue;
        if(cityWaterAt(px,pz,10)) continue;
        const parkSize=12+Math.random()*10;
        /* Grass patch */
        const grass=new THREE.Mesh(new THREE.PlaneGeometry(parkSize,parkSize),
            new THREE.MeshStandardMaterial({color:0x3a5828,roughness:.92}));
        grass.rotation.x=-Math.PI/2; grass.position.set(px,.025,pz); scene.add(grass);
        /* Dirt path through park */
        const path=new THREE.Mesh(new THREE.PlaneGeometry(1.5,parkSize*.7),
            new THREE.MeshStandardMaterial({color:0x6a5838,roughness:.92}));
        path.rotation.x=-Math.PI/2; path.position.set(px,.03,pz); scene.add(path);
        /* Trees -- varied types */
        const treeCount=6+Math.floor(Math.random()*6);
        for(let t=0;t<treeCount;t++){
            const tx=px+(Math.random()-.5)*parkSize*.85, tz=pz+(Math.random()-.5)*parkSize*.85;
            mkTree(tx,tz,Math.floor(Math.random()*5));
        }
        /* Bushes along edges */
        for(let b=0;b<4+Math.floor(Math.random()*4);b++){
            const bx=px+(Math.random()-.5)*parkSize*.9, bz=pz+(Math.random()-.5)*parkSize*.9;
            mkTree(bx,bz,5);
        }
        /* Park benches (2-3 per park) */
        for(let bn=0;bn<2+Math.floor(Math.random()*2);bn++){
            const bx=px+(Math.random()-.5)*parkSize*.5, bz=pz+(Math.random()-.5)*parkSize*.5;
            const pb=new THREE.Mesh(new THREE.BoxGeometry(1.8,.08,.45),new THREE.MeshStandardMaterial({color:0x6a4828,roughness:.8}));
            pb.position.set(bx,.42,bz); scene.add(pb);
            const pbLegs=new THREE.BoxGeometry(.08,.38,.08);
            [-0.7,0.7].forEach(ox=>{
                const leg=new THREE.Mesh(pbLegs,new THREE.MeshStandardMaterial({color:0x505048}));
                leg.position.set(bx+ox,.2,bz); scene.add(leg);
            });
        }
        /* Flower beds (colored patches near benches) */
        for(let fb=0;fb<Math.floor(Math.random()*3);fb++){
            const fCols=[0x882244,0xaa4488,0xcc8844,0xeedd22,0xff6644];
            const fm=new THREE.Mesh(new THREE.CircleGeometry(.6+Math.random()*.5,8),
                new THREE.MeshStandardMaterial({color:fCols[Math.floor(Math.random()*fCols.length)],roughness:.9}));
            fm.rotation.x=-Math.PI/2; fm.position.set(px+(Math.random()-.5)*8,.035,pz+(Math.random()-.5)*8); scene.add(fm);
        }
        /* Lamp post in park */
        const lp=new THREE.Mesh(new THREE.CylinderGeometry(.04,.05,3.5,6),new THREE.MeshStandardMaterial({color:0x606058,metalness:.7}));
        lp.position.set(px+parkSize*.3,1.75,pz); scene.add(lp);
        const lBulb=new THREE.Mesh(new THREE.SphereGeometry(.18,6,5),new THREE.MeshBasicMaterial({color:0xffdd88}));
        lBulb.position.set(px+parkSize*.3,3.6,pz); scene.add(lBulb);
        parkCount++;
    }}

    /* ===== STREET TREES (lining sidewalks along roads) ===== */
    let streetTreeCount=0;
    for(let i=0;i<blocks&&streetTreeCount<180;i++){for(let j=0;j<blocks&&streetTreeCount<180;j++){
        const bx=(i-half)*C.blockSize, bz=(j-half)*C.blockSize;
        /* Plant trees along both sides of roads */
        const spacing=8+Math.random()*4;
        for(let s=-C.blockSize/2+3;s<C.blockSize/2-3;s+=spacing){
            if(Math.random()>.5) continue;
            /* Trees along east-west road edge */
            const side=(Math.random()>.5)?7/2+1.2:-7/2-1.2;
            mkTree(bx+s, bz+side, Math.random()>.3?0:Math.floor(Math.random()*4));
            streetTreeCount++;
            if(streetTreeCount>=180) break;
        }
        if(streetTreeCount>=180) break;
    }}

    /* Billboards on building sides (large, neon, with frame) */
    let bbCount=0;
    const bbTexts=['NEON','FLY','CYBER','2099','PULSE','GRID','APEX','SYNTH'];

    /* Construction cranes on some buildings */
    let craneCount=0;

    /* Fire hydrants */
    const hydMat=new THREE.MeshStandardMaterial({color:0xcc2200,roughness:.5,metalness:.6});
    const hydGeo=new THREE.CylinderGeometry(.12,.14,.6,6);
    let hydCount=0;
    for(let i=0;i<blocks&&hydCount<30;i++){for(let j=0;j<blocks&&hydCount<30;j++){
        if(Math.random()>.08) continue;
        const hx=(i-half)*C.blockSize+(Math.random()>.5?4.5:-4.5);
        const hz=(j-half)*C.blockSize+(Math.random()-.5)*30;
        const hyd=new THREE.Mesh(hydGeo,hydMat); hyd.position.set(hx,.3,hz); scene.add(hyd);
        const cap=new THREE.Mesh(new THREE.SphereGeometry(.14,6,6),hydMat); cap.position.set(hx,.65,hz); scene.add(cap);
        hydCount++;
    }}

    /* Manhole covers on roads */
    const manholeMat=new THREE.MeshBasicMaterial({color:0x585858,transparent:true,opacity:.6,side:THREE.DoubleSide});
    let manholeCount=0;
    for(let i=0;i<=blocks&&manholeCount<20;i++){for(let j=0;j<=blocks&&manholeCount<20;j++){
        if(Math.random()>.12) continue;
        const mx=(i-half)*C.blockSize+(Math.random()-.5)*4;
        const mz=(j-half)*C.blockSize+(Math.random()-.5)*4;
        const mh=new THREE.Mesh(new THREE.CircleGeometry(.4,8),manholeMat);
        mh.rotation.x=-Math.PI/2; mh.position.set(mx,.015,mz); scene.add(mh);
        manholeCount++;
    }}

    const bldgNames = [
        'NEXUS TOWER','ORION PLAZA','VERTEX HQ','ZENITH','HELIX CORP',
        'PRISM LABS','ATLAS CENTER','NOVA SUITES','ECHO BUILDING','APEX TOWER',
        'CIPHER TECH','DELTA WORKS','VANGUARD','PINNACLE','SYNTH CORP',
        'QUANTUM HUB','SOLARIS','ARCADIA','HAVEN TOWER','MIRAGE',
        'COBALT HOUSE','MERIDIAN','PHOENIX PLAZA','TUNDRA INC','OASIS TOWER',
        'BASALT CORP','IRON GATE','SLATE TOWER','AMBER HOUSE','JADE PLAZA',
        'TITAN CENTER','LUNAR LABS','EMBER WORKS','DRIFT HQ','HARBOR TOWER',
        'CREST TOWER','FORGE INC','STONE RIDGE','AETHER PLAZA','VELVET SUITES',
    ];
    let bldgNameIdx = 0;

    function mkBldgNameTex(name, accentColor) {
        const cv=document.createElement('canvas'); cv.width=1024; cv.height=256;
        const cx=cv.getContext('2d');
        cx.fillStyle='rgba(10,10,15,0.92)'; cx.fillRect(0,0,1024,256);
        const r=(accentColor>>16)&0xff, g=(accentColor>>8)&0xff, b=accentColor&0xff;
        const hex=`rgb(${r},${g},${b})`;
        const glow=`rgba(${r},${g},${b},0.4)`;
        const glowStrong=`rgba(${r},${g},${b},0.7)`;
        /* Neon glow background wash */
        const grad=cx.createRadialGradient(512,128,40,512,128,450);
        grad.addColorStop(0,`rgba(${r},${g},${b},0.12)`);
        grad.addColorStop(1,'transparent');
        cx.fillStyle=grad; cx.fillRect(0,0,1024,256);
        /* Border with neon color */
        cx.strokeStyle=glowStrong; cx.lineWidth=4;
        cx.strokeRect(6,6,1012,244);
        cx.strokeStyle=glow; cx.lineWidth=8;
        cx.strokeRect(2,2,1020,252);
        /* Neon text with glow layers */
        cx.font='bold 72px "Courier New", monospace';
        cx.textAlign='center'; cx.textBaseline='middle';
        /* Outer glow */
        cx.shadowColor=hex; cx.shadowBlur=40;
        cx.fillStyle=glow;
        cx.fillText(name,512,128);
        /* Mid glow */
        cx.shadowBlur=20;
        cx.fillStyle=glowStrong;
        cx.fillText(name,512,128);
        /* Core bright text */
        cx.shadowBlur=8;
        cx.fillStyle=`rgb(${Math.min(255,r+120)},${Math.min(255,g+120)},${Math.min(255,b+120)})`;
        cx.fillText(name,512,128);
        /* White-hot center */
        cx.shadowBlur=4;
        cx.fillStyle=`rgb(${Math.min(255,r+200)},${Math.min(255,g+200)},${Math.min(255,b+200)})`;
        cx.fillText(name,512,128);
        cx.shadowBlur=0;
        const tex=new THREE.CanvasTexture(cv);
        tex.minFilter=THREE.LinearFilter;
        tex.magFilter=THREE.LinearFilter;
        return tex;
    }

    /* Buildings.
     *
     * Height is driven by a district density field rather than pure noise, so
     * the city actually has a skyline: towers cluster downtown and fall away
     * toward the riverfront and the industrial yard. */
    const DISTRICT_WEIGHT = { 'downtown':1.0, 'riverfront':0.55, 'industrial':0.34, 'command-base':0.2 };
    function densityAt(x,z){
        let best=0;
        for(const dist of CITY_MAP.districts){
            const dx=x-dist.x*C.citySize, dz=z-dist.z*C.citySize;
            const r=Math.hypot(dx,dz)/(dist.radius*2.6);
            if(r>=1) continue;
            /* smoothstep falloff from the district centre */
            const f=1-(r*r*(3-2*r));
            best=Math.max(best, f*(DISTRICT_WEIGHT[dist.id]??0.4));
        }
        /* Global radial falloff so the map edges stay low-rise. */
        const edge=1-Math.min(1,Math.hypot(x,z)/(C.citySize*0.72));
        return Math.max(0, best*(0.35+0.65*edge));
    }

    /* Each street block is filled with a cluster of lots rather than one lonely
     * tower, so the city reads as continuous built-up fabric between arterials
     * instead of isolated boxes on empty ground. */
    const ROAD_HALF = 7;                       /* road width/2 plus verge */
    const usable = C.blockSize - ROAD_HALF*2;  /* buildable span inside a block */
    for(let gx=0;gx<blocks;gx++){for(let gz=0;gz<blocks;gz++){
        const bx=(gx-half)*C.blockSize;
        const bz=(gz-half)*C.blockSize;
        const blockDens=densityAt(bx,bz);
        /* Dense districts subdivide into more, smaller lots. */
        const sub = blockDens>0.55 ? 3 : blockDens>0.28 ? 2 : 2;
        const lot = usable/sub;

    for(let sx=0;sx<sub;sx++){for(let sz=0;sz<sub;sz++){
        if(Math.random()>C.buildChance) continue;
        /* Lot centre inside the block, with a little jitter for irregularity. */
        const x=bx + (sx-(sub-1)/2)*lot + (Math.random()-.5)*lot*0.12;
        const z=bz + (sz-(sub-1)/2)*lot + (Math.random()-.5)*lot*0.12;
        if(Math.abs(x)<38&&Math.abs(z)<38) continue;
        if(cityWaterAt(x,z,16)) continue;

        const dens=densityAt(x,z);
        /* Footprints nearly fill their lot, leaving only a narrow light well. */
        const fill=0.72+Math.random()*0.2;
        const w=Math.max(7, lot*fill*(0.85+Math.random()*0.3));
        const d=Math.max(7, lot*fill*(0.85+Math.random()*0.3));
        const h=7+dens*dens*135*(0.5+Math.random()*0.8)+Math.random()*12;
        const geo=new THREE.BoxGeometry(w,h,d);

        const sideMat = mkBldgMat(w,h);
        const sideMat2 = mkBldgMat(d,h);
        const mats = [sideMat2, sideMat2, roofMat, roofMat, sideMat, sideMat];
        const mesh = new THREE.Mesh(geo, mats);
        mesh.position.set(x, h/2, z);
        tagShadows(mesh,true,true);
        scene.add(mesh);

        /* Floor-slab bands and a cornice cap: cheap proud rings that give the
         * facade real self-shadowing under a low sun. */
        const bandMat=new THREE.MeshStandardMaterial({color:0x6d6a63,roughness:.82,metalness:.06});
        const floors=Math.max(1,Math.floor(h/18));
        for(let fb=1;fb<=floors;fb++){
            const by=(h/(floors+1))*fb;
            const band=new THREE.Mesh(new THREE.BoxGeometry(w+0.35,0.3,d+0.35),bandMat);
            band.position.set(x,by,z); tagShadows(band,true,true); scene.add(band);
        }
        const cornice=new THREE.Mesh(new THREE.BoxGeometry(w+0.9,0.55,d+0.9),bandMat);
        cornice.position.set(x,h-0.28,z); tagShadows(cornice,true,true); scene.add(cornice);

        /* Real buildings sit on plinths, plazas, loading bays, and visible foundations. */
        const plinthMat=new THREE.MeshStandardMaterial({color:0x595955,roughness:.86,metalness:.08});
        const plinth=new THREE.Mesh(new THREE.BoxGeometry(w+3.4,.45,d+3.4),plinthMat);
        plinth.position.set(x,.22,z); tagShadows(plinth,true,true); scene.add(plinth);
        const apron=new THREE.Mesh(new THREE.PlaneGeometry(w+8,d+8),concreteMat);
        apron.rotation.x=-Math.PI/2; apron.position.set(x,.035,z); tagShadows(apron,false,true); scene.add(apron);
        if(Math.random()<.55){
            const dockMat=new THREE.MeshStandardMaterial({color:0x4b4b48,roughness:.82,metalness:.18});
            const dock=new THREE.Mesh(new THREE.BoxGeometry(Math.min(w*.55,7),.8,1.2),dockMat);
            dock.position.set(x,.45,z-d/2-1.45); scene.add(dock);
            const shutter=new THREE.Mesh(new THREE.PlaneGeometry(Math.min(w*.42,5.5),1.8),new THREE.MeshBasicMaterial({color:0x2f3436,transparent:true,opacity:.86,side:THREE.DoubleSide}));
            shutter.position.set(x,1.4,z-d/2-.06); scene.add(shutter);
        }

        /* No neon wireframe outline — real buildings are read by their silhouette
         * and cornice shadows, not by a glowing edge. */
        const nc=neonCols[Math.floor(Math.random()*neonCols.length)];

        /* One neon signboard per building */
        {
            const bName = bldgNames[bldgNameIdx % bldgNames.length];
            bldgNameIdx++;
            const nameTex = mkBldgNameTex(bName, nc);
            const faceW = w >= d ? w : d;
            const signW = Math.min(faceW * 0.85, 14);
            const signH = signW * 0.25;
            const nameSignGeo = new THREE.PlaneGeometry(signW, signH);
            const nameSignMat = new THREE.MeshBasicMaterial({map:nameTex, transparent:true, side:THREE.DoubleSide});
            const signY = h - 2.5;
            const ns = new THREE.Mesh(nameSignGeo, nameSignMat);
            if(w >= d){
                ns.position.set(x, signY, z + d/2 + 0.25);
            } else {
                ns.position.set(x + w/2 + 0.25, signY, z);
                ns.rotation.y = -Math.PI/2;
            }
            scene.add(ns);
        }

        buildings.push({mesh, bbox:new THREE.Box3().setFromObject(mesh)});

        /* Storefront at ground level */
        if(Math.random()<.6){
            const face=Math.floor(Math.random()*4);
            const ac=awningCols[Math.floor(Math.random()*awningCols.length)];
            const awW=Math.min(w,d)*.6+Math.random()*3;
            const awGeo=new THREE.BoxGeometry(awW,.06,1.2);
            const awMat=new THREE.MeshStandardMaterial({color:ac,roughness:.7});
            const aw=new THREE.Mesh(awGeo,awMat);
            if(face===0) {aw.position.set(x,3.2,z+d/2+.6);aw.rotation.z=-.15;}
            else if(face===1){aw.position.set(x,3.2,z-d/2-.6);aw.rotation.z=.15;}
            else if(face===2){aw.position.set(x+w/2+.6,3.2,z);aw.rotation.x=-.15;aw.rotation.y=Math.PI/2;}
            else{aw.position.set(x-w/2-.6,3.2,z);aw.rotation.x=.15;aw.rotation.y=Math.PI/2;}
            scene.add(aw);
            /* Shop window glow underneath awning */
            const swGeo=new THREE.PlaneGeometry(awW*.8,2);
            const sw=new THREE.Mesh(swGeo,shopGlowMat);
            if(face===0){sw.position.set(x,1.5,z+d/2+.12);}
            else if(face===1){sw.position.set(x,1.5,z-d/2-.12);sw.rotation.y=Math.PI;}
            else if(face===2){sw.position.set(x+w/2+.12,1.5,z);sw.rotation.y=-Math.PI/2;}
            else{sw.position.set(x-w/2-.12,1.5,z);sw.rotation.y=Math.PI/2;}
            scene.add(sw);
            /* Door */
            const doorMat=new THREE.MeshStandardMaterial({color:0x504838,roughness:.5,metalness:.5});
            const door=new THREE.Mesh(new THREE.PlaneGeometry(.8,2),doorMat);
            if(face===0){door.position.set(x+(Math.random()-.5)*awW*.3,1,z+d/2+.13);}
            else if(face===1){door.position.set(x+(Math.random()-.5)*awW*.3,1,z-d/2-.13);door.rotation.y=Math.PI;}
            else if(face===2){door.position.set(x+w/2+.13,1,z+(Math.random()-.5)*awW*.3);door.rotation.y=-Math.PI/2;}
            else{door.position.set(x-w/2-.13,1,z+(Math.random()-.5)*awW*.3);door.rotation.y=Math.PI/2;}
            scene.add(door);
        }

        /* Building accent light */
        if(bldgLightCount<6 && Math.random()<.12){
            const pl=new THREE.PointLight(nc,1.5,30);
            pl.position.set(x+(Math.random()-.5)*w,3,z+(Math.random()-.5)*d);
            scene.add(pl); bldgLightCount++;
        }

        /* Neon sign on tall buildings (flickering) */
        if(h>50 && Math.random()<.5){
            const sw=3+Math.random()*6, sh=1.5+Math.random()*3;
            const signGeo=new THREE.PlaneGeometry(sw,sh);
            const signMat=new THREE.MeshBasicMaterial({color:nc,transparent:true,opacity:.75,side:THREE.DoubleSide});
            const sign=new THREE.Mesh(signGeo,signMat);
            const face=Math.floor(Math.random()*4);
            const offs=[[x,h*.6,z+d/2+.2,0],[x,h*.6,z-d/2-.2,0],[x+w/2+.2,h*.6,z,Math.PI/2],[x-w/2-.2,h*.6,z,Math.PI/2]];
            sign.position.set(offs[face][0],offs[face][1],offs[face][2]);
            sign.rotation.y=offs[face][3]; scene.add(sign);
            neonSigns.push({mesh:sign,mat:signMat,base:.75,rate:.5+Math.random()*4,phase:Math.random()*Math.PI*2});
        }

        /* Building setback (wider base on tall buildings) */
        if(h>55 && Math.random()<.35){
            const bw=w+4, bd=d+4, bh=h*0.25;
            const bGeo=new THREE.BoxGeometry(bw,bh,bd);
            const bMesh=new THREE.Mesh(bGeo,[mkBldgMat(bd,bh),mkBldgMat(bd,bh),roofMat,roofMat,mkBldgMat(bw,bh),mkBldgMat(bw,bh)]);
            bMesh.position.set(x,bh/2,z); scene.add(bMesh);
        }

        /* Rooftop details */
        const parapetMat=new THREE.MeshStandardMaterial({color:0x3f4548,roughness:.82,metalness:.15});
        const pH=.7, pT=.35;
        [[0,d/2+pT/2,w+pT*2,pT],[0,-d/2-pT/2,w+pT*2,pT],[w/2+pT/2,0,pT,d],[-w/2-pT/2,0,pT,d]].forEach(p=>{
            const wall=new THREE.Mesh(new THREE.BoxGeometry(p[2],pH,p[3]),parapetMat);
            wall.position.set(x+p[0],h+pH/2,z+p[1]); scene.add(wall);
        });
        if(Math.random()<.45){
            const stair=new THREE.Mesh(new THREE.BoxGeometry(2.2,1.8,2.8),new THREE.MeshStandardMaterial({color:0x4d5355,roughness:.82,metalness:.15}));
            stair.position.set(x+(Math.random()-.5)*w*.4,h+.9,z+(Math.random()-.5)*d*.4); scene.add(stair);
        }
        if(Math.random()<.5){
            const acGeo=new THREE.BoxGeometry(1.5+Math.random()*2,.8+Math.random()*1.5,1.5+Math.random()*2);
            const acMat=new THREE.MeshStandardMaterial({color:0x909088,roughness:.7,metalness:.45});
            for(let ri=0;ri<1+Math.floor(Math.random()*3);ri++){
                const ac=new THREE.Mesh(acGeo,acMat);
                ac.position.set(x+(Math.random()-.5)*w*.5,h+.5,z+(Math.random()-.5)*d*.5);
                scene.add(ac);
            }
        }
        /* Water tank (cylinder on roof) */
        if(h>40&&Math.random()<.2){
            const tank=new THREE.Mesh(new THREE.CylinderGeometry(1.2,1.2,2.5,8),new THREE.MeshStandardMaterial({color:0x808078,roughness:.68,metalness:.4}));
            tank.position.set(x+(Math.random()-.5)*w*.3,h+1.3,z+(Math.random()-.5)*d*.3); scene.add(tank);
        }
        /* Antenna + blinking tip */
        if(h>60&&Math.random()<.35){
            const ant=new THREE.Mesh(new THREE.CylinderGeometry(.04,.04,6,4),new THREE.MeshStandardMaterial({color:0x909090,metalness:.85}));
            ant.position.set(x,h+3,z); scene.add(ant);
            const tip=new THREE.Mesh(new THREE.SphereGeometry(.15,6,6),new THREE.MeshBasicMaterial({color:0xff0022}));
            tip.position.set(x,h+6.1,z); scene.add(tip);
        }
        /* Helipad marking on very tall buildings */
        if(h>70&&Math.random()<.3){
            const pad=new THREE.Mesh(new THREE.RingGeometry(1.5,2.2,16),new THREE.MeshBasicMaterial({color:0xffff44,transparent:true,opacity:.4,side:THREE.DoubleSide}));
            pad.rotation.x=-Math.PI/2; pad.position.set(x,h+.05,z); scene.add(pad);
            const hMark=new THREE.Mesh(new THREE.PlaneGeometry(.8,1.8),new THREE.MeshBasicMaterial({color:0xffff44,transparent:true,opacity:.35,side:THREE.DoubleSide}));
            hMark.rotation.x=-Math.PI/2; hMark.position.set(x,h+.06,z); scene.add(hMark);
        }
    }}   /* lots within a block */
    }}   /* blocks */
}
function updateWater(dt){
    for(const w of waterAnims){
        if(!w.tex) continue;
        w.tex.offset.x += w.sx * dt * 60;
        w.tex.offset.y += w.sy * dt * 60;
    }
}

/* ===== MOVING TRAFFIC ===== */
const traffic=[];
const tCarGeo=new THREE.BoxGeometry(1.6,.7,3.2);
const tCarTopGeo=new THREE.BoxGeometry(1.3,.55,1.8);
const tCarCols=[0xd0d0d0,0x303030,0xb02020,0x2040a0,0xe0e0e0,0x707070,0x906820,0x404040,0x204080,0xa0a090,0x205028,0x808080];
function spawnTraffic(){
    const blocks=Math.floor(C.citySize/C.blockSize),half=blocks/2;
    for(let n=0;n<20;n++){
        const isH=Math.random()>.5;
        const lane=Math.floor(Math.random()*(blocks+1));
        const roadPos=(lane-half)*C.blockSize;
        const cc=tCarCols[Math.floor(Math.random()*tCarCols.length)];
        const mat=new THREE.MeshStandardMaterial({color:cc,roughness:.35,metalness:.6,emissive:cc,emissiveIntensity:.05});
        const g=new THREE.Group();
        const body=new THREE.Mesh(tCarGeo,mat); body.position.y=.35; g.add(body);
        const top=new THREE.Mesh(tCarTopGeo,mat); top.position.y=.8; top.position.z=-.15; g.add(top);
        const hlM=new THREE.MeshBasicMaterial({color:0xeeeebb});
        [-.55,.55].forEach(xo=>{const hl=new THREE.Mesh(new THREE.BoxGeometry(.2,.12,.04),hlM);hl.position.set(xo,.35,-1.62);g.add(hl);});
        const tlM=new THREE.MeshBasicMaterial({color:0xcc2200});
        [-.55,.55].forEach(xo=>{const tl=new THREE.Mesh(new THREE.BoxGeometry(.2,.1,.04),tlM);tl.position.set(xo,.35,1.62);g.add(tl);});
        const spd=6+Math.random()*10;
        const dir=Math.random()>.5?1:-1;
        const laneOff=dir>0?2.0:-2.0;
        if(isH){
            g.position.set((Math.random()-.5)*C.citySize,.0,roadPos+laneOff);
            g.rotation.y=dir>0?-Math.PI/2:Math.PI/2;
        }else{
            g.position.set(roadPos+laneOff,.0,(Math.random()-.5)*C.citySize);
            g.rotation.y=dir>0?0:Math.PI;
        }
        g.userData={spd,dir,isH,roadPos,laneOff};
        scene.add(g); traffic.push(g);
    }
}
function carBlocked(c){
    const ud=c.userData;
    const ahead=ud.isH?(c.position.x+ud.dir*6):c.position.x;
    const side=ud.isH?c.position.z:(c.position.z+ud.dir*6);
    const nearby=getNearbyBuildings(ahead,side);
    for(const b of nearby){
        if(b.bbox.min.x-2<ahead&&b.bbox.max.x+2>ahead&&b.bbox.min.z-2<side&&b.bbox.max.z+2>side) return true;
    }
    return false;
}
function updTraffic(dt){
    const half=C.citySize/2;
    for(const c of traffic){
        const ud=c.userData;
        if(carBlocked(c)){
            if(ud.isH) c.position.x=ud.dir>0?-half-10:half+10;
            else c.position.z=ud.dir>0?-half-10:half+10;
            continue;
        }
        if(ud.isH){
            c.position.x+=ud.spd*ud.dir*dt;
            if(c.position.x>half+20) c.position.x=-half-15;
            if(c.position.x<-half-20) c.position.x=half+15;
        }else{
            c.position.z+=ud.spd*ud.dir*dt;
            if(c.position.z>half+20) c.position.z=-half-15;
            if(c.position.z<-half-20) c.position.z=half+15;
        }
    }
}

/* ===== POWER-UPS ===== */
const powerUps=[];
const puTypes=[
    {name:'RAPID FIRE',color:0xc08e6a,dur:8},
    {name:'SHIELD',color:0x7fa9ba,dur:10},
    {name:'SPEED BOOST',color:0x8a7eb1,dur:7},
];
let activePU=null, puTimer=0;
function spawnPowerUps(){
    const hf=C.citySize/2-30;
    for(let i=0;i<6;i++){
        const type=puTypes[i%puTypes.length];
        const g=new THREE.Group();
        const core=new THREE.Mesh(new THREE.OctahedronGeometry(.6,0),new THREE.MeshBasicMaterial({color:type.color,transparent:true,opacity:.8}));
        g.add(core);
        const ring=new THREE.Mesh(new THREE.TorusGeometry(.9,.06,6,16),new THREE.MeshBasicMaterial({color:type.color,transparent:true,opacity:.4}));
        ring.rotation.x=Math.PI/2; g.add(ring);
        g.position.set((Math.random()-.5)*hf*2,10+Math.random()*50,(Math.random()-.5)*hf*2);
        g.userData={type,got:false,baseY:g.position.y};
        scene.add(g); powerUps.push(g);
    }
}
function updPowerUps(dt){
    const t=performance.now()*.001;
    for(const pu of powerUps){
        if(pu.userData.got) continue;
        pu.rotation.y+=dt*2; pu.rotation.x=Math.sin(t+pu.position.x)*0.3;
        pu.position.y=pu.userData.baseY+Math.sin(t*1.5+pu.position.z)*.8;
        if(drone.position.distanceTo(pu.position)<3.5){
            pu.userData.got=true; pu.visible=false;
            activePU=pu.userData.type; puTimer=pu.userData.type.dur;
            notify(pu.userData.type.name+' ACTIVE','ring-note');
            sndPickup(); vib(60,.15,.2);
            setTimeout(()=>{
                const hf=C.citySize/2-30;
                pu.position.set((Math.random()-.5)*hf*2,10+Math.random()*50,(Math.random()-.5)*hf*2);
                pu.userData.baseY=pu.position.y;pu.userData.got=false;pu.visible=true;
            },20000);
        }
    }
    if(puTimer>0){puTimer-=dt;if(puTimer<=0){activePU=null;notify('POWER-UP EXPIRED','kill-note');}}
}

/* ===== DUST/SAND PARTICLES ===== */
const RAIN_N=400;
const rainPos=new Float32Array(RAIN_N*3);
for(let i=0;i<RAIN_N;i++){
    rainPos[i*3]=(Math.random()-.5)*140;
    rainPos[i*3+1]=Math.random()*50;
    rainPos[i*3+2]=(Math.random()-.5)*140;
}
const rainGeo=new THREE.BufferGeometry();
rainGeo.setAttribute('position',new THREE.BufferAttribute(rainPos,3));
const rain=new THREE.Points(rainGeo,new THREE.PointsMaterial({color:0x4466aa,size:.18,transparent:true,opacity:.15,blending:THREE.AdditiveBlending,depthWrite:false}));
scene.add(rain);

/* ===== AMBIENT PARTICLES ===== */
const PART_N=150;
const partPos=new Float32Array(PART_N*3);
const partVel=[];
for(let i=0;i<PART_N;i++){
    partPos[i*3]=(Math.random()-.5)*90;
    partPos[i*3+1]=2+Math.random()*60;
    partPos[i*3+2]=(Math.random()-.5)*90;
    partVel.push((Math.random()-.5)*1.5,(Math.random()-.5)*.4,(Math.random()-.5)*1.5);
}
const partGeo=new THREE.BufferGeometry();
partGeo.setAttribute('position',new THREE.BufferAttribute(partPos,3));
const ambParts=new THREE.Points(partGeo,new THREE.PointsMaterial({color:0xc8b080,size:.4,transparent:true,opacity:.25,blending:THREE.AdditiveBlending,depthWrite:false}));
scene.add(ambParts);

/* ===== LIGHTNING ===== */
let lightningTimer=0, lightningFlash=null;
function triggerLightning(){
    if(lightningFlash){scene.remove(lightningFlash);lightningFlash=null;}
    const fl=new THREE.DirectionalLight(0xccccff,3);
    fl.position.set((Math.random()-.5)*200,120,(Math.random()-.5)*200);
    scene.add(fl); lightningFlash=fl;
    setTimeout(()=>{if(lightningFlash===fl){scene.remove(fl);lightningFlash=null;}},120);
    setTimeout(()=>{
        const fl2=new THREE.DirectionalLight(0xccccff,1.5);
        fl2.position.copy(fl.position); scene.add(fl2);
        setTimeout(()=>scene.remove(fl2),80);
    },180);
    /* Thunder sound */
    const t=actx.currentTime,dur=.6;
    const buf=actx.createBuffer(1,actx.sampleRate*dur,actx.sampleRate),d=buf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,1.2);
    const s=actx.createBufferSource();s.buffer=buf;
    const g=actx.createGain();g.gain.setValueAtTime(.15,t);g.gain.exponentialRampToValueAtTime(.001,t+dur);
    const f=actx.createBiquadFilter();f.type='lowpass';f.frequency.setValueAtTime(400,t);
    s.connect(f).connect(g).connect(actx.destination);s.start(t+.3);s.stop(t+dur+.3);
}

function updParticles(dt){
    /* Rain */
    const rp=rain.geometry.attributes.position.array;
    for(let i=0;i<RAIN_N;i++){
        const i3=i*3;
        rp[i3]+=3.5*dt; rp[i3+1]+=-2.5*dt+Math.sin(rp[i3]*0.1)*0.8*dt; rp[i3+2]+=1.2*dt;
        if(rp[i3+1]<0){rp[i3]=camera.position.x+(Math.random()-.5)*140;rp[i3+1]=3+Math.random()*45;rp[i3+2]=camera.position.z+(Math.random()-.5)*140;}
        if(Math.abs(rp[i3]-camera.position.x)>65){rp[i3]=camera.position.x+(Math.random()-.5)*120;}
        if(Math.abs(rp[i3+2]-camera.position.z)>65){rp[i3+2]=camera.position.z+(Math.random()-.5)*120;}
    }
    rain.geometry.attributes.position.needsUpdate=true;
    /* Ambient dust */
    const p=ambParts.geometry.attributes.position.array;
    for(let i=0;i<PART_N;i++){
        const i3=i*3;
        p[i3]+=partVel[i3]*dt;p[i3+1]+=partVel[i3+1]*dt;p[i3+2]+=partVel[i3+2]*dt;
        if(Math.abs(p[i3]-camera.position.x)>50){p[i3]=camera.position.x+(Math.random()-.5)*90;}
        if(Math.abs(p[i3+2]-camera.position.z)>50){p[i3+2]=camera.position.z+(Math.random()-.5)*90;}
        if(p[i3+1]<1||p[i3+1]>65){p[i3+1]=2+Math.random()*55;}
    }
    ambParts.geometry.attributes.position.needsUpdate=true;
    /* Lightning timer */
    lightningTimer-=dt;
    if(lightningTimer<=0){lightningTimer=20+Math.random()*40;triggerLightning();}
}

/* ===== REALISTIC MULTI-LAYER ENGINE SOUND (motor whine + blade chop + turbulence) ===== */
let engineOsc=null, engineOsc2=null, engineGain=null;
let windNoise=null, windGain=null, windFilter=null;
let rotorOsc=null, rotorGain=null;
let motorBuzz=null, motorBuzzGain=null, motorBuzzFilt=null;
let bladeChop=null, bladeChopGain=null;
let turbNoise=null, turbGain=null, turbFilt=null;
function startEngine(){
    if(engineOsc) return;
    try{
    /* Layer 1: Primary motor whine (high-pitched, characteristic drone sound) */
    engineOsc=actx.createOscillator(); engineGain=actx.createGain();
    engineOsc.type='sawtooth'; engineOsc.frequency.value=120;
    engineGain.gain.value=0.08;
    const filt=actx.createBiquadFilter(); filt.type='bandpass'; filt.frequency.value=280; filt.Q.value=2.5;
    engineOsc.connect(filt).connect(engineGain).connect(actx.destination);
    engineOsc.start();
    /* Layer 2: Motor harmonic (adds body/richness) */
    engineOsc2=actx.createOscillator();
    const eGain2=actx.createGain(); eGain2.gain.value=0;
    engineOsc2.type='square'; engineOsc2.frequency.value=240;
    const filt2=actx.createBiquadFilter(); filt2.type='bandpass'; filt2.frequency.value=500; filt2.Q.value=3.0;
    engineOsc2.connect(filt2).connect(eGain2).connect(actx.destination);
    engineOsc2.start(); engineOsc2._gain=eGain2;
    /* Layer 3: Low motor buzz (the distinctive drone hum) */
    motorBuzz=actx.createOscillator(); motorBuzzGain=actx.createGain();
    motorBuzz.type='sawtooth'; motorBuzz.frequency.value=55;
    motorBuzzGain.gain.value=0.06;
    motorBuzzFilt=actx.createBiquadFilter(); motorBuzzFilt.type='lowpass'; motorBuzzFilt.frequency.value=180;
    motorBuzz.connect(motorBuzzFilt).connect(motorBuzzGain).connect(actx.destination);
    motorBuzz.start();
    /* Layer 4: Blade chop / passing frequency (the rhythmic thwap-thwap) */
    bladeChop=actx.createOscillator(); bladeChopGain=actx.createGain();
    bladeChop.type='triangle'; bladeChop.frequency.value=28;
    bladeChopGain.gain.value=0;
    const chopFilt=actx.createBiquadFilter(); chopFilt.type='lowpass'; chopFilt.frequency.value=60;
    bladeChop.connect(chopFilt).connect(bladeChopGain).connect(actx.destination);
    bladeChop.start();
    /* Layer 5: Wind/aerodynamic noise (broadband, speed-dependent) */
    const windLen=actx.sampleRate*2;
    const windBuf=actx.createBuffer(1,windLen,actx.sampleRate);
    const wd=windBuf.getChannelData(0);
    for(let i=0;i<windLen;i++) wd[i]=(Math.random()*2-1);
    windNoise=actx.createBufferSource(); windNoise.buffer=windBuf; windNoise.loop=true;
    windGain=actx.createGain(); windGain.gain.value=0;
    windFilter=actx.createBiquadFilter(); windFilter.type='bandpass'; windFilter.frequency.value=1200; windFilter.Q.value=0.5;
    windNoise.connect(windFilter).connect(windGain).connect(actx.destination);
    windNoise.start();
    /* Layer 6: Turbulence rumble (low freq broadband, adds realism at speed) */
    const turbLen=actx.sampleRate*2;
    const turbBuf=actx.createBuffer(1,turbLen,actx.sampleRate);
    const td=turbBuf.getChannelData(0);
    for(let i=0;i<turbLen;i++) td[i]=(Math.random()*2-1)*0.7;
    turbNoise=actx.createBufferSource(); turbNoise.buffer=turbBuf; turbNoise.loop=true;
    turbGain=actx.createGain(); turbGain.gain.value=0;
    turbFilt=actx.createBiquadFilter(); turbFilt.type='lowpass'; turbFilt.frequency.value=200;
    turbNoise.connect(turbFilt).connect(turbGain).connect(actx.destination);
    turbNoise.start();
    /* Layer 7: High-freq rotor whirr */
    rotorOsc=actx.createOscillator(); rotorGain=actx.createGain();
    rotorOsc.type='sine'; rotorOsc.frequency.value=85;
    rotorGain.gain.value=0;
    const rotFilt=actx.createBiquadFilter(); rotFilt.type='bandpass'; rotFilt.frequency.value=150; rotFilt.Q.value=1.5;
    rotorOsc.connect(rotFilt).connect(rotorGain).connect(actx.destination);
    rotorOsc.start();
    }catch(e){console.warn('Engine audio init failed:',e);}
}
function updEngine(spd,thrust){
    if(!engineOsc) return;
    try{
    const t=actx.currentTime;
    const rpm=THREE.MathUtils.clamp(thrust,0,2);
    const mFreq=120+rpm*180+spd*0.5;
    const mVol=0.12+rpm*0.10+Math.min(spd*0.002,0.06);
    engineOsc.frequency.setTargetAtTime(THREE.MathUtils.clamp(mFreq,80,550),t,.05);
    engineGain.gain.setTargetAtTime(THREE.MathUtils.clamp(mVol,0,.30),t,.03);
    if(engineOsc2){
        engineOsc2.frequency.setTargetAtTime(THREE.MathUtils.clamp(mFreq*2,160,1100),t,.06);
        engineOsc2._gain.gain.setTargetAtTime(THREE.MathUtils.clamp(mVol*.4,0,.12),t,.04);
    }
    if(motorBuzz){
        motorBuzz.frequency.setTargetAtTime(THREE.MathUtils.clamp(55+rpm*45,45,150),t,.07);
        motorBuzzGain.gain.setTargetAtTime(THREE.MathUtils.clamp(0.10+rpm*0.08,0,.22),t,.04);
        motorBuzzFilt.frequency.setTargetAtTime(THREE.MathUtils.clamp(140+rpm*140,100,450),t,.08);
    }
    if(bladeChop){
        bladeChop.frequency.setTargetAtTime(THREE.MathUtils.clamp(22+rpm*35,18,95),t,.05);
        bladeChopGain.gain.setTargetAtTime(THREE.MathUtils.clamp(0.04+rpm*0.06,0,.12),t,.04);
    }
    if(windGain){
        const wv=Math.min(spd*0.006,0.25);
        windGain.gain.setTargetAtTime(wv,t,.08);
        if(windFilter) windFilter.frequency.setTargetAtTime(THREE.MathUtils.clamp(600+spd*20,600,4000),t,.12);
    }
    if(turbGain){
        const tv=Math.min(spd*0.003+rpm*0.02,0.10);
        turbGain.gain.setTargetAtTime(tv,t,.10);
        if(turbFilt) turbFilt.frequency.setTargetAtTime(THREE.MathUtils.clamp(120+spd*4,100,400),t,.12);
    }
    if(rotorOsc){
        rotorOsc.frequency.setTargetAtTime(THREE.MathUtils.clamp(60+rpm*60,50,200),t,.05);
        rotorGain.gain.setTargetAtTime(THREE.MathUtils.clamp(0.05+rpm*0.04,0,.12),t,.04);
    }
    }catch(_){}
}

/* ===== DRONE EXHAUST TRAIL ===== */
const TRAIL_N=80;
const trailPos=new Float32Array(TRAIL_N*3);
const trailAlpha=new Float32Array(TRAIL_N);
let trailIdx=0;
for(let i=0;i<TRAIL_N;i++){trailPos[i*3]=0;trailPos[i*3+1]=-999;trailPos[i*3+2]=0;trailAlpha[i]=0;}
const trailGeo=new THREE.BufferGeometry();
trailGeo.setAttribute('position',new THREE.BufferAttribute(trailPos,3));
trailGeo.setAttribute('alpha',new THREE.BufferAttribute(trailAlpha,1));
const trailMat=new THREE.PointsMaterial({color:0x888880,size:.25,transparent:true,opacity:.18,blending:THREE.AdditiveBlending,depthWrite:false});
const droneTrail=new THREE.Points(trailGeo,trailMat);
scene.add(droneTrail);

let trailCD=0;
function updTrail(dt){
    trailCD-=dt;
    if(trailCD<=0){
        trailCD=.02;
        const wp=new THREE.Vector3(0,-.3,.5);
        drone.localToWorld(wp);
        trailPos[trailIdx*3]=wp.x;trailPos[trailIdx*3+1]=wp.y;trailPos[trailIdx*3+2]=wp.z;
        trailAlpha[trailIdx]=1;
        trailIdx=(trailIdx+1)%TRAIL_N;
    }
    for(let i=0;i<TRAIL_N;i++){trailAlpha[i]=Math.max(0,trailAlpha[i]-dt*1.2);}
    trailMat.opacity=.25;
    droneTrail.geometry.attributes.position.needsUpdate=true;
}

/* ===== DRONE (detailed realistic model) ===== */
const drone = new THREE.Group();
const droneVis = new THREE.Group();
drone.add(droneVis);
const heliVis = new THREE.Group();
drone.add(heliVis);
heliVis.visible = false;
const heliRotors = [];

const drMat = new THREE.MeshStandardMaterial({color:0x909898,emissive:0x181818,emissiveIntensity:.08,roughness:.35,metalness:.8});
const drShellMat = new THREE.MeshStandardMaterial({color:0xa0a8a8,roughness:.38,metalness:.75});
const drArmMat = new THREE.MeshStandardMaterial({color:0x707878,roughness:.35,metalness:.8});
const drMotorMat = new THREE.MeshStandardMaterial({color:0x808888,roughness:.3,metalness:.85});
const drAccentMat = new THREE.MeshStandardMaterial({color:0x30a0e0,emissive:0x2080b0,emissiveIntensity:.5,roughness:.3});

/* Central body (hexagonal) */
const bodyLower=new THREE.Mesh(new THREE.CylinderGeometry(1.3,1.5,.35,6),drMat);
droneVis.add(bodyLower);
const bodyUpper=new THREE.Mesh(new THREE.CylinderGeometry(.75,1.3,.22,6),drShellMat);
bodyUpper.position.y=.28; droneVis.add(bodyUpper);
const bodyTop=new THREE.Mesh(new THREE.CylinderGeometry(.3,.75,.12,6),drShellMat);
bodyTop.position.y=.4; droneVis.add(bodyTop);

/* Arms + motors + rotor discs + LEDs */
const armGeo=new THREE.BoxGeometry(.22,.08,2.8);
const rotorDiscs=[];
const armTips=[ // front-right, front-left, rear-right, rear-left
    {x:2,z:-2,front:true}, {x:-2,z:-2,front:true},
    {x:2,z:2,front:false}, {x:-2,z:2,front:false}
];

armTips.forEach(tip=>{
    const angle=Math.atan2(tip.x, tip.z);
    const dist=Math.sqrt(tip.x*tip.x+tip.z*tip.z);
    const midX=tip.x*.55, midZ=tip.z*.55;

    /* Arm */
    const arm=new THREE.Mesh(armGeo,drArmMat);
    arm.position.set(midX,.02,midZ);
    arm.rotation.y=-angle;
    droneVis.add(arm);

    /* LED strip on arm */
    const ledStrip=new THREE.Mesh(new THREE.BoxGeometry(.1,.015,2.5),drAccentMat);
    ledStrip.position.set(midX,.065,midZ);
    ledStrip.rotation.y=-angle;
    droneVis.add(ledStrip);

    /* Motor housing */
    const motor=new THREE.Mesh(new THREE.CylinderGeometry(.3,.34,.2,10),drMotorMat);
    motor.position.set(tip.x,.12,tip.z);
    droneVis.add(motor);
    const motorCap=new THREE.Mesh(new THREE.CylinderGeometry(.15,.3,.1,10),drMotorMat);
    motorCap.position.set(tip.x,.24,tip.z);
    droneVis.add(motorCap);

    /* Rotor disc (semi-transparent, spins fast) */
    const disc=new THREE.Mesh(
        new THREE.CircleGeometry(.85,20),
        new THREE.MeshBasicMaterial({color:0xb0c0c8,transparent:true,opacity:.12,side:THREE.DoubleSide,depthWrite:false})
    );
    disc.rotation.x=-Math.PI/2;
    disc.position.set(tip.x,.3,tip.z);
    droneVis.add(disc);
    rotorDiscs.push(disc);

    /* Rotor blade hints (two thin rectangles per motor) */
    const bladeMat=new THREE.MeshBasicMaterial({color:0x808888,transparent:true,opacity:.4,side:THREE.DoubleSide,depthWrite:false});
    for(let b=0;b<2;b++){
        const blade=new THREE.Mesh(new THREE.PlaneGeometry(.12,.8),bladeMat);
        blade.rotation.x=-Math.PI/2;
        blade.rotation.z=b*Math.PI/2;
        blade.position.set(tip.x,.31,tip.z);
        droneVis.add(blade);
        rotorDiscs.push(blade);
    }

    /* Propeller guard ring */
    const guardGeo=new THREE.TorusGeometry(.92,.035,6,20);
    const guardMat=new THREE.MeshStandardMaterial({color:0x707878,roughness:.38,metalness:.78});
    const guard=new THREE.Mesh(guardGeo,guardMat);
    guard.rotation.x=-Math.PI/2; guard.position.set(tip.x,.2,tip.z);
    droneVis.add(guard);
    /* Guard struts (4 thin connections to motor) */
    for(let s=0;s<4;s++){
        const sa=s*Math.PI/2;
        const strut=new THREE.Mesh(new THREE.BoxGeometry(.03,.04,.6),guardMat);
        strut.position.set(tip.x+Math.cos(sa)*.46,.2,tip.z+Math.sin(sa)*.46);
        strut.rotation.y=sa; droneVis.add(strut);
    }

    /* Navigation LEDs: green=front, red=rear */
    const ledColor=tip.front?0x40e080:0xe04040;
    const led=new THREE.Mesh(new THREE.SphereGeometry(.06,6,6),new THREE.MeshBasicMaterial({color:ledColor}));
    led.position.set(tip.x,.08,tip.z+(tip.front?-.35:.35));
    droneVis.add(led);
});

/* Camera dome (front, underneath) */
const camDome=new THREE.Mesh(
    new THREE.SphereGeometry(.2,10,8,0,Math.PI*2,0,Math.PI/2),
    new THREE.MeshStandardMaterial({color:0x151a20,roughness:.08,metalness:1,emissive:0x2f4653,emissiveIntensity:.2})
);
camDome.rotation.x=Math.PI; camDome.position.set(0,-.22,-1.1);
droneVis.add(camDome);

/* Battery pack */
const battery=new THREE.Mesh(new THREE.BoxGeometry(.7,.12,1.3),new THREE.MeshStandardMaterial({color:0x1a1a38,roughness:.5,metalness:.7}));
battery.position.set(0,-.22,0); droneVis.add(battery);

/* Landing skids */
const skidMat=new THREE.MeshStandardMaterial({color:0x555575,roughness:.5,metalness:.8});
[-0.55,0.55].forEach(xo=>{
    const skid=new THREE.Mesh(new THREE.BoxGeometry(.05,.3,1.4),skidMat);
    skid.position.set(xo,-.38,0); droneVis.add(skid);
    [-.5,.5].forEach(zo=>{
        const strut=new THREE.Mesh(new THREE.BoxGeometry(.04,.25,.04),skidMat);
        strut.position.set(xo,-.25,zo);
        strut.rotation.z=xo>0?-.2:.2;
        droneVis.add(strut);
    });
});

/* Gun pods (front arms) */
const drGunMat=new THREE.MeshStandardMaterial({color:0x505858,emissive:0x101010,emissiveIntensity:.05,roughness:.25,metalness:.92});
const gunPosL=new THREE.Vector3(-1.2,-.12,-2.0);
const gunPosR=new THREE.Vector3(1.2,-.12,-2.0);
[gunPosL,gunPosR].forEach(gp=>{
    const barrel=new THREE.Mesh(new THREE.CylinderGeometry(.07,.07,1.2,6),drGunMat);
    barrel.rotation.x=Math.PI/2; barrel.position.copy(gp);
    droneVis.add(barrel);
    const muzzle=new THREE.Mesh(new THREE.CylinderGeometry(.09,.07,.15,6),drAccentMat);
    muzzle.rotation.x=Math.PI/2; muzzle.position.set(gp.x, gp.y, gp.z-.65);
    droneVis.add(muzzle);
});

/* Muzzle flash meshes */
const flashGeo=new THREE.PlaneGeometry(.35,.35);
const mfL=new THREE.Mesh(flashGeo,new THREE.MeshBasicMaterial({color:0xffeedd,transparent:true,opacity:0,side:THREE.DoubleSide,depthWrite:false}));
mfL.position.set(gunPosL.x,gunPosL.y,gunPosL.z-.7); droneVis.add(mfL);
const mfR=new THREE.Mesh(flashGeo,new THREE.MeshBasicMaterial({color:0xffeedd,transparent:true,opacity:0,side:THREE.DoubleSide,depthWrite:false}));
mfR.position.set(gunPosR.x,gunPosR.y,gunPosR.z-.7); droneVis.add(mfR);

/* Headlight */
const headlight=new THREE.SpotLight(0xa0c0e0,4,120,Math.PI/5,.4,1);
headlight.position.set(0,-.1,-2.5);
headlight.target.position.set(0,-4,-25);
drone.add(headlight); drone.add(headlight.target);

const droneGlow=new THREE.PointLight(0x2080c0,0.5,8);
droneGlow.position.set(0,-.3,0); droneVis.add(droneGlow);

/* ===== NAVIGATION LIGHTS (realistic blinking) ===== */
const navGeo=new THREE.SphereGeometry(.1,6,6);
const navLightL=new THREE.Mesh(navGeo,new THREE.MeshBasicMaterial({color:0xff0000}));
navLightL.position.set(-1.85,.05,0); droneVis.add(navLightL);
const navLightR=new THREE.Mesh(navGeo,new THREE.MeshBasicMaterial({color:0x00ff00}));
navLightR.position.set(1.85,.05,0); droneVis.add(navLightR);
const strobeTop=new THREE.Mesh(new THREE.SphereGeometry(.07,6,6),new THREE.MeshBasicMaterial({color:0xffffff}));
strobeTop.position.set(0,.35,.3); droneVis.add(strobeTop);
const strobeBtm=new THREE.Mesh(new THREE.SphereGeometry(.07,6,6),new THREE.MeshBasicMaterial({color:0xffffff}));
strobeBtm.position.set(0,-.35,.3); droneVis.add(strobeBtm);
const tailLight=new THREE.Mesh(navGeo,new THREE.MeshBasicMaterial({color:0xff2200}));
tailLight.position.set(0,.08,1.6); droneVis.add(tailLight);
const navPtL=new THREE.PointLight(0xff0000,.6,5); navPtL.position.copy(navLightL.position); droneVis.add(navPtL);
const navPtR=new THREE.PointLight(0x00ff00,.6,5); navPtR.position.copy(navLightR.position); droneVis.add(navPtR);
const strobePt=new THREE.PointLight(0xffffff,.8,8); strobePt.position.copy(strobeTop.position); droneVis.add(strobePt);

/* ===== HELICOPTER VISUAL ===== */
const heliBodyMat = new THREE.MeshStandardMaterial({color:0x808880,roughness:.35,metalness:.8,emissive:0x181818,emissiveIntensity:.08});
const heliAccentMat = new THREE.MeshStandardMaterial({color:0x30a0d0,roughness:.28,metalness:.82,emissive:0x2080a0,emissiveIntensity:.4});
const heliBody = new THREE.Mesh(new THREE.CapsuleGeometry(.45,2.4,6,14), heliBodyMat);
heliBody.rotation.z = Math.PI/2; heliBody.position.y = 0.05; heliVis.add(heliBody);
const heliCockpit = new THREE.Mesh(new THREE.SphereGeometry(.48,14,10), new THREE.MeshStandardMaterial({color:0x304050,roughness:.08,metalness:.92,emissive:0x203040,emissiveIntensity:.15}));
heliCockpit.scale.set(1.1,.85,.85); heliCockpit.position.set(0,0.15,-1.15); heliVis.add(heliCockpit);
const heliTail = new THREE.Mesh(new THREE.BoxGeometry(.22,.22,3.4), heliBodyMat);
heliTail.position.set(0,.02,2.4); heliVis.add(heliTail);
const tailFin = new THREE.Mesh(new THREE.BoxGeometry(.06,.85,.6), heliBodyMat);
tailFin.position.set(0,.5,3.85); heliVis.add(tailFin);
const skidMatH = new THREE.MeshStandardMaterial({color:0x657483,roughness:.45,metalness:.7});
[-0.5,0.5].forEach(xo=>{
    const leg = new THREE.Mesh(new THREE.BoxGeometry(.05,.42,.9), skidMatH);
    leg.position.set(xo,-.34,-.1); heliVis.add(leg);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(.04,.04,2.9), skidMatH);
    rail.position.set(xo,-.53,.2); heliVis.add(rail);
});
const mast = new THREE.Mesh(new THREE.CylinderGeometry(.05,.06,.45,8), heliBodyMat);
mast.position.set(0,.62,-.1); heliVis.add(mast);
const mainRotor = new THREE.Mesh(new THREE.BoxGeometry(6.2,.03,.22), new THREE.MeshBasicMaterial({color:0xa1b6c3,transparent:true,opacity:.45}));
mainRotor.position.set(0,.85,-.08); heliVis.add(mainRotor); heliRotors.push(mainRotor);
const mainRotorCross = new THREE.Mesh(new THREE.BoxGeometry(.22,.03,6.2), new THREE.MeshBasicMaterial({color:0xa1b6c3,transparent:true,opacity:.45}));
mainRotorCross.position.set(0,.85,-.08); heliVis.add(mainRotorCross); heliRotors.push(mainRotorCross);
const tailHub = new THREE.Mesh(new THREE.CylinderGeometry(.07,.07,.16,8), heliBodyMat);
tailHub.rotation.z=Math.PI/2; tailHub.position.set(0,.1,4.05); heliVis.add(tailHub);
const tailRotor = new THREE.Mesh(new THREE.BoxGeometry(.12,1.1,.02), new THREE.MeshBasicMaterial({color:0x9ab7c6,transparent:true,opacity:.55}));
tailRotor.position.set(0,.1,4.05); heliVis.add(tailRotor); heliRotors.push(tailRotor);
const heliNoseLight = new THREE.Mesh(new THREE.SphereGeometry(.07,6,6), heliAccentMat);
heliNoseLight.position.set(0,-.02,-1.85); heliVis.add(heliNoseLight);

drone.position.copy(SPAWN); scene.add(drone);
/* The aircraft is a small, bounded subtree, so a traverse here is cheap — unlike
 * the city, where shadow flags are set explicitly per site. Skip the unlit
 * helpers (rotor discs, muzzle flashes, light bulbs) so they don't punch
 * silhouettes into the shadow map. */
for(const vis of [droneVis, heliVis]){
    vis.traverse(o=>{
        if(!o.isMesh) return;
        const basic = o.material && o.material.isMeshBasicMaterial;
        tagShadows(o, !basic, !basic);
    });
}

/* ===== ENEMIES (3 types: Scout, Standard, Heavy) ===== */
const enemies=[];
let lockTarget = null;
let lockFollow = false;
const ETYPES=[
    {name:'Shahed-136',scale:.7,hp:1,spd:14,color:0x2a1a1a,emissive:0xc03020,eI:.55,fireCD:5},
    {name:'Mohajer-6',scale:1,hp:2,spd:9,color:0x301818,emissive:0xe04830,eI:.5,fireCD:4.5},
    {name:'Kaman-22',scale:1.5,hp:4,spd:5,color:0x281414,emissive:0xd03828,eI:.5,fireCD:3.5},
];
function mkEnemy(typeIdx){
    if(typeIdx===undefined) typeIdx=Math.floor(Math.random()*3);
    const et=ETYPES[typeIdx];
    const g=new THREE.Group();
    const vis=new THREE.Group(); g.add(vis);
    const m=new THREE.MeshStandardMaterial({color:et.color,emissive:et.emissive,emissiveIntensity:et.eI,roughness:.4,metalness:.85});

    /* Angular body (flattened octahedron) */
    const bGeo=new THREE.OctahedronGeometry(1.1,0);
    bGeo.scale(1,.28,1.3);
    vis.add(new THREE.Mesh(bGeo,m));

    /* Canopy */
    const canopy=new THREE.Mesh(
        new THREE.SphereGeometry(.35,8,6,0,Math.PI*2,0,Math.PI/2),
        new THREE.MeshStandardMaterial({color:et.color,emissive:et.emissive,emissiveIntensity:.3,roughness:.1,metalness:.9})
    );
    canopy.position.y=.18; vis.add(canopy);

    /* Heavy has extra armor plates */
    if(typeIdx===2){
        const plate=new THREE.Mesh(new THREE.BoxGeometry(1.8,.08,1.8),new THREE.MeshStandardMaterial({color:0x221122,roughness:.5,metalness:.9}));
        plate.position.y=-.15; vis.add(plate);
        const plate2=new THREE.Mesh(new THREE.BoxGeometry(2.2,.06,.6),m);
        plate2.position.set(0,.1,-1); vis.add(plate2);
    }
    /* Scout has fins */
    if(typeIdx===0){
        const fin=new THREE.Mesh(new THREE.BoxGeometry(.03,.5,.6),new THREE.MeshStandardMaterial({color:0x0a1a0a,emissive:0x44ff00,emissiveIntensity:.3}));
        fin.position.set(0,.25,.5); vis.add(fin);
    }

    /* Arms + rotor discs */
    const eArmGeo=new THREE.BoxGeometry(.12,.05,1.6);
    const eArmMat=new THREE.MeshStandardMaterial({color:0x1a0808,roughness:.35,metalness:.9});
    const eRotors=[];
    const eTips=[{x:1.2,z:-1.2},{x:-1.2,z:-1.2},{x:1.2,z:1.2},{x:-1.2,z:1.2}];
    eTips.forEach(t=>{
        const arm=new THREE.Mesh(eArmGeo,eArmMat);
        arm.position.set(t.x*.45,0,t.z*.45);
        arm.rotation.y=-Math.atan2(t.x,t.z);
        vis.add(arm);
        const motor=new THREE.Mesh(new THREE.CylinderGeometry(.18,.22,.12,8),eArmMat);
        motor.position.set(t.x,.06,t.z); vis.add(motor);
        const disc=new THREE.Mesh(
            new THREE.CircleGeometry(.55,14),
            new THREE.MeshBasicMaterial({color:0xc04030,transparent:true,opacity:.12,side:THREE.DoubleSide,depthWrite:false})
        );
        disc.rotation.x=-Math.PI/2; disc.position.set(t.x,.14,t.z);
        vis.add(disc); eRotors.push(disc);
    });

    /* Engine glow */
    const trail=new THREE.Mesh(
        new THREE.ConeGeometry(.2,.8,6),
        new THREE.MeshBasicMaterial({color:0xc04030,transparent:true,opacity:.45})
    );
    trail.rotation.x=Math.PI/2; trail.position.set(0,0,1.5);
    vis.add(trail);

    const hf=C.citySize/2-40;
    g.position.set((Math.random()-.5)*hf*2, 12+Math.random()*45, (Math.random()-.5)*hf*2);
    const wps=[];
    for(let i=0;i<4;i++) wps.push(new THREE.Vector3((Math.random()-.5)*hf*2,10+Math.random()*55,(Math.random()-.5)*hf*2));
    vis.scale.setScalar(et.scale);
    g.userData={hp:et.hp,spd:et.spd+Math.random()*6,wps,wi:0,mat:m,rotors:eRotors,vis,trail,type:et};
    scene.add(g); enemies.push(g);
    return g;
}
/* Seconds after launch during which hostiles will not engage. */
let launchGrace = 0;
const LAUNCH_GRACE_SEC = 12;

function spawnEnemies(){
    for(let i=0;i<C.enemyCount;i++){
        const e=mkEnemy();
        /* Push anything that spawned within knife-fighting range of the pad out
         * to a standoff distance, so the pilot gets a clean departure. */
        if(e && e.position.distanceTo(drone.position)<140){
            const a=Math.random()*Math.PI*2;
            const r=150+Math.random()*70;
            e.position.set(drone.position.x+Math.cos(a)*r, 20+Math.random()*45, drone.position.z+Math.sin(a)*r);
        }
    }
}
function nearestEnemy(maxDist=220){
    let best=null, bestD=maxDist;
    for(const e of enemies){
        const d=drone.position.distanceTo(e.position);
        if(d<bestD){best=e;bestD=d;}
    }
    return best;
}
function toggleLockTarget(){
    if(lockTarget && (enemies.includes(lockTarget) || remoteLockInfo())){
        lockTarget = null; lockFollow = false;
        notify('TARGET LOCK CLEARED','kill-note');
        return;
    }
    const n = nearestEnemy();
    if(n){ lockTarget = n; notify('TARGET LOCK ACQUIRED','ring-note'); }
    else {
        const remote = nearestRemotePilot(700);
        if(remote){ lockTarget = remote.rp.mesh; notify(`ENEMY LOCK ${remote.rp.state?.name||'REMOTE'}`,'ring-note'); }
        else notify('NO ENEMY IN RANGE','kill-note');
    }
}
function cycleLockTarget(dir=1){
    if(enemies.length===0){ notify('NO ENEMIES','kill-note'); return; }
    if(!lockTarget || !enemies.includes(lockTarget)){
        lockTarget = nearestEnemy();
    } else {
        const n=enemies.length;
        const i=enemies.indexOf(lockTarget);
        const next=(i + (dir>=0?1:-1) + n) % n;
        lockTarget = enemies[next];
    }
    if(lockTarget) notify(`LOCK: ${(lockTarget.userData?.type?.name||'enemy').toUpperCase()}`,'ring-note');
}
function validateLockTarget(){
    if(!lockTarget) return;
    if(!enemies.includes(lockTarget) && !remoteLockInfo()){ lockTarget = null; lockFollow = false; notify('TARGET LOST','kill-note'); }
}

/* Enemy bullets (OBJECT POOL — no runtime allocations) */
const EBULLET_MAX=12;
const eBulletPool=[];
let eBulletActive=0;
const eBltGeo=new THREE.CylinderGeometry(.035,.035,.5,4);
const eBltMat=new THREE.MeshBasicMaterial({color:0xff4010});
const _ebDir=new THREE.Vector3();
for(let _i=0;_i<EBULLET_MAX;_i++){
    const b=new THREE.Mesh(eBltGeo,eBltMat);
    b.visible=false;
    b.userData={vel:new THREE.Vector3(),life:0,active:false};
    scene.add(b);
    eBulletPool.push(b);
}
function retireEBullet(b){b.userData.active=false;b.visible=false;b.position.set(0,-999,0);eBulletActive--;}
function enemyFire(e){
    if(eBulletActive>=EBULLET_MAX) return;
    let b=null;
    for(let i=0;i<EBULLET_MAX;i++){if(!eBulletPool[i].userData.active){b=eBulletPool[i];break;}}
    if(!b) return;
    b.position.copy(e.position);
    _ebDir.copy(drone.position).sub(e.position).normalize();
    _ebDir.x+=(Math.random()-.5)*.25; _ebDir.y+=(Math.random()-.5)*.15; _ebDir.z+=(Math.random()-.5)*.25;
    _ebDir.normalize();
    b.userData.vel.copy(_ebDir).multiplyScalar(50);
    b.userData.life=2.5;
    b.userData.active=true;
    b.visible=true;
    eBulletActive++;
}
function updEBullets(dt){
    for(let i=0;i<EBULLET_MAX;i++){
        const b=eBulletPool[i];
        if(!b.userData.active) continue;
        b.position.addScaledVector(b.userData.vel,dt); b.userData.life-=dt;
        if(b.userData.life<=0){retireEBullet(b);continue;}
        if(b.position.distanceTo(drone.position)<2.2&&S.invTimer<=0){
            takeDmg(5); retireEBullet(b);
        }
    }
}

/* Combo system */
let comboCount=0, comboTimer=0;
function addCombo(){
    comboCount++; comboTimer=3;
    if(comboCount>1){
        const bonus=comboCount*50;
        const pts = addScore(bonus);
        notify('x'+comboCount+' MULTI-KILL +'+pts,'kill-note');
        if(comboCount>=2) setTimeout(()=>radioSpeak('combo'),1200);
    }
}

function updEnemies(dt){
    comboTimer=Math.max(0,comboTimer-dt);
    if(comboTimer<=0) comboCount=0;
    for(const e of enemies){
        const wp=e.userData.wps[e.userData.wi];
        const dir=wp.clone().sub(e.position);
        if(dir.length()<5){e.userData.wi=(e.userData.wi+1)%e.userData.wps.length;}
        else{dir.normalize();e.position.addScaledVector(dir,e.userData.spd*dt);e.rotation.y=THREE.MathUtils.lerp(e.rotation.y,Math.atan2(dir.x,dir.z),3*dt);}
        e.userData.rotors.forEach(r=>{r.rotation.z+=25*dt;});
        if(e.userData.trail) e.userData.trail.material.opacity=.2+Math.sin(performance.now()*.01)*.2;
        /* Enemy shoots at player when in range */
        const distToDrone=e.position.distanceTo(drone.position);
        if(!e.userData.fireCD) e.userData.fireCD=0;
        e.userData.fireCD-=dt;
        /* Weapons-hold window after launch: hostiles hold fire while the pilot
         * is still climbing out, so the sortie never opens with incoming rounds. */
        if(launchGrace>0) continue;
        if(distToDrone<50 && e.userData.fireCD<=0){
            enemyFire(e); e.userData.fireCD=(e.userData.type?e.userData.type.fireCD:3)+Math.random()*3;
            /* Enemy turns to face player when attacking */
            const toPlayer=drone.position.clone().sub(e.position);
            e.rotation.y=Math.atan2(toPlayer.x,toPlayer.z);
        }
    }
}

/* ===== WAYPOINT RINGS (military checkpoint style) ===== */
const rings=[];
const ringGeo=new THREE.TorusGeometry(4.0,.18,10,36);
const ringGeoInner=new THREE.TorusGeometry(3.6,.08,8,28);
const ringGeoOuter=new THREE.TorusGeometry(4.4,.06,6,32);
function spawnRings(){
    const hf=C.citySize/2-25;
    for(let i=0;i<C.ringCount;i++){
        const g=new THREE.Group();
        const m=new THREE.MeshStandardMaterial({color:0x20b0e0,emissive:0x1090c0,emissiveIntensity:.9,side:THREE.DoubleSide});
        const outer=new THREE.Mesh(ringGeo,m);
        g.add(outer);
        const mInner=new THREE.MeshBasicMaterial({color:0x40d0f0,transparent:true,opacity:.45,side:THREE.DoubleSide});
        const inner=new THREE.Mesh(ringGeoInner,mInner);
        g.add(inner);
        const mOuter=new THREE.MeshBasicMaterial({color:0x1090c0,transparent:true,opacity:.3,side:THREE.DoubleSide});
        const outerGlow=new THREE.Mesh(ringGeoOuter,mOuter);
        g.add(outerGlow);
        const glowDisc=new THREE.Mesh(
            new THREE.CircleGeometry(3.2,24),
            new THREE.MeshBasicMaterial({color:0x1090c0,transparent:true,opacity:.08,side:THREE.DoubleSide,depthWrite:false})
        );
        g.add(glowDisc);
        const arrow1=new THREE.Mesh(new THREE.ConeGeometry(.25,.6,4),new THREE.MeshBasicMaterial({color:0x20b0e0,transparent:true,opacity:.7}));
        arrow1.position.set(0,4.8,0);arrow1.rotation.z=Math.PI; g.add(arrow1);
        const arrow2=new THREE.Mesh(new THREE.ConeGeometry(.25,.6,4),new THREE.MeshBasicMaterial({color:0x20b0e0,transparent:true,opacity:.7}));
        arrow2.position.set(0,-4.8,0); g.add(arrow2);
        g.position.set((Math.random()-.5)*hf*2,8+Math.random()*55,(Math.random()-.5)*hf*2);
        g.rotation.y=Math.random()*Math.PI;
        g.userData={got:false,glowDisc,baseY:g.position.y}; scene.add(g); rings.push(g);
    }
}
function updRings(dt){
    const t=performance.now()*.001;
    for(const r of rings){
        if(r.userData.got) continue;
        r.rotation.z+=dt*0.8;
        r.children[0].rotation.z+=dt*1.2;
        if(r.userData.glowDisc) r.userData.glowDisc.material.opacity=0.06+Math.sin(t*3+r.position.x)*0.04;
        r.position.y=r.userData.baseY+Math.sin(t*0.8+r.position.x*0.1)*1.5;
        if(drone.position.distanceTo(r.position)<5.0){
            const pts=addScore(C.ringPts);r.userData.got=true;r.visible=false;S.rings++;WORLD.fuel=Math.min(100,WORLD.fuel+20);sndRing();vib(80,.2,.3);notify('+'+pts+' WAYPOINT SECURED  +20% FUEL','ring-note');if(Math.random()<0.4)setTimeout(()=>radioSpeak('ring'),600);
            setTimeout(()=>{const hf=C.citySize/2-25;r.position.set((Math.random()-.5)*hf*2,8+Math.random()*55,(Math.random()-.5)*hf*2);r.userData.baseY=r.position.y;r.userData.got=false;r.visible=true;},12000);
        }
    }
}

/* ===== ENERGY ORBS ===== */
const orbs=[];
const orbGeo=new THREE.SphereGeometry(.75,10,10);
function spawnOrbs(){
    const hf=C.citySize/2-25;
    for(let i=0;i<C.orbCount;i++){
        const m=new THREE.MeshStandardMaterial({color:0xffff00,emissive:0xffaa00,emissiveIntensity:1,transparent:true,opacity:.85});
        const o=new THREE.Mesh(orbGeo,m);
        o.position.set((Math.random()-.5)*hf*2,5+Math.random()*40,(Math.random()-.5)*hf*2);
        o.userData={got:false,baseY:o.position.y}; scene.add(o); orbs.push(o);
    }
}
function updOrbs(dt){
    const t=performance.now()*.001;
    for(const o of orbs){
        if(o.userData.got) continue;
        o.position.y=o.userData.baseY+Math.sin(t*2+o.position.x)*1.4; o.rotation.y+=dt*2.5;
        if(drone.position.distanceTo(o.position)<3){
            o.userData.got=true;o.visible=false;S.hp=Math.min(C.maxHP,S.hp+C.orbHeal);sndPickup();vib(50,.1,.12);
            setTimeout(()=>{const hf=C.citySize/2-25;o.position.set((Math.random()-.5)*hf*2,5+Math.random()*40,(Math.random()-.5)*hf*2);o.userData.baseY=o.position.y;o.userData.got=false;o.visible=true;},14000);
        }
    }
}

/* ===== PROJECTILES (OBJECT POOL — zero runtime allocations) ===== */
const BULLET_MAX=40;
const bulletPool=[];
let bulletActive=0;
let fCD=0, altGun=false;
const bltGeo=new THREE.CylinderGeometry(.035,.035,.5,4);
const bltMat=new THREE.MeshBasicMaterial({color:0xffeecc});
const trlGeo=new THREE.CylinderGeometry(.02,.008,1.8,4);
const trlMat=new THREE.MeshBasicMaterial({color:0xffdd88,transparent:true,opacity:.5,depthWrite:false});
const bltGlowGeo=new THREE.SphereGeometry(.08,4,4);
const bltGlowMat=new THREE.MeshBasicMaterial({color:0xffe8b0,transparent:true,opacity:.45,depthWrite:false});
const _bDir=new THREE.Vector3();
for(let _i=0;_i<BULLET_MAX;_i++){
    const b=new THREE.Group();
    const core=new THREE.Mesh(bltGeo,bltMat); core.rotation.x=Math.PI/2; b.add(core);
    const glow=new THREE.Mesh(bltGlowGeo,bltGlowMat); b.add(glow);
    const tr=new THREE.Mesh(trlGeo,trlMat); tr.rotation.x=Math.PI/2; tr.position.z=1.4; b.add(tr);
    b.visible=false;
    b.userData={vel:new THREE.Vector3(),life:0,active:false};
    scene.add(b);
    bulletPool.push(b);
}
function retireBullet(b){b.userData.active=false;b.visible=false;b.position.set(0,-999,0);bulletActive--;}

function fire(){
    if(fuelFalling) return;
    const rate=activePU&&activePU.name==='RAPID FIRE'?C.fireRate*.35:C.fireRate;
    if(fCD>0||bulletActive>=BULLET_MAX) return; fCD=rate;
    let b=null;
    for(let i=0;i<BULLET_MAX;i++){if(!bulletPool[i].userData.active){b=bulletPool[i];break;}}
    if(!b) return;
    b.userData.active=true; b.visible=true; bulletActive++;
    const gpos=altGun?gunPosR:gunPosL;
    const flash=altGun?mfR:mfL;
    flash.material.opacity=0.8; flash.scale.setScalar(.5+Math.random()*.3); flash.rotation.z=Math.random()*Math.PI;
    altGun=!altGun;
    const wp=gpos.clone(); drone.localToWorld(wp); b.position.copy(wp);
    if(lockTarget && (enemies.includes(lockTarget) || remoteLockInfo())){
        _bDir.copy(lockTarget.position).sub(wp).normalize();
    } else {
        _bDir.set(0,0,-1).applyQuaternion(drone.quaternion);
    }
    b.userData.vel.copy(_bDir).multiplyScalar(C.bulletSpeed);
    b.userData.life=2.0;
    sndLaser(); vib(45,.1,.18);
}
function findRemoteBulletHit(b){
    if(S.gameMode !== 'multiplayer' || (!onlineConnected && !localRoomConnected)) return null;
    let best = null;
    let bestDist = Infinity;
    for(const [id,rp] of remotePilots){
        if(!rp.mesh.visible || (rp.hp ?? C.maxHP) <= 0) continue;
        const dist = b.position.distanceTo(rp.mesh.position);
        if(dist < 5.5 && dist < bestDist){ best = { id, rp, dist }; bestDist = dist; }
    }
    return best;
}
function updBullets(dt){
    for(let i=0;i<BULLET_MAX;i++){
        const b=bulletPool[i];
        if(!b.userData.active) continue;
        b.position.addScaledVector(b.userData.vel,dt); b.userData.life-=dt;
        if(b.userData.life<=0){retireBullet(b);continue;}
        let hit=false;
        const remoteHit = findRemoteBulletHit(b);
        if(remoteHit){
            applyRemoteHit(remoteHit.id, C.multiplayerDmg);
            sendOnlineHit(remoteHit.id, b.position);
            sndBoom(false);vib(90,.32,.42);retireBullet(b);hit=true;
            notify(remoteHit.rp.hp <= 0 ? 'REMOTE PILOT DOWN' : `REMOTE HIT -${C.multiplayerDmg}`,'kill-note');
            if(remoteHit.rp.hp <= 0){ addScore(C.killPts); S.kills++; }
        }
        if(hit) continue;
        for(let j=enemies.length-1;j>=0;j--){
            if(b.position.distanceTo(enemies[j].position)<2.8){
                enemies[j].userData.hp--;
                if(enemies[j].userData.hp<=0){const pts=addScore(C.killPts);boom(enemies[j].position.clone());scene.remove(enemies[j]);enemies.splice(j,1);S.kills++;sndBoom(true);vib(160,.55,.75);addCombo();notify('+'+pts+' HOSTILE NEUTRALIZED','kill-note');if(getModeCfg().enemies)setTimeout(mkEnemy,15000);setTimeout(()=>radioSpeak('kill'),800);}
                else{sndBoom(false);vib(80,.3,.4);boom(b.position.clone(),true);}
                retireBullet(b);hit=true;break;
            }
        }
        if(hit) continue;
        const nearby=getNearbyBuildings(b.position.x,b.position.z);
        for(const bl of nearby){
            if(bl.bbox.containsPoint(b.position)){boom(b.position.clone(),true);sndImpact();retireBullet(b);hit=true;break;}
        }
    }
}

/* ===== EXPLOSIONS (OBJECT POOL — zero runtime allocations) ===== */
const EXP_PARTICLE_MAX=60;
const EXP_LIGHT_MAX=4;
const expPool=[];
const expLightPool=[];
const explosions=[];
const expGeo=new THREE.SphereGeometry(.35,5,5);
for(let _i=0;_i<EXP_PARTICLE_MAX;_i++){
    const m=new THREE.MeshBasicMaterial({color:0xff6020,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false});
    const mesh=new THREE.Mesh(expGeo,m);
    mesh.visible=false;
    mesh.userData={vel:new THREE.Vector3(),mat:m,active:false};
    scene.add(mesh);
    expPool.push(mesh);
}
for(let _i=0;_i<EXP_LIGHT_MAX;_i++){
    const fl=new THREE.PointLight(0xff6020,0,40);
    fl.visible=false;
    fl.userData={active:false};
    scene.add(fl);
    expLightPool.push(fl);
}
const _expD=new THREE.Vector3();
function boom(pos,small){
    const cnt=small?5:16, ml=small?.25:.7, grp={ps:[],life:ml,ml,fl:null};
    const fireCols=[0xff4010,0xff6818,0xff8020,0xffaa30,0xff5008,0xee3000,0xff9040,0xffcc50];
    const smokeCols=[0x443020,0x332218,0x221810,0x553828,0x1a1210];
    for(let i=0;i<cnt;i++){
        let p=null;
        for(let j=0;j<EXP_PARTICLE_MAX;j++){if(!expPool[j].userData.active){p=expPool[j];break;}}
        if(!p) break;
        const isFire=i<cnt*0.65;
        const cols=isFire?fireCols:smokeCols;
        p.userData.mat.color.setHex(cols[Math.floor(Math.random()*cols.length)]);
        p.userData.mat.opacity=1;
        p.position.copy(pos);
        p.scale.setScalar(isFire?1:1.3+Math.random()*.5);
        _expD.set((Math.random()-.5)*2,(Math.random()-.3)*2,(Math.random()-.5)*2).normalize();
        p.userData.vel.copy(_expD).multiplyScalar(small?8:15+Math.random()*18);
        if(!isFire) p.userData.vel.y+=6+Math.random()*4;
        p.userData.active=true;
        p.visible=true;
        grp.ps.push(p);
    }
    if(!small){
        let fl=null;
        for(let j=0;j<EXP_LIGHT_MAX;j++){if(!expLightPool[j].userData.active){fl=expLightPool[j];break;}}
        if(fl){
            fl.position.copy(pos);fl.intensity=10;fl.visible=true;fl.userData.active=true;
            grp.fl=fl;
        }
    }
    explosions.push(grp);
}
function updBooms(dt){
    for(let i=explosions.length-1;i>=0;i--){
        const e=explosions[i]; e.life-=dt;
        const t=Math.max(0,e.life/e.ml);
        if(e.fl) e.fl.intensity=12*t;
        for(const p of e.ps){p.position.addScaledVector(p.userData.vel,dt);p.userData.vel.y-=3*dt;p.userData.vel.multiplyScalar(1-2.5*dt);p.userData.mat.opacity=t*t;p.scale.setScalar(.3+t*.9);}
        if(e.life<=0){
            for(const p of e.ps){p.userData.active=false;p.visible=false;p.position.set(0,-999,0);}
            if(e.fl){e.fl.userData.active=false;e.fl.visible=false;e.fl.intensity=0;}
            explosions.splice(i,1);
        }
    }
}

/* ===== INPUT ===== */
const keys={};
let gpIdx=null, mouseDown=false;
let gpPausePrev=false, gpHeadPrev=false, gpFlipPrev=false, gpCamPrev=false;
let gpDUpPrev=false, gpDDownPrev=false, gpDLeftPrev=false, gpDRightPrev=false;
let headlightOn=true, camFar=false;
const isAndroidDevice=/Android/i.test(navigator.userAgent||'');
const hasTouchInput=('ontouchstart' in window) || navigator.maxTouchPoints>0 || matchMedia('(pointer: coarse)').matches;
const isMobileControlsDevice=isAndroidDevice || (hasTouchInput && Math.min(innerWidth,innerHeight)<=900);
let mobileTipDismissed=false;
let hasRequestedFullscreen=false;
const touchInput={moveX:0,moveY:0,lookX:0,lookY:0,fire:false,boost:false,up:false,down:false,brake:false,lock:false,lockPrev:false};
async function requestAndroidFullscreen(){
    if(!isMobileControlsDevice) return false;
    if(document.fullscreenElement || document.webkitFullscreenElement){hasRequestedFullscreen=true;return true;}
    const elem=document.documentElement;
    try{
        if(elem.requestFullscreen) await elem.requestFullscreen({ navigationUI:'hide' });
        else if(elem.webkitRequestFullscreen) await elem.webkitRequestFullscreen();
        else return false;
        hasRequestedFullscreen=true;
        return true;
    }catch(_){
        hasRequestedFullscreen=false;
        return false;
    }
}
async function requestMobileImmersive(){
    const ok = await requestAndroidFullscreen();
    try{
        if(ok && screen.orientation?.lock && innerWidth>innerHeight) await screen.orientation.lock('landscape');
    }catch(_){
        /* Chrome may reject orientation lock outside installed/fullscreen contexts. The rotate prompt remains the fallback. */
    }
}
function updateMobileMode(){
    document.body.classList.toggle('android-mobile', isMobileControlsDevice);
    document.body.classList.toggle('portrait', isMobileControlsDevice && !mobileTipDismissed && innerHeight>innerWidth);
    document.body.classList.toggle('playing', isMobileControlsDevice && S.mode==='playing');
}
function setupTouchStick(el, axisX, axisY){
    if(!el) return;
    const knob=el.querySelector('span');
    let activeId=null;
    function reset(){
        activeId=null; touchInput[axisX]=0; touchInput[axisY]=0;
        if(knob) knob.style.transform='translate(-50%,-50%)';
    }
    function move(ev){
        const p=Array.from(ev.changedTouches||[]).find(t=>t.identifier===activeId) || (ev.pointerId===activeId ? ev : null);
        if(!p) return;
        const r=el.getBoundingClientRect();
        const cx=r.left+r.width/2, cy=r.top+r.height/2;
        const max=r.width*.38;
        const dx=THREE.MathUtils.clamp(p.clientX-cx,-max,max);
        const dy=THREE.MathUtils.clamp(p.clientY-cy,-max,max);
        touchInput[axisX]=dx/max;
        touchInput[axisY]=dy/max;
        if(knob) knob.style.transform=`translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        ev.preventDefault?.();
    }
    el.addEventListener('pointerdown',ev=>{requestMobileImmersive();activeId=ev.pointerId;el.setPointerCapture?.(ev.pointerId);move(ev);},{passive:false});
    el.addEventListener('pointermove',move,{passive:false});
    el.addEventListener('pointerup',reset,{passive:false});
    el.addEventListener('pointercancel',reset,{passive:false});
}
function setupMobileControls(){
    if(!isMobileControlsDevice) return;
    setupTouchStick(document.getElementById('touch-move'),'moveX','moveY');
    setupTouchStick(document.getElementById('touch-look'),'lookX','lookY');
    const tip=document.getElementById('btn-mobile-tip');
    tip?.addEventListener('pointerdown',()=>{mobileTipDismissed=true;updateMobileMode();requestMobileImmersive();});
    document.querySelectorAll('[data-touch]').forEach(btn=>{
        const key=btn.dataset.touch;
        const set=v=>{touchInput[key]=v;btn.classList.toggle('active',v);};
        btn.addEventListener('pointerdown',ev=>{ev.preventDefault();requestMobileImmersive();set(true);btn.setPointerCapture?.(ev.pointerId);},{passive:false});
        btn.addEventListener('pointerup',()=>set(false));
        btn.addEventListener('pointercancel',()=>set(false));
    });
    window.addEventListener('resize',updateMobileMode);
    screen.orientation?.addEventListener?.('change',updateMobileMode);
    updateMobileMode();
}

window.addEventListener('keydown',e=>{
    keys[e.code]=true;
    if(e.code==='Escape'||e.code==='KeyP') togglePause();
    if(e.code==='KeyG'){ headlightOn=!headlightOn; headlight.visible=headlightOn; }
    if(e.code==='KeyH') openHelp();
    if(e.code==='KeyC'){ camFar=!camFar; }
    if(e.code==='KeyT') toggleLockTarget();
    if(e.code==='KeyL' && lockTarget){ lockFollow=!lockFollow; notify(lockFollow?'FOLLOW ASSIST ON':'FOLLOW ASSIST OFF','ring-note'); }
});
window.addEventListener('keyup',e=>{keys[e.code]=false;});
window.addEventListener('mousedown',()=>{mouseDown=true;}); window.addEventListener('mouseup',()=>{mouseDown=false;});
window.addEventListener('gamepadconnected',e=>{if(gpIdx===null)gpIdx=e.gamepad.index;});
window.addEventListener('gamepaddisconnected',e=>{if(gpIdx===e.gamepad.index)gpIdx=null;});
/* Deadzone + expo curve (configurable) */
function dz(v){
    const DZ = THREE.MathUtils.clamp(controlCfg.deadzone, 0, 0.35);
    const EXPO = THREE.MathUtils.clamp(controlCfg.expo, 0, 0.95);
    if(Math.abs(v)<DZ) return 0;
    const norm=(Math.abs(v)-DZ)/(1-DZ);
    const curved = norm*(1-EXPO) + norm*norm*norm*EXPO;
    return curved * Math.sign(v);
}
function gpAxis(raw, center=0, invert=false, sens=1){
    const v = dz((raw||0) - center) * sens * (invert ? -1 : 1);
    return THREE.MathUtils.clamp(v, -1, 1);
}
function calibrateGamepadCenter(){
    if(gpIdx===null) return false;
    const gp=navigator.getGamepads()?.[gpIdx];
    if(!gp) return false;
    controlCfg.centerLX = gp.axes[0]||0;
    controlCfg.centerLY = gp.axes[1]||0;
    controlCfg.centerRX = gp.axes[2]||0;
    controlCfg.centerRY = gp.axes[3]||0;
    return true;
}
function updateGamepadLiveUI(){
    let gp = null;
    if(gpIdx!==null) gp = navigator.getGamepads()?.[gpIdx] || null;
    if(!gp){
        const pads = navigator.getGamepads?.() || [];
        gp = Array.from(pads).find(Boolean) || null;
    }
    if(!gp){
        $gpLiveStatus.textContent = 'No gamepad connected';
        for(let i=0;i<6;i++){
            $gpAxisFill[i].style.transform = 'scaleX(0)';
            $gpAxisVal[i].textContent = '0.000';
        }
        $gpBtnChips.forEach(ch=>ch.classList.remove('on'));
        return;
    }

    $gpLiveStatus.textContent = `Connected: ${gp.id || 'Gamepad'} (index ${gp.index})`;
    const rawAxes = [
        gp.axes[0]||0, gp.axes[1]||0, gp.axes[2]||0, gp.axes[3]||0,
        gp.buttons[6]?.value||0, gp.buttons[7]?.value||0
    ];
    const procAxes = [
        gpAxis(rawAxes[0], controlCfg.centerLX, controlCfg.invertLX, controlCfg.sensYaw),
        gpAxis(rawAxes[1], controlCfg.centerLY, controlCfg.invertLY, controlCfg.sensThrottle),
        gpAxis(rawAxes[2], controlCfg.centerRX, controlCfg.invertRX, controlCfg.sensRoll),
        gpAxis(rawAxes[3], controlCfg.centerRY, controlCfg.invertRY, controlCfg.sensPitch),
        THREE.MathUtils.clamp(rawAxes[4], 0, 1),
        THREE.MathUtils.clamp(rawAxes[5], 0, 1),
    ];

    for(let i=0;i<6;i++){
        const v = procAxes[i];
        const mag = i < 4 ? Math.abs(v) : v;
        $gpAxisFill[i].style.transform = `scaleX(${mag.toFixed(3)})`;
        $gpAxisVal[i].textContent = v.toFixed(3);
    }
    for(let i=0;i<$gpBtnChips.length;i++){
        const on = !!gp.buttons[i]?.pressed;
        $gpBtnChips[i].classList.toggle('on', on);
    }
}

/* ===== COLLISIONS (spatial-grid accelerated) ===== */
const _pushDir = new THREE.Vector3();
function droneCollisions(){
    const r=1.8;
    const dp = drone.position;
    const nearbyBldgs=getNearbyBuildings(dp.x, dp.z);
    for(const b of nearbyBldgs){
        const bb = b.bbox;
        const cx = THREE.MathUtils.clamp(dp.x, bb.min.x, bb.max.x);
        const cy = THREE.MathUtils.clamp(dp.y, bb.min.y, bb.max.y);
        const cz = THREE.MathUtils.clamp(dp.z, bb.min.z, bb.max.z);
        const dx = dp.x - cx, dy = dp.y - cy, dz = dp.z - cz;
        const distSq = dx*dx + dy*dy + dz*dz;
        if(distSq < r*r){
            /* Drone overlaps building — resolve penetration */
            const dist = Math.sqrt(distSq);
            if(dist > 0.001){
                _pushDir.set(dx/dist, dy/dist, dz/dist);
            } else {
                /* Fully inside — push out the shortest axis */
                const hw = (bb.max.x - bb.min.x)*0.5, hh = (bb.max.y - bb.min.y)*0.5, hd = (bb.max.z - bb.min.z)*0.5;
                const bcx = (bb.min.x+bb.max.x)*0.5, bcy = (bb.min.y+bb.max.y)*0.5, bcz = (bb.min.z+bb.max.z)*0.5;
                const ox = hw + r - Math.abs(dp.x - bcx);
                const oy = hh + r - Math.abs(dp.y - bcy);
                const oz = hd + r - Math.abs(dp.z - bcz);
                if(ox < oy && ox < oz) _pushDir.set(dp.x > bcx ? 1 : -1, 0, 0);
                else if(oy < oz) _pushDir.set(0, dp.y > bcy ? 1 : -1, 0);
                else _pushDir.set(0, 0, dp.z > bcz ? 1 : -1);
            }
            const pen = r - Math.max(dist, 0.001);
            dp.addScaledVector(_pushDir, pen + 0.5);
            /* Bounce: reflect velocity */
            const impactSpeed = vel.length();
            const vDot = vel.dot(_pushDir);
            if(vDot < 0) vel.addScaledVector(_pushDir, -vDot * 1.6);
            vel.multiplyScalar(0.3);
            const now = performance.now();
            if(S.invTimer<=0 && now-lastImpactAt>450){
                lastImpactAt = now;
                takeDmg(Math.max(C.bldgDmg, Math.round(impactSpeed*0.7)));
            }
            break;
        }
    }
    for(let j=enemies.length-1;j>=0;j--){
        if(drone.position.distanceTo(enemies[j].position)<3.5){
            if(S.invTimer<=0) takeDmg(C.enemyDmg);
            boom(enemies[j].position.clone());scene.remove(enemies[j]);enemies.splice(j,1);S.kills++;
            sndBoom(true);
            vel.multiplyScalar(-0.3);
            setTimeout(mkEnemy,15000);break;
        }
    }
}
function takeDmg(n, sourceLabel=''){
    if(S.mode==='gameover') return;
    const dmg=activePU&&activePU.name==='SHIELD'?Math.round(n*.3):n;
    S.hp-=dmg; S.invTimer=1.2;
    drMat.emissive.setHex(0xff0000); drShellMat.emissive.set(new THREE.Color(0xff0000)); drShellMat.emissiveIntensity=.5;
    setTimeout(()=>{drMat.emissive.setHex(0x101418);drShellMat.emissive.set(new THREE.Color(0x000000));drShellMat.emissiveIntensity=0;},350);
    sndBoom(true); vib(350,.85,1); shake(2,.3);
    dmgFlash.style.opacity='1'; setTimeout(()=>{dmgFlash.style.opacity='0';},200);
    if(sourceLabel) notify(`${sourceLabel} -${dmg} HULL`,'kill-note');
    if(S.hp<=0){S.hp=0;gameOver();}
    else if(S.hp<C.maxHP*0.2){setTimeout(()=>radioSpeak('lowHP'),500);}
    else{setTimeout(()=>radioSpeak('damage'),600);}
}
function gameOver(){
    if(S.mode==='gameover') return;
    disconnectOnlineRoom().catch(()=>{});
    boom(drone.position.clone());sndBoom(true);vib(500,1,1);
    if(activeMission){
        /* A campaign loss goes to the story debrief, not the generic fail card. */
        debriefPending={ok:false, mission:activeMission, reason:'AIRFRAME LOST'};
        openDebrief();
        return;
    }
    S.mode='gameover';showScreen('gameover');updateMobileMode();
    try{
        document.getElementById('fuel-warn-overlay').classList.remove('active','critical');
        document.getElementById('fuel-countdown').classList.remove('show');
        document.getElementById('fuel-warn-text').classList.remove('show');
    }catch(_){}
    const runRecord = {
        score:S.score, dist:S.dist, kills:S.kills, rings:S.rings,
        ts:Date.now(), version:GAME_META.version, profileId: activeProfileId,
        gameMode:S.gameMode, persona:selectedPersona
    };
    dbAddRun(runRecord).then(async ()=>{
        await applyRunToProfile();
        await refreshProfilesUI();
        await syncBattleProfileToCloud(activeProfile, runRecord);
        await refreshRunStats();
    }).catch(()=>{});
}

/* ===== UI ===== */
const $menu=document.getElementById('menu-screen'),$pause=document.getElementById('pause-screen'),$go=document.getElementById('gameover-screen'),$hud=document.getElementById('hud'),$settings=document.getElementById('settings-screen'),$help=document.getElementById('help-screen');
const $hPilot=document.getElementById('h-pilot'),$hScore=document.getElementById('h-score'),$hDist=document.getElementById('h-dist'),$hKills=document.getElementById('h-kills'),$hRings=document.getElementById('h-rings');
const $hFuel=document.getElementById('h-fuel'),$hWind=document.getElementById('h-wind'),$hTime=document.getElementById('h-time');
const $hBatt=document.getElementById('h-batt'),$hSignal=document.getElementById('h-signal'),$hAir=document.getElementById('h-air'),$flightWarn=document.getElementById('flight-warn');
const $hpBar=document.getElementById('hp-bar'),$boostBar=document.getElementById('boost-bar'),$speed=document.getElementById('speed-ind');
const $alt=document.getElementById('alt-ind'),$compass=document.getElementById('compass'),$objective=document.getElementById('objective'),$lockInfo=document.getElementById('target-lock');
const $fuelOverlay=document.getElementById('fuel-warn-overlay'),$fuelCountdownEl=document.getElementById('fuel-countdown'),$fuelWarnText=document.getElementById('fuel-warn-text');

/* Canvas-based instruments */
const hdgCvs=document.getElementById('hdg-canvas'),hdgCtx=hdgCvs?hdgCvs.getContext('2d'):null;
const spdCvs=document.getElementById('spd-canvas'),spdCtx=spdCvs?spdCvs.getContext('2d'):null;
const altCvs=document.getElementById('alt-canvas'),altCtx=altCvs?altCvs.getContext('2d'):null;
const adiCvs=document.getElementById('adi-canvas'),adiCtx=adiCvs?adiCvs.getContext('2d'):null;
const spdReadout=document.getElementById('speed-readout');
const altReadout=document.getElementById('alt-readout');
const ssLat=document.getElementById('ss-lat'),ssLon=document.getElementById('ss-lon'),ssFps=document.getElementById('ss-fps'),ssLink=document.getElementById('ss-link'),ssGps=document.getElementById('ss-gps'),ssMode=document.getElementById('ss-mode'),ssOnline=document.getElementById('ss-online');
let _fpsFrames=0,_fpsTime=0,_fpsVal=60;
const $mpDebug=document.createElement('div');
$mpDebug.id='mp-debug';
$mpDebug.style.display='none';
$mpDebug.innerHTML='<b>Battle Link</b><span>Initializing room...</span>';
document.body.appendChild($mpDebug);

function drawHeadingTape(hdg){
    if(!hdgCtx) return;
    const w=300,h=26,c=hdgCtx;
    c.clearRect(0,0,w,h);
    c.font='8px Courier New';c.textAlign='center';
    const ppd=w/60;
    const dirs={0:'N',45:'NE',90:'E',135:'SE',180:'S',225:'SW',270:'W',315:'NW'};
    for(let d=-40;d<=40;d++){
        const ang=((hdg+d)%360+360)%360;
        const x=w/2+d*ppd;
        if(x<-10||x>w+10) continue;
        if(ang%10===0){
            c.strokeStyle='rgba(80,140,200,.35)';c.lineWidth=1;
            c.beginPath();c.moveTo(x,h);c.lineTo(x,h-7);c.stroke();
            c.fillStyle='#5080a0';
            c.fillText(Math.round(ang)+'',x,9);
        }else if(ang%5===0){
            c.strokeStyle='rgba(80,140,200,.18)';c.lineWidth=1;
            c.beginPath();c.moveTo(x,h);c.lineTo(x,h-4);c.stroke();
        }
        if(dirs[ang]){
            c.fillStyle='#80b8d8';c.font='bold 9px Courier New';
            c.fillText(dirs[ang],x,21);c.font='8px Courier New';
        }
    }
}

function drawSpeedTape(spd){
    if(!spdCtx) return;
    const w=54,h=180,c=spdCtx;
    c.clearRect(0,0,w,h);
    const kts=Math.round(spd*1.944);
    if(spdReadout) spdReadout.textContent=kts;
    const ppu=h/100;
    c.font='8px Courier New';c.textAlign='right';
    for(let v=-50;v<=50;v++){
        const val=kts+v;
        if(val<0) continue;
        const y=h/2-v*ppu;
        if(y<-5||y>h+5) continue;
        if(val%10===0){
            c.strokeStyle='rgba(80,140,200,.3)';c.lineWidth=1;
            c.beginPath();c.moveTo(w,y);c.lineTo(w-10,y);c.stroke();
            c.fillStyle='#5080a0';c.fillText(val+'',w-12,y+3);
        }else if(val%5===0){
            c.strokeStyle='rgba(80,140,200,.15)';c.lineWidth=1;
            c.beginPath();c.moveTo(w,y);c.lineTo(w-6,y);c.stroke();
        }
    }
}

function drawAltTape(alt){
    if(!altCtx) return;
    const w=54,h=180,c=altCtx;
    c.clearRect(0,0,w,h);
    const a=Math.round(alt);
    if(altReadout){altReadout.textContent=a;altReadout.classList.toggle('warn',a<5||a>140);}
    const ppu=h/200;
    c.font='8px Courier New';c.textAlign='left';
    for(let v=-100;v<=100;v++){
        const val=a+v;
        if(val<0) continue;
        const y=h/2-v*ppu;
        if(y<-5||y>h+5) continue;
        if(val%20===0){
            c.strokeStyle='rgba(80,140,200,.3)';c.lineWidth=1;
            c.beginPath();c.moveTo(0,y);c.lineTo(10,y);c.stroke();
            c.fillStyle='#5080a0';c.fillText(val+'',12,y+3);
        }else if(val%10===0){
            c.strokeStyle='rgba(80,140,200,.15)';c.lineWidth=1;
            c.beginPath();c.moveTo(0,y);c.lineTo(6,y);c.stroke();
        }
    }
}

function drawADI(pitch,roll){
    if(!adiCtx) return;
    const w=80,h=80,c=adiCtx,cx=w/2,cy=h/2,r=34;
    c.clearRect(0,0,w,h);
    c.save();
    c.beginPath();c.arc(cx,cy,r,0,Math.PI*2);c.clip();
    c.translate(cx,cy);c.rotate(-roll);
    const pitchPx=pitch*(r/0.6);
    c.fillStyle='#1a2018';c.fillRect(-r*2,pitchPx,r*4,r*4);
    c.fillStyle='#182848';c.fillRect(-r*2,pitchPx-r*4,r*4,r*4);
    c.strokeStyle='rgba(80,160,220,.35)';c.lineWidth=1;
    c.beginPath();c.moveTo(-r*2,pitchPx);c.lineTo(r*2,pitchPx);c.stroke();
    for(let p=-30;p<=30;p+=10){
        if(p===0) continue;
        const py=pitchPx-p*(r/30);
        const lw=Math.abs(p)%20===0?10:6;
        c.strokeStyle='rgba(255,255,255,.2)';
        c.beginPath();c.moveTo(-lw,py);c.lineTo(lw,py);c.stroke();
    }
    c.restore();
    c.strokeStyle='rgba(60,100,150,.3)';c.lineWidth=1;
    c.beginPath();c.arc(cx,cy,r,0,Math.PI*2);c.stroke();
    c.strokeStyle='#60a8d8';c.lineWidth=1.5;
    c.beginPath();c.moveTo(cx-14,cy);c.lineTo(cx-6,cy);c.lineTo(cx-4,cy+3);c.stroke();
    c.beginPath();c.moveTo(cx+14,cy);c.lineTo(cx+6,cy);c.lineTo(cx+4,cy+3);c.stroke();
    c.fillStyle='#60a8d8';c.beginPath();c.arc(cx,cy,1.5,0,Math.PI*2);c.fill();
}
const $dbStats=document.getElementById('db-stats');
const $profileMenu=document.getElementById('profile-menu'),$profileName=document.getElementById('profile-name'),$profileStats=document.getElementById('profile-stats'),$battleInsight=document.getElementById('battle-insight');
const $personaMenu=document.getElementById('persona-menu'),$personaBrief=document.getElementById('persona-brief'),$modeBrief=document.getElementById('mode-brief'),$onlineSetup=document.getElementById('online-setup');
const $modeCards=[...document.querySelectorAll('[data-mode]')];

function getModeCfg(){ return GAME_MODES[S.gameMode] || GAME_MODES.single; }
function getPersonaCfg(){ return PERSONAS[selectedPersona] || PERSONAS.recon; }
function addScore(base){
    const mode = getModeCfg();
    const persona = getPersonaCfg();
    if(base<=0 || mode.scoreMul<=0) return 0;
    const pts = Math.max(0, Math.round(base * mode.scoreMul * persona.scoreMul));
    S.score += pts;
    return pts;
}
function setGameMode(mode, persist=true){
    S.gameMode = GAME_MODES[mode] ? mode : 'single';
    const cfg = getModeCfg();
    if($modeBrief) $modeBrief.textContent = cfg.brief;
    $modeCards.forEach(card=>{
        const active = card.dataset.mode === S.gameMode;
        card.classList.toggle('active', active);
        card.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if($onlineSetup) $onlineSetup.classList.toggle('show', S.gameMode==='multiplayer');
    if(ssMode) ssMode.textContent = cfg.label.toUpperCase();
    if(persist) dbSetSetting('gameMode', S.gameMode).catch(()=>{});
}
function setPersona(persona, persist=true){
    selectedPersona = PERSONAS[persona] ? persona : 'recon';
    if($personaMenu) $personaMenu.value = selectedPersona;
    const cfg = getPersonaCfg();
    if($personaBrief) $personaBrief.textContent = cfg.brief;
    if(activeProfile) activeProfile.persona = selectedPersona;
    if(persist) dbSetSetting('persona', selectedPersona).catch(()=>{});
}

const $setDeadzone=document.getElementById('set-deadzone'),$setExpo=document.getElementById('set-expo');
const $setPitchS=document.getElementById('set-pitch-s'),$setRollS=document.getElementById('set-roll-s'),$setYawS=document.getElementById('set-yaw-s'),$setThrS=document.getElementById('set-thr-s');
const $vehicleMenu=document.getElementById('vehicle-menu'),$vehicleSet=document.getElementById('set-vehicle');
const $setDeadzoneV=document.getElementById('set-deadzone-v'),$setExpoV=document.getElementById('set-expo-v');
const $setPitchSV=document.getElementById('set-pitch-s-v'),$setRollSV=document.getElementById('set-roll-s-v'),$setYawSV=document.getElementById('set-yaw-s-v'),$setThrSV=document.getElementById('set-thr-s-v');
const $invLX=document.getElementById('inv-lx'),$invLY=document.getElementById('inv-ly'),$invRX=document.getElementById('inv-rx'),$invRY=document.getElementById('inv-ry');
const $calibInfo=document.getElementById('calib-info');
let helpReturnMode = 'menu';
const $gpLiveStatus=document.getElementById('gp-live-status');
const $gpAxisFill=[0,1,2,3,4,5].map(i=>document.getElementById(`gp-ax-${i}`));
const $gpAxisVal=[0,1,2,3,4,5].map(i=>document.getElementById(`gp-axv-${i}`));
const $gpBtnChips=[0,1,2,3,4,5,6,7,8,9,10,11].map(i=>document.getElementById(`gp-btn-${i}`));

const $campaign=document.getElementById('campaign-screen');
const $debrief=document.getElementById('debrief-screen');
function showScreen(name){
    $menu.classList.add('hidden');$pause.classList.add('hidden');$go.classList.add('hidden');$hud.classList.add('hidden');$settings.classList.add('hidden');$help.classList.add('hidden');
    $campaign.classList.add('hidden');$debrief.classList.add('hidden');
    if(name==='campaign'){$campaign.classList.remove('hidden'); startUiAmbience(); document.body.classList.add('is-landing','is-menu'); document.body.classList.remove('is-gameplay'); updateMobileMode(); return;}
    if(name==='debrief'){$debrief.classList.remove('hidden'); startUiAmbience(); document.body.classList.add('is-landing','is-menu'); document.body.classList.remove('is-gameplay'); updateMobileMode(); return;}
    document.body.classList.toggle('is-gameplay', name==='playing' || name==='pause' || name==='gameover');
    document.body.classList.toggle('is-landing', name==='menu' || name==='settings' || name==='help');
    document.body.classList.toggle('is-menu', name==='menu' || name==='settings' || name==='help');
    if(name==='menu'){$menu.classList.remove('hidden'); startUiAmbience();}
    else if(name==='pause'){
        $pause.classList.remove('hidden'); startUiAmbience();
        document.getElementById('ps-score').textContent=S.score;
        document.getElementById('ps-kills').textContent=S.kills;
        document.getElementById('ps-dist').textContent=Math.round(S.dist)+'m';
        document.getElementById('ps-rings').textContent=S.rings;
        document.getElementById('ps-fuel').textContent=Math.round(WORLD.fuel)+'%';
    }
    else if(name==='gameover'){$go.classList.remove('hidden');document.getElementById('go-score').textContent=S.score;document.getElementById('go-dist').textContent=Math.round(S.dist);document.getElementById('go-kills').textContent=S.kills;document.getElementById('go-rings').textContent=S.rings;}
    else if(name==='settings'){$settings.classList.remove('hidden'); startUiAmbience();}
    else if(name==='help'){$help.classList.remove('hidden'); startUiAmbience();}
    else if(name==='playing'){$hud.classList.remove('hidden'); stopUiAmbience();}
    updateMobileMode();
}
function openHelp(){
    helpReturnMode = S.mode;
    if(S.mode==='playing') S.mode='paused';
    showScreen('help');
}
function closeHelp(){
    if(helpReturnMode==='playing' || helpReturnMode==='paused'){
        S.mode='paused';
        showScreen('pause');
    }else{
        S.mode='menu';
        showScreen('menu');
    }
}
function getVehicleProfile(){
    return VEHICLE_PROFILES[controlCfg.vehicleMode] || VEHICLE_PROFILES.drone;
}
function applyVehicleMode(){
    const mode = controlCfg.vehicleMode === 'helicopter' ? 'helicopter' : 'drone';
    controlCfg.vehicleMode = mode;
    droneVis.visible = mode === 'drone';
    heliVis.visible = mode === 'helicopter';
    const vp = getVehicleProfile();
    document.getElementById('game-meta').textContent =
        `${GAME_META.version} | ${controlCfg.vehicleMode==='helicopter'?'MQ-8B Fire Scout':'MQ-9 Reaper'} | ${GAME_META.note}`;
}
function applySettingsToUI(){
    $setDeadzone.value=controlCfg.deadzone; $setExpo.value=controlCfg.expo;
    $setPitchS.value=controlCfg.sensPitch; $setRollS.value=controlCfg.sensRoll; $setYawS.value=controlCfg.sensYaw; $setThrS.value=controlCfg.sensThrottle;
    $vehicleMenu.value=controlCfg.vehicleMode; $vehicleSet.value=controlCfg.vehicleMode;
    $invLX.checked=controlCfg.invertLX; $invLY.checked=controlCfg.invertLY; $invRX.checked=controlCfg.invertRX; $invRY.checked=controlCfg.invertRY;
    $setDeadzoneV.textContent=Number(controlCfg.deadzone).toFixed(2);
    $setExpoV.textContent=Number(controlCfg.expo).toFixed(2);
    $setPitchSV.textContent=Number(controlCfg.sensPitch).toFixed(2);
    $setRollSV.textContent=Number(controlCfg.sensRoll).toFixed(2);
    $setYawSV.textContent=Number(controlCfg.sensYaw).toFixed(2);
    $setThrSV.textContent=Number(controlCfg.sensThrottle).toFixed(2);
    $calibInfo.textContent=`LX ${controlCfg.centerLX.toFixed(3)} | LY ${controlCfg.centerLY.toFixed(3)} | RX ${controlCfg.centerRX.toFixed(3)} | RY ${controlCfg.centerRY.toFixed(3)}`;
}
function pullSettingsFromUI(){
    controlCfg.deadzone=Number($setDeadzone.value);
    controlCfg.expo=Number($setExpo.value);
    controlCfg.sensPitch=Number($setPitchS.value);
    controlCfg.sensRoll=Number($setRollS.value);
    controlCfg.sensYaw=Number($setYawS.value);
    controlCfg.sensThrottle=Number($setThrS.value);
    controlCfg.vehicleMode=$vehicleSet.value;
    controlCfg.invertLX=!!$invLX.checked;
    controlCfg.invertLY=!!$invLY.checked;
    controlCfg.invertRX=!!$invRX.checked;
    controlCfg.invertRY=!!$invRY.checked;
    applySettingsToUI();
    applyVehicleMode();
}
async function saveControlSettings(){
    await dbSetSetting('controls', {...controlCfg});
}
async function loadControlSettings(){
    const saved = await dbGetSetting('controls');
    if(saved) Object.assign(controlCfg, CONTROL_DEFAULT, saved);
    applySettingsToUI();
    applyVehicleMode();
}
async function refreshRunStats(){
    const topProfile = await dbTopRuns(3, activeProfileId);
    const recentProfile = await dbRecentRuns(4, activeProfileId);
    const topGlobal = await dbTopRuns(4);
    if(!topGlobal.length){
        $dbStats.innerHTML='<b>Battle Database</b><br>No missions logged yet. Launch your first sortie to create a previous record.';
        if($battleInsight) $battleInsight.textContent='No sorties yet. First launch will create battle insight for this callsign.';
        return;
    }
    const pTitle = activeProfile?.name || 'Operator';
    const latest = recentProfile[0];
    const avgScore = recentProfile.length ? Math.round(recentProfile.reduce((n,r)=>n+(r.score||0),0)/recentProfile.length) : 0;
    $dbStats.innerHTML=
        `<div class="record-grid">` +
        `<div><b>${pTitle} Battle Profile</b><span>Best ${Math.round(activeProfile?.bestScore||0)} pts</span><span>Sorties ${activeProfile?.totalFlights||0}</span></div>` +
        `<div><b>Recent Insight</b><span>Avg ${avgScore} pts</span><span>${latest ? `${Math.round(latest.dist||0)}m last range` : 'No recent sortie'}</span></div>` +
        `</div>` +
        `<b class="record-heading">Previous Records</b>` +
        (recentProfile.length ? recentProfile.map((r,i)=>`${i+1}. ${Math.round(r.score)} pts | ${Math.round(r.dist)}m | ${(r.gameMode||'single').toUpperCase()} | ${new Date(r.ts||Date.now()).toLocaleDateString()}`).join('<br>') : 'No sorties logged') +
        `<b class="record-heading">Top Operators</b>` +
        topGlobal.map((r,i)=>`${i+1}. ${Math.round(r.score)} pts | ${Math.round(r.dist)}m | ${(r.gameMode||'single').toUpperCase()}`).join('<br>');
    if($battleInsight){
        const kd = activeProfile?.totalFlights ? (activeProfile.totalKills/activeProfile.totalFlights).toFixed(1) : '0.0';
        const cloud = cloudSyncState.ok ? `Cloud: ${cloudSyncState.last}` : `Cloud: ${cloudSyncState.last}`;
        $battleInsight.innerHTML = `<b>Battle Insight</b><br>Callsign: ${pTitle} | Mode: ${(activeProfile?.preferredMode||S.gameMode).toUpperCase()} | Kills/sortie: ${kd}<br>Previous record: ${latest ? `${Math.round(latest.score||0)} pts, ${Math.round(latest.dist||0)}m, ${(latest.gameMode||'single').toUpperCase()}` : 'none yet'}<br>${cloud}`;
    }
}
function fmtSec(sec){
    const s=Math.max(0,Math.floor(sec));
    const m=Math.floor(s/60), r=s%60;
    return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;
}
async function refreshProfilesUI(){
    const profiles = await ensureDefaultProfile();
    $profileMenu.innerHTML = profiles.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
    const savedId = await dbGetSetting('activeProfileId');
    activeProfileId = (savedId && profiles.some(p=>p.id===savedId)) ? savedId : profiles[0].id;
    $profileMenu.value = activeProfileId;
    activeProfile = profiles.find(p=>p.id===activeProfileId) || profiles[0];
    const savedPersona = await dbGetSetting('persona');
    const savedMode = await dbGetSetting('gameMode');
    const hasProfilePersona = !!activeProfile.persona;
    const hasProfileMode = !!activeProfile.preferredMode;
    selectedPersona = activeProfile.persona || savedPersona || selectedPersona || 'recon';
    setPersona(selectedPersona, false);
    if(activeProfile.preferredMode || savedMode) setGameMode(activeProfile.preferredMode || savedMode, false);
    if(!hasProfilePersona || !hasProfileMode){
        activeProfile.persona = selectedPersona;
        activeProfile.preferredMode = S.gameMode;
        await dbSaveProfile(activeProfile);
    }
    const persona = getPersonaCfg();
    const mode = getModeCfg();
    $profileStats.innerHTML = `<b>${activeProfile.name}</b> | ${persona.rank} ${persona.badge}<br>Mode: ${mode.label} | Online: ${getOnlineStateLabel()}<br>Sorties: ${activeProfile.totalFlights||0} | Best: ${Math.round(activeProfile.bestScore||0)} pts | Kills: ${activeProfile.totalKills||0}<br>Total Range: ${Math.round(activeProfile.totalDistance||0)}m | Time: ${fmtSec(activeProfile.totalTime||0)}`;
    if($battleInsight && !$battleInsight.innerHTML.includes('Battle Insight')) $battleInsight.textContent = `Battle profile ready for ${activeProfile.name}. Launch a sortie to create insight and previous records.`;
    syncBattleProfileToCloud(activeProfile).then(()=>refreshRunStats()).catch(()=>{});
}
async function createProfileFromInput(){
    const name = ($profileName.value||'').trim().toUpperCase().replace(/[^A-Z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,24);
    if(!name){ notify('ENTER CALLSIGN','kill-note'); return; }
    const id = `pilot_${Date.now().toString(36)}`;
    await dbSaveProfile({
        id, name, createdAt:Date.now(), lastPlayed:Date.now(),
        totalFlights:0,totalScore:0,bestScore:0,totalDistance:0,totalKills:0,totalRings:0,totalTime:0,
        persona:selectedPersona, preferredMode:S.gameMode
    });
    activeProfileId = id;
    await dbSetSetting('activeProfileId', activeProfileId);
    $profileName.value='';
    await refreshProfilesUI();
    await refreshRunStats();
    await syncBattleProfileToCloud(activeProfile);
    notify('OPERATOR REGISTERED','ring-note');
}
async function switchActiveProfile(id){
    activeProfileId = id;
    await dbSetSetting('activeProfileId', activeProfileId);
    await refreshProfilesUI();
    await refreshRunStats();
}
async function applyRunToProfile(){
    const p = await dbGetProfileById(activeProfileId);
    if(!p) return;
    p.lastPlayed = Date.now();
    p.totalFlights = (p.totalFlights||0)+1;
    p.totalScore = (p.totalScore||0)+S.score;
    p.bestScore = Math.max(p.bestScore||0, S.score);
    p.totalDistance = (p.totalDistance||0)+S.dist;
    p.totalKills = (p.totalKills||0)+S.kills;
    p.totalRings = (p.totalRings||0)+S.rings;
    p.totalTime = (p.totalTime||0)+WORLD.missionSec;
    p.persona = selectedPersona;
    p.preferredMode = S.gameMode;
    await dbSaveProfile(p);
}
/* ===== STORY CAMPAIGN =====================================================
 * Operation Andromeda. The campaign screen lets the pilot pick an unlocked
 * sortie, read the handler's brief, and launch. In flight, a MissionDirector
 * drives the objective chain and the handler's radio calls; on completion the
 * debrief screen closes the story beat and unlocks the next sortie.
 * ========================================================================= */
let campaignProgress = defaultProgress();
let selectedMissionId = CAMPAIGN[0].id;
let activeMission = null;       /* set while a campaign sortie is in the air */
let director = null;
let debriefPending = null;

const $cmpList=document.getElementById('cmp-list');
const $cmpBrief=document.getElementById('cmp-brief');
const $cmpObjectives=document.getElementById('cmp-objectives');
const $cmpPortrait=document.getElementById('cmp-portrait');
const $cmpHandlerName=document.getElementById('cmp-handler-name');
const $cmpHandlerRole=document.getElementById('cmp-handler-role');
const $cmpHandlerBio=document.getElementById('cmp-handler-bio');

function paintHandler(h, portraitEl, nameEl, roleEl, bioEl){
    portraitEl.textContent = h.initials;
    portraitEl.style.background = `linear-gradient(150deg, ${h.tint}, ${h.tint}55)`;
    nameEl.textContent = h.name;
    roleEl.textContent = `${h.role}  ·  ${h.callsign}`;
    if(bioEl) bioEl.textContent = h.bio;
}

function renderCampaignList(){
    $cmpList.innerHTML='';
    let lastAct=null;
    for(const m of CAMPAIGN){
        const unlocked=isUnlocked(campaignProgress,m.id);
        const done=campaignProgress.completed.includes(m.id);
        const el=document.createElement('button');
        el.type='button';
        el.className='cmp-item'+(m.id===selectedMissionId?' active':'')+(unlocked?'':' locked')+(done?' done':'');
        const actLine = m.act!==lastAct ? `<div class="cmp-item-act">${m.act}</div>` : '';
        lastAct=m.act;
        const best=campaignProgress.bestScores[m.id];
        el.innerHTML=`${actLine}
            <div class="cmp-item-no">SORTIE ${String(m.no).padStart(2,'0')}${unlocked?'':' — LOCKED'}</div>
            <div class="cmp-item-name">${m.name}</div>
            <div class="cmp-item-syn">${unlocked?m.synopsis:'Complete the previous sortie to unlock.'}${best?`<br>Best score: ${best}`:''}</div>`;
        if(unlocked) el.addEventListener('click',()=>{selectedMissionId=m.id;renderCampaign();sndUiClick();});
        $cmpList.appendChild(el);
    }
}

function renderMissionDetail(){
    const m=missionById(selectedMissionId)||CAMPAIGN[0];
    paintHandler(handlerFor(m), $cmpPortrait, $cmpHandlerName, $cmpHandlerRole, $cmpHandlerBio);
    $cmpBrief.innerHTML=m.briefing.map(p=>`<p>${p}</p>`).join('');
    $cmpObjectives.innerHTML=`<div class="cmp-obj-h">SORTIE OBJECTIVES</div>`+
        m.objectives.map((o,i)=>`<div class="cmp-obj"><span class="cmp-obj-i">${i+1}.</span><span>${o.text}</span></div>`).join('')+
        `<div class="cmp-obj" style="margin-top:8px"><span class="cmp-obj-i">◷</span><span>Conditions: ${(TIME_PRESETS[m.time]||{}).label||m.time} · ${m.enemies?`${m.enemies} hostile airframes expected`:'no hostiles expected'}</span></div>`;
}

function renderCampaign(){ renderCampaignList(); renderMissionDetail(); }

async function saveCampaignProgress(){
    try{ await dbSetSetting('campaignProgress', campaignProgress); }catch(_){}
}
async function loadCampaignProgress(){
    try{ campaignProgress = normalizeProgress(await dbGetSetting('campaignProgress')); }
    catch(_){ campaignProgress = defaultProgress(); }
    selectedMissionId = campaignProgress.current || CAMPAIGN[0].id;
}

function openCampaign(){ renderCampaign(); showScreen('campaign'); }

function launchCampaignMission(){
    const m=missionById(selectedMissionId);
    if(!m || !isUnlocked(campaignProgress,m.id)) return;
    activeMission = m;
    setGameMode('mission', false);
    startGame();
}

/* Objective marker so "go to the Harbor Yard" is actually findable from the air.
 * Kept as a faint boundary column plus a ground ring — a solid cylinder at any
 * useful radius simply fills the screen. */
const objMarker=new THREE.Group();
const objWallMat=new THREE.MeshBasicMaterial({color:0x63ff9c,transparent:true,opacity:.07,side:THREE.DoubleSide,depthWrite:false});
const objWall=new THREE.Mesh(new THREE.CylinderGeometry(1,1,150,32,1,true),objWallMat);
objWall.position.y=75; objMarker.add(objWall);
const objRingMat=new THREE.MeshBasicMaterial({color:0x63ff9c,transparent:true,opacity:.5,side:THREE.DoubleSide,depthWrite:false});
const objRing=new THREE.Mesh(new THREE.RingGeometry(0.94,1,64),objRingMat);
objRing.rotation.x=-Math.PI/2; objRing.position.y=0.3; objMarker.add(objRing);
objMarker.visible=false; scene.add(objMarker);

function setObjectiveMarker(loc,radius){
    if(!loc){ objMarker.visible=false; return; }
    const r=radius||70;
    objMarker.position.set(loc.x,0,loc.z);
    objMarker.scale.set(r,1,r);
    objMarker.visible=true;
}

function beginMissionDirector(){
    director=null; objMarker.visible=false;
    if(!activeMission) return;
    applyTimeOfDay(activeMission.time);
    director=new MissionDirector(activeMission, C.citySize);
    const h=handlerFor(activeMission);
    showRadioMsg(`${h.callsign}: ${activeMission.name.toUpperCase()} — you are cleared for departure, ${activeCallsign()}.`, 6);
}

function missionCtx(){
    return {
        kills:S.kills, waypoints:S.rings, hp:S.hp, maxHp:C.maxHP,
        fuel:WORLD.fuel, pos:drone.position,
    };
}

function handleMissionEvents(events){
    for(const ev of events){
        if(ev.type==='objective-start'){
            $objective.textContent=ev.objective.text;
            $objective.classList.add('show');
            setObjectiveMarker(ev.location, ev.objective.radius);
            if(ev.objective.radio){
                const h=handlerFor(activeMission);
                showRadioMsg(`${h.callsign}: ${expandRadioLine(ev.objective.radio)}`, 6);
            }
        } else if(ev.type==='objective-progress'){
            $objective.textContent=`${ev.objective.text}  [${ev.status}]`;
        } else if(ev.type==='objective-complete'){
            notify('OBJECTIVE COMPLETE','ring-note'); addScore(500);
        } else if(ev.type==='mission-complete'){
            campaignProgress=markComplete(campaignProgress, activeMission.id, S.score);
            saveCampaignProgress();
            debriefPending={ok:true, mission:activeMission, reason:''};
            openDebrief();
        } else if(ev.type==='mission-failed'){
            debriefPending={ok:false, mission:activeMission, reason:ev.reason};
            openDebrief();
        }
    }
}

function openDebrief(){
    if(!debriefPending) return;
    const {ok, mission, reason}=debriefPending;
    S.mode='debrief'; objMarker.visible=false; director=null;
    const h=handlerFor(mission);
    paintHandler(h, document.getElementById('dbf-portrait'), document.getElementById('dbf-handler-name'), document.getElementById('dbf-handler-role'), null);
    document.getElementById('dbf-tag').textContent = ok ? 'SORTIE COMPLETE' : 'SORTIE FAILED';
    document.getElementById('dbf-title').textContent = ok ? mission.name : `${mission.name} — ${reason}`;
    document.getElementById('dbf-text').innerHTML = ok
        ? `<p>${mission.debrief}</p><p><b>${mission.unlockText}</b></p>`
        : `<p>${reason}. ${h.name.split(' ').slice(-1)[0]} wants you back on the pad and airborne again.</p>`;
    document.getElementById('dbf-stats').innerHTML=`<div class="cmp-obj-h">SORTIE RECORD</div>`+
        [['Score',S.score],['Hostiles neutralised',S.kills],['Waypoints',S.rings],['Distance',`${Math.round(S.dist)} m`],['Hull',`${Math.max(0,Math.round(S.hp))}/${C.maxHP}`],['Fuel remaining',`${Math.round(WORLD.fuel)}%`]]
            .map(([k,v])=>`<div class="cmp-obj"><span class="cmp-obj-i">›</span><span>${k}: ${v}</span></div>`).join('');
    const next=CAMPAIGN.find(x=>!campaignProgress.completed.includes(x.id));
    const $next=document.getElementById('btn-dbf-next');
    $next.style.display = (ok && next) ? '' : 'none';
    if(next) $next.textContent = `Next Sortie — ${next.name}`;
    applyRunToProfile().catch(()=>{});
    showScreen('debrief');
}

document.getElementById('btn-cmp-launch').addEventListener('click',launchCampaignMission);
document.getElementById('btn-cmp-back').addEventListener('click',()=>showScreen('menu'));
document.getElementById('btn-dbf-retry').addEventListener('click',()=>{ if(activeMission){ selectedMissionId=activeMission.id; launchCampaignMission(); } });
document.getElementById('btn-dbf-menu').addEventListener('click',()=>{ activeMission=null; openCampaign(); });
document.getElementById('btn-dbf-next').addEventListener('click',()=>{
    const next=CAMPAIGN.find(x=>!campaignProgress.completed.includes(x.id));
    if(next){ selectedMissionId=next.id; renderCampaign(); launchCampaignMission(); }
});

function startGame(){
    document.body.classList.remove('direct-launch');
    updateMobileMode();
    if(!$profileMenu.value && activeProfileId) $profileMenu.value = activeProfileId;
    activeProfileId = $profileMenu.value || activeProfileId;
    activeProfile = { id: activeProfileId, name: $profileMenu.selectedOptions[0]?.textContent || activeProfile.name, persona:selectedPersona, preferredMode:S.gameMode };
    dbSetSetting('activeProfileId', activeProfileId).catch(()=>{});
    dbSetSetting('gameMode', S.gameMode).catch(()=>{});
    dbSetSetting('persona', selectedPersona).catch(()=>{});
    if(S.gameMode!=='multiplayer') disconnectOnlineRoom().catch(()=>{});
    resumeAudio();startEngine();resetState();drone.position.copy(SPAWN);drone.rotation.set(0,0,0);
    if(S.gameMode==='multiplayer'){
        const spawnAngle = (hashString(`${onlineConfig.room}:${onlineClientId}`) % 6283) / 1000;
        drone.position.x += Math.cos(spawnAngle) * 24;
        drone.position.z += Math.sin(spawnAngle) * 24;
        drone.rotation.y = spawnAngle + Math.PI;
    }
    prevPos.copy(drone.position);droneVis.rotation.set(0,0,0);heliVis.rotation.set(0,0,0);
    WORLD.fuel = getModeCfg().fuelStart;
    applyVehicleMode();
    lockTarget=null; lockFollow=false;
    /* A campaign sortie overrides the generic mode: its own hostile count,
     * time of day and objective chain take over. */
    const missionEnemies = activeMission ? activeMission.enemies : C.enemyCount;
    launchGrace = missionEnemies>0 ? LAUNCH_GRACE_SEC : 0;
    enemies.forEach(e=>scene.remove(e));enemies.length=0;
    if(activeMission){ for(let i=0;i<missionEnemies;i++){ const e=mkEnemy(); if(e && e.position.distanceTo(drone.position)<140){ const a=Math.random()*Math.PI*2, r=150+Math.random()*70; e.position.set(drone.position.x+Math.cos(a)*r,20+Math.random()*45,drone.position.z+Math.sin(a)*r);} } }
    else if(getModeCfg().enemies) spawnEnemies();
    rings.forEach(r=>{r.userData.got=false;r.visible=true;});
    orbs.forEach(o=>{o.userData.got=false;o.visible=true;});
    for(const b of bulletPool){b.userData.active=false;b.visible=false;b.position.set(0,-999,0);}bulletActive=0;
    for(const b of eBulletPool){b.userData.active=false;b.visible=false;b.position.set(0,-999,0);}eBulletActive=0;
    for(const p of expPool){p.userData.active=false;p.visible=false;p.position.set(0,-999,0);}
    for(const l of expLightPool){l.userData.active=false;l.visible=false;l.intensity=0;}explosions.length=0;
    comboCount=0;comboTimer=0;objIdx=0;objTimer=0;objShown=!getModeCfg().objective;activePU=null;puTimer=0;
    powerUps.forEach(pu=>{pu.userData.got=false;pu.visible=true;});
    $objective.classList.remove('show');
    S.mode='playing';showScreen('playing');updateMobileMode();requestMobileImmersive();clock.getDelta();
    document.getElementById('game-meta').style.display='none';
    periodicTimer=20+Math.random()*15;
    beginMissionDirector();
    if(!activeMission) setTimeout(()=>radioSpeak('startup'),1500);
    notify(`${getModeCfg().label.toUpperCase()} MODE | ${getPersonaCfg().label.toUpperCase()}`,'ring-note');
    if(S.gameMode==='multiplayer') connectOnlineRoom();
}
function togglePause(){
    if(S.mode==='playing'){
        S.mode='paused';showScreen('pause');updateMobileMode();
    }
    else if(S.mode==='paused'){
        S.mode='playing';showScreen('playing');updateMobileMode();clock.getDelta();trackOnlineState(true).catch(()=>{});
    }
}
function exitToMenu(){
    disconnectOnlineRoom().catch(()=>{});
    location.href = './index.html';
}
document.getElementById('btn-settings').addEventListener('click',()=>{applySettingsToUI();showScreen('settings');});
document.getElementById('btn-back-menu').addEventListener('click',()=>showScreen('menu'));
document.getElementById('btn-help').addEventListener('click',openHelp);
document.getElementById('btn-help-back').addEventListener('click',closeHelp);
function setVehicleMode(mode){
    controlCfg.vehicleMode = mode === 'helicopter' ? 'helicopter' : 'drone';
    $vehicleMenu.value = controlCfg.vehicleMode;
    $vehicleSet.value = controlCfg.vehicleMode;
    applyVehicleMode();
}
$vehicleMenu.addEventListener('change', async ()=>{setVehicleMode($vehicleMenu.value); await saveControlSettings();});
$vehicleSet.addEventListener('change', pullSettingsFromUI);
$modeCards.forEach(card=>card.addEventListener('click', async ()=>{
    setGameMode(card.dataset.mode);
    const p = await dbGetProfileById(activeProfileId);
    if(p){p.preferredMode=S.gameMode; await dbSaveProfile(p); activeProfile=p; await refreshProfilesUI();}
    if(S.gameMode==='multiplayer') setOnlineStatus(getOnlineStateLabel(), 'good');
}));
$personaMenu.addEventListener('change', async ()=>{
    setPersona($personaMenu.value);
    const p = await dbGetProfileById(activeProfileId);
    if(p){p.persona=selectedPersona; await dbSaveProfile(p); activeProfile=p; await refreshProfilesUI();}
});
document.getElementById('btn-calibrate').addEventListener('click', async ()=>{
    const ok = calibrateGamepadCenter();
    if(ok){applySettingsToUI();await saveControlSettings();notify('GAMEPAD CALIBRATED','ring-note');}
    else notify('CONNECT GAMEPAD FIRST','kill-note');
});
document.getElementById('btn-room-create').addEventListener('click',()=>{createOnlineRoom().catch(()=>setOnlineStatus('Could not create room.', 'bad'));});
document.getElementById('btn-room-join').addEventListener('click',()=>{joinOnlineRoom().catch(()=>setOnlineStatus('Could not join room.', 'bad'));});
document.getElementById('btn-room-copy').addEventListener('click',()=>{copyOnlineInvite().catch(()=>setOnlineStatus('Could not copy invite.', 'bad'));});
document.getElementById('btn-save-settings').addEventListener('click', async ()=>{pullSettingsFromUI();await saveControlSettings();notify('SETTINGS SAVED','ring-note');});
[$setDeadzone,$setExpo,$setPitchS,$setRollS,$setYawS,$setThrS,$invLX,$invLY,$invRX,$invRY].forEach(el=>el.addEventListener('input',pullSettingsFromUI));
document.getElementById('btn-campaign').addEventListener('click',openCampaign);
document.getElementById('btn-start').addEventListener('click',()=>{
    /* "Mission" is the story campaign; every other mode is a free sortie. */
    if(S.gameMode==='mission'){ openCampaign(); return; }
    activeMission=null;
    startGame();
});
document.getElementById('btn-resume').addEventListener('click',togglePause);
document.getElementById('btn-restart-p').addEventListener('click',startGame);
document.getElementById('btn-restart-go').addEventListener('click',startGame);
document.getElementById('btn-pause-settings').addEventListener('click',()=>{applySettingsToUI();showScreen('settings');});
document.getElementById('btn-exit-menu').addEventListener('click',exitToMenu);
document.getElementById('btn-create-profile').addEventListener('click',createProfileFromInput);
$profileName.addEventListener('keydown',e=>{ if(e.key==='Enter') createProfileFromInput(); });
$profileMenu.addEventListener('change', async ()=>{await switchActiveProfile($profileMenu.value);});
document.getElementById('btn-exit-app').addEventListener('click',()=>{
    notify('Use browser/tab close to quit','kill-note');
    try{ window.close(); }catch(_){}
});
document.querySelectorAll('.btn, .m-start').forEach(b=>{
    b.addEventListener('pointerenter', sndUiHover);
    b.addEventListener('click', sndUiClick);
});
document.querySelectorAll('select').forEach(s=>{
    s.addEventListener('pointerenter', sndUiHover);
    s.addEventListener('change', sndUiClick);
});
applySettingsToUI();
applyVehicleMode();
setupMobileControls();
(async ()=>{
    await initDB();
    await loadControlSettings();
    await loadOnlineConfig();
    await refreshProfilesUI();
    await refreshRunStats();
    await loadCampaignProgress();
    renderCampaign();
    const boot = getBootParams();
    if(boot.mode && GAME_MODES[boot.mode]) setGameMode(boot.mode);
    if(boot.aircraft) {
        setVehicleMode(boot.aircraft === 'helicopter' ? 'helicopter' : 'drone');
        await saveControlSettings();
    }
    if(boot.room) await saveOnlineRoom(boot.room);
    if(boot.mode || boot.aircraft){
        /* Mirror the btn-start rule: "mission" IS the story campaign, so a direct
         * launch has to land on the campaign screen and pick a sortie. Calling
         * startGame() here instead dropped the pilot into a generic sortie with
         * activeMission null, which is why the campaign was unreachable from the
         * preflight page. Clear the overlay by hand — only startGame() does it. */
        if(S.gameMode === 'mission'){
            document.body.classList.remove('direct-launch');
            openCampaign();
        } else {
            setTimeout(startGame, 250);
        }
    }
})();

/* Objective system */
const objectives=['Neutralize 5 hostile drones','Secure 8 waypoints','Hold station for 60 seconds','Maintain air superiority'];
let objIdx=0, objTimer=0, objShown=false;
function checkObjective(dt=1/60){
    if(!getModeCfg().objective) return;
    if(objIdx===0&&S.kills>=5){objIdx++;$objective.classList.remove('show');setTimeout(()=>{$objective.textContent=objectives[objIdx];$objective.classList.add('show');},500);notify('OBJECTIVE COMPLETE','ring-note');addScore(500);}
    else if(objIdx===1&&S.rings>=8){objIdx++;$objective.classList.remove('show');setTimeout(()=>{$objective.textContent=objectives[objIdx];$objective.classList.add('show');},500);notify('OBJECTIVE COMPLETE','ring-note');addScore(500);}
    else if(objIdx===2){objTimer+=dt;if(objTimer>=60){objIdx++;$objective.classList.remove('show');setTimeout(()=>{$objective.textContent='AO Secured - Free Hunt';$objective.classList.add('show');},500);notify('ALL OBJECTIVES COMPLETE +1000','ring-note');addScore(1000);setTimeout(()=>radioSpeak('objective'),800);}}
    if(!objShown){$objective.textContent=objectives[0];$objective.classList.add('show');objShown=true;}
}

const $threats=document.getElementById('threats'), $puInd=document.getElementById('pu-ind');
const _threatArrows=[];
for(let _i=0;_i<12;_i++){
    const arr=document.createElement('div');arr.className='threat-arrow';arr.style.display='none';
    $threats.appendChild(arr);_threatArrows.push(arr);
}
function updHUD(spd,dt=1/60){
    $hPilot.textContent = S.gameMode==='multiplayer' ? `YOU ${multiplayerCallsign()}` : (activeProfile?.name || 'VIPER-1').toUpperCase();
    $hScore.textContent=S.score;$hDist.textContent=Math.round(S.dist);$hKills.textContent=S.kills;$hRings.textContent=S.rings;
    const pct=(S.hp/C.maxHP)*100;$hpBar.style.width=pct+'%';$hpBar.classList.toggle('low',pct<30);
    document.getElementById('hp-label').textContent='HULL '+Math.max(0,Math.round(S.hp))+'/'+C.maxHP;
    $boostBar.style.width=S.boost+'%';
    const kts=Math.round(spd*1.944);
    $speed.textContent=kts+' KTS';
    lowHpWarn.classList.toggle('active',pct<25);
    const alt=Math.round(drone.position.y);
    $alt.textContent='ALT '+alt+'m';
    $alt.classList.toggle('warn',alt<5||alt>140);
    const fuelPct=Math.max(0,Math.round(WORLD.fuel));
    $hFuel.textContent = `${fuelPct}%`;
    $hFuel.classList.toggle('warn-fuel',fuelPct<25);
    $hWind.textContent = `${WORLD.windSpeed.toFixed(1)} m/s`;
    if($hBatt){
        $hBatt.textContent = `${WORLD.batteryV.toFixed(1)}V`;
        $hBatt.classList.toggle('warn-sys', WORLD.batteryV<21.8);
    }
    if($hSignal){
        $hSignal.textContent = `${Math.round(WORLD.signal)}%`;
        $hSignal.classList.toggle('warn-sys', WORLD.signal<55);
    }
    if($hAir){
        $hAir.textContent = `${Math.round(WORLD.airDensity*100)}%`;
        $hAir.classList.toggle('warn-sys', WORLD.airDensity<0.9 || WORLD.turbulence>0.8);
    }
    $hTime.textContent = fmtSec(WORLD.missionSec);
    const deg=((drone.rotation.y*180/Math.PI)%360+360)%360;
    const dirs=['N','NE','E','SE','S','SW','W','NW'];
    $compass.textContent=dirs[Math.round(deg/45)%8]+' '+Math.round(deg)+'°';
    drawHeadingTape(deg);
    drawSpeedTape(spd);
    drawAltTape(drone.position.y);
    const eul=new THREE.Euler().setFromQuaternion(drone.quaternion,'ZXY');
    drawADI(-eul.x,-eul.z);
    _fpsFrames++;
    const now=performance.now();
    if(now-_fpsTime>1000){_fpsVal=Math.round(_fpsFrames*1000/(now-_fpsTime));_fpsFrames=0;_fpsTime=now;}
    if(ssFps)ssFps.textContent=_fpsVal+'FPS';
    const fakeLat=(32.0+drone.position.z*0.0001).toFixed(4);
    const fakeLon=(51.4+drone.position.x*0.0001).toFixed(4);
    if(ssLat)ssLat.textContent=fakeLat+'N';
    if(ssLon)ssLon.textContent=fakeLon+'E';
    if(ssLink){
        ssLink.textContent = WORLD.signal<25 ? 'LOST' : (WORLD.signal<55 ? 'WEAK' : 'GOOD');
        ssLink.classList.toggle('bad-sys', WORLD.signal<25);
        ssLink.classList.toggle('warn-sys', WORLD.signal>=25 && WORLD.signal<55);
    }
    if(ssGps){
        ssGps.textContent = WORLD.gps;
        ssGps.classList.toggle('bad-sys', WORLD.gps==='NO FIX');
        ssGps.classList.toggle('warn-sys', WORLD.gps==='2D');
    }
    if(ssMode) ssMode.textContent = getModeCfg().label.toUpperCase();
    if(ssOnline){
        ssOnline.textContent = (onlineConnected || localRoomConnected) ? `${remotePilots.size+1}/${onlinePresenceCount||remotePilots.size+1}` : 'OFF';
        ssOnline.classList.toggle('warn-sys', S.gameMode==='multiplayer' && !onlineConnected && !localRoomConnected);
        ssOnline.classList.toggle('bad-sys', S.gameMode==='multiplayer' && !onlineConfig.url);
    }
    if($mpDebug){
        const active = S.gameMode==='multiplayer' && S.mode==='playing';
        $mpDebug.style.display = active ? 'block' : 'none';
        if(active){
            const age = onlineStats.lastReceiveAt ? `${Math.round((performance.now()-onlineStats.lastReceiveAt)/1000)}s` : 'never';
            const transport = onlineConnected ? 'SUPABASE' : (localRoomConnected ? 'LOCAL' : 'OFFLINE');
            const stateClass = onlineConnected ? 'good' : (localRoomConnected ? 'warn' : 'bad');
            const statusText = remotePilots.size ? `${remotePilots.size} enemy contact active` : onlineStats.lastStatus;
            $mpDebug.className = `battle-status ${stateClass}`;
            $mpDebug.innerHTML = `<b>Battle Link</b><span>${transport} room ${onlineConfig.room||'--'} | sent ${onlineStats.sent} | rx ${onlineStats.received} | last ${age}</span><em>${statusText}</em>`;
        }
    }
    if($flightWarn){
        $flightWarn.textContent = WORLD.warning;
        $flightWarn.classList.toggle('show', !!WORLD.warning);
    }
    /* Threat indicators (pooled DOM — no innerHTML thrashing) */
    const sw=innerWidth,sh=innerHeight,cx=sw/2,cy=sh/2;
    let _taIdx=0;
    for(const e of enemies){
        if(_taIdx>=_threatArrows.length) break;
        const d=e.position.distanceTo(drone.position);
        if(d>120||d<5) continue;
        const sp=e.position.clone().project(camera);
        const sx=(sp.x*.5+.5)*sw, sy=(1-sp.y*.5-.5)*sh;
        if(sp.z>1||sx<-20||sx>sw+20||sy<-20||sy>sh+20){
            const ang=Math.atan2(sy-cy,sx-cx);
            const margin=40;
            const exx=cx+Math.cos(ang)*(cx-margin), eyy=cy+Math.sin(ang)*(cy-margin);
            const arr=_threatArrows[_taIdx++];
            arr.style.display='';
            arr.style.left=exx+'px';arr.style.top=eyy+'px';
            arr.style.transform='translate(-50%,-50%) rotate('+(ang+Math.PI/2)+'rad)';
        }
    }
    if(S.gameMode==='multiplayer'){
        for(const rp of remotePilots.values()){
            if(_taIdx>=_threatArrows.length) break;
            if(!rp.mesh.visible || (rp.hp ?? C.maxHP) <= 0) continue;
            const sp=rp.mesh.position.clone().project(camera);
            const sx=(sp.x*.5+.5)*sw, sy=(1-sp.y*.5-.5)*sh;
            if(sp.z>1||sx<-20||sx>sw+20||sy<-20||sy>sh+20){
                const ang=Math.atan2(sy-cy,sx-cx);
                const margin=40;
                const exx=cx+Math.cos(ang)*(cx-margin), eyy=cy+Math.sin(ang)*(cy-margin);
                const arr=_threatArrows[_taIdx++];
                arr.style.display='';
                arr.style.left=exx+'px';arr.style.top=eyy+'px';
                arr.style.transform='translate(-50%,-50%) rotate('+(ang+Math.PI/2)+'rad)';
            }
        }
    }
    for(let ti=_taIdx;ti<_threatArrows.length;ti++) _threatArrows[ti].style.display='none';
    /* Power-up indicator */
    if(activePU){
        $puInd.textContent=activePU.name+' '+Math.ceil(puTimer)+'s';
        $puInd.style.background='rgba('+((activePU.color>>16)&255)+','+((activePU.color>>8)&255)+','+(activePU.color&255)+',.25)';
        $puInd.style.color='#'+activePU.color.toString(16).padStart(6,'0');
        $puInd.style.border='1px solid rgba('+((activePU.color>>16)&255)+','+((activePU.color>>8)&255)+','+(activePU.color&255)+',.4)';
        $puInd.classList.add('show');
    }else{$puInd.classList.remove('show');}
    const remoteLock = remoteLockInfo();
    if(lockTarget && enemies.includes(lockTarget)){
        const d = drone.position.distanceTo(lockTarget.position);
        const nm = lockTarget.userData?.type?.name || 'enemy';
        $lockInfo.textContent = `LOCK: ${nm.toUpperCase()} • ${Math.round(d)}m${lockFollow?' • FOLLOW':''}`;
        $lockInfo.classList.add('show');
    }else if(remoteLock){
        const d = drone.position.distanceTo(remoteLock.rp.mesh.position);
        const nm = remoteLock.rp.state?.name || 'REMOTE';
        $lockInfo.textContent = `LOCK: ENEMY ${nm.toUpperCase()} • ${Math.round(d)}m${lockFollow?' • FOLLOW':''}`;
        $lockInfo.classList.add('show');
    }else{
        const contact = S.gameMode==='multiplayer' ? nearestRemotePilot() : null;
        if(contact){
            const nm = contact.rp.state?.name || 'REMOTE';
            $lockInfo.textContent = `ENEMY CONTACT: ${nm.toUpperCase()} • ${Math.round(contact.d)}m`;
            $lockInfo.classList.add('show');
        }else{
            $lockInfo.classList.remove('show');
        }
    }
    /* Objectives */
    /* Campaign sorties run the story objective chain; everything else falls
     * back to the generic objective ladder. */
    if(director){
        handleMissionEvents(director.update(dt, missionCtx()));
        if(objMarker.visible) objMarker.rotation.y += dt*0.25;
    } else {
        checkObjective(dt);
    }
}

/* ===== MINIMAP ===== */
const mmCvs=document.getElementById('minimap'),mmC=mmCvs.getContext('2d'),MM=140,MMR=320;
function updMinimap(){
    mmC.clearRect(0,0,MM,MM);mmC.fillStyle='rgba(6,10,18,.85)';mmC.fillRect(0,0,MM,MM);
    const cx=MM/2,cy=MM/2,sc=MM/MMR;
    mmC.fillStyle='rgba(40,60,80,.4)';
    for(const b of buildings){const dx=(b.mesh.position.x-drone.position.x)*sc,dz=(b.mesh.position.z-drone.position.z)*sc;if(Math.abs(dx)>72||Math.abs(dz)>72)continue;mmC.fillRect(cx+dx-2,cy+dz-2,4,4);}
    mmC.fillStyle='#40b8e0';for(const r of rings){if(r.userData.got)continue;const dx=(r.position.x-drone.position.x)*sc,dz2=(r.position.z-drone.position.z)*sc;if(Math.abs(dx)>72||Math.abs(dz2)>72)continue;mmC.beginPath();mmC.arc(cx+dx,cy+dz2,2,0,Math.PI*2);mmC.fill();}
    mmC.fillStyle='#60a0d0';for(const o of orbs){if(o.userData.got)continue;const dx=(o.position.x-drone.position.x)*sc,dz2=(o.position.z-drone.position.z)*sc;if(Math.abs(dx)>72||Math.abs(dz2)>72)continue;mmC.beginPath();mmC.arc(cx+dx,cy+dz2,2,0,Math.PI*2);mmC.fill();}
    mmC.fillStyle='#e05540';for(const e of enemies){const dx=(e.position.x-drone.position.x)*sc,dz2=(e.position.z-drone.position.z)*sc;if(Math.abs(dx)>72||Math.abs(dz2)>72)continue;mmC.beginPath();mmC.arc(cx+dx,cy+dz2,3,0,Math.PI*2);mmC.fill();}
    mmC.fillStyle='#ff3348';mmC.strokeStyle='rgba(255,51,72,.9)';mmC.lineWidth=1.8;for(const rp of remotePilots.values()){if(!rp.mesh.visible)continue;const dx=(rp.mesh.position.x-drone.position.x)*sc,dz2=(rp.mesh.position.z-drone.position.z)*sc;const px=THREE.MathUtils.clamp(cx+dx,8,MM-8),py=THREE.MathUtils.clamp(cy+dz2,8,MM-8);const far=px!==cx+dx||py!==cy+dz2;mmC.beginPath();mmC.arc(px,py,far?5:4,0,Math.PI*2);mmC.fill();mmC.beginPath();mmC.arc(px,py,far?10:8,0,Math.PI*2);mmC.stroke();mmC.beginPath();mmC.moveTo(px-5,py);mmC.lineTo(px+5,py);mmC.moveTo(px,py-5);mmC.lineTo(px,py+5);mmC.stroke();if(far){mmC.beginPath();mmC.moveTo(cx,cy);mmC.lineTo(px,py);mmC.stroke();}}
    mmC.fillStyle='#60c0e8';mmC.beginPath();mmC.arc(cx,cy,3,0,Math.PI*2);mmC.fill();
    const fwd=new THREE.Vector3(0,0,-1).applyQuaternion(drone.quaternion);mmC.strokeStyle='#60c0e8';mmC.lineWidth=1.5;mmC.beginPath();mmC.moveTo(cx,cy);mmC.lineTo(cx+fwd.x*12,cy+fwd.z*12);mmC.stroke();
    mmC.strokeStyle='rgba(60,90,120,.3)';mmC.lineWidth=1;mmC.strokeRect(0,0,MM,MM);
}

/* ===== SMOKE COLUMNS (war zone atmosphere) ===== */
const smokeColumns=[];
function spawnSmokeColumns(){
    const hf=C.citySize/2-40;
    for(let i=0;i<3;i++){
        const smokePos=new Float32Array(30*3);
        const smokeVel=[];
        for(let j=0;j<30;j++){
            smokePos[j*3]=(Math.random()-.5)*3;
            smokePos[j*3+1]=Math.random()*40;
            smokePos[j*3+2]=(Math.random()-.5)*3;
            smokeVel.push((Math.random()-.5)*0.5, 3+Math.random()*4, (Math.random()-.5)*0.5);
        }
        const geo=new THREE.BufferGeometry();
        geo.setAttribute('position',new THREE.BufferAttribute(smokePos,3));
        const mat=new THREE.PointsMaterial({color:0x1a2030,size:2.5,transparent:true,opacity:.25,depthWrite:false});
        const smoke=new THREE.Points(geo,mat);
        smoke.position.set((Math.random()-.5)*hf*2, 0, (Math.random()-.5)*hf*2);
        scene.add(smoke);
        smokeColumns.push({pts:smoke,vel:smokeVel,baseX:smoke.position.x,baseZ:smoke.position.z});
    }
}
function updSmoke(dt){
    for(const sc of smokeColumns){
        const p=sc.pts.geometry.attributes.position.array;
        for(let i=0;i<30;i++){
            const i3=i*3;
            p[i3]+=sc.vel[i3]*dt+(Math.random()-.5)*0.3*dt;
            p[i3+1]+=sc.vel[i3+1]*dt;
            p[i3+2]+=sc.vel[i3+2]*dt+(Math.random()-.5)*0.3*dt;
            if(p[i3+1]>45){
                p[i3]=(Math.random()-.5)*2;
                p[i3+1]=0;
                p[i3+2]=(Math.random()-.5)*2;
            }
        }
        sc.pts.geometry.attributes.position.needsUpdate=true;
    }
}

/* ===== INIT ===== */
try{
    const bootRoomSeed = normalizeRoomId(new URLSearchParams(location.search).get('room'));
    /* Casting is enumerated explicitly (it costs a shadow-map draw per object),
     * but *receiving* is just a shader branch on an already-shared material, so
     * it's safe to blanket-apply to every lit surface. Without this the sun's
     * shadows land on the base ground plane and are then hidden by the road,
     * lot and sidewalk meshes drawn on top of it. */
    const enableShadowReceiving = () => {
        scene.traverse(o=>{
            if(!o.isMesh || o.receiveShadow) return;
            const m = o.material;
            const lit = Array.isArray(m) ? m.some(x=>x && x.isMeshStandardMaterial) : (m && m.isMeshStandardMaterial);
            if(lit) o.receiveShadow = true;
        });
    };
    const initWorld = () => { generateCity(); buildSpatialGrid(); spawnTraffic(); spawnEnemies(); spawnRings(); spawnOrbs(); spawnPowerUps(); spawnSmokeColumns(); enableShadowReceiving(); };
    bootRoomSeed ? withSeededRandom(`room:${bootRoomSeed}`, initWorld) : initWorld();
}catch(e){console.error('Init error:',e);}

/* ===== GAME LOOP ===== */
const clock=new THREE.Clock();
let prevPos=drone.position.clone();

function animate(){
    requestAnimationFrame(animate);
    try{
    updateGamepadLiveUI();
    validateLockTarget();

    if(S.mode!=='playing'&&S.mode!=='paused'){
        renderer.clear();
        clock.getDelta();
        return;
    }
    if(S.mode==='paused'){postfx.render(0);return;}

    const dt=Math.min(clock.getDelta(),.05);
    if(launchGrace>0){
        launchGrace=Math.max(0,launchGrace-dt);
        if(launchGrace===0) notify('WEAPONS FREE — HOSTILES ENGAGING','kill-note');
    }
    updateWater(dt);
    S.invTimer=Math.max(0,S.invTimer-dt); fCD-=dt;
    WORLD.missionSec += dt;
    WORLD.windDir += Math.sin(performance.now()*0.00007)*0.0008;

    /* ---- GAMEPAD: read raw axes & buttons ---- */
    let gpLX=0,gpLY=0,gpRX=0,gpRY=0;
    let gpFire=false,gpUp=false,gpDown=false,gpBoost=false,gpPause=false;
    let gpBrake=false,gpHead=false,gpFlip=false,gpCamTog=false;
    let gpDU=false,gpDD=false,gpDL=false,gpDR=false,gpL3=false,gpR3=false;
    let gpLTVal=0, gpRTVal=0;

    if(gpIdx!==null){
        const gp=navigator.getGamepads()?.[gpIdx];
        if(gp){
            /* Calibrated + configurable stick processing */
            gpLX=gpAxis(gp.axes[0], controlCfg.centerLX, controlCfg.invertLX, controlCfg.sensYaw);
            gpLY=gpAxis(gp.axes[1], controlCfg.centerLY, controlCfg.invertLY, controlCfg.sensThrottle);
            gpRX=gpAxis(gp.axes[2], controlCfg.centerRX, controlCfg.invertRX, controlCfg.sensRoll);
            gpRY=gpAxis(gp.axes[3], controlCfg.centerRY, controlCfg.invertRY, controlCfg.sensPitch);

            /* Buttons */
            gpBoost=!!gp.buttons[0]?.pressed;  // A → boost
            gpBrake=!!gp.buttons[1]?.pressed;  // B → brake
            gpHead=!!gp.buttons[2]?.pressed;   // X → toggle headlight
            gpFlip=!!gp.buttons[3]?.pressed;   // Y → quick 180
            gpUp=!!gp.buttons[4]?.pressed;     // LB → throttle bump up
            gpFire=!!gp.buttons[5]?.pressed;   // RB → fire
            gpLTVal=gp.buttons[6]?.value||0;   // LT → analog throttle down
            gpRTVal=gp.buttons[7]?.value||0;   // RT → analog fire
            gpDown=gpLTVal>.1;
            if(gpRTVal>.15) gpFire=true;
            gpCamTog=!!gp.buttons[8]?.pressed; // Back → camera toggle
            gpPause=!!gp.buttons[9]?.pressed;  // Start → pause
            gpL3=!!gp.buttons[10]?.pressed;    // L3 → turbo
            gpR3=!!gp.buttons[11]?.pressed;    // R3 → reset cam
            gpDU=!!gp.buttons[12]?.pressed;    // D-pad Up
            gpDD=!!gp.buttons[13]?.pressed;    // D-pad Down
            gpDL=!!gp.buttons[14]?.pressed;    // D-pad Left
            gpDR=!!gp.buttons[15]?.pressed;    // D-pad Right
        }
    }

    /* Rising-edge toggles */
    if(gpPause&&!gpPausePrev) togglePause();
    gpPausePrev=gpPause;
    if(S.mode==='paused') return;
    const flipPressed = gpFlip && !gpFlipPrev;
    if(gpHead&&!gpHeadPrev){ headlightOn=!headlightOn; headlight.visible=headlightOn; }
    gpHeadPrev=gpHead;
    if(flipPressed){ drone.rotation.y+=Math.PI; }
    gpFlipPrev=gpFlip;
    if(gpCamTog&&!gpCamPrev){ camFar=!camFar; }
    gpCamPrev=gpCamTog;
    if(gpDU&&!gpDUpPrev) toggleLockTarget();
    gpDUpPrev=gpDU;
    if(gpDD&&!gpDDownPrev){ if(lockTarget){ lockTarget=null; lockFollow=false; notify('TARGET LOCK CLEARED','kill-note'); } }
    gpDDownPrev=gpDD;
    if(gpDL&&!gpDLeftPrev) cycleLockTarget(-1);
    gpDLeftPrev=gpDL;
    if(gpDR&&!gpDRightPrev){
        if(lockTarget){ lockFollow=!lockFollow; notify(lockFollow?'FOLLOW ASSIST ON':'FOLLOW ASSIST OFF','ring-note'); }
        else cycleLockTarget(1);
    }
    gpDRightPrev=gpDR;

    /* ==================================================================
       REAL DRONE CONTROLLER MAPPING (Mode 2 — most common worldwide)
       ──────────────────────────────────────────────────────────────
       LEFT STICK:   Y-axis = Throttle (up=climb, down=descend)
                     X-axis = Yaw (left=rotate left, right=rotate right)
       RIGHT STICK:  Y-axis = Pitch (up=tilt forward=fly forward)
                     X-axis = Roll (right=tilt right=strafe right)
       Triggers:     RT = Fire, LT = Fine throttle down (analog)
       ================================================================== */

    let moveF=0, moveS=0, yaw=0, vert=0, pitch=0, wantFire=false;

    /* Keyboard input (binary -1/0/+1) */
    if(keys['KeyW']||keys['ArrowUp']) moveF=1;
    if(keys['KeyS']||keys['ArrowDown']) moveF=-1;
    if(keys['KeyA']) moveS=-1;
    if(keys['KeyD']) moveS=1;
    if(keys['KeyQ']||keys['ArrowLeft']) yaw=1;
    if(keys['KeyE']||keys['ArrowRight']) yaw=-1;
    if(keys['Space']) vert=1;
    if(keys['ShiftLeft']||keys['ShiftRight']) vert=-1;
    if(keys['KeyR']) pitch=-1;
    if(keys['KeyV']) pitch=1;
    if(keys['KeyF']||mouseDown) wantFire=true;
    if(keys['KeyB']||keys['ControlLeft']||keys['ControlRight']) gpBrake=true;

    if(isMobileControlsDevice){
        moveF = THREE.MathUtils.clamp(moveF + (-touchInput.moveY), -1, 1);
        moveS = THREE.MathUtils.clamp(moveS + touchInput.moveX, -1, 1);
        yaw = THREE.MathUtils.clamp(yaw + touchInput.lookX, -1, 1);
        if(Math.abs(touchInput.lookY) > 0.08) pitch = THREE.MathUtils.clamp(pitch + (-touchInput.lookY*.55), -1, 1);
        if(touchInput.up) vert = THREE.MathUtils.clamp(vert + 1, -1, 1);
        if(touchInput.down) vert = THREE.MathUtils.clamp(vert - 1, -1, 1);
        if(touchInput.fire) wantFire = true;
        if(touchInput.brake) gpBrake = true;
        if(touchInput.lock && !touchInput.lockPrev) toggleLockTarget();
        touchInput.lockPrev = touchInput.lock;
    }

    /* Gamepad Mode-2 mapping: analog values ADD to keyboard (both sources blend) */
    /* Left stick Y → Throttle (up = climb, inverted axis) */
    vert = THREE.MathUtils.clamp(vert + (-gpLY), -1, 1);
    /* Left stick X → Yaw */
    yaw = THREE.MathUtils.clamp(yaw + (-gpLX), -1, 1);
    /* Right stick Y → Pitch / forward-back tilt (push up = tilt forward = fly forward, inverted) */
    moveF = THREE.MathUtils.clamp(moveF + (-gpRY), -1, 1);
    /* Right stick X → Roll / strafe tilt */
    moveS = THREE.MathUtils.clamp(moveS + gpRX, -1, 1);

    /* LT analog → fine throttle-down (proportional) */
    if(gpLTVal > 0.1) vert = THREE.MathUtils.clamp(vert - gpLTVal*0.8, -1, 1);
    /* LB digital → throttle bump up */
    if(gpUp) vert = THREE.MathUtils.clamp(vert + 0.7, -1, 1);

    if(lockFollow && lockTarget && (enemies.includes(lockTarget) || remoteLockInfo())){
        const toTarget = lockTarget.position.clone().sub(drone.position);
        const distToTarget = toTarget.length();
        if(distToTarget > 6){
            const desiredYaw = Math.atan2(toTarget.x, toTarget.z);
            const yawErr = Math.atan2(Math.sin(desiredYaw-drone.rotation.y), Math.cos(desiredYaw-drone.rotation.y));
            yaw = THREE.MathUtils.clamp(yaw + yawErr*1.2, -1, 1);
            moveF = Math.max(moveF, THREE.MathUtils.clamp(distToTarget/45, 0.25, 1));
            const rightVec = new THREE.Vector3(1,0,0).applyAxisAngle(new THREE.Vector3(0,1,0), drone.rotation.y);
            const lat = rightVec.dot(toTarget.normalize());
            moveS = THREE.MathUtils.clamp(moveS + lat*0.6, -1, 1);
        }
    }

    /* Fire: RB digital or RT analog */
    if(gpFire) wantFire=true;

    /* Boost: A button / Tab / L3 (turbo) */
    const _wasBoosting=S.boosting;
    S.boosting=!!(keys['Tab']||gpBoost||gpL3||touchInput.boost);
    if(S.boosting&&!_wasBoosting&&S.boost>0) sndBoost(true);
    if(!S.boosting&&_wasBoosting) sndBoost(false);
    if(S.boosting&&S.boost>0){S.boost-=28*dt;if(S.boost<=0){S.boost=0;S.boosting=false;sndBoost(false);}}
    else if(!S.boosting) S.boost=Math.min(100,S.boost+14*dt);
    let sm=S.boosting&&S.boost>0?C.boostMult:1;
    if(activePU&&activePU.name==='SPEED BOOST') sm*=1.5;
    const fuelFactor = fuelFalling ? 0 : THREE.MathUtils.clamp(0.35 + WORLD.fuel*0.0065, 0.35, 1);
    sm *= fuelFactor;
    const vp = getVehicleProfile();

    if(wantFire) fire();

    /* ---- SIMULATED FLIGHT CONTROLLER (assisted real-world dynamics) ---- */

    /* 1. Smooth raw inputs */
    const lag = 1.0 / Math.max(C.motorLag, 0.01);
    sInput.fwd  = THREE.MathUtils.lerp(sInput.fwd,  moveF,  1-Math.exp(-lag*dt));
    sInput.side = THREE.MathUtils.lerp(sInput.side, moveS,  1-Math.exp(-lag*dt));
    sInput.yaw  = THREE.MathUtils.lerp(sInput.yaw,  yaw,    1-Math.exp(-lag*dt));
    sInput.vert = THREE.MathUtils.lerp(sInput.vert, vert,   1-Math.exp(-lag*dt));
    sInput.pitch= THREE.MathUtils.lerp(sInput.pitch,pitch,  1-Math.exp(-lag*dt));

    /* 2. Yaw */
    yawVel += sInput.yaw * C.yawAccel * vp.yawMul * dt;
    yawVel *= Math.exp(-C.dragYaw * dt);
    drone.rotation.y += yawVel * dt;

    /* 3. Visual banking/pitch */
    const tiltRespMul = controlCfg.vehicleMode==='helicopter' ? 0.72 : 1.0;
    const tiltMax = C.maxTiltAngle * sm * vp.tiltMul;
    const targetPitch = sInput.fwd * tiltMax;
    const targetRoll  = sInput.side * tiltMax;
    const pitchRate = (Math.abs(moveF) > 0.05 ? C.tiltSpeed : C.tiltReturn) * tiltRespMul;
    const rollRate  = (Math.abs(moveS) > 0.05 ? C.tiltSpeed : C.tiltReturn) * tiltRespMul;
    tiltPitch = THREE.MathUtils.lerp(tiltPitch, targetPitch, 1-Math.exp(-pitchRate*dt));
    tiltRoll  = THREE.MathUtils.lerp(tiltRoll,  targetRoll,  1-Math.exp(-rollRate*dt));
    tiltPitch += sInput.pitch * C.maxTiltAngle * 0.25 * dt;
    tiltPitch = THREE.MathUtils.clamp(tiltPitch, -C.maxTiltAngle*1.1, C.maxTiltAngle*1.1);

    /* 4. Movement (target-velocity model, independent axes) */
    const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), drone.rotation.y);
    const fwd = new THREE.Vector3(0,0,-1).applyQuaternion(yawQ);
    const right = new THREE.Vector3(1,0,0).applyQuaternion(yawQ);

    const desiredDir = new THREE.Vector3();
    desiredDir.addScaledVector(fwd, sInput.fwd);
    desiredDir.addScaledVector(right, sInput.side);
    if(desiredDir.lengthSq() > 1) desiredDir.normalize();

    const altM = Math.max(0, drone.position.y);
    const airDensity = THREE.MathUtils.clamp(1 - altM*0.0009, 0.82, 1);
    WORLD.airDensity = airDensity;
    const maxH = C.maxSpeedH * sm * vp.maxHMul * (0.88 + airDensity*0.12);
    const targetVX = desiredDir.x * maxH;
    const targetVZ = desiredDir.z * maxH;
    const hasHInput = desiredDir.lengthSq() > 0.0005;
    const dvx = targetVX - vel.x;
    const dvz = targetVZ - vel.z;
    const dvm = Math.hypot(dvx, dvz);
    const hStep = (hasHInput ? (dvx * vel.x + dvz * vel.z < 0 ? C.hDecel*vp.hDecelMul : C.hAccel*vp.hAccelMul) : C.hCoast*vp.hCoastMul) * dt;
    if(dvm > hStep && dvm > 0.0001){
        vel.x += (dvx / dvm) * hStep;
        vel.z += (dvz / dvm) * hStep;
    } else {
        vel.x = targetVX;
        vel.z = targetVZ;
    }

    const targetVY = sInput.vert * C.maxSpeedV * sm * vp.maxVMul * airDensity;
    const vRate = (targetVY > vel.y ? C.vAccelUp*vp.vUpMul : (targetVY < vel.y ? C.vAccelDown*vp.vDownMul : C.vStabilize*vp.vStabMul)) * airDensity;
    const vyDelta = targetVY - vel.y;
    const vyStep = vRate * dt;
    if(Math.abs(vyDelta) > vyStep) vel.y += Math.sign(vyDelta) * vyStep;
    else vel.y = targetVY;

    if(drone.position.y < C.groundEffectH && sInput.vert > -0.1){
        const geFrac = 1.0 - drone.position.y / C.groundEffectH;
        vel.y += C.groundEffectMult * 1.2 * geFrac * dt;
    }

    const hSpd=Math.sqrt(vel.x*vel.x+vel.z*vel.z);
    const tiltMag = Math.sqrt(tiltPitch*tiltPitch + tiltRoll*tiltRoll);
    const targetThrottle = C.hoverThrottle + tiltMag*0.35 + Math.abs(sInput.vert)*0.35 + (hSpd/Math.max(C.maxSpeedH,1))*0.25;
    throttle = THREE.MathUtils.lerp(throttle, Math.min(1.0, targetThrottle), 1-Math.exp(-8*dt));
    const distFromBase = Math.hypot(drone.position.x, drone.position.z);
    const lowAltLoss = drone.position.y < 12 ? (12-drone.position.y)*0.7 : 0;
    WORLD.signal = THREE.MathUtils.clamp(100 + getPersonaCfg().signalBonus - distFromBase*0.13 - lowAltLoss - WORLD.turbulence*5, 0, 100);
    WORLD.gps = WORLD.signal<18 ? 'NO FIX' : (WORLD.signal<45 ? '2D' : '3D');
    WORLD.batteryV = THREE.MathUtils.clamp(18.6 + (WORLD.fuel/100)*6.6 - throttle*0.55 - (S.boosting?0.45:0), 18.0, 25.2);
    if(!fuelFalling){
        WORLD.fuel = Math.max(0, WORLD.fuel - dt*(0.18 + throttle*0.95 + (S.boosting?1.2:0) + (controlCfg.vehicleMode==='helicopter'?0.22:0))*getPersonaCfg().fuelMul);
    }
    /* Fuel warning system */
    if(WORLD.fuel<25 && WORLD.fuel>0){
        if(!fuelWarned){fuelWarned=true; notify('LOW FUEL WARNING','kill-note');setTimeout(()=>radioSpeak('lowFuel'),400);}
        $fuelOverlay.classList.add('active');
        $fuelOverlay.classList.remove('critical');
        $fuelWarnText.textContent='LOW FUEL';
        $fuelWarnText.classList.add('show');
    } else if(WORLD.fuel<=0 && !fuelFalling){
        if(!fuelEmpty){
            fuelEmpty=true;
            fuelCountdown=5;
            $fuelOverlay.classList.remove('active');
            $fuelOverlay.classList.add('critical');
            $fuelWarnText.textContent='ENGINE FAILURE';
            $fuelWarnText.classList.add('show');
            notify('FUEL DEPLETED — ENGINE SHUTDOWN IN 5','kill-note');
            setTimeout(()=>radioSpeak('lowFuel'),200);
        }
        if(fuelCountdown>0){
            fuelCountdown -= dt;
            const sec = Math.ceil(fuelCountdown);
            $fuelCountdownEl.textContent = sec > 0 ? sec : '0';
            $fuelCountdownEl.classList.add('show');
            if(sec<=0){
                fuelFalling=true;
                $fuelCountdownEl.textContent='ENGINE OUT';
                notify('ENGINE SHUTDOWN — GOING DOWN','kill-note');
            }
        }
    }
    if(WORLD.fuel>=25){
        fuelWarned=false; fuelEmpty=false; fuelCountdown=-1;
        $fuelOverlay.classList.remove('active','critical');
        $fuelCountdownEl.classList.remove('show');
        $fuelWarnText.classList.remove('show');
    }
    /* Drone falls when fuel is gone */
    if(fuelFalling){
        vel.x *= Math.exp(-0.5*dt); vel.z *= Math.exp(-0.5*dt);
        vel.y += C.gravity * dt;
        tiltPitch += (Math.random()-0.5)*0.4*dt;
        tiltRoll += (Math.random()-0.5)*0.4*dt;
        if(drone.position.y <= 0.5){
            drone.position.y = 0.5;
            $fuelCountdownEl.classList.remove('show');
            $fuelWarnText.classList.remove('show');
            $fuelOverlay.classList.remove('active','critical');
            gameOver();
        }
    }

    const gust = 0.55 + Math.sin(performance.now()*0.00023)*0.45 + Math.sin(performance.now()*0.00091 + drone.position.x*.02)*0.18;
    WORLD.gust = gust;
    WORLD.turbulence = THREE.MathUtils.clamp((WORLD.windSpeed/8) * (0.35 + Math.abs(gust-0.55)), 0, 1.4);
    const windPush = WORLD.windSpeed * gust * 0.6;
    vel.x += Math.cos(WORLD.windDir) * windPush * dt;
    vel.z += Math.sin(WORLD.windDir) * windPush * dt;
    if(!fuelFalling && WORLD.turbulence>0.15){
        const turb = WORLD.turbulence * dt;
        vel.x += (Math.random()-0.5) * turb * 1.8;
        vel.y += (Math.random()-0.5) * turb * 0.9;
        vel.z += (Math.random()-0.5) * turb * 1.8;
        tiltPitch += (Math.random()-0.5) * turb * 0.08;
        tiltRoll += (Math.random()-0.5) * turb * 0.08;
    }
    const settling = !fuelFalling && vel.y < -4.5 && hSpd < 7 && throttle > 0.55;
    if(settling){
        vel.y -= (0.8 + Math.abs(vel.y)*0.08) * dt;
        WORLD.warning = 'SETTLING WITH POWER';
    } else if(WORLD.signal<25){
        WORLD.warning = 'DATA LINK LOST';
    } else if(WORLD.turbulence>0.85){
        WORLD.warning = 'TURBULENCE';
    } else if(WORLD.batteryV<21.5){
        WORLD.warning = 'LOW BATTERY VOLTAGE';
    } else {
        WORLD.warning = '';
    }

    /* 9. Brake: heavy drag (emergency stop feel) */
    if(gpBrake){
        vel.x *= Math.exp(-C.brakeDrag*dt); vel.z *= Math.exp(-C.brakeDrag*dt); vel.y *= Math.exp(-4*dt);
        tiltPitch *= Math.exp(-6*dt); tiltRoll *= Math.exp(-6*dt);
    }

    /* 10. Speed caps */
    const hSpdNow=Math.hypot(vel.x,vel.z);
    if(hSpdNow>maxH){const s=maxH/hSpdNow; vel.x*=s; vel.z*=s;}
    vel.y=THREE.MathUtils.clamp(vel.y,-C.maxSpeedV*airDensity,C.maxSpeedV*airDensity);

    /* 11. 180 flip: reverse horizontal velocity */
    if(flipPressed){ vel.x*=-0.3; vel.z*=-0.3; tiltPitch*=-1; }

    /* 12. Integrate position (with building pre-check to prevent tunneling) */
    {
        const stepX = vel.x*dt, stepY = vel.y*dt, stepZ = vel.z*dt;
        const nx = drone.position.x+stepX, ny = drone.position.y+stepY, nz = drone.position.z+stepZ;
        const pr = 1.8;
        let blocked = false;
        const nearby = getNearbyBuildings(nx, nz);
        const impactSpeed = vel.length();
        for(const b of nearby){
            const bb = b.bbox;
            const cx = THREE.MathUtils.clamp(nx, bb.min.x, bb.max.x);
            const cy = THREE.MathUtils.clamp(ny, bb.min.y, bb.max.y);
            const cz = THREE.MathUtils.clamp(nz, bb.min.z, bb.max.z);
            const dx2 = (nx-cx)*(nx-cx)+(ny-cy)*(ny-cy)+(nz-cz)*(nz-cz);
            if(dx2 < pr*pr){
                blocked = true;
                vel.multiplyScalar(-0.3);
                const now = performance.now();
                if(S.invTimer<=0 && now-lastImpactAt>450){
                    lastImpactAt = now;
                    takeDmg(Math.max(6, Math.round(impactSpeed*0.45)));
                    sndImpact(); shake(Math.min(2.5, impactSpeed*.05), .18);
                }
                break;
            }
        }
        if(!blocked) drone.position.addScaledVector(vel, dt);
    }

    const curSpeed=Math.hypot(vel.x,vel.z);

    /* 13. Boundaries (soft bounce with energy loss) */
    const hf=C.citySize/2+60;
    if(drone.position.x>hf){drone.position.x=hf;vel.x=-Math.abs(vel.x)*0.25;}
    if(drone.position.x<-hf){drone.position.x=-hf;vel.x=Math.abs(vel.x)*0.25;}
    if(drone.position.z>hf){drone.position.z=hf;vel.z=-Math.abs(vel.z)*0.25;}
    if(drone.position.z<-hf){drone.position.z=-hf;vel.z=Math.abs(vel.z)*0.25;}
    /* Ground collision: realistic -- hard landing damages */
    if(drone.position.y<1.2){
        drone.position.y=1.2;
        if(vel.y<-5 && S.invTimer<=0){takeDmg(Math.round(-vel.y*0.8));vib(200,.6,.8);}
        else if(vel.y<-2){vib(60,.2,.3);} /* light bump */
        vel.y=Math.max(0,vel.y*-0.15); /* tiny bounce */
    }
    if(drone.position.y>160){drone.position.y=160;vel.y=Math.min(0,vel.y);}

    /* 14. Visual tilt matches physics tilt (they ARE the same now) */
    drone.rotation.z = THREE.MathUtils.lerp(drone.rotation.z, (-tiltRoll*vp.rollVisualMul) - yawVel*0.18, 8*dt);
    droneVis.rotation.x = THREE.MathUtils.lerp(droneVis.rotation.x, -tiltPitch*vp.pitchVisualMul, 8*dt);
    heliVis.rotation.x = THREE.MathUtils.lerp(heliVis.rotation.x, -tiltPitch*0.35, 6*dt);
    heliVis.rotation.z = THREE.MathUtils.lerp(heliVis.rotation.z, -tiltRoll*0.45, 6*dt);

    /* 15. Spin rotor discs (RPM scales with throttle and speed) */
    const rotSpd = (12 + throttle*25 + curSpeed*0.1) * vp.rotorMul;
    rotorDiscs.forEach(d=>{d.rotation.z+=rotSpd*dt;});
    if(heliRotors.length){
        heliRotors[0].rotation.y += rotSpd*1.4*dt;
        heliRotors[1].rotation.y += rotSpd*1.4*dt;
        heliRotors[2].rotation.z += rotSpd*1.8*dt;
    }

    /* Blinking navigation lights */
    const bT=performance.now();
    const navBlink=Math.sin(bT*.005)>0;
    const strobeBlink=Math.sin(bT*.025)>0.85;
    const tailBlink=Math.sin(bT*.008)>0.3;
    navLightL.visible=navBlink; navPtL.visible=navBlink;
    navLightR.visible=navBlink; navPtR.visible=navBlink;
    strobeTop.visible=strobeBlink; strobeBtm.visible=strobeBlink; strobePt.visible=strobeBlink;
    tailLight.visible=tailBlink;

    S.dist+=prevPos.distanceTo(drone.position);
    addScore(Math.round(prevPos.distanceTo(drone.position)*.4));
    prevPos.copy(drone.position);

    /* Chase camera (toggleable distance) */
    const heliCam = controlCfg.vehicleMode==='helicopter';
    const camD=(camFar||lockFollow)?30:(heliCam?20:17), camH=(camFar||lockFollow)?11:(heliCam?7.2:5.5);
    const camOff=new THREE.Vector3(0,camH,camD).applyQuaternion(drone.quaternion);
    const idealCam=drone.position.clone().add(camOff);
    camera.position.lerp(idealCam, camFar?.05:.07);
    if(shakeD>0){shakeD-=dt;camera.position.x+=(Math.random()-.5)*shakeI;camera.position.y+=(Math.random()-.5)*shakeI*.6;}
    // R3 snaps camera instantly behind drone
    if(gpR3){camera.position.copy(idealCam);}
    if(lockTarget && (enemies.includes(lockTarget) || remoteLockInfo())){
        const look = lockFollow ? lockTarget.position : drone.position.clone().lerp(lockTarget.position, 0.35);
        camera.lookAt(look);
    } else {
        camera.lookAt(drone.position);
    }

    /* Sky/clouds/stars recentre on the drone and the shadow frustum tracks it. */
    atmo.update(dt, drone.position);

    updEnemies(dt); updBullets(dt); updEBullets(dt); updBooms(dt); updRings(dt); updOrbs(dt);
    updTraffic(dt); updPowerUps(dt); updTrail(dt); updateRemotePilots(dt); trackOnlineState().catch(()=>{});
    updParticles(dt); updRadio(dt); updSmoke(dt);
    droneCollisions();
    updEngine(curSpeed, fuelFalling ? 0 : throttle*2);

    /* Muzzle flash fade */
    mfL.material.opacity*=0.7; mfR.material.opacity*=0.7;

    /* Flickering neon signs */
    const ft=performance.now()*.001;
    for(const ns of neonSigns){
        const flicker=Math.sin(ft*ns.rate+ns.phase)*Math.sin(ft*ns.rate*2.7+ns.phase);
        ns.mat.opacity=ns.base*(flicker>-.3?1:.1+Math.random()*.3);
    }

    /* Boost speed overlay */
    boostLines.style.opacity=S.boosting&&S.boost>0?'1':'0';

    updHUD(curSpeed,dt); updMinimap();
    postfx.setDamage(Math.max(0, 1 - S.hp/C.maxHP) * 0.75);
    renderer.info.reset();
    postfx.render(dt);
    updatePerf(dt);
    }catch(e){console.warn('Frame error:',e);}
}

animate(); showScreen('menu');
/* Tells the boot watchdog in game.html that the module resolved and ran. */
window.__simBooted = true;
window.addEventListener('resize',()=>{
    camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();
    renderer.setSize(innerWidth,innerHeight);
    postfx.setSize(innerWidth,innerHeight);
});
