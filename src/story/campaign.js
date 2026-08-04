/*
 * Campaign: "OPERATION ANDROMEDA"
 *
 * A seven-sortie story arc flown over Andromeda Harbor. This module owns the
 * narrative data and a small objective state machine; it deliberately knows
 * nothing about Three.js. The simulator feeds it a context snapshot each frame
 * and reacts to the events it returns.
 */

/*
 * The people you fly for. Every sortie is launched by a named handler who
 * briefs you at the pad and talks to you in the air, so the campaign has a
 * voice rather than an anonymous objective list.
 */
export const CHARACTERS = {
    'ANVIL TOC': {
        id: 'voss',
        name: 'Maj. Elena Voss',
        role: 'Mission Handler — FOB ANVIL',
        callsign: 'ANVIL TOC',
        /* Initials drive the procedural portrait plate. */
        initials: 'EV',
        tint: '#63ff9c',
        bio: 'Twelve years running ISR desks. Calm on the net, blunt in the debrief. She launched you and she intends to get you back.',
    },
    'TALON ACTUAL': {
        id: 'reyes',
        name: 'Col. Marcus Reyes',
        role: 'Task Force Commander — TALON',
        callsign: 'TALON ACTUAL',
        initials: 'MR',
        tint: '#ffb84d',
        bio: 'Took over the net when the storm dropped the relay mast. Talks in objectives, not reassurance. If he is on your frequency, it has gone badly.',
    },
};

export function handlerFor(mission) {
    return CHARACTERS[mission?.controller] || CHARACTERS['ANVIL TOC'];
}

/* Normalised map coordinates (-0.5..0.5 of city size) so mission geography
 * follows CITY_MAP if the city is ever resized. */
export const STORY_LOCATIONS = {
    base:        { x: -0.38, z: 0.34,  label: 'FOB ANVIL' },
    downtown:    { x: -0.16, z: -0.02, label: 'Downtown Core' },
    riverfront:  { x: 0.18,  z: -0.24, label: 'Riverfront District' },
    industrial:  { x: 0.34,  z: 0.22,  label: 'Industrial Yard' },
    bridge:      { x: 0.09,  z: -0.18, label: 'Central River Bridge' },
    harborYard:  { x: 0.28,  z: 0.44,  label: 'Harbor Yard' },
    airstrip:    { x: -0.36, z: 0.38,  label: 'Forward Airstrip' },
};

/*
 * Objective grammar
 * -----------------
 *  kills   { count }               destroy N hostiles
 *  wp      { count }               fly through N waypoint rings
 *  hold    { seconds, at?, radius? } loiter, optionally inside a zone
 *  reach   { at, radius, alt? }    arrive at a location (optional altitude gate)
 *  scan    { at, radius, seconds } hold inside a zone with sensors on target
 *  survive { seconds }             stay alive under pressure
 *  rtb     { at, radius, alt }     return to base and descend to land
 *
 * `fail` conditions are evaluated continuously:
 *  hullBelow, timeLimit, fuelBelow
 */

