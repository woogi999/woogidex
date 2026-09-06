// ==================== battle scene ====================
// Layout geometry and animation timing adapted from Pokémon Showdown's client
// (MIT licensed, smogon/pokemon-showdown-client): the scene box/statbar
// sizing, near/far mon placement, replaying the log over time instead of
// snapping to the final state, and its move/switch/HP/faint timings.
//
// Showdown's sprites, backgrounds and audio are NOT MIT-licensed, so none are
// used here -- the field is CSS-drawn and every sprite is original artwork.
//
// This file never touches battle state -- the engine has already resolved
// the turn by the time the scene sees it, so PvP lockstep stays unaffected
// by animation.

import { playMoveFX, resolveMoveInfo, shapeFor, MOVE_FX_MS } from './move-anim.js';
import { mountField3D, fieldForSeed } from './field3d.js';

export const SCENE_SPEEDS = [
    { id: 'instant', label: 'Instant', scale: 0 },
    { id: 'fast', label: 'Fast', scale: 0.55 },
    { id: 'normal', label: 'Normal', scale: 1 },
    { id: 'slow', label: 'Slow', scale: 1.7 }
];

import { esc } from '../../core/html.js';

// Which side a log reference like "p1a" belongs to.
function sideOfRef(ref) { return String(ref).startsWith('p2') ? 1 : 0; }

// Showdown targets that never leave the user's own side. A Swords Dance has
// nobody to cut to, so the camera stays where it is.
const SELF_TARGETS = new Set(['self', 'allySide', 'allies', 'adjacentAllyOrSelf']);

// How long a contact lunge runs, shared with the camera so the two stay in step.
const CONTACT_MS = 620;

function prefersReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch { return false; }
}

export class BattleScene {
    constructor({ battle, mySide, formatLine, onPhaseChange, field }) {
        this.battle = battle;
        this.mySide = mySide;
        this.formatLine = formatLine || (() => '');
        this.onPhaseChange = onPhaseChange || (() => {});

        this.speed = prefersReducedMotion() ? 'instant' : 'normal';
        this.root = null;
        this.logEl = null;
        this.els = null;

        this.queue = [];
        this.cursor = 0;          // how far through battle.log we've animated
        // Whether each side's Pokemon has actually been sent out on screen yet.
        // The 3D meshes are pushed as soon as the field mounts, so without this
        // both leads were already standing on the field before their Poke Balls
        // were thrown. A scene attached to a battle already in progress starts
        // with both out, which is the truth for everything except the intro.
        this._sentOut = [true, true];
        // Set once a move has left the camera on its target; cleared when the
        // camera is brought home at the end of the queue.
        this.restPending = false;
        this.running = false;
        this.skipping = false;
        this.destroyed = false;

        this.vis = this._freshVis();
        // One biome per battle, derived from the seed so both clients of a
        // battle really do see the same place -- drawing it at random meant
        // they never did, whatever this comment used to claim. The caller can
        // pass one in so the lead preview and the battle agree.
        this.field = field || fieldForSeed(battle?.seed);
    }

    // Visual state, deliberately separate from the engine's. It lags behind
    // during animation and catches up as log entries play.
    _freshVis() {
        return {
            turn: 0,
            weather: null,
            terrain: null,
            sides: this.battle.sides.map(side => ({
                activeIndex: side.activeIndex,
                // Entry hazards, as layer counts -- drawn on the field in 3D.
                conditions: Object.fromEntries(
                    Object.entries(side.conditions || {}).map(([k, v]) => [k, v.layers || 1])),
                mons: side.team.map(m => ({
                    hp: m.hp, maxhp: m.maxhp, status: m.status,
                    fainted: m.fainted, types: [...m.types],
                    boosts: { ...m.boosts }
                }))
            }))
        };
    }

