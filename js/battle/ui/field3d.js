// ==================== 3D battlefield ====================
// A Gen-5-style battlefield rendered with three.js: tilted ground, raised
// platforms, the two Pokemon as upright billboards that cast real shadows, and
// the move effects as particles in world space.
//
// three.js is imported dynamically the moment a battle starts, so it costs
// nothing on any other page. If the import fails (offline, blocked CDN, no
// WebGL) mountField3D returns null and scene.js falls back to the CSS field and
// its DOM sprites -- the battle is fully playable either way.
//
// Nothing here reads or writes battle state. It is handed positions, artwork
// URLs and effect names by scene.js and draws them.

import { TYPE_COLORS } from './move-anim.js';


// Open-field biomes: rolling ground and hills receding into haze. Each one is
// nothing but a colour set -- same geometry throughout -- so adding a field is
// one table row and costs no extra draws.
export const FIELDS = {
    meadow: {
        label: 'Meadow',
        skyTop: 0x6fb7e8, skyLow: 0xd6ecfa,
        groundNear: 0x86c95d, groundFar: 0x5d9c4a,
        hillNear: 0x6fae72, hillFar: 0x8fb7c9,
        haze: 0xcfe4f2, fog: [22, 62], sun: 1.15
    },
    desert: {
        label: 'Desert',
        skyTop: 0x8ec6e6, skyLow: 0xfbeecb,
        groundNear: 0xe8ce92, groundFar: 0xd0ad6c,
        hillNear: 0xc2924f, hillFar: 0xd9bc93,
        haze: 0xf2e2c0, fog: [26, 70], sun: 1.35
    },
    snow: {
        label: 'Snowfield',
        skyTop: 0xa8c8e8, skyLow: 0xeaf3fb,
        groundNear: 0xf4f8fc, groundFar: 0xd4e2ee,
        hillNear: 0xdce8f2, hillFar: 0xb9cddd,
        haze: 0xe6f0f8, fog: [18, 52], sun: 1.0
    },
    dusk: {
        label: 'Dusk',
        skyTop: 0x4a3f7a, skyLow: 0xf7a765,
        groundNear: 0x6b7a52, groundFar: 0x44503a,
        hillNear: 0x53496d, hillFar: 0x7b6a91,
        haze: 0xd9a07a, fog: [20, 56], sun: 0.85
    },
    coast: {
        label: 'Coast',
        skyTop: 0x63b8dd, skyLow: 0xdff2fa,
        groundNear: 0xecd9a8, groundFar: 0x7fc0c4,
        hillNear: 0x6ba99b, hillFar: 0x9dc6d6,
        haze: 0xd6eef5, fog: [24, 64], sun: 1.25
    }
};

export const FIELD_IDS = Object.keys(FIELDS);

// Which biome a battle takes place in, derived from its seed rather than drawn
// at random. Two clients of the same battle share the seed, so they now share
// the place as well -- and the lead preview can stand on the very field the
// battle is about to use instead of defaulting to a different one.
export function fieldForSeed(seed) {
    const str = String(seed ?? '');
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return FIELD_IDS[h % FIELD_IDS.length];
}

// The two Pokemon stand straight on the ground now. Keeping the anchor names
// so the rest of the file (and scene.js) is unchanged.
const NEAR_PLATFORM = { x: -2.6, z: 3.1 };
const FAR_PLATFORM = { x: 2.4, z: -2.4 };
const PLATFORM_TOP = 0;

// A full-height Pokemon in world units. The near one reads bigger than the far
// one purely because it is closer to the camera -- that is the depth scaling,
// and it now comes from the projection rather than from a CSS percentage.
const SPRITE_HEIGHT = 3.0;

// Shots are described by how far back, how high, how far around toward the
// perpendicular of the near->far axis, and what they look at -- then solved
// against the real anchor positions. The old hardcoded triples had drifted out
// of step with the platforms: the default shot pushed a Pokemon past the edge
// of frame and sat the pair well above centre.
//
// blend 0 looks straight down +z; blend 1 looks square-on at the line between
// the two Pokemon. Half-way keeps the classic composition (your Pokemon nearer
// and larger) while still framing both.
// Where the six-a-side team preview stands: two ranks facing each other,
// centred on the field so the camera can take both in at once.
const PREVIEW_ROW = { z: 2.6, spread: 2.15, height: 2.0 };

