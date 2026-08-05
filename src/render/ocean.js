/* Ocean, coastline and the things that live on them.
 *
 * The city sits on an island. Land is a noisy disc so the coast never reads as
 * a square, the ocean is one large plane that follows the camera so it always
 * reaches the horizon, and a foam ring marks the waterline.
 *
 * Waves are displaced in the vertex shader via onBeforeCompile rather than by
 * touching geometry from JS each frame — the grid is 128x128, which is 16k
 * vertices we are not going to move on the main thread every frame on a phone.
 */
import * as THREE from 'three';

/* Water tint per time of day, keyed to match TIME_PRESETS in atmosphere.js. */
const WATER_TINTS = {
    dawn:   { shallow: 0x25506b, deep: 0x0b2136, foam: 0xbcd2de, sun: 0.45 },
    golden: { shallow: 0x2f5b6d, deep: 0x102636, foam: 0xd8c4a8, sun: 0.75 },
    noon:   { shallow: 0x2c6f92, deep: 0x0d2c4a, foam: 0xffffff, sun: 0.9 },
    dusk:   { shallow: 0x2a4257, deep: 0x0c1b2b, foam: 0xc0b0ba, sun: 0.5 },
    night:  { shallow: 0x0d1b2a, deep: 0x050b13, foam: 0x5d7183, sun: 0.15 },
    storm:  { shallow: 0x1f3540, deep: 0x0a161d, foam: 0x9aa8ae, sun: 0.2 },
};

const LAND_RADIUS = 780;      /* city half-extent is 250, so there is real shore */
const OCEAN_SIZE = 9000;