    // ---------------------------------------------------------------- mount
    mount(root, logEl) {
        this.root = root;
        this.logEl = logEl;
        root.innerHTML = `
          <div class="ps-field">
            <div class="ps-sky"></div>
            <div class="ps-ground"></div>
            <div class="ps-weather" data-w=""></div>
            <div class="ps-platform ps-platform-far"></div>
            <div class="ps-platform ps-platform-near"></div>

            <div class="ps-slot ps-slot-far">
              <div class="ps-fx"></div>
              <img class="ps-sprite" alt="">
            </div>
            <div class="ps-slot ps-slot-near">
              <div class="ps-fx"></div>
              <img class="ps-sprite" alt="">
            </div>

            ${this._statbarHTML('far')}
            ${this._statbarHTML('near')}

            <div class="ps-turnbox"><span class="ps-turnnum">-</span></div>
            <div class="ps-movebanner"></div>
          </div>`;

        const pick = sel => root.querySelector(sel);
        this.els = {
            field: pick('.ps-field'),
            weather: pick('.ps-weather'),
            turn: pick('.ps-turnnum'),
            banner: pick('.ps-movebanner'),
            far: this._slotEls(root, 'far'),
            near: this._slotEls(root, 'near')
        };
        this.paint();
        // Fire-and-forget: the DOM scene is already usable, and if three.js
        // never arrives the CSS field underneath just stays visible.
        mountField3D(this.els.field, this.field).then(f => {
            if (this.destroyed || !f) return f?.destroy();
            this.field3d = f;
            this._push3DSprites();
            // A battle rejoined mid-way already has hazards on the ground.
            for (const i of [0, 1]) this._paintHazards(i);
            // From here the two .ps-slot boxes are positioned by the 3D scene
            // rather than by the CSS percentages, so they track the camera.
            f.setFrameHook(() => this._syncSlotsTo3D());
        });
    }

    _statbarHTML(which) {
        return `
          <div class="ps-statbar ps-statbar-${which}">
            <div class="ps-statbar-top">
              <span class="ps-mon-name"></span>
              <span class="ps-mon-lvl"></span>
              <span class="ps-mon-status"></span>
            </div>
            <div class="ps-hpbar"><div class="ps-hp"></div></div>
            <div class="ps-statbar-bottom">
              <span class="ps-hptext"></span>
              <span class="ps-boosts"></span>
            </div>
            <div class="ps-teamicons"></div>
          </div>`;
    }

    _slotEls(root, which) {
        const slot = root.querySelector(`.ps-slot-${which}`);
        const bar = root.querySelector(`.ps-statbar-${which}`);
        return {
            slot, fx: slot.querySelector('.ps-fx'), sprite: slot.querySelector('.ps-sprite'),
            bar,
            name: bar.querySelector('.ps-mon-name'), lvl: bar.querySelector('.ps-mon-lvl'),
            status: bar.querySelector('.ps-mon-status'), hp: bar.querySelector('.ps-hp'),
            hptext: bar.querySelector('.ps-hptext'), boosts: bar.querySelector('.ps-boosts'),
            icons: bar.querySelector('.ps-teamicons')
        };
    }

    // `far` is always the opponent, `near` always the viewer -- so both
    // players see themselves in the foreground, the way Showdown does.
    _elsFor(sideIndex) { return sideIndex === this.mySide ? this.els.near : this.els.far; }

    // Pins each .ps-slot over the platform it stands on, sized by how far the
    // camera currently is. The <img> inside is unchanged, so it stays a flat
    // image facing the viewer -- a billboard -- while its position, footing and
    // scale all come from the 3D scene.
    // Every camera move goes through here so 'instant' speed and
    // prefers-reduced-motion both cut to the shot instead of gliding to it.
    _pan(shot, ms) {
        if (!this.field3d) return Promise.resolve();
        return this.field3d.panTo(shot, this._animating() && !prefersReducedMotion() ? ms : 0);
    }

    // The Pokemon themselves are meshes in the 3D scene now, but .ps-slot is
    // still the anchor the result text and the DOM fallback FX are positioned
    // against, so it is kept pinned over each platform.
    _syncSlotsTo3D() {
        const f = this.field3d;
        if (!f || !this.els) return;
        for (const which of ['near', 'far']) {
            const el = this.els[which].slot;
            if (!el) continue;
            const p = f.project(which);
            el.style.transform = 'translate(-50%,-100%)';
            el.style.left = `${p.x}%`;
            el.style.top = `${p.y}%`;
            el.style.opacity = p.visible ? '' : '0';
        }
    }

    // Mirrors whichever Pokemon is out onto the 3D scene.
    _push3DSprites() {
        const f = this.field3d;
        if (!f) return;
        for (const which of ['near', 'far']) {
            const sideIndex = which === 'near' ? this.mySide : 1 - this.mySide;
            const vside = this.vis.sides[sideIndex];
            const idx = vside?.activeIndex ?? 0;
            const art = this.battle.sides[sideIndex]?.team?.[idx]?.species?.artwork || '';
            const out = !!art && !vside?.mons?.[idx]?.fainted && this._sentOut[sideIndex];
            f.setSprite(which, art);
            f.setHidden(which, !out);
        }
    }