export const CAMERA_SHOTS = {
    preview:  { dist: 17, elev: 14, blend: 1, focus: 'mid' },
    rest:     { dist: 14.5, elev: 21, blend: 0.5, focus: 'mid' },
    nearPush: { dist: 11,   elev: 17, blend: 0.5, focus: 'near' },
    farPush:  { dist: 11,   elev: 17, blend: 0.5, focus: 'far' },
    wide:     { dist: 18,   elev: 26, blend: 0.5, focus: 'mid' },
    lowNear:  { dist: 10,   elev: 11, blend: 0.5, focus: 'near' },
    lowFar:   { dist: 10,   elev: 11, blend: 0.5, focus: 'far' }
};

export const CAMERA_FOV = 34;

// Solves a shot description into a camera position and look-at point.
export function solveShot(THREE, shot, anchors) {
    const near = anchors.near, far = anchors.far;
    const mid = near.clone().add(far).multiplyScalar(0.5);
    const focus = shot.focus === 'near' ? near.clone() : shot.focus === 'far' ? far.clone() : mid;
    const axis = far.clone().sub(near).normalize();
    // Perpendicular to the battle line, in the ground plane, on the viewer's side.
    let perp = new THREE.Vector3(axis.z, 0, -axis.x);
    if (perp.z < 0) perp.negate();
    const dir = new THREE.Vector3(0, 0, 1).multiplyScalar(1 - shot.blend)
        .add(perp.multiplyScalar(shot.blend)).normalize();
    const rad = shot.elev * Math.PI / 180;
    const look = focus.clone().setY(focus.y + 1.0);
    const pos = look.clone()
        .add(dir.multiplyScalar(shot.dist * Math.cos(rad)))
        .add(new THREE.Vector3(0, shot.dist * Math.sin(rad), 0));
    return { pos, look };
}

// Where each trainer stands to throw. The near one is behind and left of the
// camera, the far one across the field, so a ball genuinely comes from its
// owner's side rather than sliding in from nowhere.
const THROW_FROM = {
    near: [-4.6, 1.4, 8.2],
    far: [6.2, 1.6, -5.4]
};

// Status colours, matching the .status-* pills on the statbar.
const STATUS_COLORS = {
    brn: 0xf97316, psn: 0xa855f7, tox: 0x9333ea,
    par: 0xfacc15, slp: 0x94a3b8, frz: 0x67e8f9
};

const hex = (n) => '#' + n.toString(16).padStart(6, '0');

