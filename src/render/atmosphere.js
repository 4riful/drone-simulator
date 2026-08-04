/*
 * Atmosphere: physically-based sky, sun, image-based lighting, and shadows.
 *
 * Replaces the old flat gradient dome. The sky is rendered with Rayleigh/Mie
 * scattering, then baked into a PMREM environment map so every
 * MeshStandardMaterial in the city picks up real ambient reflections. That
 * single change is what moves the render from "flat game" to "photographic".
 */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/* Sun elevation/azimuth in degrees, scattering params, and the matching
 * artificial lighting for each time of day. Fog colour is sampled to sit close
 * to the horizon colour so distant geometry dissolves instead of clipping. */
export const TIME_PRESETS = {
    dawn: {
        label: 'Dawn Patrol',
        elevation: 3.2, azimuth: 105,
        turbidity: 7.5, rayleigh: 2.6, mie: 0.012, mieG: 0.82,
        exposure: 0.52,
        sunColor: 0xffb27a, sunIntensity: 3.2,
        hemiSky: 0x9fb6d4, hemiGround: 0x40372c, hemiIntensity: 0.55,
        ambient: 0x2a3546, ambientIntensity: 0.35,
        fogColor: 0x8d9cae, fogDensity: 0.00075,
        starOpacity: 0.25, windowLights: 0.85, streetLights: 0.7,
    },
    golden: {
        label: 'Golden Hour',
        elevation: 7.5, azimuth: 118,
        turbidity: 6.0, rayleigh: 2.1, mie: 0.009, mieG: 0.80,
        exposure: 0.58,
        sunColor: 0xffc98f, sunIntensity: 4.1,
        hemiSky: 0xa8bed8, hemiGround: 0x4a3c2c, hemiIntensity: 0.6,
        ambient: 0x33404f, ambientIntensity: 0.3,
        fogColor: 0xa8aeb6, fogDensity: 0.00062,
        starOpacity: 0, windowLights: 0.5, streetLights: 0.35,
    },
    noon: {
        label: 'High Noon',
        elevation: 62, azimuth: 165,
        turbidity: 3.4, rayleigh: 1.1, mie: 0.005, mieG: 0.78,
        exposure: 0.48,
        sunColor: 0xfff4e2, sunIntensity: 4.6,
        hemiSky: 0xbdd4ee, hemiGround: 0x5a5040, hemiIntensity: 0.75,
        ambient: 0x48546a, ambientIntensity: 0.28,
        fogColor: 0xbcc6d2, fogDensity: 0.00048,
        starOpacity: 0, windowLights: 0.12, streetLights: 0,
    },
    dusk: {
        label: 'Dusk Strike',
        /* High enough to actually rake the city with long shadows — at 1-2 deg
         * the sun grazes the horizon and everything reads as a silhouette. */
        elevation: 8.0, azimuth: 252,
        turbidity: 8.0, rayleigh: 2.6, mie: 0.017, mieG: 0.85,
        exposure: 0.46,
        sunColor: 0xffa163, sunIntensity: 5.2,
        hemiSky: 0x7f96bc, hemiGround: 0x4a3c30, hemiIntensity: 0.65,
        ambient: 0x35405a, ambientIntensity: 0.42,
        fogColor: 0x8a7d80, fogDensity: 0.00085,
        starOpacity: 0.15, windowLights: 0.9, streetLights: 0.8,
    },
    night: {
        label: 'Night Ops',
        elevation: -8.5, azimuth: 280,
        turbidity: 6.5, rayleigh: 1.4, mie: 0.006, mieG: 0.80,
        exposure: 0.62,
        /* Moonlight: cool, low, still directional enough to cast soft shadows. */
        sunColor: 0x93aed6, sunIntensity: 0.55,
        hemiSky: 0x2b3a54, hemiGround: 0x14161c, hemiIntensity: 0.35,
        ambient: 0x1b2534, ambientIntensity: 0.45,
        fogColor: 0x0e131b, fogDensity: 0.00095,
        starOpacity: 0.9, windowLights: 1.25, streetLights: 1.0,
        moonElevation: 34, moonAzimuth: 60,
    },
    storm: {
        label: 'Storm Front',
        elevation: 14, azimuth: 200,
        turbidity: 14.0, rayleigh: 3.6, mie: 0.03, mieG: 0.88,
        exposure: 0.42,
        sunColor: 0x9aa4b4, sunIntensity: 1.1,
        hemiSky: 0x5b6572, hemiGround: 0x2e2c28, hemiIntensity: 0.5,
        ambient: 0x2c333c, ambientIntensity: 0.5,
        fogColor: 0x4e555f, fogDensity: 0.00135,
        starOpacity: 0, windowLights: 1.0, streetLights: 0.85,
    },
};