export const CAMPAIGN = [
    {
        id: 'act1-first-light',
        act: 'ACT I — FIRST LIGHT',
        no: 1,
        name: 'First Light',
        time: 'dawn',
        controller: 'ANVIL TOC',
        enemies: 0,
        synopsis: 'Andromeda Harbor went dark eleven hours ago. You are the first airframe back over the grid.',
        briefing: [
            'Harbor authority lost the grid at 04:12 local. Civil traffic is stranded, the port is unlit, and nobody on the ground is answering.',
            'You are flying an unarmed ISR profile out of FOB ANVIL. Nothing on this sortie is hostile — yet.',
            'Get airborne, run the river line, and give me pictures of the Downtown Core.',
        ],
        objectives: [
            { type: 'reach', at: 'downtown', radius: 70, alt: 25, text: 'Transit to Downtown Core', radio: 'ANVIL TOC, {CALL} is off the deck. Running the river line.' },
            { type: 'wp',    count: 5,  text: 'Fly the survey route — 5 waypoints', radio: '{CALL}, follow the marked survey corridor. Photograph everything.' },
            { type: 'scan',  at: 'riverfront', radius: 80, seconds: 18, text: 'Hold over Riverfront and scan', radio: 'Hold station over the Riverfront. I want eighteen seconds of clean sensor.' },
        ],
        fail: { fuelBelow: 0 },
        debrief: 'Sensor take confirms the substations are intact. Somebody switched this city off deliberately.',
        unlockText: 'ACT I complete — the grid was cut, not broken.',
    },
    {
        id: 'act1-ghost-signal',
        act: 'ACT I — FIRST LIGHT',
        no: 2,
        name: 'Ghost Signal',
        time: 'golden',
        controller: 'ANVIL TOC',
        enemies: 3,
        synopsis: 'A repeating carrier wave is coming off the Industrial Yard. It is not one of ours.',
        briefing: [
            'Signals picked up a narrowband repeater in the Industrial Yard broadcasting on our own ISR band.',
            'Weapons are hot as of this sortie. Expect light drone presence — assume anything airborne that is not you is hostile.',
            'Find the source, then clear the airspace around it.',
        ],
        objectives: [
            { type: 'reach', at: 'industrial', radius: 75, text: 'Locate the repeater — Industrial Yard', radio: '{CALL}, vector zero-six-five for the Industrial Yard. Weapons free.' },
            { type: 'kills', count: 3, text: 'Destroy the escorting drones (3)', radio: 'Contact! Three rotary contacts lifting off the yard. Engage.' },
            { type: 'hold',  at: 'industrial', radius: 90, seconds: 15, text: 'Secure the site for 15s', radio: 'Good kills. Hold overhead while I dump the signal capture.' },
        ],
        fail: { hullBelow: 0, fuelBelow: 0 },
        debrief: 'The repeater was rebroadcasting our own sensor feeds. Someone has been watching the watchers.',
        unlockText: 'The swarm knows our frequencies.',
    },
    {
        id: 'act2-cut-the-bridge',
        act: 'ACT II — THE SWARM',
        no: 3,
        name: 'Cut The Bridge',
        time: 'dusk',
        controller: 'ANVIL TOC',
        enemies: 6,
        synopsis: 'Hostile rotary elements are massing to cross the Central River Bridge.',
        briefing: [
            'The swarm is using the Central River Bridge as a corridor between the north and south grid.',
            'Six-plus contacts, they fight in pairs and they will bracket you if you stay predictable.',
            'Break up the crossing. Do not let the hull go below a quarter — there is no recovery aircraft tonight.',
        ],
        objectives: [
            { type: 'reach', at: 'bridge', radius: 65, text: 'Push to the Central River Bridge', radio: '{CALL}, the bridge corridor is your target. Stay low, use the span for cover.' },
            { type: 'kills', count: 6, text: 'Destroy the crossing element (6)', radio: 'They see you. Multiple contacts converging — fight your fight.' },
            { type: 'survive', seconds: 25, text: 'Survive the counter-attack — 25s', radio: 'Second wave inbound! Keep moving, do not hover!' },
        ],
        fail: { hullBelow: 0, timeLimit: 420 },
        debrief: 'Bridge corridor denied. Their airframes are commercial hulls with military seekers bolted on.',
        unlockText: 'ACT II — someone is arming civilian drones at scale.',
    },
    {
        id: 'act2-blackout-run',
        act: 'ACT II — THE SWARM',
        no: 4,
        name: 'Blackout Run',
        time: 'night',
        controller: 'ANVIL TOC',
        enemies: 5,
        synopsis: 'Night infiltration of the Harbor Yard. Sensors only. They are listening for your transmitter.',
        briefing: [
            'Full dark. The harbor cranes are still standing and we think the yard is their forward staging point.',
            'You will be flying on passive sensors — expect degraded contrast and short detection ranges.',
            'Get in, tag the yard, and get out. Hull integrity matters more than kill count on this one.',
        ],
        objectives: [
            { type: 'reach', at: 'harborYard', radius: 80, text: 'Infiltrate the Harbor Yard', radio: '{CALL}, running dark. Keep it under the rooftops.' },
            { type: 'scan',  at: 'harborYard', radius: 95, seconds: 22, text: 'Tag the staging area — 22s on station', radio: 'Sensor on the yard. Twenty-two seconds. Do not drift.' },
            { type: 'kills', count: 5, text: 'Break contact — destroy pursuers (5)', radio: 'You are burned! They launched on your position — fight clear!' },
        ],
        fail: { hullBelow: 0, timeLimit: 480 },
        debrief: 'The yard is a factory. They are not importing airframes, they are building them.',
        unlockText: 'The swarm is self-replicating.',
    },
    {
        id: 'act3-hornets-nest',
        act: 'ACT III — ANDROMEDA',
        no: 5,
        name: "Hornet's Nest",
        time: 'storm',
        controller: 'TALON ACTUAL',
        enemies: 8,
        synopsis: 'Weather is closing. Command wants the Downtown Core swept before the front arrives.',
        briefing: [
            'This is TALON ACTUAL. Your regular controller is off station — the storm took the relay mast.',
            'Downtown is thick with them. Eight confirmed, likely more. Turbulence will fight your stick the whole way.',
            'Sweep the core. Then hold it. That is the whole mission.',
        ],
        objectives: [
            { type: 'kills', count: 8, text: 'Sweep the Downtown Core (8 kills)', radio: '{CALL}, TALON ACTUAL. Downtown is yours. Clear it.' },
            { type: 'hold',  at: 'downtown', radius: 110, seconds: 30, text: 'Hold the core for 30s', radio: 'Core is thinning. Hold overhead — I need thirty seconds of air superiority.' },
            { type: 'wp',    count: 6, text: 'Re-mark the corridor — 6 waypoints', radio: 'Re-mark the transit corridor before the front closes it.' },
        ],
        fail: { hullBelow: 0, timeLimit: 540 },
        debrief: 'Core is held. In the storm noise we finally isolated their uplink — it comes from the airstrip.',
        unlockText: 'ACT III — the uplink is at our own forward airstrip.',
    },
    {
        id: 'act3-the-handler',
        act: 'ACT III — ANDROMEDA',
        no: 6,
        name: 'The Handler',
        time: 'dusk',
        controller: 'TALON ACTUAL',
        enemies: 9,
        synopsis: 'The swarm is being flown from inside our own perimeter.',
        briefing: [
            'The uplink is transmitting from the Forward Airstrip. Our airstrip. That means the handler is one of ours.',
            'Nine airframes are orbiting the strip as a screen. They will defend it harder than anything you have flown against.',
            'Cut the screen, hold the strip, and we will take the handler alive.',
        ],
        objectives: [
            { type: 'reach', at: 'airstrip', radius: 70, text: 'Approach the Forward Airstrip', radio: '{CALL}, this is going to be ugly. The strip is defended.' },
            { type: 'kills', count: 9, text: 'Destroy the defensive screen (9)', radio: 'The whole screen just turned on you. Break and engage!' },
            { type: 'hold',  at: 'airstrip', radius: 85, seconds: 25, text: 'Hold the strip for the ground team', radio: 'Ground team is two minutes out. Hold that strip.' },
        ],
        fail: { hullBelow: 0, timeLimit: 600 },
        debrief: 'Ground team has the handler. The uplink hardware was installed during a scheduled maintenance window.',
        unlockText: 'It was an inside job from the first day.',
    },
    {
        id: 'act3-last-light',
        act: 'ACT III — ANDROMEDA',
        no: 7,
        name: 'Last Light',
        time: 'dawn',
        controller: 'TALON ACTUAL',
        enemies: 10,
        synopsis: 'The swarm has gone autonomous. Kill the remaining airframes and bring the aircraft home.',
        briefing: [
            'With the handler in custody the swarm fell back on its autonomous profile. It is now attacking everything.',
            'Ten airframes still flying. No coordination, no mercy, and no fuel discipline — they will burn themselves out, but not before the city does.',
            'End it. Then bring my aircraft home to ANVIL and put it on the deck.',
        ],
        objectives: [
            { type: 'kills', count: 10, text: 'Destroy the remaining swarm (10)', radio: '{CALL}, last light. Ten airframes. Finish this.' },
            { type: 'survive', seconds: 20, text: 'Weather the final surge — 20s', radio: 'They are all converging on you. Twenty seconds — hold together!' },
            { type: 'rtb', at: 'base', radius: 70, alt: 14, text: 'Return to FOB ANVIL and descend below 14m', radio: 'Airspace is clear. {CALL}, come home. Bring her down gently.' },
        ],
        fail: { hullBelow: 0, timeLimit: 660 },
        debrief: 'Andromeda Harbor is quiet. The lights came back on at 06:40. You were the last aircraft airborne.',
        unlockText: 'OPERATION ANDROMEDA — COMPLETE',
    },
];