function noisyDisc(radius, segments) {
    const geo = new THREE.CircleGeometry(radius, segments);
    const pos = geo.attributes.position;
    /* Skip vertex 0 — CircleGeometry puts the centre there and pushing it would
     * tear the fan. */
    for (let i = 1; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getY(i);
        const a = Math.atan2(z, x);
        const wobble =
            Math.sin(a * 3.0) * 26 +
            Math.sin(a * 7.3 + 1.7) * 14 +
            Math.sin(a * 13.1 + 0.4) * 7;
        const r = radius + wobble;
        const len = Math.hypot(x, z) || 1;
        pos.setXY(i, (x / len) * r, (z / len) * r);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
}

function sparkleTexture() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#808080';
    cx.fillRect(0, 0, 256, 256);
    /* Soft blobs read as swell once tiled and scrolled; hard noise reads as dirt. */
    for (let i = 0; i < 90; i++) {
        const x = Math.random() * 256, y = Math.random() * 256;
        const r = 6 + Math.random() * 26;
        const g = cx.createRadialGradient(x, y, 0, x, y, r);
        const bright = Math.random() > 0.5;
        g.addColorStop(0, bright ? 'rgba(255,255,255,.30)' : 'rgba(0,0,0,.22)');
        g.addColorStop(1, 'rgba(128,128,128,0)');
        cx.fillStyle = g;
        cx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
}

export function createOcean(scene, opts = {}) {
    const quality = opts.quality === 'low' ? 'low' : 'high';
    const segs = quality === 'low' ? 64 : 128;
    const tint = WATER_TINTS[opts.timeOfDay] || WATER_TINTS.dusk;

    const group = new THREE.Group();
    scene.add(group);

    /* ---- ocean ---- */
    const waterMat = new THREE.MeshStandardMaterial({
        color: tint.shallow,
        roughness: 0.22,
        metalness: 0.55,
    });

    const detail = sparkleTexture();
    detail.repeat.set(60, 60);
    waterMat.roughnessMap = detail;

    const uniforms = {
        uTime:    { value: 0 },
        uWave:    { value: opts.waveHeight ?? 1.0 },
        uDeep:    { value: new THREE.Color(tint.deep) },
        uShallow: { value: new THREE.Color(tint.shallow) },
        uFoam:    { value: new THREE.Color(tint.foam) },
        uSky:     { value: new THREE.Color(tint.shallow).multiplyScalar(1.9) },
        uShore:   { value: LAND_RADIUS + 26 },
        uSun:     { value: tint.sun },
    };

    waterMat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);

        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `
                #include <common>
                uniform float uTime;
                uniform float uWave;
                uniform float uShore;
                varying vec3 vWPos;
                varying float vWaveH;

                /* Gerstner: each train also pulls the surface horizontally toward
                 * its crest, which sharpens peaks and flattens troughs. Pure sine
                 * gives rolling hills that only read as water because they are
                 * blue.
                 *
                 * Amplitude is given directly. Deriving it from steepness/k the
                 * textbook way produced an 11 m amplitude for the longest train
                 * and ~20 m of total crest, which drowned the island and
                 * z-fought the beach.
                 *
                 * Returns world-space (x, z) pull in .xy and height in .z. */
                vec3 gerstner(vec2 p, vec2 dir, float amp, float len, float speed, float steep){
                    float k = 6.28318 / len;
                    float f = k * (dot(dir, p) - speed * uTime);
                    return vec3(dir * steep * amp * cos(f), amp * sin(f));
                }
                vec3 waves(vec2 worldXZ){
                    vec3 w = vec3(0.0);
                    w += gerstner(worldXZ, normalize(vec2( 1.0,  0.35)), 0.95, 118.0, 11.0, 0.55);
                    w += gerstner(worldXZ, normalize(vec2(-0.6,  1.0 )), 0.52,  73.0,  8.5, 0.5);
                    w += gerstner(worldXZ, normalize(vec2( 0.75, -0.8)), 0.26,  41.0,  6.5, 0.45);
                    w += gerstner(worldXZ, normalize(vec2(-0.2, -1.0 )), 0.13,  23.0,  4.5, 0.4);
                    /* Swell shoals and dies as it runs into the beach. Also keeps
                     * crests from ever reaching the sand. */
                    float shoal = smoothstep(uShore - 30.0, uShore + 300.0, length(worldXZ));
                    return w * uWave * shoal;
                }
            `)
            /* The normal has to be set in beginnormal_vertex: <normal_vertex>
             * writes vNormal before begin_vertex ever runs, so perturbing it
             * afterwards would either be overwritten or, with FLAT_SHADED, refer
             * to a varying that was never declared.
             *
             * Object axes vs world: the plane is rotated -90deg about X, so
             * object +x is world +x, object +y is world -z, and object +z is
             * world up. The y-offset sample is therefore taken at world -z. */
            .replace('#include <beginnormal_vertex>', `
                #include <beginnormal_vertex>
                {
                    vec2 wxz = (modelMatrix * vec4(position, 1.0)).xz;
                    float h0 = waves(wxz).z;
                    float hx = waves(wxz + vec2(2.5, 0.0)).z;
                    float hy = waves(wxz + vec2(0.0, -2.5)).z;
                    objectNormal = normalize(vec3(-(hx - h0), -(hy - h0), 2.5));
                }
            `)
            /* Sampling in world space is what makes the plane's re-centring
             * invisible. Sampled in local space the entire wave field travelled
             * with the mesh and snapped 40 m every time it moved, which looked
             * like the whole ocean blinking. */
            .replace('#include <begin_vertex>', `
                #include <begin_vertex>
                {
                    vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
                    vec3 w = waves(wp.xz);
                    transformed.x += w.x;
                    transformed.y -= w.y;
                    transformed.z += w.z;
                    vWaveH = w.z;
                    vWPos = vec3(wp.x + w.x, wp.y + w.z, wp.z + w.y);
                }
            `);

        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `
                #include <common>
                uniform vec3 uDeep;
                uniform vec3 uShallow;
                uniform vec3 uFoam;
                uniform vec3 uSky;
                uniform float uShore;
                uniform float uSun;
                varying vec3 vWPos;
                varying float vWaveH;
            `)
            .replace('#include <color_fragment>', `
                #include <color_fragment>
                {
                    float d = length(vWPos.xz);
                    /* Shelving water: pale near the beach, dark out to sea. */
                    float shallowT = smoothstep(uShore + 420.0, uShore - 20.0, d);
                    vec3 water = mix(uDeep, uShallow, shallowT);
                    /* Breaking crests, and a band of surf along the shoreline. */
                    float crest = smoothstep(0.55, 1.2, vWaveH);
                    float surf = 1.0 - smoothstep(0.0, 45.0, abs(d - uShore));
                    water = mix(water, uFoam, clamp(crest * 0.35 + surf * 0.5, 0.0, 1.0));
                    diffuseColor.rgb = water;
                }
            `)
            /* Cheap Fresnel: water is nearly a mirror at grazing angles and
             * nearly clear straight down. Without it the surface reads as
             * coloured plastic no matter how good the waves are. */
            .replace('#include <emissivemap_fragment>', `
                #include <emissivemap_fragment>
                {
                    float fres = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0), 4.0);
                    totalEmissiveRadiance += uSky * fres * (0.08 + uSun * 0.22);
                }
            `);
    };

    const water = new THREE.Mesh(new THREE.PlaneGeometry(OCEAN_SIZE, OCEAN_SIZE, segs, segs), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = -1.6;
    water.renderOrder = -1;
    group.add(water);

    /* ---- land + beach ---- */
    const beachMat = new THREE.MeshStandardMaterial({ color: 0x9d8c6a, roughness: 0.95 });
    const beach = new THREE.Mesh(noisyDisc(LAND_RADIUS + 26, 128), beachMat);
    beach.rotation.x = -Math.PI / 2;
    beach.position.y = -0.55;
    beach.receiveShadow = true;
    group.add(beach);

    /* ---- foam at the waterline ---- */
    const foamMat = new THREE.MeshBasicMaterial({
        color: tint.foam, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide,
    });
    const foam = new THREE.Mesh(new THREE.RingGeometry(LAND_RADIUS + 10, LAND_RADIUS + 44, 128), foamMat);
    foam.rotation.x = -Math.PI / 2;
    foam.position.y = -1.2;
    group.add(foam);

    /* ---- boats ---- */
    const boats = [];
    const boatCount = quality === 'low' ? 3 : 7;
    const hullGeo = new THREE.BoxGeometry(4.5, 2.2, 15);
    const cabinGeo = new THREE.BoxGeometry(3.4, 2.6, 5);
    const mastGeo = new THREE.CylinderGeometry(0.18, 0.18, 9, 6);
    const wakeGeo = new THREE.PlaneGeometry(9, 46);

    for (let i = 0; i < boatCount; i++) {
        const g = new THREE.Group();
        const hue = [0xb8bcc0, 0x8d9aa4, 0xc4a68a, 0x7d8f97][i % 4];
        const hull = new THREE.Mesh(hullGeo, new THREE.MeshStandardMaterial({ color: hue, roughness: 0.7, metalness: 0.2 }));
        hull.position.y = 1.1;
        g.add(hull);
        const cabin = new THREE.Mesh(cabinGeo, new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.6 }));
        cabin.position.set(0, 3.2, -1.5);
        g.add(cabin);
        const mast = new THREE.Mesh(mastGeo, new THREE.MeshStandardMaterial({ color: 0x6b6b66, roughness: 0.8 }));
        mast.position.set(0, 8, -1.5);
        g.add(mast);
        const lamp = new THREE.Mesh(
            new THREE.SphereGeometry(0.45, 6, 6),
            new THREE.MeshBasicMaterial({ color: 0xffd08a }),
        );
        lamp.position.set(0, 12.4, -1.5);
        g.add(lamp);

        const wake = new THREE.Mesh(wakeGeo, new THREE.MeshBasicMaterial({
            color: tint.foam, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide,
        }));
        wake.rotation.x = -Math.PI / 2;
        wake.position.set(0, -0.5, 26);
        g.add(wake);

        /* Wide, slow circuits well outside the shoreline. */
        const radius = LAND_RADIUS + 180 + i * 130;
        boats.push({
            mesh: g, lamp,
            radius,
            angle: (i / boatCount) * Math.PI * 2,
            speed: (0.006 + Math.random() * 0.005) * (i % 2 ? -1 : 1),
            bob: Math.random() * Math.PI * 2,
        });
        group.add(g);
    }

    /* ---- gulls ----
     * A gull is a body, two swept wings hinged at the shoulder, and a tail.
     * Two spinning rectangles do not read as a bird from any distance.
     *
     * The flight matters more than the model: real gulls glide far more than
     * they flap, bank into their turns, and ride a wandering path rather than a
     * perfect circle. All three are cheap to fake and all three are what the eye
     * actually uses to tell "bird" from "moving object". */
    function wingShape(span, chord) {
        const shape = new THREE.Shape();
        shape.moveTo(0, -chord * 0.5);
        shape.quadraticCurveTo(span * 0.45, -chord * 0.75, span, -chord * 0.12);
        shape.lineTo(span, chord * 0.06);
        shape.quadraticCurveTo(span * 0.5, chord * 0.5, 0, chord * 0.5);
        shape.closePath();
        return new THREE.ShapeGeometry(shape, 6);
    }

    const gulls = [];
    const gullCount = quality === 'low' ? 12 : 26;
    const gullMat = new THREE.MeshLambertMaterial({ color: 0xf4f4f0, side: THREE.DoubleSide });
    const gullDark = new THREE.MeshLambertMaterial({ color: 0x9aa3ab, side: THREE.DoubleSide });
    const wingGeoL = wingShape(-1.55, 0.62);
    const wingGeoR = wingShape(1.55, 0.62);
    const bodyGeo = new THREE.CapsuleGeometry(0.16, 0.78, 4, 8);
    const tailGeo = wingShape(0.42, 0.5);

    for (let i = 0; i < gullCount; i++) {
        const g = new THREE.Group();

        const body = new THREE.Mesh(bodyGeo, gullMat);
        body.rotation.x = Math.PI / 2;
        g.add(body);

        /* Shoulders are separate groups so the wing pivots at the body rather
         * than around its own centre — a wing that rotates about its middle
         * flaps through the fuselage. */
        const shoulderL = new THREE.Group();
        const shoulderR = new THREE.Group();
        shoulderL.add(new THREE.Mesh(wingGeoL, i % 4 === 0 ? gullDark : gullMat));
        shoulderR.add(new THREE.Mesh(wingGeoR, i % 4 === 0 ? gullDark : gullMat));
        shoulderL.rotation.x = shoulderR.rotation.x = -Math.PI / 2;
        g.add(shoulderL, shoulderR);

        const tail = new THREE.Mesh(tailGeo, gullMat);
        tail.rotation.x = -Math.PI / 2;
        tail.rotation.z = Math.PI / 2;
        tail.position.z = 0.52;
        g.add(tail);

        const scale = 1.5 + Math.random() * 1.1;
        g.scale.setScalar(scale);
        /* Yaw -> pitch -> roll, so the bank is applied about the bird's own
         * forward axis instead of the world's. Default XYZ rolls first. */
        g.rotation.order = 'YXZ';

        gulls.push({
            mesh: g, shoulderL, shoulderR,
            /* Two radii and a phase turn the circle into a drifting ellipse. */
            radius: 140 + Math.random() * 820,
            wobbleR: 40 + Math.random() * 120,
            wobbleRate: 0.05 + Math.random() * 0.12,
            angle: Math.random() * Math.PI * 2,
            speed: (0.03 + Math.random() * 0.05) * (Math.random() > 0.35 ? 1 : -1),
            height: 38 + Math.random() * 120,
            bobRate: 0.25 + Math.random() * 0.4,
            flap: Math.random() * Math.PI * 2,
            flapRate: 7 + Math.random() * 4,
            /* Glide/flap cycle: mostly gliding, with bursts of flapping. */
            glidePhase: Math.random() * Math.PI * 2,
            glideRate: 0.16 + Math.random() * 0.22,
            prevAngle: 0,
        });
        group.add(g);
    }

    let time = 0;

    return {
        landRadius: LAND_RADIUS,

        setTimeOfDay(key) {
            const t = WATER_TINTS[key] || WATER_TINTS.dusk;
            waterMat.color.setHex(t.shallow);
            waterMat.metalness = 0.35 + t.sun * 0.3;
            foamMat.color.setHex(t.foam);
            foamMat.opacity = 0.22 + t.sun * 0.26;
            for (const b of boats) b.lamp.visible = t.sun < 0.55;
        },

        update(dt, focus) {
            time += dt;
            uniforms.uTime.value = time;

            /* The ocean plane follows the camera on the horizontal so it always
             * runs to the horizon without being enormous. Snapping to the wave
             * period keeps the swell from sliding under the aircraft. */
            if (focus) {
                water.position.x = Math.round(focus.x / 40) * 40;
                water.position.z = Math.round(focus.z / 40) * 40;
            }

            for (const b of boats) {
                b.angle += b.speed * dt;
                b.mesh.position.set(Math.cos(b.angle) * b.radius, 0, Math.sin(b.angle) * b.radius);
                b.mesh.rotation.y = -b.angle + (b.speed > 0 ? Math.PI / 2 : -Math.PI / 2);
                b.bob += dt * 1.4;
                b.mesh.position.y = -1.2 + Math.sin(b.bob) * 0.5;
                b.mesh.rotation.z = Math.sin(b.bob * 0.8) * 0.05;
            }

            for (const g of gulls) {
                g.prevAngle = g.angle;
                g.angle += g.speed * dt;
                g.flap += dt * g.flapRate;
                g.glidePhase += dt * g.glideRate;

                /* Gulls glide most of the time and flap in bursts. Constant
                 * flapping is the single biggest tell of a fake bird. */
                const burst = Math.max(0, Math.sin(g.glidePhase));
                const amount = 0.08 + Math.pow(burst, 2.0) * 0.85;
                const beat = Math.sin(g.flap) * amount;
                /* Downstroke is faster and deeper than the recovery. */
                const stroke = beat > 0 ? beat : beat * 0.55;
                g.shoulderL.rotation.y = stroke;
                g.shoulderR.rotation.y = -stroke;

                const r = g.radius + Math.sin(g.angle * 2.3 + g.wobbleRate * 40) * g.wobbleR;
                g.mesh.position.set(
                    Math.cos(g.angle) * r,
                    g.height + Math.sin(g.glidePhase * 1.7) * 11 + stroke * 1.2,
                    Math.sin(g.angle) * r,
                );

                /* Bank into the turn, and pitch slightly nose-up while climbing. */
                const turn = (g.angle - g.prevAngle) / Math.max(dt, 1e-4);
                g.mesh.rotation.y = -g.angle + (g.speed > 0 ? -Math.PI / 2 : Math.PI / 2);
                g.mesh.rotation.z = THREE.MathUtils.clamp(turn * 4.5, -0.75, 0.75);
                g.mesh.rotation.x = Math.cos(g.glidePhase * 1.7) * 0.12;
            }
        },
    };
}