    _side3D(sideIndex) { return sideIndex === this.mySide ? 'near' : 'far'; }

    // Keeps each mesh's status tint in step with the vis model, so a Pokemon
    // that switches in already burned looks burned.
    _push3DStatus() {
        const f = this.field3d;
        if (!f) return;
        for (const which of ['near', 'far']) {
            const sideIndex = which === 'near' ? this.mySide : 1 - this.mySide;
            const vside = this.vis.sides[sideIndex];
            f.setStatus(which, vside?.mons?.[vside.activeIndex]?.status || null);
        }
    }

    // ---------------------------------------------------------------- paint
    // Snaps every visual to the current vis model. Used on mount, on resize,
    // and after a fast-forward.
    paint() {
        if (!this.els) return;
        for (let s = 0; s < 2; s++) this._paintSide(s);
        this.els.turn.textContent = this.vis.turn || '-';
        this.els.weather.dataset.w = this.vis.weather || '';
        this.els.field.dataset.terrain = this.vis.terrain || '';
    }

    _paintSide(sideIndex) {
        if (!this.els) return;
        const els = this._elsFor(sideIndex);
        const side = this.battle.sides[sideIndex];
        const vside = this.vis.sides[sideIndex];
        const idx = vside.activeIndex;
        const mon = side.team[idx];
        const vmon = vside.mons[idx];
        if (!mon || !vmon) return;

        this._push3DSprites();
        els.sprite.src = mon.species.artwork || '';
        els.sprite.alt = mon.name;
        els.sprite.classList.toggle('is-artless', !mon.species.artwork);
        els.name.textContent = mon.name;
        els.lvl.textContent = `L${mon.level}`;

        const pct = vmon.maxhp ? Math.max(0, (vmon.hp / vmon.maxhp) * 100) : 0;
        els.hp.style.width = `${pct}%`;
        els.hp.className = `ps-hp ${pct > 50 ? 'is-high' : pct > 20 ? 'is-mid' : 'is-low'}`;
        // Only the viewer sees their own exact HP; the opponent's reads as a
        // percentage, matching how a real battle hides that information.
        els.hptext.textContent = sideIndex === this.mySide
            ? `${Math.max(0, vmon.hp)}/${vmon.maxhp}`
            : `${Math.round(pct)}%`;

        els.status.textContent = vmon.status ? vmon.status.toUpperCase() : '';
        els.status.className = `ps-mon-status ${vmon.status ? `status-${vmon.status}` : 'is-empty'}`;

        const shown = Object.entries(vmon.boosts).filter(([, v]) => v);
        els.boosts.innerHTML = shown.map(([k, v]) =>
            `<span class="ps-boost ${v > 0 ? 'is-up' : 'is-down'}">${esc(k.slice(0, 3))}${v > 0 ? '+' : ''}${v}</span>`).join('');

        els.icons.innerHTML = side.team.map((m, i) => {
            const vm = vside.mons[i];
            const st = !vm.fainted && vm.status ? `status-${vm.status}` : '';
            const label = vm.status ? `${m.name} (${String(vm.status).toUpperCase()})` : m.name;
            return `<span class="ps-ball ${vm.fainted ? 'is-fainted' : ''} ${i === idx ? 'is-active' : ''} ${st}" title="${esc(label)}"></span>`;
        }).join('');

        els.slot.classList.toggle('is-fainted', !!vmon.fainted);
    }

    // Hazards going up or coming down. The layer count is what changes when a
    // second Spikes lands, and the field reads it to decide how much to draw.
    async _doSideCondition(ref, id, layers) {
        const sideIndex = sideOfRef(ref);
        const conds = this.vis.sides[sideIndex].conditions;
        if (layers > 0) conds[id] = layers; else delete conds[id];
        this._paintHazards(sideIndex);
        await this._wait(120);
    }

    _paintHazards(sideIndex) {
        this.field3d?.setHazards(this._side3D(sideIndex), this.vis.sides[sideIndex].conditions);
    }

    // Catches the visuals up to the engine with no animation. Used after a
    // reconnect resync, where replaying every missed turn would be absurd.
    snapToEngine() {
        this._sentOut = [true, true];
        this.queue.length = 0;
        this.vis = this._freshVis();
        this.vis.turn = this.battle.turn;
        this.vis.weather = this.battle.field?.weather || null;
        this.vis.terrain = this.battle.field?.terrain || null;
        this.cursor = this.battle.log.length;
        this.rebuildLog();
        this.paint();
        for (const i of [0, 1]) this._paintHazards(i);
    }