/* ---- procedural cloud sheet ------------------------------------------- */

function valueNoiseCanvas(size, cells, seedFn) {
    /* Lattice of random values, bicubic-ish smoothed — cheap fbm octave. */
    const grid = new Float32Array((cells + 1) * (cells + 1));
    for (let i = 0; i < grid.length; i++) grid[i] = seedFn();
    const data = new Float32Array(size * size);
    const step = size / cells;
    const fade = t => t * t * (3 - 2 * t);
    for (let y = 0; y < size; y++) {
        const gy = y / step, y0 = Math.floor(gy), fy = fade(gy - y0);
        for (let x = 0; x < size; x++) {
            const gx = x / step, x0 = Math.floor(gx), fx = fade(gx - x0);
            const a = grid[y0 * (cells + 1) + x0];
            const b = grid[y0 * (cells + 1) + x0 + 1];
            const c = grid[(y0 + 1) * (cells + 1) + x0];
            const d = grid[(y0 + 1) * (cells + 1) + x0 + 1];
            data[y * size + x] = (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
        }
    }
    return data;
}

function makeCloudTexture(size = 512, seed = 1) {
    let s = seed >>> 0 || 1;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };

    const octaves = [
        { cells: 4, amp: 0.55 },
        { cells: 9, amp: 0.26 },
        { cells: 19, amp: 0.13 },
        { cells: 37, amp: 0.06 },
    ];
    const acc = new Float32Array(size * size);
    for (const o of octaves) {
        const n = valueNoiseCanvas(size, o.cells, rnd);
        for (let i = 0; i < acc.length; i++) acc[i] += n[i] * o.amp;
    }

    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const cx = cv.getContext('2d');
    const img = cx.createImageData(size, size);
    for (let i = 0; i < acc.length; i++) {
        /* Sharpen into distinct cloud masses, keep wispy edges. */
        let v = acc[i];
        v = Math.max(0, (v - 0.46) / 0.54);
        v = Math.pow(v, 1.5);
        const alpha = Math.min(1, v) * 255;
        /* Brighter cores, slightly grey undersides for depth. */
        const lum = 200 + Math.min(55, v * 90);
        const p = i * 4;
        img.data[p] = lum; img.data[p + 1] = lum; img.data[p + 2] = Math.min(255, lum + 6);
        img.data[p + 3] = alpha;
    }
    cx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
}

/**
 * Build the atmosphere rig and attach it to the scene.
 *
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @param {object} [opts] - { shadowRadius, shadowMapSize, cloudAltitude }
 */