export function missionById(id) {
    return CAMPAIGN.find(m => m.id === id) || null;
}

export function missionIndex(id) {
    return CAMPAIGN.findIndex(m => m.id === id);
}

/**
 * Objective state machine.
 *
 * The director is fed a context each frame:
 *   { kills, waypoints, hp, maxHp, fuel, missionSec, pos:{x,y,z}, worldScale }
 * `worldScale` converts normalised STORY_LOCATIONS into world units.
 *
 * Returns an array of events, each { type, ... }:
 *   objective-start, objective-progress, objective-complete,
 *   mission-complete, mission-failed
 */
export class MissionDirector {
    constructor(mission, worldScale) {
        this.mission = mission;
        this.worldScale = worldScale;
        this.reset();
    }

    reset() {
        this.index = 0;
        this.timer = 0;
        this.elapsed = 0;
        this.done = false;
        this.failed = false;
        this.started = false;
        /* Counters are captured as offsets so an objective asking for "5 kills"
         * means five *more* kills, not five since the sortie began. */
        this.baseKills = 0;
        this.baseWaypoints = 0;
        this.lastProgress = -1;
    }

    get objective() {
        return this.mission.objectives[this.index] || null;
    }

    /** World-space position for an objective's location key, or null. */
    locationOf(objective) {
        if (!objective?.at) return null;
        const loc = STORY_LOCATIONS[objective.at];
        if (!loc) return null;
        return { x: loc.x * this.worldScale, z: loc.z * this.worldScale, label: loc.label };
    }