    // ---------------------------------------------------------------- queue
    // Feeds everything the engine has logged since we last animated.
    pump() {
        const log = this.battle.log;
        // The engine doesn't log the opening leads (they're just already out
        // at activeIndex 0), so the scene stages its own send-out for them.
        if (!this._introDone) { this._introDone = true; this.queue.push(['__intro']); }
        for (let i = this.cursor; i < log.length; i++) this.queue.push(log[i]);
        this.cursor = log.length;
        return this.running ? Promise.resolve() : this._drain();
    }

    get busy() { return this.running; }

    setSpeed(id) {
        this.speed = id;
        if (id === 'instant' && this.running) this.skip();
    }

    skip() { this.skipping = true; }

    async _drain() {
        if (this.running) return;
        this.running = true;
        this.onPhaseChange(true);
        try {
            while (this.queue.length && !this.destroyed) {
                await this._playEntry(this.queue.shift());
            }
            // Everything that followed the last move has now played, so the
            // camera comes home -- rather than leaving before the effects it
            // was framing had happened.
            if (this.restPending && !this.destroyed) {
                this.restPending = false;
                await this._pan('rest', 340);
            }
        } catch { /* a broken animation must never strand the battle UI */ }
        this.restPending = false;
        this.running = false;
        this.skipping = false;
        this.paint();          // guarantee we land exactly on the vis model
        this.onPhaseChange(false);
    }

    // Every await in an animation goes through here, so flipping `skipping`
    // collapses the rest of the queue instantly.
    _wait(ms) {
        const scale = SCENE_SPEEDS.find(s => s.id === this.speed)?.scale ?? 1;
        const real = Math.round(ms * scale);
        if (this.skipping || real <= 0) return Promise.resolve();
        return new Promise(r => setTimeout(r, real));
    }

    _animating() {
        const scale = SCENE_SPEEDS.find(s => s.id === this.speed)?.scale ?? 1;
        return !this.skipping && scale > 0;
    }

    // ---------------------------------------------------------------- entries
    async _playEntry(entry) {
        const [kind, ...rest] = entry;
        switch (kind) {
            case '__intro': await this._doIntro(); break;
            case 'turn': await this._doTurn(rest[0]); break;
            case 'switch': await this._doSwitch(rest[0], rest[1], rest[2]); break;
            case 'move': await this._doMove(rest[0], rest[1], rest[2]); break;
            case '-damage': await this._doHPChange(rest[0], rest[1], rest[2], 'damage'); break;
            case '-heal': await this._doHPChange(rest[0], rest[1], rest[2], 'heal'); break;
            case 'faint': await this._doFaint(rest[0]); break;
            case '-status': await this._doStatus(rest[0], rest[1]); break;
            case '-curestatus': await this._doCureStatus(rest[0]); break;
            case '-boost': await this._doBoost(rest[0], rest[1], Number(rest[2]), 1); break;
            case '-unboost': await this._doBoost(rest[0], rest[1], Number(rest[2]), -1); break;
            case '-clearboost': await this._doClearBoost(rest[0]); break;
            case '-crit': await this._doResult(rest[0], 'Critical hit!', 'crit'); break;
            case '-supereffective': await this._doResult(rest[0], 'Super effective', 'good'); break;
            case '-resisted': await this._doResult(rest[0], 'Not very effective', 'weak'); break;
            case '-immune': await this._doResult(rest[0], 'No effect', 'weak'); break;
            case '-miss': await this._doResult(rest[1] || rest[0], 'Missed!', 'weak'); break;
            case '-weather': await this._doWeather(rest[0]); break;
            case '-fieldstart': await this._doTerrain(rest[0]); break;
            case '-fieldend': await this._doTerrain(null); break;
            case '-ability': await this._doResult(rest[0], rest[1] || 'Ability', 'ability'); break;
            case '-enditem': await this._doResult(rest[0], rest[1] || 'Item', 'ability'); break;
            case '-start': await this._doStart(rest[0], rest[1], rest[2]); break;
            case '-sidestart': await this._doSideCondition(rest[0], rest[1], Number(rest[2]) || 1); break;
            case '-sideend': await this._doSideCondition(rest[0], rest[1], 0); break;
            case 'cant': await this._doResult(rest[0], 'Cannot move', 'weak'); break;
            case '-prepare': await this._doResult(rest[0], `Charging ${rest[1] || ''}`.trim(), 'ability'); break;
            default: break;                    // purely informational lines
        }
        this.appendLogLine(entry);
        await this._wait(40);
    }