export function createAtmosphere(scene, renderer, opts = {}) {
    const shadowRadius = opts.shadowRadius ?? 190;
    const shadowMapSize = opts.shadowMapSize ?? 2048;
    const cloudAltitude = opts.cloudAltitude ?? 320;

    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    /* ---- sky dome ---- */
    const sky = new Sky();
    sky.scale.setScalar(45000);
    sky.frustumCulled = false;
    scene.add(sky);

    /* ---- lights ---- */
    const sunLight = new THREE.DirectionalLight(0xffffff, 3);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    sunLight.shadow.camera.near = 1;
    /* Must clear the light's stand-off distance, which grows as the sun drops
     * toward the horizon (see update()). */
    sunLight.shadow.camera.far = 3400;
    sunLight.shadow.camera.left = -shadowRadius;
    sunLight.shadow.camera.right = shadowRadius;
    sunLight.shadow.camera.top = shadowRadius;
    sunLight.shadow.camera.bottom = -shadowRadius;
    /* Required: three never recomputes an orthographic shadow frustum for you,
     * so without this the light keeps its default +/-5 unit box (far 500) and
     * silently casts no usable shadows at all. */
    sunLight.shadow.camera.updateProjectionMatrix();
    /* Normal bias handles the slope acne on building faces far better than a
     * constant bias, which would detach contact shadows at the ground. */
    sunLight.shadow.bias = -0.0004;
    sunLight.shadow.normalBias = 0.25;
    scene.add(sunLight);
    scene.add(sunLight.target);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
    scene.add(hemi);
    const ambient = new THREE.AmbientLight(0xffffff, 0.3);
    scene.add(ambient);

    /* Secondary fill from the opposite side of the sun. Keeps shadowed facades
     * readable without flattening them the way raising ambient would. */
    const fill = new THREE.DirectionalLight(0x8fa8c8, 0.25);
    scene.add(fill);

    /* ---- stars (visible when the sun is down) ---- */
    const starVerts = [];
    const starSizes = [];
    for (let i = 0; i < 2200; i++) {
        const r = 2400 + Math.random() * 900;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(Math.random());
        starVerts.push(
            r * Math.sin(phi) * Math.cos(theta),
            r * Math.cos(phi) + 200,
            r * Math.sin(phi) * Math.sin(theta),
        );
        starSizes.push(Math.random() < 0.08 ? 9 : 3 + Math.random() * 3.5);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starVerts, 3));
    starGeo.setAttribute('size', new THREE.Float32BufferAttribute(starSizes, 1));
    const starMat = new THREE.PointsMaterial({
        color: 0xdce6ff, size: 5, sizeAttenuation: true,
        transparent: true, opacity: 0, depthWrite: false, fog: false,
    });
    const stars = new THREE.Points(starGeo, starMat);
    stars.frustumCulled = false;
    scene.add(stars);

    /* ---- cloud sheets ---- */
    const cloudLayers = [];
    const cloudSpecs = [
        /* Kept inside camera.far (5000) so the sheets never show a clip edge. */
        { alt: cloudAltitude, size: 2600, repeat: 2.0, opacity: 0.5, drift: 0.0022, seed: 7 },
        { alt: cloudAltitude + 130, size: 3200, repeat: 1.35, opacity: 0.32, drift: 0.0013, seed: 913 },
        { alt: cloudAltitude + 300, size: 3800, repeat: 0.9, opacity: 0.18, drift: 0.0007, seed: 5501 },
    ];
    for (const spec of cloudSpecs) {
        const tex = makeCloudTexture(512, spec.seed);
        tex.repeat.set(spec.repeat, spec.repeat);
        const mat = new THREE.MeshBasicMaterial({
            map: tex, transparent: true, opacity: spec.opacity,
            depthWrite: false, side: THREE.DoubleSide, fog: false,
        });
        mat.vertexColors = true;
        /* Radial alpha falloff baked into vertex colours. Without this the sheet
         * ends in a hard rectangular edge across the sky wherever the plane
         * boundary falls inside the far plane. */
        const geo = new THREE.PlaneGeometry(spec.size, spec.size, 48, 48);
        const pos = geo.attributes.position;
        const col = new Float32Array(pos.count * 4);
        const half = spec.size / 2;
        for (let i = 0; i < pos.count; i++) {
            const r = Math.hypot(pos.getX(i), pos.getY(i)) / half;
            /* Fully opaque out to 45% of the half-extent, gone by 95%. */
            const t = Math.min(1, Math.max(0, (r - 0.45) / 0.5));
            col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = 1;
            col[i * 4 + 3] = 1 - t * t * (3 - 2 * t);
        }
        geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = Math.PI / 2;
        mesh.position.y = spec.alt;
        mesh.renderOrder = -1;
        mesh.frustumCulled = false;
        scene.add(mesh);
        cloudLayers.push({ mesh, mat, tex, spec, baseOpacity: spec.opacity });
    }

    /* ---- IBL ---- */
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    let envRT = null;
    const envScene = new THREE.Scene();

    scene.fog = new THREE.FogExp2(0x9aa6b4, 0.002);

    const sunPos = new THREE.Vector3();
    const state = {
        preset: null,
        key: 'dusk',
        windowLights: 1,
        streetLights: 1,
        /* Lightning flash bookkeeping for the storm preset. */
        flash: 0,
    };

    function sphericalToVec(elevationDeg, azimuthDeg, target) {
        const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
        const theta = THREE.MathUtils.degToRad(azimuthDeg);
        return target.setFromSphericalCoords(1, phi, theta);
    }

    function rebuildEnvironment() {
        /* Bake the current sky into a prefiltered radiance map. Every standard
         * material samples it, so ambient tint and reflections stay physically
         * consistent with whatever time of day is active. */
        if (envRT) envRT.dispose();
        scene.remove(sky);
        envScene.add(sky);
        envRT = pmrem.fromScene(envScene);
        envScene.remove(sky);
        scene.add(sky);
        scene.environment = envRT.texture;
    }

    function setTimeOfDay(key, { rebuild = true } = {}) {
        const preset = TIME_PRESETS[key] || TIME_PRESETS.dusk;
        state.preset = preset;
        state.key = TIME_PRESETS[key] ? key : 'dusk';

        const u = sky.material.uniforms;
        u.turbidity.value = preset.turbidity;
        u.rayleigh.value = preset.rayleigh;
        u.mieCoefficient.value = preset.mie;
        u.mieDirectionalG.value = preset.mieG;

        sphericalToVec(preset.elevation, preset.azimuth, sunPos);
        u.sunPosition.value.copy(sunPos);

        /* At night the key light comes from the moon, not the below-horizon sun. */
        const keyElev = preset.moonElevation ?? preset.elevation;
        const keyAzim = preset.moonAzimuth ?? preset.azimuth;
        const keyDir = sphericalToVec(keyElev, keyAzim, new THREE.Vector3());
        sunLight.userData.dir = keyDir;
        sunLight.color.setHex(preset.sunColor);
        sunLight.intensity = preset.sunIntensity;

        fill.position.copy(keyDir).multiplyScalar(-300).setY(160);
        fill.intensity = preset.sunIntensity > 1 ? 0.3 : 0.16;

        hemi.color.setHex(preset.hemiSky);
        hemi.groundColor.setHex(preset.hemiGround);
        hemi.intensity = preset.hemiIntensity;
        ambient.color.setHex(preset.ambient);
        ambient.intensity = preset.ambientIntensity;

        renderer.toneMappingExposure = preset.exposure;

        scene.fog.color.setHex(preset.fogColor);
        scene.fog.density = preset.fogDensity;
        scene.background = null; /* sky dome provides the backdrop */

        starMat.opacity = preset.starOpacity;
        stars.visible = preset.starOpacity > 0;

        /* Clouds catch the sun colour at low elevations. */
        const cloudTint = new THREE.Color(preset.sunColor).lerp(new THREE.Color(preset.hemiSky), 0.45);
        for (const layer of cloudLayers) {
            layer.mat.color.copy(cloudTint);
            const stormy = key === 'storm';
            layer.mat.opacity = layer.baseOpacity * (stormy ? 1.7 : 1);
            layer.baseCurrent = layer.mat.opacity;
        }

        state.windowLights = preset.windowLights;
        state.streetLights = preset.streetLights;

        if (rebuild) rebuildEnvironment();
        return preset;
    }

    setTimeOfDay('dusk');

    let cloudTime = 0;

    /**
     * Per-frame update. `focus` is the point shadows should stay crisp around
     * (the drone), so the shadow frustum tracks the player instead of trying to
     * cover the whole city at once.
     */
    function update(dt, focus) {
        cloudTime += dt;

        /* Keep sky, stars and clouds centred on the viewer so they never clip. */
        if (focus) {
            sky.position.set(focus.x, 0, focus.z);
            stars.position.set(focus.x, 0, focus.z);
            for (const layer of cloudLayers) {
                layer.mesh.position.x = focus.x;
                layer.mesh.position.z = focus.z;
            }

            /* Snap the shadow camera to texel increments — without this the
             * shadow edges crawl and shimmer as the drone moves. */
            const dir = sunLight.userData.dir;
            const texel = (shadowRadius * 2) / shadowMapSize;
            const sx = Math.round(focus.x / texel) * texel;
            const sz = Math.round(focus.z / texel) * texel;
            sunLight.target.position.set(sx, 0, sz);
            /* Stand the light off far enough that it clears the tallest towers.
             * A fixed 400-unit offset puts a low sun *below* the skyline, which
             * silently produces no shadows at all. */
            const dist = THREE.MathUtils.clamp(280 / Math.max(dir.y, 0.10), 420, 2800);
            sunLight.position.set(sx + dir.x * dist, dir.y * dist + 30, sz + dir.z * dist);
            sunLight.target.updateMatrixWorld();
        }

        for (const layer of cloudLayers) {
            layer.tex.offset.x = (cloudTime * layer.spec.drift) % 1;
            layer.tex.offset.y = (cloudTime * layer.spec.drift * 0.35) % 1;
        }

        /* Storm lightning: brief global exposure lift plus a cloud flash. */
        if (state.flash > 0) {
            state.flash = Math.max(0, state.flash - dt * 3.2);
            const f = state.flash * state.flash;
            renderer.toneMappingExposure = state.preset.exposure * (1 + f * 1.6);
            for (const layer of cloudLayers) layer.mat.opacity = layer.baseCurrent * (1 + f * 1.2);
        }
    }

    function flash(strength = 1) {
        state.flash = Math.max(state.flash, strength);
    }

    function dispose() {
        if (envRT) envRT.dispose();
        pmrem.dispose();
    }

    return {
        sky, sunLight, hemi, ambient, fill, stars, cloudLayers,
        setTimeOfDay, update, flash, dispose,
        get preset() { return state.preset; },
        get timeKey() { return state.key; },
        get windowLights() { return state.windowLights; },
        get streetLights() { return state.streetLights; },
        sunDirection: () => sunLight.userData.dir,
    };
}