    /** 0..1 completion of the current objective, or null when not measurable. */
    progressOf(ctx) {
        const o = this.objective;
        if (!o) return null;
        switch (o.type) {
            case 'kills':   return Math.min(1, (ctx.kills - this.baseKills) / o.count);
            case 'wp':      return Math.min(1, (ctx.waypoints - this.baseWaypoints) / o.count);
            case 'hold':
            case 'scan':    return Math.min(1, this.timer / o.seconds);
            case 'survive': return Math.min(1, this.timer / o.seconds);
            default:        return null;
        }
    }

    /** Human-readable status suffix for the HUD objective line. */
    statusOf(ctx) {
        const o = this.objective;
        if (!o) return '';
        switch (o.type) {
            case 'kills':   return `${Math.min(o.count, ctx.kills - this.baseKills)}/${o.count}`;
            case 'wp':      return `${Math.min(o.count, ctx.waypoints - this.baseWaypoints)}/${o.count}`;
            case 'hold':
            case 'scan':
            case 'survive': return `${Math.max(0, Math.ceil(o.seconds - this.timer))}s`;
            case 'reach':
            case 'rtb': {
                const loc = this.locationOf(o);
                if (!loc) return '';
                const d = Math.hypot(ctx.pos.x - loc.x, ctx.pos.z - loc.z);
                return `${Math.round(d)}m`;
            }
            default: return '';
        }
    }

    inZone(ctx, o) {
        const loc = this.locationOf(o);
        if (!loc) return true;
        const d = Math.hypot(ctx.pos.x - loc.x, ctx.pos.z - loc.z);
        return d <= (o.radius ?? 80);
    }

    beginObjective(events) {
        const o = this.objective;
        if (!o) return;
        this.timer = 0;
        this.lastProgress = -1;
        events.push({ type: 'objective-start', objective: o, index: this.index, location: this.locationOf(o) });
    }