    // Sends out both leads at the start of a battle: opponent first, then
    // you, the way a real match opens.
    async _doIntro() {
        if (!this.els || !this._animating()) { this._sentOut = [true, true]; return; }
        // An empty field to begin with -- in the 3D scene as well as the DOM.
        // Hiding only the DOM slot left the 3D Pokemon standing there waiting
        // for a ball that had not been thrown yet.
        this._sentOut = [false, false];
        for (const s of [0, 1]) {
            const els = this._elsFor(s);
            els.slot.classList.add('is-empty');
            els.bar.classList.add('is-hidden');
            this.field3d?.setHidden(this._side3D(s), true);
        }
        await this._wait(200);
        for (const s of [1 - this.mySide, this.mySide]) {
            const els = this._elsFor(s);
            this._throwBall(s);
            await this._wait(300);
            this._sentOut[s] = true;
            els.slot.classList.remove('is-empty');
            els.slot.classList.add('is-summoning');
            this._push3DSprites();
            this._push3DStatus();
            this.field3d?.playSpriteAnim(this._side3D(s), 'summon', 400);
            els.bar.classList.remove('is-hidden');
            await this._wait(400);
            els.slot.classList.remove('is-summoning');
        }
    }

    async _doTurn(n) {
        this.vis.turn = n;
        if (this.els) this.els.turn.textContent = n;
        await this._wait(120);
    }

    // Showdown: 300ms ball arc, then the sprite scales in over 400ms.
    async _doSwitch(ref, name, hpText) {
        const sideIndex = sideOfRef(ref);
        const side = this.battle.sides[sideIndex];
        const vside = this.vis.sides[sideIndex];

        // The log carries the name rather than a team index. Same name means
        // same species, so matching by name is visually exact even if a team
        // somehow runs two of one Fakémon.
        let idx = side.team.findIndex((m, i) => m.name === name && !vside.mons[i].fainted && i !== vside.activeIndex);
        if (idx < 0) idx = side.team.findIndex(m => m.name === name);
        if (idx < 0) return;

        const [hp, maxhp] = String(hpText || '').split('/').map(Number);
        if (Number.isFinite(hp)) vside.mons[idx].hp = hp;
        if (Number.isFinite(maxhp)) vside.mons[idx].maxhp = maxhp;
        // A Pokémon leaving the field drops its stat stages.
        vside.mons[vside.activeIndex].boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
        vside.activeIndex = idx;

        if (!this._animating()) { this._paintSide(sideIndex); return; }

        const els = this._elsFor(sideIndex);
        els.slot.classList.remove('is-fainted');
        els.slot.classList.add('is-empty');
        this._sentOut[sideIndex] = false;
        this.field3d?.setHidden(this._side3D(sideIndex), true);
        els.bar.classList.add('is-hidden');
        this._throwBall(sideIndex);
        this._pan(sideIndex === this.mySide ? 'nearPush' : 'farPush', 220)
            .then(() => this._pan('rest', 380));
        await this._wait(300);

        this._sentOut[sideIndex] = true;
        this._paintSide(sideIndex);
        els.slot.classList.remove('is-empty');
        els.slot.classList.add('is-summoning');
        this._push3DStatus();
        this.field3d?.playSpriteAnim(this._side3D(sideIndex), 'summon', 400);
        els.bar.classList.remove('is-hidden');
        await this._wait(400);
        els.slot.classList.remove('is-summoning');
    }

    _throwBall(sideIndex) {
        if (this.field3d) { this.field3d.throwBall(this._side3D(sideIndex)); return; }
        const els = this._elsFor(sideIndex);
        const ball = document.createElement('div');
        ball.className = `ps-throwball ${sideIndex === this.mySide ? 'to-near' : 'to-far'}`;
        this.els.field.appendChild(ball);
        setTimeout(() => ball.remove(), 700);
        this.field3d?.playSpriteAnim(this._side3D(sideIndex), 'hit', 300);
        els.fx.classList.add('is-flash');
        setTimeout(() => els.fx.classList.remove('is-flash'), 320);
    }

