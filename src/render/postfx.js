/*
 * Post-processing chain.
 *
 * Order matters: scene -> bloom (light bleed on emissives) -> grade
 * (vignette, grain, chromatic aberration, filmic contrast) -> SMAA -> output.
 * The grade pass is where most of the "camera feed" character comes from; the
 * simulator is meant to look like a downlink from an airborne sensor, not a
 * clean rasteriser.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const GradeShader = {
    uniforms: {
        tDiffuse: { value: null },
        uTime: { value: 0 },
        uVignette: { value: 0.62 },
        uGrain: { value: 0.055 },
        uAberration: { value: 0.0016 },
        uContrast: { value: 1.06 },
        uSaturation: { value: 1.06 },
        uLift: { value: new THREE.Vector3(0.006, 0.010, 0.018) },
        uGain: { value: new THREE.Vector3(1.02, 1.0, 0.98) },
        /* Damage / signal-loss feedback driven by the sim. */
        uDamage: { value: 0 },
        uScanline: { value: 0.03 },
    },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform float uVignette;
        uniform float uGrain;
        uniform float uAberration;
        uniform float uContrast;
        uniform float uSaturation;
        uniform vec3  uLift;
        uniform vec3  uGain;
        uniform float uDamage;
        uniform float uScanline;
        varying vec2 vUv;

        float hash(vec2 p) {
            return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        void main() {
            vec2 uv = vUv;
            vec2 center = uv - 0.5;
            float r2 = dot(center, center);

            // Horizontal tearing when the airframe is hurt / link is degraded.
            if (uDamage > 0.001) {
                float band = step(0.985 - uDamage * 0.25, hash(vec2(floor(uv.y * 90.0), floor(uTime * 12.0))));
                uv.x += band * (hash(vec2(floor(uv.y * 90.0), uTime)) - 0.5) * 0.05 * uDamage;
            }

            // Lateral chromatic aberration, scaled by distance from the optical axis.
            float ab = uAberration * (1.0 + uDamage * 4.0);
            vec2 dir = center * r2;
            vec3 color;
            color.r = texture2D(tDiffuse, uv + dir * ab).r;
            color.g = texture2D(tDiffuse, uv).g;
            color.b = texture2D(tDiffuse, uv - dir * ab).b;

            // Filmic lift / gain grade.
            color = color * uGain + uLift;

            // Contrast about mid grey.
            color = (color - 0.5) * uContrast + 0.5;

            // Saturation.
            float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
            color = mix(vec3(luma), color, uSaturation);

            // Vignette — smooth, not a hard ring.
            float vig = smoothstep(0.85, 0.15, r2 * uVignette * 2.2);
            color *= mix(1.0, vig, 0.85);

            // Sensor grain: animated, slightly stronger in the shadows where a
            // real low-light sensor is noisiest.
            float n = hash(uv * vec2(1024.0, 768.0) + fract(uTime) * 91.7) - 0.5;
            color += n * uGrain * (1.0 - luma * 0.6);

            // Faint downlink scanlines.
            color *= 1.0 - uScanline * (0.5 + 0.5 * sin(uv.y * 1400.0));

            // Damage tint.
            color = mix(color, vec3(color.r * 1.25, color.g * 0.72, color.b * 0.72), uDamage * 0.5);

            gl_FragColor = vec4(max(color, 0.0), 1.0);
        }
    `,
};

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {object} [opts] - { quality: 'high'|'medium'|'low' }
 */
export function createPostFX(renderer, scene, camera, opts = {}) {
    const quality = opts.quality || 'high';
    const size = renderer.getSize(new THREE.Vector2());

    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(size.x, size.y);

    composer.addPass(new RenderPass(scene, camera));

    /* Bloom runs on LINEAR HDR (before tone mapping), so the threshold is in
     * scene-referred units, not 0..1. Mid-grey after ACES at exposure ~0.5 sits
     * near 2.0 — anything lower blooms the sky and every sunlit facade. */
    const bloom = new UnrealBloomPass(
        new THREE.Vector2(size.x, size.y),
        quality === 'low' ? 0.28 : 0.42,  // strength
        0.72,                              // radius
        2.2,                               // threshold (linear HDR)
    );
    if (quality !== 'low') composer.addPass(bloom);

    /* Tone map + sRGB encode here, mid-chain, so everything after this point is
     * display-referred 0..1 — which is what the grade shader and SMAA both
     * expect. Grading in linear HDR would blow out the grain and contrast maths. */
    composer.addPass(new OutputPass());

    if (quality === 'high') composer.addPass(new SMAAPass(size.x, size.y));

    const grade = new ShaderPass(GradeShader);
    grade.renderToScreen = true;
    composer.addPass(grade);

    let time = 0;

    return {
        composer,
        bloom,
        grade,
        render(dt) {
            time += dt;
            grade.uniforms.uTime.value = time;
            composer.render(dt);
        },
        setSize(w, h) {
            composer.setPixelRatio(renderer.getPixelRatio());
            composer.setSize(w, h);
            bloom.setSize(w, h);
        },
        /** 0..1 — drives glitch, aberration and red tint from hull damage / link loss. */
        setDamage(v) {
            grade.uniforms.uDamage.value = THREE.MathUtils.clamp(v, 0, 1);
        },
        /** Night presets want more grain and a stronger vignette. */
        applyPreset(key) {
            const night = key === 'night';
            const storm = key === 'storm';
            grade.uniforms.uGrain.value = night ? 0.10 : storm ? 0.07 : 0.045;
            grade.uniforms.uVignette.value = night ? 0.78 : 0.6;
            grade.uniforms.uSaturation.value = storm ? 0.9 : night ? 0.95 : 1.08;
            /* Night has far less scene luminance, so the HDR threshold drops to
             * let window and street lighting bloom at all. */
            bloom.strength = night ? 0.75 : storm ? 0.32 : 0.42;
            bloom.threshold = night ? 0.75 : storm ? 2.6 : 2.2;
        },
    };
}