export async function mountField3D(fieldEl, fieldId) {
    if (!fieldEl) return null;
    let THREE;
    try {
        // A literal specifier, so the bundler can resolve three and split it
        // into its own chunk. It is ~600 kB and only the 3D battle field
        // uses it, so it must not land in the main bundle. The try/catch
        // stays: if the chunk fails to load we fall back to the CSS field.
        THREE = await import('three');
    } catch (err) {
        console.warn('[BATTLE] three.js unavailable, keeping the CSS field', err);
        return null;
    }

    const PALETTE = FIELDS[fieldId] || FIELDS.meadow;
    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (err) {
        console.warn('[BATTLE] WebGL unavailable, keeping the CSS field', err);
        return null;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const canvas = renderer.domElement;
    canvas.className = 'ps-field3d';
    fieldEl.prepend(canvas);
    fieldEl.classList.add('has-field3d');

    const scene = new THREE.Scene();
    scene.background = gradientTexture(THREE, [PALETTE.skyTop, PALETTE.skyLow]);
    // Distance haze is most of what sells the open-field look, and it is one line.
    scene.fog = new THREE.Fog(PALETTE.haze, PALETTE.fog[0], PALETTE.fog[1]);

    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 200);

    scene.add(new THREE.AmbientLight(0xffffff, 1.25));
    // The one light that casts. High and slightly behind the camera so shadows
    // fall away from the viewer the way they do in Gen 5.
    const sun = new THREE.DirectionalLight(0xffffff, PALETTE.sun);
    sun.position.set(-5, 11, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const sc = sun.shadow.camera;
    sc.left = -12; sc.right = 12; sc.top = 12; sc.bottom = -12; sc.near = 1; sc.far = 34;
    scene.add(sun);

    // Lambert, not Basic: a Basic material does not receive shadows.
    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(160, 160),
        new THREE.MeshLambertMaterial({ map: gradientTexture(THREE, [PALETTE.groundFar, PALETTE.groundNear]) })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    for (const o of buildBackdrop(THREE, PALETTE)) scene.add(o);

    const anchors = {
        near: new THREE.Vector3(NEAR_PLATFORM.x, PLATFORM_TOP, NEAR_PLATFORM.z),
        far: new THREE.Vector3(FAR_PLATFORM.x, PLATFORM_TOP, FAR_PLATFORM.z)
    };

    // ---------------------------------------------------------------- sprites
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');

    function makeMon(which) {
        const mat = new THREE.MeshBasicMaterial({
            transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, toneMapped: false
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        mesh.castShadow = true;
        mesh.visible = false;
        // Without a custom depth material the shadow pass ignores the artwork's
        // alpha and every Pokemon casts a rectangle. This is what makes the
        // shadow an actual silhouette of the Fakemon.
        mesh.customDepthMaterial = new THREE.MeshDepthMaterial({
            depthPacking: THREE.RGBADepthPacking, alphaTest: 0.35
        });
        scene.add(mesh);
        return {
            mesh, mat, aspect: 1, base: anchors[which].clone(), anim: null,
            hidden: true, url: '', status: null
        };
    }
    const mons = { near: makeMon('near'), far: makeMon('far') };

    // Places a Pokemon: scaled to SPRITE_HEIGHT, standing on the platform
    // (the plane is centred, so it lifts by half its height), with an optional
    // offset for whatever animation is running.
    function placeMon(m, { scale = 1, opacity = 1, tilt = 0, dx = 0, dy = 0, dz = 0 } = {}) {
        const h = SPRITE_HEIGHT * scale;
        m.mesh.scale.set(h * m.aspect, h, 1);
        m.mesh.position.set(m.base.x + dx, m.base.y + h / 2 + dy, m.base.z + dz);
        m.mesh.rotation.z = tilt;
        m.mat.opacity = opacity;
    }

    // ---------------------------------------------------------------- hazards
    // Entry hazards are persistent field state that the player has to plan
    // around, so they get real objects on the ground rather than only a line in
    // the log: Spikes and Toxic Spikes as caltrops scattered around the
    // platform, Stealth Rock as stones hanging in the air above it, Sticky Web
    // as a mat underfoot. Each side's set is rebuilt only when it changes.
    const hazardGeo = {
        spike: new THREE.ConeGeometry(0.085, 0.3, 4),
        toxicSpike: new THREE.ConeGeometry(0.075, 0.21, 4),
        rock: new THREE.IcosahedronGeometry(0.17, 0),
        web: new THREE.RingGeometry(0.55, 1.75, 24, 1)
    };
    const hazards = { near: { key: '', group: null }, far: { key: '', group: null } };

    // Deterministic scatter: the same hazard set always lays out the same way,
    // so adding a second layer of Spikes does not reshuffle the first. Both
    // clients of a battle therefore see the same field, and nothing jumps.
    function scatterAt(i, radius) {
        const a = i * 2.39996;                       // golden angle, spreads evenly
        const r = radius * (0.45 + ((i * 37) % 55) / 100);
        return [Math.cos(a) * r, Math.sin(a) * r];
    }

    function hazardKey(conds) {
        return ['spikes', 'toxicspikes', 'stealthrock', 'stickyweb']
            .map(k => `${k}:${conds?.[k] || 0}`).join('|');
    }

    function buildHazards(which, conds) {
        const group = new THREE.Group();
        group.position.copy(anchors[which]);

        // `seed` shifts a set into the gaps of the other, so a field carrying
        // both Spikes and Toxic Spikes does not stack one inside the other.
        const caltrops = (geo, color, count, tilt, seed) => {
            const mat = new THREE.MeshLambertMaterial({ color });
            for (let i = seed; i < seed + count; i++) {
                const [x, z] = scatterAt(i, 1.55);
                const m = new THREE.Mesh(geo, mat);
                m.position.set(x, geo.parameters.height / 2, z);
                // Leaning slightly, so a scattering of them does not read as a
                // row of identical pylons.
                m.rotation.set(Math.sin(i * 2.1) * tilt, i * 1.3, Math.cos(i * 1.7) * tilt);
                m.castShadow = true;
                group.add(m);
            }
        };

        // Layers deepen the field rather than stacking taller: more caltrops.
        if (conds.spikes) caltrops(hazardGeo.spike, 0x9aa1ab, 3 + conds.spikes * 3, 0.22, 0);
        if (conds.toxicspikes) caltrops(hazardGeo.toxicSpike, 0xa855c8, 3 + conds.toxicspikes * 3, 0.3, 40);

        if (conds.stealthrock) {
            const mat = new THREE.MeshLambertMaterial({ color: 0x8d7c63 });
            for (let i = 0; i < 6; i++) {
                const [x, z] = scatterAt(i + 2, 1.5);
                const m = new THREE.Mesh(hazardGeo.rock, mat);
                m.position.set(x, 1.1 + ((i * 29) % 70) / 60, z);
                m.rotation.set(i * 1.1, i * 0.7, i * 1.9);
                m.scale.setScalar(0.7 + ((i * 13) % 40) / 80);
                m.castShadow = true;
                group.add(m);
            }
        }

        if (conds.stickyweb) {
            const mat = new THREE.MeshBasicMaterial({
                color: 0xdfe6ee, transparent: true, opacity: 0.34,
                side: THREE.DoubleSide, depthWrite: false, wireframe: true
            });
            const web = new THREE.Mesh(hazardGeo.web, mat);
            web.rotation.x = -Math.PI / 2;
            web.position.y = 0.02;
            group.add(web);
        }

        return group;
    }

    function applyHazards(which, conds = {}) {
        const slot = hazards[which];
        const key = hazardKey(conds);
        if (key === slot.key) return;
        slot.key = key;
        if (slot.group) {
            scene.remove(slot.group);
            slot.group.traverse(o => { o.material?.dispose?.(); });
        }
        const empty = !conds.spikes && !conds.toxicspikes && !conds.stealthrock && !conds.stickyweb;
        slot.group = empty ? null : buildHazards(which, conds);
        if (slot.group) scene.add(slot.group);
        kick();
    }

    // Turns the floating stones over, but only while the loop is already
    // running for something else -- hazards never keep the scene awake on
    // their own, so an idle battle costs nothing.
    function stepHazards(now) {
        for (const which of ['near', 'far']) {
            const g = hazards[which].group;
            if (!g) continue;
            for (const child of g.children) {
                if (child.position.y > 0.6) child.rotation.y = now / 2400 + child.position.x;
            }
        }
    }

    // ---------------------------------------------------------------- effects
    const particles = [];
    const sharedGeo = {
        quad: new THREE.PlaneGeometry(1, 1),
        ring: new THREE.RingGeometry(0.42, 0.5, 28)
    };
    const ballGeo = new THREE.SphereGeometry(0.5, 20, 14);
    let ballTex = null;
    const ballTexture = (T) => (ballTex ||= makeBallTexture(T));

    function addParticle(geo, color, opts) {
        const mat = new THREE.MeshBasicMaterial({
            color, transparent: true, opacity: 1, side: THREE.DoubleSide,
            depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(opts.from);
        scene.add(mesh);
        const p = { mesh, mat, born: performance.now(), life: 500, size: 0.3, ...opts };
        particles.push(p);
        return p;
    }

    let alive = true;
    let onFrame = null;
    let running = false;
    const restShot = solveShot(THREE, CAMERA_SHOTS.rest, anchors);
    camera.position.copy(restShot.pos);
    camera.lookAt(restShot.look);
    const lookTarget = restShot.look.clone();
    let shakeUntil = 0, shakeMag = 0;
    let panToken = 0;

    function stepMon(m, now) {
        if (!m.anim) return false;
        const a = m.anim;
        const t = Math.min(1, (now - a.born) / a.ms);
        if (a.kind === 'summon') placeMon(m, { scale: 0.15 + 0.85 * easeOutBack(t) });
        else if (a.kind === 'faint') placeMon(m, { opacity: 1 - t, dy: -1.7 * t * t, tilt: t * 0.9 });
        else if (a.kind === 'hit') placeMon(m, { dx: Math.sin(t * Math.PI * 7) * 0.2 * (1 - t) });
        else if (a.kind === 'dash') {
            const lunge = Math.sin(Math.min(1, t * 1.5) * Math.PI);
            placeMon(m, { dx: a.dir.x * lunge * 1.5, dz: a.dir.z * lunge * 1.5, dy: lunge * 0.2 });
        } else if (a.kind === 'recoil') {
            const back = Math.sin(t * Math.PI);
            placeMon(m, { dx: -a.dir.x * back * 0.55, dz: -a.dir.z * back * 0.55 });
        } else if (a.kind === 'contact') {
            // Close the whole distance, land the hit, come back: run in on the
            // first 45%, hold through the impact, retreat over the rest.
            let k;
            if (t < 0.45) k = ease(t / 0.45, 'out');
            else if (t < 0.58) k = 1;
            else k = 1 - ease((t - 0.58) / 0.42, 'inout');
            placeMon(m, {
                dx: a.delta.x * k, dz: a.delta.z * k,
                dy: Math.sin(Math.min(1, t / 0.45) * Math.PI) * 0.28
            });
        }
        if (t >= 1) {
            m.anim = null;
            placeMon(m, { opacity: a.kind === 'faint' ? 0 : 1 });
            if (m.hidden) m.mesh.visible = false;
            return false;
        }
        return true;
    }

    function stepParticles(now) {
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            const t = (now - p.born) / p.life;
            if (t < 0) continue;                       // staggered spawn, not born yet
            if (t >= 1) {
                scene.remove(p.mesh);
                p.mat.dispose();
                particles.splice(i, 1);
                continue;
            }
            if (p.to) p.mesh.position.lerpVectors(p.from, p.to, ease(t, p.mode));
            if (p.arc) p.mesh.position.y += p.arc * Math.sin(t * Math.PI);
            if (p.tumble) p.mesh.rotation.set(t * 14, t * 9, 0);
            if (!p.fixed) {
                p.mesh.scale.setScalar(p.size * (1 + (p.grow || 0) * t));
                if (p.flat) p.mesh.rotation.x = -Math.PI / 2;
                else if (!p.spin) p.mesh.quaternion.copy(camera.quaternion);
            }
            if (p.spin) p.mesh.rotation.z += p.spin;
            p.mat.opacity = p.solid ? 1 : 1 - Math.max(0, t - 0.35) / 0.65;
        }
        return particles.length > 0;
    }

    function frame() {
        if (!alive) return;
        const now = performance.now();
        let busy = false;
        for (const which of ['near', 'far']) {
            const m = mons[which];
            if (m.mesh.visible) {
                // Upright billboard: yaw only, so it always faces the camera but
                // never tips over like a full lookAt would.
                m.mesh.rotation.y = Math.atan2(camera.position.x - m.mesh.position.x,
                                               camera.position.z - m.mesh.position.z);
            }
            if (stepMon(m, now)) busy = true;
        }
        if (stepParticles(now)) busy = true;
        stepHazards(now);
        if (now < shakeUntil) {
            const k = (shakeUntil - now) / 260;
            camera.position.x += Math.sin(now / 11) * shakeMag * k;
            camera.position.y += Math.cos(now / 9) * shakeMag * k * 0.6;
            camera.lookAt(lookTarget);
            busy = true;
        }
        renderer.render(scene, camera);
        onFrame?.();
        if (busy) requestAnimationFrame(frame);
        else running = false;
    }

    function kick() { if (!running && alive) { running = true; requestAnimationFrame(frame); } }

    const render = () => { if (alive) { renderer.render(scene, camera); onFrame?.(); } };

    const resize = () => {
        const w = fieldEl.clientWidth || 640;
        const h = fieldEl.clientHeight || 360;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        render();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(fieldEl);

    // ---- team preview ----
    // Twelve billboards in two ranks. They share the sprite material setup but
    // not the battle meshes, so showing and clearing the preview never disturbs
    // whatever the battle itself is doing.
    let previewMeshes = [];

    function clearPreview() {
        for (const mesh of previewMeshes) {
            scene.remove(mesh);
            mesh.material.map?.dispose();
            mesh.material.dispose();
            mesh.geometry.dispose();
        }
        previewMeshes = [];
    }

    function addPreviewRank(urls, z, facing) {
        const count = Math.max(1, urls.length);
        // Centre the rank on x = 0 whatever its size.
        const start = -((count - 1) / 2) * PREVIEW_ROW.spread;
        urls.forEach((url, i) => {
            const mat = new THREE.MeshBasicMaterial({
                transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, toneMapped: false,
                opacity: url ? 1 : 0.28, color: url ? 0xffffff : 0x2a3444
            });
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
            mesh.castShadow = true;
            mesh.customDepthMaterial = new THREE.MeshDepthMaterial({
                depthPacking: THREE.RGBADepthPacking, alphaTest: 0.35
            });
            const h = PREVIEW_ROW.height;
            mesh.scale.set(h, h, 1);
            mesh.position.set(start + i * PREVIEW_ROW.spread, h / 2, z);
            mesh.rotation.y = facing;
            scene.add(mesh);
            previewMeshes.push(mesh);
            if (!url) return;
            loader.load(url, (tex) => {
                if (!alive || !previewMeshes.includes(mesh)) { tex.dispose(); return; }
                tex.colorSpace = THREE.SRGBColorSpace;
                mat.map = tex;
                mat.needsUpdate = true;
                mesh.customDepthMaterial.map = tex;
                mesh.customDepthMaterial.needsUpdate = true;
                const aspect = (tex.image?.width || 1) / (tex.image?.height || 1);
                mesh.scale.set(h * aspect, h, 1);
                render();
            }, undefined, () => {});
        });
    }

    const api = {
        // Both teams lined up facing each other, before anyone is sent out.
        // `mine` and `theirs` are arrays of artwork URLs; a falsy entry draws as
        // an unrevealed silhouette.
        showTeamPreview(mine, theirs) {
            clearPreview();
            // Yours nearer the camera, theirs across the field, each rank turned
            // to face the other.
            addPreviewRank(mine, PREVIEW_ROW.z, 0);
            addPreviewRank(theirs, -PREVIEW_ROW.z, Math.PI);
            for (const which of ['near', 'far']) mons[which].mesh.visible = false;
            this.panTo('preview', 0);
            kick();
        },

        hideTeamPreview() {
            clearPreview();
            render();
        },

        // Screen position of a platform in % of the field box, for the statbars
        // and anything still living in the DOM.
        project(which) {
            const v = anchors[which].clone().project(camera);
            return { x: (v.x * 0.5 + 0.5) * 100, y: (-v.y * 0.5 + 0.5) * 100, visible: v.z < 1 };
        },

        setSprite(which, url) {
            const m = mons[which];
            if (!url) { m.mesh.visible = false; return; }
            if (m.url === url) { m.mesh.visible = !m.hidden; kick(); return; }
            m.url = url;
            loader.load(url, (tex) => {
                if (!alive) { tex.dispose(); return; }
                tex.colorSpace = THREE.SRGBColorSpace;
                m.mat.map = tex;
                m.mat.needsUpdate = true;
                m.mesh.customDepthMaterial.map = tex;
                m.mesh.customDepthMaterial.needsUpdate = true;
                m.aspect = (tex.image?.width || 1) / (tex.image?.height || 1);
                placeMon(m);
                m.mesh.visible = !m.hidden;
                kick();
            }, undefined, () => { m.mesh.visible = false; });
        },

        // A Poke Ball lobbed from its trainer's corner onto the platform.
        // Returns the flight time so the caller can time the send-out to it.
        throwBall(which, ms = 620) {
            const from = new THREE.Vector3(...THROW_FROM[which]);
            const to = anchors[which].clone().setY(anchors[which].y + 0.35);
            const ball = addParticle(ballGeo, 0xffffff, {
                from, to, life: ms, size: 0.001, mode: 'out',
                arc: 2.6, tumble: true, solid: true, fixed: true
            });
            ball.mesh.material.map = ballTexture(THREE);
            ball.mesh.material.color.set(0xffffff);
            ball.mesh.material.blending = THREE.NormalBlending;
            ball.mesh.material.needsUpdate = true;
            ball.mesh.scale.setScalar(0.34);
            kick();
            return ms;
        },

        // The entry hazards standing on one side of the field, as
        // { spikes, toxicspikes, stealthrock, stickyweb } layer counts.
        setHazards(which, conditions) {
            applyHazards(which, conditions || {});
        },

        // Tints the Pokemon while a status is on it, and flashes a burst in the
        // same colour when it lands. Cleared by passing null.
        setStatus(which, status) {
            const m = mons[which];
            m.status = status || null;
            const c = STATUS_COLORS[status];
            m.mat.color.set(c ?? 0xffffff);
            if (c) {
                for (let i = 0; i < 10; i++) {
                    const a = (i / 10) * Math.PI * 2;
                    addParticle(sharedGeo.quad, c, {
                        from: m.base.clone().setY(m.base.y + 1.2),
                        to: m.base.clone().setY(m.base.y + 1.2)
                            .add(new THREE.Vector3(Math.cos(a) * 1.1, Math.random() * 1.4, Math.sin(a) * 1.1)),
                        life: 620, size: 0.22, mode: 'out'
                    });
                }
            }
            kick();
        },

        setHidden(which, hidden) {
            const m = mons[which];
            m.hidden = !!hidden;
            // A faint animation owns the mesh until it finishes, so a repaint
            // that marks the mon gone must not snap it off screen first.
            if (hidden && m.anim?.kind === 'faint') return;
            m.mesh.visible = !hidden && !!m.mat.map;
            if (!hidden) placeMon(m);
            kick();
        },

        playSpriteAnim(which, kind, ms = 460) {
            const m = mons[which];
            if (!m) return;
            const other = which === 'near' ? 'far' : 'near';
            const toOther = anchors[other].clone().sub(anchors[which]);
            m.anim = {
                kind, ms: Math.max(1, ms), born: performance.now(),
                dir: toOther.clone().normalize(),
                // Stop just short so the attacker lands on the target rather
                // than inside it.
                delta: toOther.multiplyScalar(0.72)
            };
            kick();
        },

        shake(mag = 0.16) {
            shakeUntil = performance.now() + 260;
            shakeMag = mag;
            kick();
        },

        // World-space move effects, using the same shape vocabulary as the DOM
        // version in move-anim.js so scene.js chooses the effect once and either
        // renderer can draw it.
        playFX(shape, { type = 'Normal', count = 8, fromSide = 'near', toSide = 'far' } = {}) {
            const [c1, c2] = (TYPE_COLORS[type] || TYPE_COLORS.Normal).map(h => Number('0x' + h.slice(1)));
            const from = anchors[fromSide].clone().setY(anchors[fromSide].y + 1.2);
            const to = anchors[toSide].clone().setY(anchors[toSide].y + 1.2);
            const jitter = (r) => (Math.random() - 0.5) * r;
            const now = performance.now();

            switch (shape) {
                case 'beam': {
                    const mid = from.clone().lerp(to, 0.5);
                    const p = addParticle(sharedGeo.quad, c2, { from: mid, life: 460, fixed: true });
                    p.mesh.scale.set(from.distanceTo(to), 0.36, 1);
                    p.mesh.lookAt(to);
                    p.mesh.rotateY(Math.PI / 2);
                    break;
                }
                case 'sound':
                    for (let i = 0; i < count; i++) {
                        addParticle(sharedGeo.ring, c1, {
                            from: from.clone(), life: 620, size: 0.5, grow: 7, mode: 'out',
                            born: now + i * 95
                        });
                    }
                    break;
                case 'quake':
                    for (let i = 0; i < count; i++) {
                        addParticle(sharedGeo.ring, c1, {
                            from: to.clone().setY(PLATFORM_TOP + 0.06), life: 600, size: 0.7, grow: 6,
                            flat: true, mode: 'out', born: now + i * 85
                        });
                    }
                    break;
                case 'drain':
                    for (let i = 0; i < count; i++) {
                        addParticle(sharedGeo.quad, c2, {
                            from: to.clone().add(new THREE.Vector3(jitter(1.4), jitter(1.5), jitter(1.4))),
                            to: from.clone(), life: 720, size: 0.2, mode: 'inout', born: now + Math.random() * 200
                        });
                    }
                    break;
                case 'explode':
                    addParticle(sharedGeo.quad, 0xffffff, { from: to.clone(), life: 420, size: 1.1, grow: 4, mode: 'out' });
                    for (let i = 0; i < count; i++) {
                        const a = (i / count) * Math.PI * 2;
                        addParticle(sharedGeo.quad, i % 2 ? c1 : c2, {
                            from: to.clone(),
                            to: to.clone().add(new THREE.Vector3(Math.cos(a) * 3.2, Math.random() * 2.2, Math.sin(a) * 3.2)),
                            life: 640, size: 0.3, mode: 'out'
                        });
                    }
                    break;
                case 'slash':
                    for (let i = 0; i < count; i++) {
                        const p = addParticle(sharedGeo.quad, c2, {
                            from: to.clone().add(new THREE.Vector3(jitter(0.7), jitter(0.9), 0.1)),
                            life: 400, fixed: true, born: now + i * 80
                        });
                        p.mesh.quaternion.copy(camera.quaternion);
                        p.mesh.scale.set(2.6, 0.14, 1);
                        p.mesh.rotateZ(i % 2 ? 0.5 : -0.5);
                    }
                    break;
                case 'ring':
                    for (let i = 0; i < count; i++) {
                        addParticle(sharedGeo.ring, c1, {
                            from: to.clone(), life: 620, size: 0.6, grow: 4, mode: 'out', born: now + i * 120
                        });
                    }
                    break;
                case 'wave':
                    for (let i = 0; i < count; i++) {
                        addParticle(sharedGeo.quad, c1, {
                            from: from.clone().lerp(to, (i + 1) / (count + 1)),
                            life: 560, size: 0.45, grow: 1.8, mode: 'out', born: now + i * 55
                        });
                    }
                    break;
                default: // burst / orb / shard / wisp / bolt all read as a scatter
                    for (let i = 0; i < count; i++) {
                        const a = (i / count) * Math.PI * 2;
                        const r = shape === 'shard' ? 1.7 : 1.15;
                        addParticle(sharedGeo.quad, i % 2 ? c1 : c2, {
                            from: to.clone(),
                            to: to.clone().add(new THREE.Vector3(Math.cos(a) * r, jitter(1.5), Math.sin(a) * r)),
                            life: 520, size: shape === 'orb' ? 0.32 : 0.22, mode: 'out',
                            spin: shape === 'shard' ? 0.25 : 0
                        });
                    }
            }
            kick();
        },

        panTo(shotName, ms = 420) {
            const solved = solveShot(THREE, CAMERA_SHOTS[shotName] || CAMERA_SHOTS.rest, anchors);
            const fromPos = camera.position.clone();
            const toPos = solved.pos;
            const fromLook = lookTarget.clone();
            const toLook = solved.look;
            const token = ++panToken;
            if (ms <= 0) {
                camera.position.copy(toPos);
                lookTarget.copy(toLook);
                camera.lookAt(lookTarget);
                render();
                return Promise.resolve();
            }
            const start = performance.now();
            return new Promise(resolve => {
                const step = (now) => {
                    if (!alive || token !== panToken) return resolve();
                    const t = Math.min(1, (now - start) / ms);
                    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
                    camera.position.lerpVectors(fromPos, toPos, e);
                    lookTarget.lerpVectors(fromLook, toLook, e);
                    camera.lookAt(lookTarget);
                    render();
                    if (t < 1) requestAnimationFrame(step);
                    else resolve();
                };
                requestAnimationFrame(step);
            });
        },

        setFrameHook(fn) { onFrame = fn; fn?.(); },

        destroy() {
            alive = false;
            panToken++;
            onFrame = null;
            clearPreview();
            observer.disconnect();
            for (const p of particles) { scene.remove(p.mesh); p.mat.dispose(); }
            particles.length = 0;
            sharedGeo.quad.dispose();
            sharedGeo.ring.dispose();
            for (const g of Object.values(hazardGeo)) g.dispose();
            ballGeo.dispose();
            ballTex?.dispose();
            scene.traverse(o => {
                o.geometry?.dispose?.();
                o.material?.map?.dispose?.();
                o.material?.dispose?.();
            });
            scene.background?.dispose?.();
            renderer.dispose();
            canvas.remove();
            fieldEl.classList.remove('has-field3d');
        }
    };
    return api;
}

function easeOutBack(t) {
    const c = 2.70158;
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
}
function ease(t, mode) {
    if (mode === 'out') return 1 - Math.pow(1 - t, 3);
    if (mode === 'inout') return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    return t;
}

// Rolling hills ringed well outside the fight. One shared sphere geometry, one
// flat colour each, no textures -- seven draws, and the fog does the rest.
//
// ponytail: fixed layout rather than seeded noise. Swap in a seeded RNG if the
// hills ever need to differ per battle.
function buildBackdrop(THREE, palette) {
    const hillGeo = new THREE.SphereGeometry(1, 10, 6);
    // [x, z, radius, flatten, near?]
    return [
        [-34, -46, 17, 0.42, false], [6, -58, 22, 0.38, false],
        [42, -40, 15, 0.45, false], [-52, -14, 13, 0.40, false],
        [-20, -30, 10, 0.50, true], [26, -26, 9, 0.52, true],
        [54, 6, 12, 0.44, false]
    ].map(([x, z, r, flat, near]) => {
        const m = new THREE.Mesh(hillGeo, new THREE.MeshLambertMaterial({
            color: near ? palette.hillNear : palette.hillFar, flatShading: true
        }));
        m.position.set(x, -r * flat * 0.35, z);
        m.scale.set(r, r * flat, r);
        return m;
    });
}

// Red over black band over white: the ball reads correctly from any angle
// because the texture wraps the sphere vertically.
function makeBallTexture(THREE) {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ee3d34'; ctx.fillRect(0, 0, 4, 28);
    ctx.fillStyle = '#1c1c1c'; ctx.fillRect(0, 28, 4, 8);
    ctx.fillStyle = '#f7f7f7'; ctx.fillRect(0, 36, 4, 28);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

function gradientTexture(THREE, [top, bottom]) {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, hex(top));
    grad.addColorStop(1, hex(bottom));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 2, 256);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}