    // Showdown's contact attack is 400ms out / 100ms contact / 500ms back.
    // Tightened here so a long battle doesn't drag. The type-coloured FX
    // plays over the lunge, matching what the engine actually resolved.
    async _doMove(ref, moveName, targetRef) {
        const sideIndex = sideOfRef(ref);
        this._banner(moveName);
        if (!this._animating()) return;
        const els = this._elsFor(sideIndex);
        const targetEls = targetRef ? this._elsFor(sideOfRef(targetRef)) : null;

        const info = resolveMoveInfo(this.battle, sideIndex, moveName);
        const fx = shapeFor(info.move, info.type);
        // A move that only touches its user has no second subject: it plays out
        // entirely on the attacker, and the camera never leaves.
        const isSelf = SELF_TARGETS.has(info.move?.target || 'normal');
        const targetIndex = isSelf ? sideIndex
            : (targetRef ? sideOfRef(targetRef) : 1 - sideIndex);
        const shots = this._shotsFor(fx.shape, info, sideIndex, targetIndex, isSelf);

        // Settle on the attacker BEFORE anything moves. Running the pan
        // alongside the animation meant the move -- a 620ms contact lunge above
        // all -- had already finished by the time the camera arrived.
        await this._pan(shots.attacker, 300);

        // The 3D renderer draws the effect in world space; the DOM version is
        // the fallback for when three.js never loaded.
        let fxMs = MOVE_FX_MS;
        if (this.field3d) {
            const fromSide = this._side3D(sideIndex);
            this.field3d.playFX(info.category === 'Status' ? 'ring' : fx.shape, {
                type: info.type, count: fx.count,
                fromSide, toSide: isSelf ? fromSide : (fromSide === 'near' ? 'far' : 'near')
            });
        } else {
            fxMs = playMoveFX(
                { field: this.els.field },
                els.slot,
                targetEls?.slot || (sideIndex === this.mySide ? this.els.far.slot : this.els.near.slot),
                info
            );
        }

        // Physical moves dash the attacker onto the target; special moves
        // recoil in place; status moves just shimmer. Mirrors Showdown's
        // "attacker commits before the effect lands" rhythm.
        const dash = info.category === 'Physical' ? 'is-dash'
            : info.category === 'Special' ? 'is-recoil' : null;
        const isContact = !!info.move?.flags?.contact && !isSelf;
        let travelPan = null;
        if (dash) {
            if (this.field3d) {
                const kind = isContact ? 'contact' : dash === 'is-dash' ? 'dash' : 'recoil';
                this.field3d.playSpriteAnim(this._side3D(sideIndex), kind, isContact ? CONTACT_MS : 480);
                // Travel with the attacker rather than cutting after it lands:
                // the lunge covers the distance in the first 45% of its run, so
                // the camera takes exactly that long and starts on the same frame.
                if (isContact && shots.target && shots.target !== shots.attacker) {
                    travelPan = this._pan(shots.target, Math.round(CONTACT_MS * 0.45));
                }
            } else {
                els.slot.classList.add(dash);
            }
        }
        await this._wait(Math.max(250, fxMs));
        if (dash && !this.field3d) els.slot.classList.remove(dash);
        // Impact lands here: a short whole-field shake sells the hit.
        if (info.category !== 'Status') this._shakeField();
        await this._wait(120);
        // Carry to the target as the hit lands -- unless there is nowhere to go
        // (a move on its own user, or a shot that already frames both), or the
        // camera already travelled there with a contact lunge.
        //
        // And then STAY there. Everything the move does to its target -- the
        // damage, the burn, the stat drop -- arrives as the entries after this
        // one, so cutting back to rest here meant the camera left before there
        // was anything to see. The return to rest is deferred to the end of the
        // queue instead (see _drain), which gives the order asked for:
        //   pan to user -> user's effect -> pan to target -> target's effects.
        if (travelPan) await travelPan;
        else if (shots.target && shots.target !== shots.attacker) await this._pan(shots.target, 300);
        this.restPending = true;
    }

    // Which camera preset a move gets. Keyed off the same shape the FX uses, so
    // the framing and the effect always agree.
    // Which pair of shots a move gets: where the camera sits while the attacker
    // commits, and where it moves as the effect lands. Keyed off the same shape
    // the effect uses, so framing and effect always agree.
    _shotsFor(shape, info, sideIndex, targetIndex, isSelf = false) {
        const push = (i) => (i === this.mySide ? 'nearPush' : 'farPush');
        const low = (i) => (i === this.mySide ? 'lowNear' : 'lowFar');

        // Nothing to cut to: hold on the user for the whole move.
        if (isSelf) return { attacker: push(sideIndex), target: null };

        // Everything with reach fills the frame better from one wide shot than
        // from a cut, so those hold rather than pan.
        if (shape === 'explode') return { attacker: low(sideIndex), target: 'wide' };
        if (shape === 'beam') return { attacker: low(sideIndex), target: 'wide' };
        if (shape === 'sound') return { attacker: push(sideIndex), target: 'wide' };
        if (shape === 'quake') return { attacker: low(sideIndex), target: low(targetIndex) };
        if (shape === 'drain') return { attacker: push(targetIndex), target: push(sideIndex) };
        if (shape === 'slash') return { attacker: low(sideIndex), target: push(targetIndex) };

        // A contact move rides in with the attacker and stays on the impact.
        if (info.move?.flags?.contact) return { attacker: low(sideIndex), target: push(targetIndex) };
        if (info.category === 'Status') return { attacker: push(sideIndex), target: push(targetIndex) };
        return { attacker: push(sideIndex), target: push(targetIndex) };
    }