    /**
     * @param {number} dt seconds
     * @param {object} ctx see class docs
     * @returns {Array<object>} events
     */
    update(dt, ctx) {
        const events = [];
        if (this.done || this.failed) return events;

        if (!this.started) {
            this.started = true;
            this.baseKills = ctx.kills;
            this.baseWaypoints = ctx.waypoints;
            this.beginObjective(events);
        }

        this.elapsed += dt;

        /* ---- failure checks ---- */
        const f = this.mission.fail || {};
        if (f.hullBelow !== undefined && ctx.hp <= f.hullBelow) {
            this.failed = true;
            events.push({ type: 'mission-failed', reason: 'AIRFRAME LOST' });
            return events;
        }
        if (f.timeLimit !== undefined && this.elapsed >= f.timeLimit) {
            this.failed = true;
            events.push({ type: 'mission-failed', reason: 'MISSION WINDOW EXPIRED' });
            return events;
        }
        if (f.fuelBelow !== undefined && ctx.fuel <= f.fuelBelow) {
            this.failed = true;
            events.push({ type: 'mission-failed', reason: 'FUEL EXHAUSTED' });
            return events;
        }

        const o = this.objective;
        if (!o) return events;

        /* ---- progress ---- */
        let complete = false;
        switch (o.type) {
            case 'kills':
                complete = (ctx.kills - this.baseKills) >= o.count;
                break;
            case 'wp':
                complete = (ctx.waypoints - this.baseWaypoints) >= o.count;
                break;
            case 'survive':
                this.timer += dt;
                complete = this.timer >= o.seconds;
                break;
            case 'hold':
            case 'scan':
                /* The clock only runs inside the zone, and drains when outside so
                 * drifting off station has a cost without resetting outright. */
                if (this.inZone(ctx, o)) this.timer += dt;
                else this.timer = Math.max(0, this.timer - dt * 0.6);
                complete = this.timer >= o.seconds;
                break;
            case 'reach':
                complete = this.inZone(ctx, o) && (o.alt === undefined || ctx.pos.y >= o.alt);
                break;
            case 'rtb':
                complete = this.inZone(ctx, o) && ctx.pos.y <= (o.alt ?? 15);
                break;
            default:
                complete = true;
        }

        const p = this.progressOf(ctx);
        if (p !== null && Math.abs(p - this.lastProgress) > 0.001) {
            this.lastProgress = p;
            events.push({ type: 'objective-progress', objective: o, progress: p, status: this.statusOf(ctx) });
        }

        if (complete) {
            events.push({ type: 'objective-complete', objective: o, index: this.index });
            this.index++;
            if (this.index >= this.mission.objectives.length) {
                this.done = true;
                events.push({ type: 'mission-complete', mission: this.mission });
            } else {
                /* Re-baseline counters for the next objective. */
                this.baseKills = ctx.kills;
                this.baseWaypoints = ctx.waypoints;
                this.beginObjective(events);
            }
        }

        return events;
    }
}

/* ---- progress persistence ------------------------------------------- */

export function defaultProgress() {
    return { completed: [], current: CAMPAIGN[0].id, bestScores: {} };
}

export function normalizeProgress(raw) {
    const p = defaultProgress();
    if (!raw || typeof raw !== 'object') return p;
    if (Array.isArray(raw.completed)) {
        p.completed = raw.completed.filter(id => CAMPAIGN.some(m => m.id === id));
    }
    if (raw.bestScores && typeof raw.bestScores === 'object') p.bestScores = { ...raw.bestScores };
    /* Current mission is the first not-yet-completed sortie. */
    const next = CAMPAIGN.find(m => !p.completed.includes(m.id));
    p.current = raw.current && CAMPAIGN.some(m => m.id === raw.current) && !p.completed.includes(raw.current)
        ? raw.current
        : (next ? next.id : CAMPAIGN[CAMPAIGN.length - 1].id);
    return p;
}

export function isUnlocked(progress, missionId) {
    const idx = missionIndex(missionId);
    if (idx <= 0) return true;
    /* A mission unlocks once the one before it is complete. */
    return progress.completed.includes(CAMPAIGN[idx - 1].id);
}

export function markComplete(progress, missionId, score) {
    const p = normalizeProgress(progress);
    if (!p.completed.includes(missionId)) p.completed.push(missionId);
    if (score !== undefined) {
        p.bestScores[missionId] = Math.max(p.bestScores[missionId] || 0, Math.round(score));
    }
    const next = CAMPAIGN.find(m => !p.completed.includes(m.id));
    p.current = next ? next.id : CAMPAIGN[CAMPAIGN.length - 1].id;
    return p;
}
