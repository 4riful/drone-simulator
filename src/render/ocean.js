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

    const uniforms = { uTime: { value: 0 }, uWave: { value: opts.waveHeight ?? 1.0 } };
    waterMat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = uniforms.uTime;
        shader.uniforms.uWave = uniforms.uWave;
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `
                #include <common>
                uniform float uTime;
                uniform float uWave;
                /* Three crossing swells at different angles and speeds. Any two
                 * would visibly repeat; three is enough to hide the period. */
                float swell(vec2 p){
                    float h  = sin(p.x * 0.018 + uTime * 0.9) * 0.55;
                    h += sin(p.y * 0.023 - uTime * 0.7) * 0.42;
                    h += sin((p.x + p.y) * 0.011 + uTime * 1.3) * 0.3;
                    h += sin((p.x - p.y) * 0.037 - uTime * 1.9) * 0.12;
                    return h * uWave;
                }
            `)
            /* The normal has to be set in beginnormal_vertex: <normal_vertex>
             * writes vNormal before begin_vertex ever runs, so perturbing it
             * afterwards would either be overwritten or, with FLAT_SHADED, refer
             * to a varying that was never declared. */
            .replace('#include <beginnormal_vertex>', `
                #include <beginnormal_vertex>
                {
                    float h0 = swell(position.xy);
                    float hx = swell(position.xy + vec2(2.0, 0.0));
                    float hy = swell(position.xy + vec2(0.0, 2.0));
                    objectNormal = normalize(vec3(-(hx - h0), -(hy - h0), 2.0));
                }
            `)
            .replace('#include <begin_vertex>', `
                #include <begin_vertex>
                transformed.z += swell(position.xy);
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

    /* ---- gulls ---- */
    const gulls = [];
    const gullCount = quality === 'low' ? 10 : 22;
    const gullMat = new THREE.MeshBasicMaterial({ color: 0xf2f2ee, side: THREE.DoubleSide });
    const wingGeo = new THREE.PlaneGeometry(3.2, 0.7);
    for (let i = 0; i < gullCount; i++) {
        const g = new THREE.Group();
        const l = new THREE.Mesh(wingGeo, gullMat);
        const r = new THREE.Mesh(wingGeo, gullMat);
        l.position.x = -1.7; r.position.x = 1.7;
        g.add(l, r);
        gulls.push({
            mesh: g, wingL: l, wingR: r,
            radius: 120 + Math.random() * 700,
            angle: Math.random() * Math.PI * 2,
            speed: 0.05 + Math.random() * 0.06,
            height: 45 + Math.random() * 90,
            flap: Math.random() * Math.PI * 2,
            flapRate: 6 + Math.random() * 5,
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
                g.angle += g.speed * dt;
                g.flap += dt * g.flapRate;
                const wing = Math.sin(g.flap) * 0.9;
                g.wingL.rotation.z = wing;
                g.wingR.rotation.z = -wing;
                g.mesh.position.set(
                    Math.cos(g.angle) * g.radius,
                    g.height + Math.sin(g.flap * 0.2) * 8,
                    Math.sin(g.angle) * g.radius,
                );
                g.mesh.rotation.y = -g.angle;
            }
        },
    };
}