    _shakeField() {
        if (!this.els) return;
        if (this.field3d) return this.field3d.shake(0.18);
        this.els.field.classList.add('is-shaking');
        setTimeout(() => this.els.field.classList.remove('is-shaking'), 260);
    }

    _banner(text) {
        if (!this.els) return;
        const b = this.els.banner;
        b.textContent = text;
        b.classList.remove('is-show');
        void b.offsetWidth;              // restart the CSS animation
        b.classList.add('is-show');
    }

    // Showdown tweens the HP bar over 350ms and floats the delta for ~1000ms.
    async _doHPChange(ref, hp, maxhp, mode) {
        const sideIndex = sideOfRef(ref);
        const vside = this.vis.sides[sideIndex];
        const vmon = vside.mons[vside.activeIndex];
        const before = vmon.hp;
        const after = Number(hp);
        const delta = Math.abs(after - before);

        vmon.hp = after;
        if (Number.isFinite(Number(maxhp))) vmon.maxhp = Number(maxhp);

        if (!this._animating()) { this._paintSide(sideIndex); return; }

        const els = this._elsFor(sideIndex);
        if (delta > 0) {
            const pctDelta = vmon.maxhp ? Math.round((delta / vmon.maxhp) * 100) : 0;
            this._float(sideIndex, `${mode === 'heal' ? '+' : '−'}${pctDelta}%`, mode === 'heal' ? 'good' : 'bad');
        }
        if (mode === 'damage' && delta > 0) {
            els.slot.classList.add('is-hit');
            els.fx.classList.add('is-hurt');
            setTimeout(() => { els.slot.classList.remove('is-hit'); els.fx.classList.remove('is-hurt'); }, 320);
        } else if (mode === 'heal' && delta > 0) {
            els.fx.classList.add('is-healed');
            setTimeout(() => els.fx.classList.remove('is-healed'), 400);
        }
        this._paintSide(sideIndex);       // CSS transition tweens the bar
        await this._wait(350);
    }

    // Showdown: sprite rises and fades over 400ms, statbar fades over 300ms.
    async _doFaint(ref) {
        const sideIndex = sideOfRef(ref);
        const vside = this.vis.sides[sideIndex];
        const vmon = vside.mons[vside.activeIndex];
        vmon.fainted = true;
        vmon.hp = 0;

        if (!this._animating()) { this._paintSide(sideIndex); return; }
        const els = this._elsFor(sideIndex);
        // Start the faint before the repaint that marks this mon gone -- the 3D
        // layer holds the mesh on screen for the length of the animation.
        this.field3d?.playSpriteAnim(this._side3D(sideIndex), 'faint', 420);
        this._paintSide(sideIndex);
        els.slot.classList.add('is-fainting');
        els.bar.classList.add('is-hidden');
        await this._wait(420);
        els.slot.classList.remove('is-fainting');
        els.slot.classList.add('is-empty');
    }

    async _doStatus(ref, status) {
        const sideIndex = sideOfRef(ref);
        const vside = this.vis.sides[sideIndex];
        vside.mons[vside.activeIndex].status = status;
        this.field3d?.setStatus(this._side3D(sideIndex), status);
        this._float(sideIndex, String(status).toUpperCase(), 'bad');
        this._paintSide(sideIndex);
        await this._wait(this._animating() ? 300 : 0);
    }

    async _doCureStatus(ref) {
        const sideIndex = sideOfRef(ref);
        const vside = this.vis.sides[sideIndex];
        vside.mons[vside.activeIndex].status = null;
        this._paintSide(sideIndex);
        await this._wait(this._animating() ? 220 : 0);
    }

    async _doBoost(ref, stat, amount, dir) {
        const sideIndex = sideOfRef(ref);
        const vside = this.vis.sides[sideIndex];
        const vmon = vside.mons[vside.activeIndex];
        const n = Number.isFinite(amount) ? amount : 1;
        vmon.boosts[stat] = (vmon.boosts[stat] || 0) + dir * n;
        this._float(sideIndex, `${stat.toUpperCase()} ${dir > 0 ? '↑' : '↓'}`, dir > 0 ? 'good' : 'bad');
        if (this._animating()) {
            const els = this._elsFor(sideIndex);
            els.fx.classList.add(dir > 0 ? 'is-boost' : 'is-unboost');
            setTimeout(() => els.fx.classList.remove('is-boost', 'is-unboost'), 420);
        }
        this._paintSide(sideIndex);
        await this._wait(this._animating() ? 300 : 0);
    }

    async _doClearBoost(ref) {
        const sideIndex = sideOfRef(ref);
        const vside = this.vis.sides[sideIndex];
        vside.mons[vside.activeIndex].boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
        this._paintSide(sideIndex);
        await this._wait(this._animating() ? 200 : 0);
    }

    async _doStart(ref, key, extra) {
        if (key === 'typechange' && extra) {
            const sideIndex = sideOfRef(ref);
            const vside = this.vis.sides[sideIndex];
            vside.mons[vside.activeIndex].types = String(extra).split('/');
        }
        await this._wait(0);
    }

    async _doWeather(w) {
        this.vis.weather = (w && w !== 'none') ? w : null;
        if (this.els) this.els.weather.dataset.w = this.vis.weather || '';
        await this._wait(this._animating() ? 300 : 0);
    }

    async _doTerrain(t) {
        this.vis.terrain = t || null;
        if (this.els) this.els.field.dataset.terrain = this.vis.terrain || '';
        await this._wait(this._animating() ? 300 : 0);
    }

    async _doResult(ref, text, type) {
        this._float(sideOfRef(ref), text, type);
        await this._wait(this._animating() ? 260 : 0);
    }

    // Showdown's resultAnim: text appears on the sprite and drifts upward
    // while fading, over roughly a second.
    _float(sideIndex, text, type) {
        if (!this._animating() || !this.els) return;
        const els = this._elsFor(sideIndex);
        const node = document.createElement('div');
        node.className = `ps-result is-${type}`;
        node.textContent = text;
        els.slot.appendChild(node);
        setTimeout(() => node.remove(), 1100);
    }

    // ---------------------------------------------------------------- log
    // The log fills in as the animation plays, so the text and the action on
    // screen stay in step. Names resolve against the VIS model, which is why
    // scrolling back shows who was actually out at the time.
    appendLogLine(entry) {
        if (!this.logEl) return;
        const html = this.formatLine(entry, ref => this.nameFor(ref), ref => sideOfRef(ref) === this.mySide);
        if (!html) return;
        this.logEl.insertAdjacentHTML('beforeend', html);
        this.logEl.scrollTop = this.logEl.scrollHeight;
    }

    nameFor(ref) {
        const sideIndex = sideOfRef(ref);
        const vside = this.vis.sides[sideIndex];
        return this.battle.sides[sideIndex].team[vside.activeIndex]?.name || ref;
    }

    // Used after a resync, where the vis model jumped and the log needs to be
    // reprinted from scratch rather than appended to.
    rebuildLog() {
        if (!this.logEl) return;
        const replay = new BattleScene({ battle: this.battle, mySide: this.mySide, formatLine: this.formatLine });
        let html = '';
        for (const entry of this.battle.log) {
            const line = this.formatLine(entry, ref => replay.nameFor(ref), ref => sideOfRef(ref) === this.mySide);
            if (line) html += line;
            replay._trackForLog(entry);
        }
        this.logEl.innerHTML = html;
        this.logEl.scrollTop = this.logEl.scrollHeight;
    }

    // The subset of state the log formatter needs -- just who is out.
    _trackForLog(entry) {
        const [kind, ...rest] = entry;
        if (kind !== 'switch') return;
        const sideIndex = sideOfRef(rest[0]);
        const side = this.battle.sides[sideIndex];
        const vside = this.vis.sides[sideIndex];
        let idx = side.team.findIndex((m, i) => m.name === rest[1] && i !== vside.activeIndex);
        if (idx < 0) idx = side.team.findIndex(m => m.name === rest[1]);
        if (idx >= 0) vside.activeIndex = idx;
    }

    destroy() {
        this.destroyed = true;
        this.queue.length = 0;
        this.field3d?.destroy();
        this.field3d = null;
    }
}
