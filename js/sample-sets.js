import { log } from './log.js';
import { state, api } from './app.js';

import { NATURE_DATA, NATURES, STAT_NAMES } from './data.js';
import { buildTypeMenuOptions, getSdMoveByName, loadCompetitiveMoveUsefulness, renderDropdown, selectTeraType } from './editor.js';
import { updatePreview } from './editor-core.js';
// ==================== sample sets ====================
        // competitive sample-set generator.
        //
        // this is intentionally local/deterministic: it never calls an ai or external
        // generation API.  the only move data it consumes is the fakemon's current
        // learnset plus the Showdown move metadata already loaded into state.sdMoves.
        //
        // the scoring tables below are deliberately kept in one place so the generator
        // can be tuned without rewriting the selection algorithm.
        const SAMPLE_SET_CONFIG = {
            roleMeta: {
                physicalSweeper: { name: 'Physical Sweeper', attack: 'atk', natureFast: 'Jolly', natureSlow: 'Adamant' },
                specialSweeper: { name: 'Special Sweeper', attack: 'spa', natureFast: 'Timid', natureSlow: 'Modest' },
                wallbreaker: { name: 'Wallbreaker', attack: null, natureFast: null, natureSlow: null },
                bulkyAttacker: { name: 'Bulky Attacker', attack: null, natureFast: null, natureSlow: null },
                defensive: { name: 'Defensive', attack: null, natureFast: null, natureSlow: null },
                support: { name: 'Support', attack: null, natureFast: null, natureSlow: null },
                pivot: { name: 'Pivot', attack: null, natureFast: null, natureSlow: null },
                setupSweeper: { name: 'Setup Sweeper', attack: null, natureFast: null, natureSlow: null },
                hazard: { name: 'Hazard Setter/Remover', attack: null, natureFast: null, natureSlow: null },
                screens: { name: 'Screens', attack: null, natureFast: 'Timid', natureSlow: 'Bold' }
            },
            move: {
                stab: 34,
                superEffectiveCoverage: 18,
                neutralCoverage: 7,
                power: 0.075,
                usefulness: 7,
                selfKOPenalty: 45,
                accuracy: 4,
                priority: 10,
                setup: 30,
                recovery: 27,
                status: 12,
                hazard: 26,
                removal: 25,
                pivot: 24,
                speedControl: 18,
                disruption: 14,
                sameCategoryPenalty: 8,
                redundantTypePenalty: 13,
                redundantRolePenalty: 16,
                lowPowerPenalty: 8,
                abilitySynergy: 18,
                signaturePenalty: 0
            },
            roleThresholds: {
                speedSweeperMin: 80,
                physicalAttackMin: 85,
                specialAttackMin: 85,
                bulkyHpMin: 85,
                bulkyDefMin: 85,
                bulkySpdMin: 85,
                wallbreakerPowerMin: 80
            }
        };

        const SAMPLE_SET_MOVE_TAGS = {
            setup: new Set(['Swords Dance','Nasty Plot','Calm Mind','Bulk Up','Dragon Dance','Quiver Dance','Shell Smash','Shift Gear','Victory Dance','Tail Glow','Growth','Work Up','Hone Claws','Coil','Curse','Agility','Rock Polish','Autotomize']),
            defensiveSetup: new Set(['Iron Defense','Amnesia','Acid Armor','Cotton Guard','Cosmic Power','Stockpile']),
            recovery: new Set(['Recover','Roost','Rest','Slack Off','Synthesis','Moonlight','Morning Sun','Milk Drink','Soft-Boiled','Shore Up','Wish','Strength Sap','Heal Order']),
            hazards: new Set(['Stealth Rock','Spikes','Toxic Spikes','Sticky Web']),
            removal: new Set(['Rapid Spin','Defog','Mortal Spin']),
            pivot: new Set(['U-turn','Volt Switch','Flip Turn','Parting Shot','Chilly Reception','Teleport','Shed Tail']),
            speedControl: new Set(['Thunder Wave','Glare','Icy Wind','Electroweb','Tailwind']),
            disruption: new Set(['Taunt','Encore','Knock Off','Trick','Switcheroo','Haze','Roar','Whirlwind','Yawn','Disable','Toxic','Will-O-Wisp']),
            screens: new Set(['Reflect','Light Screen','Aurora Veil'])
        };

        // setup moves that boost speed alongside their main stat(s), used to give
        // quiver dance/shell smash/etc. proper credit over speed-less equivalents
        // like calm mind/nasty plot when the Fakemon still benefits from more speed.
        const SAMPLE_SET_SETUP_SPEED_BOOST = new Set(['Quiver Dance','Shell Smash','Shift Gear','Dragon Dance','Victory Dance']);

        // competitive-set filters. these are intentionally explicit so the generator
        // prefers moves that actually belong on a serious set instead of merely having
        // high BP or being technically legal.
        const SAMPLE_SET_BAD_DEFAULT_MOVES = new Set([
            // generic/weak attacks that should never be auto-selected for a competitive
            // sample set. these remain perfectly legal in the fakemon's learnset and can
            // still be selected manually. genuinely useful tools (priority moves like
            // mach punch/bullet punch, coverage like aerial ace/snarl, trapping moves
            // like pursuit, etc.) are deliberately not in this list; their value is
            // instead judged by their actual stats via sampleMoveIntrinsicScore.
            'Covet','Thief','Tackle','Pound','Scratch','Constrict','Present','Round','Snore',
            'Bide','Rage','Fury Attack','Fury Swipes','Take Down','Submission','Headbutt',
            'Mega Drain','Absorb','Vine Whip','Razor Leaf','Ember','Water Gun','Bubble',
            'Powder Snow','Gust','Peck','Astonish','Lick',
            'Nuzzle','Pounce','Fling','Natural Gift','Echoed Voice',
            'Struggle Bug','Infestation'
        ]);

        // additional low-value status/utility moves. the sample-set generator is
        // deliberately conservative: if a status move does not have a clear competitive
        // job, it should never be used merely to fill the fourth slot.
        const SAMPLE_SET_LOW_VALUE_UTILITY_MOVES = new Set([
            'Safeguard','Mist','Lucky Chant','Sweet Scent','Odor Sleuth','Foresight',
            'Flash','Sand Attack','Smokescreen','Kinesis','Mud-Slap','Tail Whip',
            'Growl','Leer','String Shot','Scary Face','Baby-Doll Eyes','Play Nice',
            'Tickle','Noble Roar','Screech','Fake Tears','Metal Sound',
            'Harden','Withdraw','Defense Curl','Minimize','Double Team','Swagger',
            'Flatter','Teeter Dance','Confide','Charm','Captivate','Attract',
            'Sweet Kiss','Flatter','Supersonic','Confusion','Kinesis','Smog',
            'Poison Gas','Smokescreen','Sand Attack','Water Sport','Mud Sport',
            'Lucky Chant','Magic Coat'
        ]);
        // moves whose damage also functions as a trapping effect. these are not
        // general-purpose coverage/utility: they should only appear when the set has
        // an identifiable trapping gameplan (explicit trapping move/ability).
        const SAMPLE_SET_TRAPPING_DAMAGE_MOVES = new Set([
            'Bind','Clamp','Fire Spin','Magma Storm','Sand Tomb','Snap Trap',
            'Whirlpool','Wrap','Infestation'
        ]);

        const SAMPLE_SET_PASSIVE_DAMAGE_MOVES = new Set([
            'Seismic Toss','Night Shade','Psywave','Endeavor'
        ]);

        const SAMPLE_SET_EXPLICIT_TRAPPING_MOVES = new Set([
            'Mean Look','Block','Spider Web','Jaw Lock','Anchor Shot','Spirit Shackle',
            'Thousand Waves','Octolock'
        ]);

        const SAMPLE_SET_TRAPPING_ABILITIES = /shadow tag|arena trap|magnet pull/i;

        // powerful but conditional attacks should not be treated as ordinary coverage.
        // they become reasonable when the set explicitly supplies the condition.
        // moves whose normal value depends heavily on an external battle condition.
        // these should not be treated as generic coverage unless the set itself supplies
        // the condition (or the Pokemon has an ability that supplies it automatically).
        //
        // weather:
        //   sun  -> solar beam, solar blade, weather ball
        //   rain -> thunder, hurricane, electro shot
        //   snow -> blizzard
        //
        // terrain:
        //   terrain pulse, nature power, rising voltage, grassy glide,
        //   expanding force, psyblade
        //
        // aurora veil is utility rather than coverage, but it is also conditional and
        // is handled by the same support check below.
        const SAMPLE_SET_CONDITIONAL_COVERAGE_MOVES = new Set([
            'Solar Beam','Solar Blade','Weather Ball',
            'Thunder','Hurricane','Electro Shot','Blizzard',
            'Terrain Pulse','Nature Power','Rising Voltage',
            'Grassy Glide','Expanding Force','Psyblade'
        ]);

        const SAMPLE_SET_WEATHER_SETTERS = new Set([
            'Sunny Day','Rain Dance','Sandstorm','Snowscape','Hail'
        ]);

        const SAMPLE_SET_TERRAIN_SETTERS = new Set([
            'Electric Terrain','Grassy Terrain','Misty Terrain','Psychic Terrain'
        ]);

        const SAMPLE_SET_EXTERNAL_CONDITION_SETTERS = new Set([
            ...SAMPLE_SET_WEATHER_SETTERS,
            ...SAMPLE_SET_TERRAIN_SETTERS,
            'Gravity','Trick Room','Wonder Room','Magic Room'
        ]);

        const SAMPLE_SET_SELF_KO_MOVES = new Set([
            'Explosion','Self-Destruct','Misty Explosion','Final Gambit','Memento','Healing Wish','Lunar Dance'
        ]);
        // moves that cost the user a huge, fixed chunk of their own max HP to use
        // (independent of recoil-from-damage-dealt, which scales with the hit and is
        // penalized separately). these are especially bad on a set that wants to set up
        // first and then stick around to sweep, since half their HP is gone before they
        // even get to attack with their boosted stats.
        const SAMPLE_SET_HEAVY_SELF_DAMAGE_MOVES = new Set(['Steel Beam','Mind Blown','Chloroblast','Light of Ruin']);
        const SAMPLE_SET_COVERAGE_TYPES = ['Normal','Fire','Water','Electric','Grass','Ice','Fighting','Poison','Ground','Flying','Psychic','Bug','Rock','Ghost','Dragon','Dark','Steel','Fairy'];
        // premium attacks that should survive competitive-usefulness filtering even when
        // they have little/no sample-set frequency. these are not blanket auto-picks;
        // they still have to fit the fakemon's role, category, typing, and movepool.
        const SAMPLE_SET_PREMIUM_ATTACKS = new Set([
            'V-create','Gigaton Hammer','Make It Rain','Fleur Cannon','Bolt Beak','Fishious Rend',
            'Headlong Rush','Glacial Lance','Astral Barrage','Collision Course','Electro Drift',
            'Population Bomb','Last Respects','Rage Fist','Expanding Force','Surging Strikes'
        ]);

        // strong attacks whose stat drops are especially valuable with contrary.
        // keep this separate from the generic premium-attack list so contrary can
        // recognize the strategic interaction rather than merely rewarding raw BP.
        const SAMPLE_SET_CONTRARY_SYNERGY_MOVES = new Set([
            'V-create','Superpower','Close Combat','Leaf Storm','Overheat',
            'Draco Meteor','Make It Rain','Psycho Boost','Fleur Cannon',
            'Headlong Rush','Contrary Boost Move'
        ]);

        // generation-local memoization. the beam search evaluates the same partial
        // move combinations many times across roles; cache those pure scoring checks
        // so debug/investigation support never becomes part of the hot path.
        let sampleGenerationMemo = null;
        function sampleMemoKey(role, chosen) {
            const names = (chosen || []).map(m => m?.name || '').sort();
            return `${role || ''}|${names.join('\x1f')}`;
        }
        function sampleMoveMemoKey(role, move, chosen) {
            return `${role || ''}|${move?.name || ''}|${(chosen || []).map(m => m?.name || '').sort().join('\x1f')}`;
        }

        function sampleSetHash(value) {
            let h = 2166136261 >>> 0;
            const s = String(value);
            for (let i = 0; i < s.length; i++) {
                h ^= s.charCodeAt(i);
                h = Math.imul(h, 16777619);
            }
            return h >>> 0;
        }

        function sampleSetRng(seed) {
            let x = seed >>> 0;
            return () => {
                x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
                return (x >>> 0) / 4294967296;
            };
        }

        function getSampleSetProfile() {
            const stats = {
                hp: parseInt(document.getElementById('stat-hp')?.value) || 60,
                atk: parseInt(document.getElementById('stat-atk')?.value) || 60,
                def: parseInt(document.getElementById('stat-def')?.value) || 60,
                spa: parseInt(document.getElementById('stat-spa')?.value) || 60,
                spd: parseInt(document.getElementById('stat-spd')?.value) || 60,
                spe: parseInt(document.getElementById('stat-spe')?.value) || 60
            };
            const types = [
                document.getElementById('fakemon-type1')?.value,
                document.getElementById('fakemon-type2')?.value
            ].filter(Boolean);
            const abilities = getAllAbilities();
            const abilityDetails = state.abilities.filter(a => a && a.name).map(a => {
                const sd = Object.values(state.sdAbilities || {}).find(v => v.name === a.name);
                return { name: a.name, desc: a.desc || a.description || sd?.desc || '' };
            });
            const moves = (state.learnset || []).filter(m => m && m.name).map(m => {
                const sd = getSdMoveByName(m.name);
                return {
                    ...m,
                    ...(sd || {}),
                    name: m.name,
                    type: m.type || sd?.type || 'Normal',
                    category: m.category || sd?.category || 'Status',
                    basePower: m.basePower ?? sd?.basePower ?? 0,
                    accuracy: m.accuracy ?? sd?.accuracy,
                    priority: m.priority ?? sd?.priority ?? 0,
                    flags: m.flags || sd?.flags || {},
                    desc: m.desc || sd?.desc || ''
                };
            });
            return { stats, types, abilities, abilityDetails, moves };
        }

        function sampleMoveKind(move) {
            if (!move) return {};
            const cache = sampleGenerationMemo?.moveKind;
            if (cache?.has(move)) return cache.get(move);
            const name = move.name;
            const lower = `${name} ${move.desc || ''}`.toLowerCase();
            const kinds = {
                setup: SAMPLE_SET_MOVE_TAGS.setup.has(name),
                defensiveSetup: SAMPLE_SET_MOVE_TAGS.defensiveSetup.has(name),
                recovery: SAMPLE_SET_MOVE_TAGS.recovery.has(name),
                hazard: SAMPLE_SET_MOVE_TAGS.hazards.has(name),
                removal: SAMPLE_SET_MOVE_TAGS.removal.has(name),
                pivot: SAMPLE_SET_MOVE_TAGS.pivot.has(name),
                speedControl: SAMPLE_SET_MOVE_TAGS.speedControl.has(name),
                disruption: SAMPLE_SET_MOVE_TAGS.disruption.has(name),
                screens: SAMPLE_SET_MOVE_TAGS.screens.has(name),
                selfKO: /^(Explosion|Self-Destruct|Misty Explosion|Final Gambit|Memento|Healing Wish|Lunar Dance)$/.test(name)
            };
            // name/description fallback catches custom *status* recovery moves, but
            // deliberately avoids broad 'heal/regain' matching that can misclassify
            // offensive draining attacks as recovery.
            kinds.recovery ||= (move.category === 'Status' && /(?:recover|heals? the user|restores? the user's hp|restores? hp|regains? hp|fully restores? hp|wish|rest$)/.test(lower));
            kinds.setup ||= /raises? (its |the )?(attack|sp\\. attack|special attack|speed|defen|sp\\. def|all stats)|boosts? .*stat/.test(lower);
            kinds.hazard ||= /stealth rock|spikes|toxic spikes|sticky web/.test(lower);
            kinds.removal ||= /remove.*hazard|clear.*hazard|defog|rapid spin/.test(lower);
            kinds.pivot ||= /switch.*out|user.*switches|switches out/.test(lower) && move.category === 'Status';
            if (cache) cache.set(move, kinds);
            return kinds;
        }

        function sampleIsDamaging(move) {
            return move.category === 'Physical' || move.category === 'Special';
        }

        // Showdown lists basePower as 0 for moves whose damage is computed dynamically
        // in battle (weight/HP/weather-based, etc). falling back to 0 here would make
        // the scoring system treat genuinely strong moves like facade, gyro ball, or
        // stored power as worthless. these are rough "typical case" estimates used only
        // for scoring/filtering purposes, not for anything shown to the user.
        const SAMPLE_SET_VARIABLE_BP_ESTIMATE = {
            'Low Kick': 80, 'Grass Knot': 80, 'Heavy Slam': 80, 'Heat Crash': 80,
            'Gyro Ball': 80, 'Electro Ball': 60, 'Flail': 100, 'Reversal': 100,
            'Wring Out': 90, 'Crush Grip': 90, 'Punishment': 60, 'Payback': 50,
            'Facade': 70, 'Hex': 65, 'Acrobatics': 75, 'Stored Power': 70, 'Power Trip': 70,
            'Return': 100, 'Frustration': 60, 'Rollout': 60, 'Ice Ball': 60,
            'Triple Kick': 60, 'Water Shuriken': 40, 'Beat Up': 60, 'Trump Card': 60,
            'Weather Ball': 100, 'Terrain Pulse': 100, 'Magnitude': 70, 'Present': 60,
            'Foul Play': 95, 'Spit Up': 100, 'Eruption': 100, 'Water Spout': 100,
            'Dragon Energy': 100, 'Last Respects': 100, 'Rage Fist': 90, 'Barb Barrage': 60,
            'Nature Power': 80, 'Fury Cutter': 40, 'Freeze-Dry': 70
        };

        function sampleEffectiveBasePower(move) {
            const raw = Number(move.basePower || 0);
            if (raw > 0) return raw;
            return SAMPLE_SET_VARIABLE_BP_ESTIMATE[move.name] || 0;
        }

        // standard 2-5 hit moves land ~3.1 hits on average (35/35/15/15% for 2/3/4/5
        // hits); fixed 2-hit and 3-hit moves get their real average instead.
        const SAMPLE_SET_MULTIHIT_AVG_MULT = {
            'Bullet Seed': 3.1, 'Rock Blast': 3.1, 'Icicle Spear': 3.1, 'Pin Missile': 3.1,
            'Tail Slap': 3.1, 'Bone Rush': 3.1, 'Scale Shot': 3.1, 'Population Bomb': 4.4,
            'Double Kick': 2, 'Twineedle': 2, 'Dual Chop': 2, 'Dragon Darts': 2,
            'Gear Grind': 2, 'Double Hit': 2, 'Surging Strikes': 3
        };

        // self-contained, network-independent quality estimate for a damaging move.
        // folds in effective power, accuracy, priority (which is extremely valuable
        // competitively since it bypasses speed entirely), multi-hit averages, and
        // guaranteed drain, without relying on any external usage-stats fetch.
        function sampleMoveIntrinsicScore(move) {
            const cache = sampleGenerationMemo?.intrinsic;
            if (cache?.has(move)) return cache.get(move);
            if (!sampleIsDamaging(move)) { if (cache) cache.set(move, 0); return 0; }
            const bp = sampleEffectiveBasePower(move);
            if (!bp) return 0;
            const accRaw = move.accuracy;
            const acc = (accRaw === true || accRaw == null) ? 100 : (Number(accRaw) || 100);
            let score = bp * Math.min(1, acc / 100);
            score *= SAMPLE_SET_MULTIHIT_AVG_MULT[move.name] || 1;
            if (move.priority > 0) score += 20 + move.priority * 8;
            const flags = move.flags || {};
            if (flags.drain) score += 10;
            if (flags.recoil) score -= 8;
            const desc = (move.desc || '').toLowerCase();
            if (/flinch|paraly|burn|freeze|poison|lowers? the target|lower(s)? its target/.test(desc)) score += 6;
            if (SAMPLE_SET_PREMIUM_ATTACKS.has(move.name)) score += 20;
            if (cache) cache.set(move, score);
            return score;
        }

        function sampleTypeEffectiveness(moveType, defenderType) {
            const chart = {
                Normal:{Rock:.5,Steel:.5,Ghost:0}, Fire:{Grass:2,Ice:2,Bug:2,Steel:2,Fire:.5,Water:.5,Rock:.5,Dragon:.5},
                Water:{Fire:2,Ground:2,Rock:2,Water:.5,Grass:.5,Dragon:.5}, Electric:{Water:2,Flying:2,Electric:.5,Grass:.5,Dragon:.5,Ground:0},
                Grass:{Water:2,Ground:2,Rock:2,Fire:.5,Grass:.5,Poison:.5,Flying:.5,Bug:.5,Dragon:.5,Steel:.5},
                Ice:{Grass:2,Ground:2,Flying:2,Dragon:2,Fire:.5,Water:.5,Ice:.5,Steel:.5},
                Fighting:{Normal:2,Ice:2,Rock:2,Dark:2,Steel:2,Poison:.5,Flying:.5,Psychic:.5,Bug:.5,Fairy:.5,Ghost:0},
                Poison:{Grass:2,Fairy:2,Poison:.5,Ground:.5,Rock:.5,Ghost:.5,Steel:0},
                Ground:{Fire:2,Electric:2,Poison:2,Rock:2,Steel:2,Grass:.5,Bug:.5,Flying:0},
                Flying:{Grass:2,Fighting:2,Bug:2,Electric:.5,Rock:.5,Steel:.5},
                Psychic:{Fighting:2,Poison:2,Psychic:.5,Steel:.5,Dark:0},
                Bug:{Grass:2,Psychic:2,Dark:2,Fire:.5,Fighting:.5,Poison:.5,Flying:.5,Ghost:.5,Steel:.5,Fairy:.5},
                Rock:{Fire:2,Ice:2,Flying:2,Bug:2,Fighting:.5,Ground:.5,Steel:.5},
                Ghost:{Psychic:2,Ghost:2,Dark:.5,Normal:0},
                Dragon:{Dragon:2,Steel:.5,Fairy:0},
                Dark:{Psychic:2,Ghost:2,Fighting:.5,Dark:.5,Fairy:.5},
                Steel:{Ice:2,Rock:2,Fairy:2,Fire:.5,Water:.5,Electric:.5,Steel:.5},
                Fairy:{Fighting:2,Dragon:2,Dark:2,Fire:.5,Poison:.5,Steel:.5}
            };
            return chart[moveType]?.[defenderType] ?? 1;
        }

        function sampleCoverageScore(move, types, chosen = []) {
            if (!sampleHasGoodCoverage(move, { types }, chosen)) return 0;
            let score = 0;
            const chosenDamaging = chosen.filter(sampleIsDamaging);
            const stabTypes = types;
            let meaningful = 0;
            for (const defender of SAMPLE_SET_COVERAGE_TYPES) {
                const stabBest = Math.max(...stabTypes.map(t => sampleTypeEffectiveness(t, defender)));
                const coverageMult = sampleTypeEffectiveness(move.type, defender);
                if (stabBest < 2 && coverageMult >= 2) meaningful++;
                if (stabBest < 1 && coverageMult >= 2) score += 4;
            }
            score += Math.min(18, meaningful * 4);
            if (chosenDamaging.some(m => m.type === move.type)) score -= 12;
            if (chosenDamaging.some(m => m.type !== move.type && !types.includes(m.type))) score += 2;
            return score;
        }

        function sampleRoleScores(profile) {
            const { stats, types, moves, abilities } = profile;
            const damaging = moves.filter(sampleIsDamaging);
            const physical = damaging.filter(m => m.category === 'Physical');
            const special = damaging.filter(m => m.category === 'Special');
            const setup = moves.filter(m => sampleMoveKind(m).setup);
            const defensiveSetup = moves.filter(m => sampleMoveKind(m).defensiveSetup);
            const recovery = moves.filter(m => sampleMoveKind(m).recovery);
            const hazards = moves.filter(m => sampleMoveKind(m).hazard);
            const removal = moves.filter(m => sampleMoveKind(m).removal);
            const pivot = moves.filter(m => sampleMoveKind(m).pivot);
            const utility = moves.filter(m => {
                const k = sampleMoveKind(m);
                return k.disruption || k.speedControl || k.screens || k.removal || k.hazard;
            });

            // use the whole stat line, not isolated thresholds. this gives the role
            // scorer a much better picture of what the Fakemon actually wants to do.
            const physicalAdvantage = stats.atk - stats.spa;
            const specialAdvantage = stats.spa - stats.atk;
            const bulk = stats.hp + stats.def + stats.spd;
            const physicalBulk = stats.hp + stats.def;
            const specialBulk = stats.hp + stats.spd;
            const speed = stats.spe;
            const fast = speed >= 100;
            const veryFast = speed >= 115;
            const slow = speed <= 65;
            const hasPhysicalSTAB = physical.some(m => types.includes(m.type) && sampleMoveIsActuallyUseful(m));
            const hasSpecialSTAB = special.some(m => types.includes(m.type) && sampleMoveIsActuallyUseful(m));
            const goodPhysical = physical.filter(sampleMoveIsActuallyUseful);
            const goodSpecial = special.filter(sampleMoveIsActuallyUseful);
            const abilityText = abilities.join(' ').toLowerCase();

            const scores = {
                physicalSweeper: 0, specialSweeper: 0, wallbreaker: 0,
                bulkyAttacker: 0, defensive: 0, support: 0, pivot: 0,
                setupSweeper: 0, hazard: 0, screens: 0
            };

            // offensive profile: reward both the stat and the existence of genuinely
            // usable attacks of that category. a 120 atk stat with only bad moves should
            // not beat a 105 SpA stat with a great movepool.
            scores.physicalSweeper += Math.max(0, physicalAdvantage) * 0.55 + Math.max(0, stats.atk - 80) * 0.7;
            scores.specialSweeper += Math.max(0, specialAdvantage) * 0.55 + Math.max(0, stats.spa - 80) * 0.7;
            scores.physicalSweeper += goodPhysical.length * 7 + (hasPhysicalSTAB ? 12 : 0);
            scores.specialSweeper += goodSpecial.length * 7 + (hasSpecialSTAB ? 12 : 0);
            scores.wallbreaker += Math.max(0, stats.atk - 90) * 0.55 + Math.max(0, stats.spa - 90) * 0.55;
            scores.wallbreaker += (goodPhysical.length + goodSpecial.length) * 3;
            scores.wallbreaker += damaging.filter(m => (m.basePower || 0) >= 100 && sampleMoveIsActuallyUseful(m)).length * 7;

            // speed is meaningful only when the offensive profile can capitalize on it.
            if (fast) {
                scores.physicalSweeper += hasPhysicalSTAB ? 10 : 3;
                scores.specialSweeper += hasSpecialSTAB ? 10 : 3;
                scores.pivot += 6;
            }
            if (veryFast) {
                scores.physicalSweeper += 7;
                scores.specialSweeper += 7;
                scores.pivot += 8;
            }
            if (slow) {
                scores.bulkyAttacker += 7;
                scores.wallbreaker += 5;
            }

            // bulk is relative to offensive stats. high bulk + high offense points to a
            // bulky attacker; high bulk without offensive tools points to defense/support.
            scores.bulkyAttacker += Math.max(0, bulk - 250) * 0.22;
            scores.bulkyAttacker += Math.max(0, Math.max(stats.atk, stats.spa) - 95) * 0.45;
            scores.bulkyAttacker += recovery.length * 9;
            scores.defensive += Math.max(0, physicalBulk - 155) * 0.35;
            scores.defensive += Math.max(0, specialBulk - 155) * 0.35;
            scores.defensive += recovery.length * 24;
            scores.defensive += utility.length * 5;
            scores.support += utility.length * 12 + recovery.length * 10;
            scores.support += Math.max(0, bulk - 240) * 0.15;

            // recovery is a major role signal. this prevents a bulky mon with moonlight /
            // synthesis / recover from being treated as a pure sweeper just because its
            // attack stat is high.
            if (recovery.length) {
                if (physicalBulk >= 170 || specialBulk >= 170) scores.defensive += 18;
                if (bulk >= 270) scores.bulkyAttacker += 10;
            }

            // likewise, pivot only makes sense with an actual pivot move (u-turn, volt
            // switch, etc.) on the learnset.
            if (pivot.length) {
                scores.pivot += pivot.length * 30 + Math.max(0, stats.spe - 70) * 0.35 + utility.length * 2;
            }
            scores.setupSweeper += setup.length * 30 + Math.max(0, stats.spe - 75) * 0.45;
            scores.defensive += defensiveSetup.length * 8;
            scores.bulkyAttacker += defensiveSetup.length * 4;
            // the hazard role only makes sense if the Fakemon actually learns a hazard
            // move. removal (rapid spin/defog) and generic utility moves used to inflate
            // this score on their own, which could win the role for a Fakemon with zero
            // hazard moves and produce a "hazard set" with no hazard in it.
            if (hazards.length) {
                scores.hazard += hazards.length * 40 + removal.length * 8 + utility.length * 2;
            }

            if (stats.atk >= 110 && hasPhysicalSTAB) scores.physicalSweeper += 10;
            if (stats.spa >= 110 && hasSpecialSTAB) scores.specialSweeper += 10;
            if (stats.hp >= 100 && (stats.def >= 100 || stats.spd >= 100)) scores.defensive += 10;
            if (types.length === 2) scores.bulkyAttacker += 2;

            // ability synergy is still a nudge, but now uses the role's actual stat profile.
            if (/huge power|pure power|technician|guts|moxie|adaptability|strong jaw|iron fist/.test(abilityText)) {
                scores.physicalSweeper += Math.max(0, physicalAdvantage) >= 0 ? 10 : 2;
                scores.bulkyAttacker += Math.max(0, physicalBulk - 160) * 0.08;
            }
            if (/analytic|sheer force|competitive|mega launcher|solar power|torrent|blaze/.test(abilityText)) {
                scores.specialSweeper += Math.max(0, specialAdvantage) >= 0 ? 10 : 2;
            }
            if (/regenerator|natural cure|magic guard|multiscale|filter|unaware|levitate|flame body|water absorb|volt absorb/.test(abilityText)) {
                scores.defensive += 12;
                scores.bulkyAttacker += 5;
            }
            if (/prankster|magic bounce/.test(abilityText)) scores.support += 14;

            if (sampleHasScreensGameplan(profile)) {
                scores.screens += 95;
                scores.screens += pivot.length * 20;
                if (fast) scores.screens += 20;
                if (/prankster/.test(abilityText)) scores.screens += 25;
            }

            return scores;
        }

        // hard role feasibility: a role is a claim about the set's strategy, not a
        // generic label. if the defining tools are absent from the learnset, that role
        // must never be generated.
        function sampleRoleIsFeasible(profile, role) {
            const moves = profile.moves || [];
            const damaging = moves.filter(sampleIsDamaging);
            const usefulDamaging = damaging.filter(m => sampleMoveIsActuallyUseful(m, profile, role));
            const pivot = moves.filter(m => sampleMoveKind(m).pivot);
            const hazards = moves.filter(m => sampleMoveKind(m).hazard);
            const setup = moves.filter(m => sampleMoveKind(m).setup && sampleSetupFitsRole(m, profile, role));
            const recovery = moves.filter(m => sampleMoveKind(m).recovery);
            const removal = moves.filter(m => sampleMoveKind(m).removal);
            const utility = moves.filter(m => {
                const k = sampleMoveKind(m);
                return k.disruption || k.speedControl || k.screens || k.removal || k.hazard || k.pivot || k.recovery;
            });

            const t = SAMPLE_SET_CONFIG.roleThresholds;
            if (role === 'pivot') return pivot.length > 0;
            if (role === 'hazard') return hazards.length > 0;
            if (role === 'screens') return sampleHasScreensGameplan(profile);
            if (role === 'setupSweeper') return setup.length > 0 && usefulDamaging.length >= 1;
            // A qualifying STAB move existing isn't enough on its own - the stat
            // behind it needs to actually be worth building a set around, or this
            // role gets offered to Fakemon whose attack stat can't do anything with
            // the move it's being credited for (e.g. a 50 Atk mon with one weak
            // physical STAB move getting suggested a "Physical Sweeper" set).
            if (role === 'physicalSweeper') return profile.stats.atk >= t.physicalAttackMin && usefulDamaging.some(m => m.category === 'Physical' && profile.types.includes(m.type));
            if (role === 'specialSweeper') return profile.stats.spa >= t.specialAttackMin && usefulDamaging.some(m => m.category === 'Special' && profile.types.includes(m.type));
            if (role === 'wallbreaker') return usefulDamaging.length >= 2 && Math.max(profile.stats.atk, profile.stats.spa) >= t.wallbreakerPowerMin;
            if (role === 'bulkyAttacker') return usefulDamaging.length >= 1 && (recovery.length > 0 || profile.stats.hp >= t.bulkyHpMin || Math.max(profile.stats.def, profile.stats.spd) >= Math.min(t.bulkyDefMin, t.bulkySpdMin));
            if (role === 'defensive') return recovery.length > 0 || utility.length >= 2 || removal.length > 0 || hazards.length > 0;
            if (role === 'support') return utility.length >= 2 || recovery.length > 0;
            return true;
        }

        function sampleRoleMoveRequirements(role) {
            return {
                physicalSweeper: { attack: 'Physical', require: 'damaging', preferSetup: true, preferSpeed: true },
                specialSweeper: { attack: 'Special', require: 'damaging', preferSetup: true, preferSpeed: true },
                wallbreaker: { attack: 'either', require: 'damaging', preferPower: true },
                bulkyAttacker: { attack: 'either', require: 'damaging', preferRecovery: true },
                defensive: { attack: 'either', require: 'utility', preferRecovery: true },
                support: { attack: 'either', require: 'utility', preferRecovery: true },
                pivot: { attack: 'either', require: 'pivot', preferSpeed: true },
                setupSweeper: { attack: 'either', require: 'damaging', preferSetup: true, preferSpeed: true },
                hazard: { attack: 'either', require: 'utility', preferHazard: true },
                screens: { attack: 'either', require: 'utility', preferSpeed: true }
            }[role];
        }

        function sampleAbilityScore(move, profile, role) {
            const abilityNames = profile.abilityDetails?.map(a => a.name) || profile.abilities || [];
            const text = abilityNames.join(' ').toLowerCase();
            const name = move.name.toLowerCase();
            let score = 0;
            if (/technician/.test(text) && move.basePower <= 60 && sampleIsDamaging(move)) score += 18;
            if (/adaptability/.test(text) && profile.types.includes(move.type)) score += 16;
            if (/sheer force/.test(text) && sampleIsDamaging(move) && /secondary|chance|flinch|lower|raise/.test(move.desc || '')) score += 10;
            if (/moxie/.test(text) && sampleIsDamaging(move)) score += 7;
            if (/guts/.test(text) && move.category === 'Physical') score += 7;
            if (/iron fist/.test(text) && /punch/.test(name)) score += 10;
            if (/strong jaw/.test(text) && /fang|bite/.test(name)) score += 10;
            if (/mega launcher/.test(text) && /pulse/.test(name)) score += 10;
            if (/pixilate|refrigerate|galvanize|aerilate/.test(text) && move.type === 'Normal') score += 12;
            if (/prankster/.test(text) && move.category === 'Status') score += 9;
            if (/serene grace/.test(text) && sampleIsDamaging(move)) score += 5;
            return score;
        }

        function sampleAbilityFitScore(ability, profile, role, chosenMoves = []) {
            const name = String(ability.name || ability || '');
            const desc = String(ability.desc || ability.description || '').toLowerCase();
            const n = name.toLowerCase();
            const s = profile.stats;
            const moveNames = profile.moves.map(m => m.name.toLowerCase());
            const has = (...names) => names.some(x => moveNames.includes(x.toLowerCase()));
            let score = 0;
            const offensive = ['physicalSweeper','specialSweeper','wallbreaker','setupSweeper'].includes(role);
            const bulky = ['bulkyAttacker','defensive','support','pivot','hazard'].includes(role);

            // directly match common competitive ability archetypes to the fakemon's actual data.
            if (/huge power|pure power/.test(n)) score += s.atk >= s.spa ? 28 : 6;
            if (/guts/.test(n)) score += offensive && s.atk >= s.spa ? 22 : 4;
            if (/moxie|beast boost/.test(n)) score += offensive && (s.atk >= 95 || s.spa >= 95) ? 20 : 5;
            if (/adaptability/.test(n)) score += profile.types.length ? 18 : 4;
            if (/technician/.test(n)) score += profile.moves.some(m => sampleIsDamaging(m) && m.basePower <= 60) ? 20 : -2;
            if (/tinted lens/.test(n)) score += profile.moves.some(m => sampleIsDamaging(m) && !profile.types.includes(m.type)) ? 18 : 4;
            if (/sheer force/.test(n)) score += profile.moves.some(m => sampleIsDamaging(m) && /secondary|chance|flinch|lower|raise/.test(m.desc || '')) ? 22 : 2;
            if (/strong jaw/.test(n)) score += profile.moves.some(m => /fang|bite/i.test(m.name)) ? 20 : 0;
            if (/iron fist/.test(n)) score += profile.moves.some(m => /punch/i.test(m.name)) ? 20 : 0;
            if (/sharpness/.test(n)) score += profile.moves.some(m => /slash|blade|sword|cut/i.test(m.name)) ? 20 : 0;
            if (/mega launcher/.test(n)) score += profile.moves.some(m => /pulse/i.test(m.name)) ? 20 : 0;
            // contrary is a set-level ability. do not reward it merely because the
            // learnset contains a contrary-friendly move; that produces the exact
            // failure mode where contrary is selected on one sample while v-create
            // appears on another. the ability is only valuable when the chosen set
            // actually contains a stat-dropping attack it can reverse.
            if (/contrary/.test(n)) {
                score -= 8;
            }
            if (/speed boost/.test(n)) score += offensive && s.spe >= 70 ? 22 : 4;
            if (/clear body|white smoke/.test(n)) score += bulky ? 10 : 4;
            if (/intimidate/.test(n)) score += bulky && s.def >= s.spd ? 24 : 8;
            if (/fur coat/.test(n)) score += s.def >= 95 ? 26 : 4;
            if (/ice scales/.test(n)) score += s.spd >= 95 ? 26 : 4;
            if (/unaware/.test(n)) score += bulky ? 25 : 5;
            if (/regenerator/.test(n)) score += bulky ? 28 : 8;
            if (/magic guard/.test(n)) score += bulky || offensive ? 20 : 6;
            if (/multiscale|shadow shield/.test(n)) score += s.hp >= 80 && (s.def >= 80 || s.spd >= 80) ? 24 : 4;
            if (/sturdy/.test(n)) score += bulky ? 10 : 5;
            if (/levitate/.test(n)) score += profile.types.includes('Ground') ? 24 : 12;
            if (/water absorb|storm drain/.test(n)) score += bulky && profile.types.includes('Water') ? 24 : 14;
            if (/volt absorb|motor drive/.test(n)) score += bulky && profile.types.includes('Electric') ? 24 : 14;
            if (/flash fire/.test(n)) score += profile.types.includes('Fire') ? 18 : 14;
            if (/thick fat|heatproof|fluffy/.test(n)) score += bulky ? 20 : 10;
            if (/poison heal/.test(n)) score += bulky && has('Protect','Substitute') ? 30 : 20;
            if (/magic bounce/.test(n)) score += bulky || role === 'support' ? 28 : 12;
            if (/prankster/.test(n)) score += profile.moves.some(m => m.category === 'Status') ? 24 : 2;
            if (/unburden/.test(n)) score += offensive && s.spe < 100 ? 22 : 8;
            if (/competitive|defiant/.test(n)) score += offensive ? 16 : 5;
            if (/solar power/.test(n)) score += profile.types.includes('Fire') || profile.moves.some(m => /sun|solar/i.test(m.desc || '')) ? 18 : 2;
            if (/swift swim|chlorophyll|slush rush|sand rush/.test(n)) score += offensive && s.spe >= 70 ? 18 : 6;

            // ability/move interaction must be evaluated against the moves that will
            // actually be on the generated set, not merely anything in the full learnset.
            // this is especially important for contrary: swords dance + contrary is
            // actively counter-synergistic, while v-create/superpower/leaf storm/etc.
            // can make contrary excellent when their stat drops are part of the set.
            const chosen = chosenMoves || [];
            const chosenNames = chosen.map(m => String(m.name || '').toLowerCase());
            const chosenText = chosen.map(m => `${m.name} ${m.desc || ''}`).join(' ').toLowerCase();
            const hasChosen = (...names) => names.some(x => chosenNames.includes(String(x).toLowerCase()));
            const hasSelfDropMove = /(?:v-create|superpower|close combat|leaf storm|overheat|draco meteor|make it rain|psychic noise)/.test(chosenText)
                || chosen.some(m => /(?:lowers|lowered|drop|drops).*(?:user|its|attack|defen|sp\. atk|sp\. def|speed)/i.test(String(m.desc || '')));
            const hasDirectRaise = chosen.some(m => /(?:raises|boosts).*(?:user|its).*(?:attack|defen|sp\. atk|sp\. def|speed|stats)/i.test(String(m.desc || '')))
                || hasChosen('Swords Dance','Nasty Plot','Calm Mind','Iron Defense','Amnesia','Acid Armor','Cotton Guard','Bulk Up','Dragon Dance','Quiver Dance','Coil','Curse','Shell Smash','Rock Polish','Agility','Autotomize');

            if (/contrary/.test(n)) {
                // only select contrary when the actual four-move set contains a
                // meaningful stat-dropping attack. one such move is enough to make
                // the ability viable; multiple compatible moves make it substantially
                // more compelling.
                const contraryCount = chosen.filter(m =>
                    SAMPLE_SET_CONTRARY_SYNERGY_MOVES.has(m.name) ||
                    /(?:lowers?|drops?).*(?:user|its).*(?:attack|defen|sp\.? atk|sp\.? def|speed|stats)/i.test(`${m.name} ${m.desc || ''}`)
                ).length;
                if (contraryCount > 0) score += 55 + Math.min(35, (contraryCount - 1) * 18);
                else score -= 60;

                if (hasDirectRaise) score -= 80;
            }
            if (/simple/.test(n)) {
                score += hasDirectRaise ? 28 : -8;
                if (hasSelfDropMove) score -= 35;
            }
            if (/defiant|competitive/.test(n)) {
                score += chosen.some(m => /lower|drop/i.test(String(m.desc || ''))) ? 24 : 0;
            }
            if (/sheer force/.test(n)) {
                score += chosen.some(m => sampleIsDamaging(m) && /chance|flinch|lower|raise|secondary/i.test(String(m.desc || ''))) ? 28 : -6;
            }
            if (/technician/.test(n)) {
                score += chosen.some(m => sampleIsDamaging(m) && (m.basePower || 0) <= 60) ? 30 : -8;
            }
            if (/strong jaw/.test(n)) score += chosen.some(m => /fang|bite/i.test(m.name)) ? 28 : -8;
            if (/iron fist/.test(n)) score += chosen.some(m => /punch/i.test(m.name)) ? 28 : -8;
            if (/mega launcher/.test(n)) score += chosen.some(m => /pulse/i.test(m.name)) ? 28 : -8;
            if (/sharpness/.test(n)) score += chosen.some(m => /slash|blade|sword|cut/i.test(m.name)) ? 28 : -8;
            if (/moxie|beast boost/.test(n)) score += chosen.some(sampleIsDamaging) ? 10 : -8;
            if (/regenerator/.test(n)) score += ['pivot','defensive','support','bulkyAttacker'].includes(role) ? 18 : 2;
            if (/unaware/.test(n)) score += ['defensive','support'].includes(role) ? 18 : -4;

            // use the actual description as a final semantic-ish deterministic signal.
            if (bulky && /damage|power|attack|defense|special defense|speed|status|heal|recover|switch/.test(desc)) score += 2;
            if (offensive && /attack|special attack|damage|power|speed/.test(desc)) score += 2;
            return score;
        }

        function sampleRoleAttackCategory(profile, role) {
            const s = profile.stats;
            if (role === 'physicalSweeper' || role === 'setupSweeper') return s.atk >= s.spa ? 'Physical' : 'Special';
            if (role === 'specialSweeper') return 'Special';
            if (role === 'wallbreaker' || role === 'bulkyAttacker' || role === 'pivot') return s.atk >= s.spa ? 'Physical' : 'Special';
            return 'either';
        }

        function sampleSetupFitsRole(move, profile, role) {
            const moveKind = sampleMoveKind(move);
            if (moveKind.defensiveSetup) return false;
            if (!moveKind.setup) return true;
            const n = move.name.toLowerCase();
            const physicalSetup = /swords dance|bulk up|dragon dance|coil|hone claws|shift gear|victory dance|curse/.test(n);
            const specialSetup = /nasty plot|calm mind|quiver dance|tail glow|growth/.test(n);
            const speedSetup = /agility|rock polish|autotomize/.test(n);
            const category = sampleRoleAttackCategory(profile, role);
            if (category === 'Physical' && specialSetup && !speedSetup) return false;
            if (category === 'Special' && physicalSetup && !speedSetup) return false;
            return true;
        }

        function sampleMoveCompatibleWithRole(move, profile, role) {
            // screens are a dedicated archetype. reflect/light screen/aurora veil are
            // never generic defensive utility, even if the Pokemon happens to learn one.
            if (sampleMoveKind(move).screens) {
                if (role !== 'screens') return false;
                if (!sampleHasScreensGameplan(profile)) return false;
            }

            // a damaging move must use the offensive category the set is built around.
            // this is a hard compatibility rule: it prevents things like eruption from
            // appearing on a physical sweeper simply because its raw BP is high.
            if (sampleIsDamaging(move)) {
                const category = sampleRoleAttackCategory(profile, role);
                if (category !== 'either' && move.category !== category) return false;
            }
            if (!sampleSetupFitsRole(move, profile, role)) return false;
            return true;
        }

        // dynamic-power attacks are often represented by external usefulness data as
        // zero because their damage is calculated from battle state instead of a fixed
        // base power. that is not the same thing as being useless.
        const SAMPLE_SET_DYNAMIC_POWER_MOVES = new Set([
            'Stored Power','Power Trip','Punishment','Gyro Ball','Electro Ball',
            'Low Kick','Grass Knot','Heavy Slam','Heat Crash','Wring Out','Crush Grip',
            'Flail','Reversal','Facade','Hex','Acrobatics','Eruption','Water Spout',
            'Dragon Energy','Last Respects','Rage Fist','Fury Cutter','Rollout','Ice Ball',
            'Weather Ball','Terrain Pulse','Nature Power','Magnitude','Spit Up'
        ]);

        function sampleCompetitiveUsefulness(move) {
            const weights = state.sdMoveUsefulness || {};
            const exact = weights[move.name];
            if (SAMPLE_SET_DYNAMIC_POWER_MOVES.has(move.name)) {
                // never let a missing/zero external score mark a dynamic-power move
                // useless. its local BP estimate + role/set synergy decide its value.
                if (exact == null || Number(exact) <= 0) return 1;
                return Number(exact);
            }
            if (exact != null) return exact;
            // custom/Fakemon moves are not in smogon data. give them a neutral baseline
            // and let the local role/coverage/ability rules decide their value.
            return 1;
        }

        // hard blacklist for sample-set generation. these moves are legal, but are
        // deliberately never allowed to enter an automatically generated sample set.
        // this prevents the final-slot fallback from turning into generic low-value
        // utility just because the Fakemon happens to learn it.
        const SAMPLE_SET_BANNED_MOVES = new Set([
            'Safeguard', 'Mist', 'Lucky Chant', 'Sweet Scent', 'Odor Sleuth', 'Foresight',
            'Flash', 'Sand Attack', 'Smokescreen', 'Kinesis', 'Mud-Slap', 'Tail Whip',
            'Growl', 'Leer', 'String Shot', 'Scary Face', 'Baby-Doll Eyes', 'Play Nice',
            'Tickle', 'Noble Roar', 'Screech', 'Fake Tears', 'Metal Sound',
            'Sweet Scent', 'Defog'
        ]);

        function sampleMoveIsBanned(move) {
            if (!move || !move.name) return true;
            // one hard gate for all permanently banned sample-set moves.
            if (SAMPLE_SET_BANNED_MOVES.has(move.name)) return true;
            if (SAMPLE_SET_BAD_DEFAULT_MOVES.has(move.name)) return true;
            if (SAMPLE_SET_LOW_VALUE_UTILITY_MOVES.has(move.name)) return true;
            return false;
        }

        // ----- Pokemon Showdown teambuilder "usually useless moves" model -----
        // Ported from BattleMoveSearch.moveIsNotUseless() in
        // play.pokemonshowdown.com/src/battle-dex-search.ts. That's the exact
        // logic Showdown's own teambuilder uses to decide whether a move goes
        // under "Moves" or gets demoted to "Usually useless moves" for a given
        // species. We don't have gen-specific formats/doubles here (Fakemon are
        // always evaluated as a modern-gen, singles, non-hackmons context), so
        // this ports the generation-agnostic switch-case + move-list rules,
        // which is the part that actually applies to a custom species.
        const toShowdownId = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');

        const SHOWDOWN_GOOD_STATUS_MOVES = new Set([
            'acidarmor','agility','aromatherapy','auroraveil','autotomize','banefulbunker','batonpass','bellydrum','bulkup','burningbulwark','calmmind','chillyreception','clangoroussoul','coil','cottonguard','courtchange','curse','defog','destinybond','detect','disable','dragondance','encore','extremeevoboost','filletaway','geomancy','glare','haze','healbell','healingwish','healorder','heartswap','honeclaws','kingsshield','leechseed','lightscreen','lovelykiss','lunardance','magiccoat','maxguard','memento','milkdrink','moonlight','morningsun','nastyplot','naturesmadness','noretreat','obstruct','painsplit','partingshot','perishsong','protect','quiverdance','recover','reflect','reflecttype','rest','revivalblessing','roar','rockpolish','roost','shedtail','shellsmash','shiftgear','shoreup','silktrap','slackoff','sleeppowder','sleeptalk','softboiled','spikes','spikyshield','spore','stealthrock','stickyweb','strengthsap','substitute','switcheroo','swordsdance','synthesis','tailglow','tailwind','taunt','thunderwave','tidyup','toxic','transform','trick','victorydance','whirlwind','willowisp','wish','yawn'
        ]);
        const SHOWDOWN_GOOD_WEAK_MOVES = new Set([
            'accelerock','acrobatics','aquacutter','avalanche','barbbarrage','bonemerang','bouncybubble','bulletpunch','buzzybuzz','ceaselessedge','circlethrow','clearsmog','doubleironbash','dragondarts','dragontail','drainingkiss','endeavor','facade','firefang','flipturn','flowertrick','freezedry','frustration','geargrind','gigadrain','grassknot','gyroball','icefang','iceshard','iciclespear','infernalparade','knockoff','lastrespects','lowkick','machpunch','mortalspin','mysticalpower','naturesmadness','nightshade','nuzzle','pikapapow','populationbomb','psychocut','psyshieldbash','pursuit','quickattack','ragefist','rapidspin','return','rockblast','ruination','saltcure','scorchingsands','seismictoss','shadowclaw','shadowsneak','sizzlyslide','stoneaxe','storedpower','stormthrow','suckerpunch','superfang','surgingstrikes','tachyoncutter','tailslap','thunderclap','tripleaxel','tripledive','twinbeam','uturn','vacuumwave','veeveevolley','voltswitch','watershuriken','weatherball'
        ]);
        const SHOWDOWN_BAD_STRONG_MOVES = new Set([
            'belch','burnup','crushclaw','dragonrush','dreameater','eggbomb','firepledge','flyingpress','futuresight','grasspledge','hyperbeam','hyperfang','hyperspacehole','jawlock','landswrath','megakick','megapunch','mistyexplosion','muddywater','nightdaze','pollenpuff','rockclimb','selfdestruct','shelltrap','skyuppercut','slam','strength','submission','synchronoise','takedown','thrash','uproar','waterpledge'
        ]);

        // set-level context (ability/item) isn't always known at the point
        // sampleMoveIsActuallyUseful is called - most callers only have the
        // profile and are asking "could this move be useful at all". When an
        // explicit ability/item isn't supplied, a move that Showdown gates on a
        // specific ability/item is treated as useful if ANY ability the Fakemon
        // actually has would make it so, mirroring how the teambuilder shows the
        // move as soon as it's plausible for that species.
        function sampleShowdownAbilityIds(profile, set) {
            if (set && set.ability) return [toShowdownId(set.ability)];
            const names = (profile?.abilities || []).map(a => a?.name).filter(Boolean);
            return names.length ? names.map(toShowdownId) : [''];
        }

        // returns true/false when this move is explicitly ability/item/species
        // gated by Showdown's model, or null when it falls through to the
        // generic power/accuracy/flag rules below.
        function sampleShowdownMoveNotUselessForAbility(id, species, moveNames, abilityid, itemid) {
            switch (id) {
            case 'fakeout': case 'flamecharge': case 'nuzzle': case 'poweruppunch': case 'trailblaze':
                return abilityid !== 'sheerforce';
            case 'solarbeam': case 'solarblade':
                return ['desolateland','drought','chlorophyll','orichalcumpulse'].includes(abilityid) || itemid === 'powerherb';
            case 'dynamicpunch': case 'grasswhistle': case 'inferno': case 'sing':
                return abilityid === 'noguard';
            case 'aerialace':
                return ['technician','toughclaws'].includes(abilityid) && !moveNames.includes('bravebird');
            case 'ancientpower':
                return ['serenegrace','technician'].includes(abilityid) || !moveNames.includes('powergem');
            case 'aquajet':
                return !moveNames.includes('jetpunch');
            case 'aurawheel':
                return species.baseSpecies === 'Morpeko';
            case 'axekick':
                return !moveNames.includes('highjumpkick');
            case 'barrier':
                return !moveNames.includes('acidarmor');
            case 'bellydrum':
                return moveNames.includes('aquajet') || moveNames.includes('jetpunch') || moveNames.includes('extremespeed') ||
                    ['iceface','unburden'].includes(abilityid);
            case 'bulletseed':
                return ['skilllink','technician'].includes(abilityid);
            case 'chillingwater':
                return !moveNames.includes('scald');
            case 'counter': case 'mirrorcoat':
                return (species.baseStats.hp || 0) >= 65;
            case 'dazzlinggleam':
                return !moveNames.includes('alluringvoice');
            case 'dualwingbeat':
                return abilityid === 'technician' || !moveNames.includes('drillpeck');
            case 'electroshot':
                return true;
            case 'feint':
                return abilityid === 'refrigerate';
            case 'futuresight':
                return true;
            case 'grassyglide':
                return abilityid === 'grassysurge';
            case 'gyroball':
                return (species.baseStats.spe || 0) <= 60;
            case 'headbutt':
                return abilityid === 'serenegrace';
            case 'hex':
                return !moveNames.includes('infernalparade');
            case 'hyperspacefury':
                return species.id === 'hoopaunbound';
            case 'hypnosis':
                return abilityid === 'baddreams';
            case 'icepunch':
                return !moveNames.includes('icespinner') || ['sheerforce','ironfist'].includes(abilityid) || itemid === 'punchingglove';
            case 'iciclecrash':
                return !moveNames.includes('mountaingale');
            case 'iciclespear':
                return true;
            case 'icywind':
                return species.baseSpecies === 'Keldeo';
            case 'incinerate':
                return !moveNames.includes('flamethrower') && !moveNames.includes('mysticalfire') && !moveNames.includes('burningjealousy');
            case 'infestation':
                return moveNames.includes('stickyweb');
            case 'irondefense':
                return !moveNames.includes('acidarmor') && !moveNames.includes('barrier');
            case 'irontail':
                return !moveNames.includes('ironhead') && !moveNames.includes('gunkshot') && !moveNames.includes('poisonjab');
            case 'jumpkick':
                return !moveNames.includes('highjumpkick') && !moveNames.includes('axekick');
            case 'lastresort':
                return true;
            case 'leafblade':
                return true;
            case 'leechlife':
                return true;
            case 'magiccoat':
                return true;
            case 'meteorbeam':
                return true;
            case 'mysticalfire':
                return !moveNames.includes('flamethrower');
            case 'naturepower':
                return false;
            case 'nightslash':
                return !moveNames.includes('crunch') && !moveNames.includes('knockoff');
            case 'outrage':
                return !moveNames.includes('glaiverush');
            case 'petaldance':
                return abilityid === 'owntempo';
            case 'phantomforce':
                return !moveNames.includes('poltergeist') && !moveNames.includes('shadowclaw');
            case 'poisonfang':
                return (species.types || []).includes('Poison') && !moveNames.includes('gunkshot') && !moveNames.includes('poisonjab');
            case 'raindance':
                return false;
            case 'relicsong':
                return species.id === 'meloetta';
            case 'refresh':
                return !moveNames.includes('aromatherapy') && !moveNames.includes('healbell');
            case 'risingvoltage':
                return abilityid === 'electricsurge' || abilityid === 'hadronengine';
            case 'rocktomb':
                return abilityid === 'technician';
            case 'selfdestruct':
                return !moveNames.includes('explosion');
            case 'shadowpunch':
                return abilityid === 'ironfist' && !moveNames.includes('ragefist');
            case 'shelter':
                return !moveNames.includes('acidarmor') && !moveNames.includes('irondefense');
            case 'skyuppercut':
                return false;
            case 'smackdown':
                return (species.types || []).includes('Ground');
            case 'smartstrike':
                return (species.types || []).includes('Steel') && !moveNames.includes('ironhead');
            case 'soak':
                return abilityid === 'unaware';
            case 'steelwing':
                return !moveNames.includes('ironhead');
            case 'stompingtantrum':
                return !moveNames.includes('earthquake') && !moveNames.includes('drillrun');
            case 'stunspore':
                return !moveNames.includes('thunderwave');
            case 'sunnyday':
                return false;
            case 'technoblast':
                return itemid.endsWith('drive') || itemid === 'dousedrive';
            case 'teleport':
                return true;
            case 'temperflare':
                return !moveNames.includes('flareblitz') && !moveNames.includes('pyroball') && !moveNames.includes('sacredfire') &&
                    !moveNames.includes('bitterblade') && !moveNames.includes('firepunch');
            case 'terrainpulse': case 'waterpulse':
                return ['megalauncher','technician'].includes(abilityid) && !moveNames.includes('originpulse');
            case 'toxicspikes':
                return abilityid !== 'toxicdebris';
            case 'triattack':
                return true;
            case 'trickroom':
                return (species.baseStats.spe || 0) <= 100;
            case 'wildcharge':
                return !moveNames.includes('supercellslam');
            case 'zapcannon':
                return abilityid === 'noguard';
            default:
                return null;
            }
        }

        // Fakemon don't carry a fixed weight stat in this editor, so
        // heatcrash/heavyslam (weight-gated on Showdown) skip the ability-gate
        // pass below and fall through to the generic power/accuracy rules.
        function sampleShowdownMoveIsNotUseless(move, profile, set) {
            const id = toShowdownId(move.name);
            const species = { baseStats: profile?.stats || {}, types: profile?.types || [], baseSpecies: '', id: '' };
            const moveNames = (profile?.moves || []).map(m => toShowdownId(m.name));
            const itemid = set && set.item ? toShowdownId(set.item) : '';
            const abilityIds = sampleShowdownAbilityIds(profile, set);

            if (id !== 'heatcrash' && id !== 'heavyslam') {
                const perAbility = abilityIds.map(abilityid => sampleShowdownMoveNotUselessForAbility(id, species, moveNames, abilityid, itemid));
                const decided = perAbility.filter(v => v !== null);
                if (decided.length) return decided.some(Boolean);
            }

            if (move.category === 'Status' && (String(move.status || '').toLowerCase() === 'slp' || id === 'yawn')) {
                return false;
            }
            if (move.category === 'Status') {
                return SHOWDOWN_GOOD_STATUS_MOVES.has(id);
            }
            const bp = Number(move.basePower || 0);
            if (bp < 75) {
                const isTechnician = abilityIds.includes('technician');
                return SHOWDOWN_GOOD_WEAK_MOVES.has(id) || (isTechnician && bp === 60);
            }
            if (id === 'skydrop') return true;
            if (move.flags && move.flags.charge) return itemid === 'powerherb';
            if (move.flags && move.flags.recharge) return false;
            if (move.flags && move.flags.slicing && abilityIds.includes('sharpness')) return true;
            return !SHOWDOWN_BAD_STRONG_MOVES.has(id);
        }

        function sampleMoveIsActuallyUseful(move, profile = null, role = null, set = null) {
            if (!move || !move.name) return false;
            if (sampleMoveIsBanned(move)) return false;
            if (SAMPLE_SET_BAD_DEFAULT_MOVES.has(move.name)) return false;
            if (SAMPLE_SET_SELF_KO_MOVES.has(move.name)) return false;
            const kind = sampleMoveKind(move);
            if (kind.hazard || kind.removal || kind.pivot || kind.setup || kind.defensiveSetup || kind.disruption || kind.speedControl || kind.screens) return true;
            // only status moves with explicit recovery semantics count as recovery.
            if (kind.recovery && move.category === 'Status') return true;
            // signature/premium attacks stay viable regardless of Showdown's generic
            // classification, as long as they still clear a real power/accuracy bar.
            if (sampleIsDamaging(move) && SAMPLE_SET_PREMIUM_ATTACKS.has(move.name)) {
                const bp = sampleEffectiveBasePower(move);
                const accuracy = move.accuracy === true || move.accuracy == null || Number(move.accuracy) >= 65;
                if (accuracy && bp >= 90) return true;
            }
            if (!profile) {
                // no profile context (types/stats/movepool) to run the Showdown
                // ability/species-gated rules against - fall back to its own
                // combat stats via the intrinsic scorer.
                if (!sampleIsDamaging(move)) return SHOWDOWN_GOOD_STATUS_MOVES.has(toShowdownId(move.name));
                return sampleMoveIntrinsicScore(move) >= 58;
            }
            return sampleShowdownMoveIsNotUseless(move, profile, set);
        }

        function sampleIsPassiveProfile(profile, role) {
            if (!['defensive','support','hazard'].includes(role)) return false;

            const damaging = profile.moves.filter(m => sampleIsDamaging(m) && sampleMoveIsActuallyUseful(m));
            const strongAttacks = damaging.filter(m => (m.basePower || 0) >= 80).length;
            const atk = Number(profile.stats.atk || 0);
            const spa = Number(profile.stats.spa || 0);

            // fixed-damage/attrition attacks are for Pokemon that genuinely cannot
            // threaten opponents well through normal attacks.
            return strongAttacks <= 1 && Math.max(atk, spa) < 90;
        }

        function sampleHasTrappingGameplan(profile, chosen, role = '') {
            const chosenNames = new Set((chosen || []).map(m => m.name));

            // shadow tag / arena trap / magnet pull already provide the trapping
            // mechanism. do not add fire spin / whirlpool / magma storm just because
            // one of these abilities is present.
            if (SAMPLE_SET_TRAPPING_ABILITIES.test((profile.abilities || []).join(' '))) return false;

            // an explicit trapping move means trapping is deliberately part of the set.
            if ([...SAMPLE_SET_EXPLICIT_TRAPPING_MOVES].some(name => chosenNames.has(name))) return true;

            // very passive Pokemon may use trapping damage as their actual attrition plan.
            return sampleIsPassiveProfile(profile, role);
        }

        function sampleHasScreensGameplan(profile) {
            const moveNames = new Set(profile.moves.map(m => m.name));
            const hasReflect = moveNames.has('Reflect');
            const hasLightScreen = moveNames.has('Light Screen');
            const hasAuroraVeil = moveNames.has('Aurora Veil');
            const hasPivot = profile.moves.some(m => sampleMoveKind(m).pivot);
            const prankster = /prankster/i.test((profile.abilities || []).join(' '));
            const fast = Number(profile.stats.spe || 0) >= 100;
            const snowAbility = /snow warning/i.test((profile.abilities || []).join(' '));

            // a screens set is an actual archetype, not a generic support set.
            // normal screens requires both reflect and light screen. aurora veil is
            // the only alternative, and it requires an actual snow-setting ability.
            const dualScreens = hasReflect && hasLightScreen;
            const veilScreens = hasAuroraVeil && snowAbility;

            // it also needs a credible way to establish screens: fast enough to act
            // before most threats or prankster, plus a pivoting move to retain momentum.
            return (dualScreens || veilScreens) && hasPivot && (fast || prankster);
        }

        function sampleIsScreensMoveAllowed(move, profile, role, chosen) {
            if (!sampleMoveKind(move).screens) return true;
            if (role !== 'screens' || !sampleHasScreensGameplan(profile)) return false;

            const names = new Set(profile.moves.map(m => m.name));
            const hasReflect = names.has('Reflect');
            const hasLightScreen = names.has('Light Screen');
            const hasVeil = names.has('Aurora Veil');
            const snowAbility = /snow warning/i.test((profile.abilities || []).join(' '));

            if (move.name === 'Aurora Veil') return hasVeil && snowAbility;
            if (move.name === 'Reflect') return hasReflect && hasLightScreen && !hasVeil;
            if (move.name === 'Light Screen') return hasLightScreen && hasReflect && !hasVeil;
            return false;
        }

        function sampleHasExternalCondition(profile, chosen, condition) {
            const chosenNames = new Set((chosen || []).map(m => m.name));
            const abilityText = (profile.abilities || []).join(' ').toLowerCase();

            if (condition === 'sun') {
                return chosenNames.has('Sunny Day') || /drought|desolate land|orichalcum pulse/.test(abilityText);
            }
            if (condition === 'rain') {
                return chosenNames.has('Rain Dance') || /drizzle|primordial sea/.test(abilityText);
            }
            if (condition === 'sand') {
                return chosenNames.has('Sandstorm') || /sand stream|sand spit/.test(abilityText);
            }
            if (condition === 'snow') {
                return chosenNames.has('Snowscape') || chosenNames.has('Hail') || /snow warning/.test(abilityText);
            }
            if (condition === 'terrain') {
                return SAMPLE_SET_TERRAIN_SETTERS.has([...chosenNames].find(n => SAMPLE_SET_TERRAIN_SETTERS.has(n))) ||
                    /electric surge|grassy surge|misty surge|psychic surge/.test(abilityText);
            }

            return false;
        }

        function sampleHasConditionalCoverageSupport(move, profile, chosen) {
            if (!SAMPLE_SET_CONDITIONAL_COVERAGE_MOVES.has(move.name)) return true;

            // sun-dependent attacks.
            if (['Solar Beam','Solar Blade','Weather Ball'].includes(move.name)) {
                return sampleHasExternalCondition(profile, chosen, 'sun');
            }

            // rain-dependent / rain-enhanced attacks. electro shot is especially
            // inappropriate as generic coverage because it normally requires rain.
            if (['Thunder','Hurricane','Electro Shot'].includes(move.name)) {
                return sampleHasExternalCondition(profile, chosen, 'rain');
            }

            // blizzard is the snow analogue.
            if (move.name === 'Blizzard') {
                return sampleHasExternalCondition(profile, chosen, 'snow');
            }

            // terrain-dependent moves should only be selected when the set supplies
            // a terrain or the ability supplies one automatically.
            if (['Terrain Pulse','Nature Power','Rising Voltage','Grassy Glide','Expanding Force','Psyblade'].includes(move.name)) {
                return sampleHasExternalCondition(profile, chosen, 'terrain');
            }

            return false;
        }

        // these moves can be legal and occasionally useful on a hand-built set, but
        // they are poor defaults for an automatically generated competitive sample set.
        // in particular, two-turn attacks must never be allowed to masquerade as ordinary
        // coverage just because their displayed BP is high.
        const SAMPLE_SET_NEVER_AUTO_COVERAGE_MOVES = new Set([
            'Bounce','Fly','Dig','Dive','Phantom Force','Shadow Force',
            'Skull Bash','Sky Attack','Razor Wind','Belch'
        ]);

        // tera blast is not generic coverage. it is a strategic fallback for offensive
        // sets whose movepool does not provide meaningful off-type attacks. in particular,
        // never use it to fill a defensive/support/hazard set's last slot when the Pokemon
        // already has ordinary utility such as knock off, recovery, hazards, removal, etc.
        const SAMPLE_SET_OFFENSIVE_TERA_ROLES = new Set([
            'physicalSweeper','specialSweeper','setupSweeper','wallbreaker'
        ]);

        // rest is legitimate on some bulky/defensive strategies, but it should not
        // consume a slot on an offensive sweeper when that slot can provide coverage
        // or another offensive tool. sleep talk can still be used manually.
        const SAMPLE_SET_OFFENSIVE_NO_REST_ROLES = new Set([
            'physicalSweeper','specialSweeper','setupSweeper','wallbreaker'
        ]);

        function sampleHasNaturalCoverageOptions(profile, role) {
            const cache = sampleGenerationMemo?.naturalCoverage;
            const key = role || '';
            if (cache?.has(key)) return cache.get(key);
            const options = profile.moves.filter(m => {
                if (!m?.name || m.name === 'Tera Blast') return false;
                if (sampleMoveIsBanned(m) || SAMPLE_SET_SELF_KO_MOVES.has(m.name) || SAMPLE_SET_BAD_DEFAULT_MOVES.has(m.name)) return false;
                if (!sampleIsDamaging(m) || profile.types.includes(m.type)) return false;
                if (SAMPLE_SET_NEVER_AUTO_COVERAGE_MOVES.has(m.name)) return false;
                if (sampleIsTwoTurnAttack(m)) return false;
                if (!sampleMoveCompatibleWithRole(m, profile, role)) return false;
                return sampleHasGoodCoverage(m, profile, []);
            });
            if (cache) cache.set(key, options);
            return options;
        }

        function sampleTeraBlastAllowed(profile, role, chosen = []) {
            if (!SAMPLE_SET_OFFENSIVE_TERA_ROLES.has(role)) return false;
            // if the movepool already gives the offensive set meaningful natural coverage,
            // use that move instead of spending a slot on tera blast.
            const naturalCoverage = sampleHasNaturalCoverageOptions(profile, role);
            if (naturalCoverage.length > 0) return false;
            // a tera blast already selected should not somehow justify another tera blast.
            if (chosen.some(m => m.name === 'Tera Blast')) return false;
            return true;
        }

        function sampleHasGoodCoverage(move, profile, chosen) {
            const cache = sampleGenerationMemo?.goodCoverage;
            const key = `${move?.name || ''}|${(chosen || []).map(m => m?.name || '').sort().join('\x1f')}`;
            if (cache?.has(key)) return cache.get(key);
            const finish = value => { if (cache) cache.set(key, value); return value; };
            if (!sampleIsDamaging(move) || profile.types.includes(move.type)) return finish(false);
            // never let a two-turn attack enter an automatic coverage slot.
            // its raw BP is not a meaningful representation of its competitive role.
            if (SAMPLE_SET_NEVER_AUTO_COVERAGE_MOVES.has(move.name)) return finish(false);
            if (!sampleMoveIsActuallyUseful(move)) return finish(false);

            // trapping damage is not generic coverage. fire spin / whirlpool /
            // magma storm / etc. need an actual trapping plan.
            if (SAMPLE_SET_TRAPPING_DAMAGE_MOVES.has(move.name) && !sampleHasTrappingGameplan(profile, chosen)) {
                return finish(false);
            }

            // conditional/weather/terrain attacks should not be treated as normal
            // coverage without the condition that makes them worthwhile.
            if (!sampleHasConditionalCoverageSupport(move, profile, chosen)) return finish(false);

            const bp = sampleEffectiveBasePower(move);

            // coverage gets a substantially higher quality floor than ordinary
            // "useful" attacks. weak attacks should not occupy an offensive coverage
            // slot merely because they happen to hit something super-effectively.
            const premiumCoverage = SAMPLE_SET_PREMIUM_ATTACKS.has(move.name);
            if (bp < 80 && !(premiumCoverage && bp >= 70)) return finish(false);

            // air slash is perfectly legitimate as STAB, but should not be treated as
            // strong off-type coverage merely because it is a legal damaging move.
            if (move.name === 'Air Slash' && !profile.types.includes(move.type)) return finish(false);

            const chosenGood = chosen.filter(sampleMoveIsActuallyUseful);
            const stabTypes = profile.types;
            let best = 1;

            for (const defender of SAMPLE_SET_COVERAGE_TYPES) {
                const stabBest = Math.max(...stabTypes.map(t => sampleTypeEffectiveness(t, defender)));
                const cov = sampleTypeEffectiveness(move.type, defender);
                if (stabBest < 2 && cov >= 2) best = Math.max(best, cov);
            }

            if (best < 2) return finish(false);
            if (chosenGood.some(m => !profile.types.includes(m.type) && m.type === move.type)) return finish(false);
            return finish(true);
        }

        function sampleMoveScore(move, profile, role, chosen) {
            const { stats, types } = profile;
            const kind = sampleMoveKind(move);
            const req = sampleRoleMoveRequirements(role);
            let score = 0;

            if (!sampleMoveCompatibleWithRole(move, profile, role)) return -10000;
            if (SAMPLE_SET_BAD_DEFAULT_MOVES.has(move.name)) return -9000;
            if (SAMPLE_SET_NEVER_AUTO_COVERAGE_MOVES.has(move.name) && move.name === 'Belch') return -9000;
            if (move.name === 'Rest' && SAMPLE_SET_OFFENSIVE_NO_REST_ROLES.has(role)) return -9000;
            if (move.name === 'Tera Blast' && !sampleTeraBlastAllowed(profile, role, chosen)) return -9000;
            if (kind.selfKO) return -8500;

            // trapping damage is specialized tech, not generic utility. do not let
            // fire spin/whirlpool/etc. win simply because their raw damage/secondary
            // effect score happens to look attractive.
            if (SAMPLE_SET_TRAPPING_DAMAGE_MOVES.has(move.name) && !sampleHasTrappingGameplan(profile, chosen, role)) {
                return -7000;
            }

            if (SAMPLE_SET_PASSIVE_DAMAGE_MOVES.has(move.name) && !sampleIsPassiveProfile(profile, role)) {
                return -7000;
            }

            if (!sampleIsScreensMoveAllowed(move, profile, role, chosen)) {
                return -7000;
            }

            if (SAMPLE_SET_CONDITIONAL_COVERAGE_MOVES.has(move.name) && !sampleHasConditionalCoverageSupport(move, profile, chosen)) {
                return -7000;
            }

            const usefulness = sampleCompetitiveUsefulness(move);
            score += usefulness * SAMPLE_SET_CONFIG.move.usefulness;

            // knock off is unusually valuable utility: it permanently removes an
            // opponent's item and is useful across offensive, defensive, support,
            // hazard, and pivot sets. do not let raw damage/BP or mediocre coverage
            // scoring push it behind a redundant attack.
            if (move.name === 'Knock Off') {
                score += ['defensive','support','hazard','pivot'].includes(role) ? 52 : 38;
            }
            if (!sampleIsDamaging(move) && !kind.recovery && !kind.hazard && !kind.removal && !kind.pivot && !kind.disruption && !kind.speedControl && !kind.screens && !kind.setup && !kind.defensiveSetup) score -= 40;

            if (sampleIsDamaging(move)) {
                if (types.includes(move.type)) score += SAMPLE_SET_CONFIG.move.stab;
                // coverage is a bonus only when it is genuinely good. it is never a
                // requirement, so a mediocre coverage move cannot beat a useful STAB,
                // recovery, setup, or utility move just because it is super effective.
                score += sampleCoverageScore(move, types, chosen);
                // strong attacks deserve to compete on their actual combat value, not
                // merely on usage frequency. this is especially important for legal
                // Fakemon movepools containing moves such as v-create or gigaton hammer.
                const effBp = sampleEffectiveBasePower(move);
                score += Math.min(10, effBp * 0.05);
                if (SAMPLE_SET_PREMIUM_ATTACKS.has(move.name)) score += 24;

                // v-create, superpower, close combat, boomburst, etc. are good
                // attacks in their own right. contrary is an optional synergy, not
                // a prerequisite for selecting them.
                if (move.name === 'V-create') score += 18;
                if (move.name === 'Superpower' || move.name === 'Close Combat' || move.name === 'Boomburst') score += 12;
                if (effBp >= 120 && (move.accuracy === true || move.accuracy == null || Number(move.accuracy) >= 80)) score += 8;
                if (move.accuracy === true || move.accuracy === undefined) score += SAMPLE_SET_CONFIG.move.accuracy;
                else if (typeof move.accuracy === 'number') score += (move.accuracy / 100) * SAMPLE_SET_CONFIG.move.accuracy;
                if (move.priority > 0) score += SAMPLE_SET_CONFIG.move.priority;
                if (req.attack === move.category) score += 15;
                if (!sampleMoveIsActuallyUseful(move)) score -= 25;
                if (effBp < 60) score -= SAMPLE_SET_CONFIG.move.lowPowerPenalty;
                // big self-damage costs are far worse on a set that needs to survive
                // multiple turns (setup sweepers, bulky attackers) than on a wallbreaker
                // that's already committing to trading in one or two hits.
                const setupReliant = ['physicalSweeper','specialSweeper','setupSweeper','bulkyAttacker'].includes(role);
                if (SAMPLE_SET_HEAVY_SELF_DAMAGE_MOVES.has(move.name)) score -= setupReliant ? 55 : 18;
                else if ((move.flags || {}).recoil) score -= setupReliant ? 20 : 8;
            }

            // stat-aware offensive fit. the same move is worth more when it matches the
            // fakemon's genuinely superior attacking stat.
            if (sampleIsDamaging(move)) {
                if (move.category === 'Physical') score += Math.max(-4, Math.min(12, (stats.atk - stats.spa) * 0.18));
                if (move.category === 'Special') score += Math.max(-4, Math.min(12, (stats.spa - stats.atk) * 0.18));

                // contrary makes self-dropping attacks a central part of the set.
                // without this, a high-bp move can lose to generic STAB/utility even
                // though the ability fundamentally changes how the move functions.
                const abilityText = (profile.abilities || []).join(' ').toLowerCase();
                if (/contrary/.test(abilityText)) {
                    const moveText = `${move.name} ${move.desc || ''}`.toLowerCase();
                    const selfDrop = SAMPLE_SET_CONTRARY_SYNERGY_MOVES.has(move.name) ||
                        /(?:lowers?|drops?).*(?:user|its).*(?:attack|defen|sp\.? atk|sp\.? def|speed|stats)/i.test(moveText);
                    const directBoost = /(?:raises?|boosts?).*(?:user|its).*(?:attack|defen|sp\.? atk|sp\.? def|speed|stats)/i.test(moveText);
                    // contrary synergy is deliberately modest here. the move must
                    // already be good on its own; this bonus simply makes the ability
                    // and move converge on the same generated set.
                    if (selfDrop) score += 28;
                    if (directBoost) score -= 35;
                }
            }

            if (kind.setup) {
                score += req.preferSetup ? SAMPLE_SET_CONFIG.move.setup : -12;

                const premiumSetup = new Set([
                    'Shell Smash','Quiver Dance','Victory Dance','Shift Gear','Dragon Dance'
                ]);
                const strongSetup = new Set([
                    'Swords Dance','Nasty Plot','Tail Glow','Geomancy','Fillet Away'
                ]);
                const genericSetup = new Set([
                    'Calm Mind','Bulk Up','Coil','Growth','Work Up','Hone Claws'
                ]);

                if (premiumSetup.has(move.name)) {
                    score += 75;
                    if (req.preferSpeed) score += 25;
                } else if (strongSetup.has(move.name)) {
                    score += 30;
                } else if (genericSetup.has(move.name)) {
                    score += 4;
                }
            }
            if (kind.recovery) {
                score += req.preferRecovery ? SAMPLE_SET_CONFIG.move.recovery : (role === 'physicalSweeper' || role === 'specialSweeper' || role === 'wallbreaker' ? -5 : 8);
                if (['defensive','support','hazard','bulkyAttacker'].includes(role)) score += 18;
            }
            if (kind.hazard) score += req.preferHazard ? SAMPLE_SET_CONFIG.move.hazard : (['defensive','support','hazard'].includes(role) ? 10 : -4);
            if (kind.removal) {
                if (['defensive','support','pivot','hazard'].includes(role)) score += SAMPLE_SET_CONFIG.move.removal + 18;
                else score += 2;
            }
            if (kind.pivot) {
                if (['defensive','support','hazard','bulkyAttacker'].includes(role)) score += 18;
                if (role === 'pivot') score += SAMPLE_SET_CONFIG.move.pivot;
                else score += 3;
            }
            if (kind.speedControl) score += ['support','pivot'].includes(role) ? SAMPLE_SET_CONFIG.move.speedControl : 1;
            if (kind.disruption) score += ['support','defensive','pivot'].includes(role) ? SAMPLE_SET_CONFIG.move.disruption : (role === 'setupSweeper' || role === 'physicalSweeper' || role === 'specialSweeper' || role === 'wallbreaker' ? 1 : 2);
            if (move.name === 'Taunt' && ['setupSweeper','physicalSweeper','specialSweeper','wallbreaker'].includes(role)) score -= 12;
            if (kind.screens) score += role === 'screens' ? 55 : -7000;
            score += sampleAbilityScore(move, profile, role);

            // defensive roles should not spend slots on four attacks if they have real
            // longevity/utility available.
            if (['defensive','support','hazard'].includes(role) && sampleIsDamaging(move)) score -= 4;
            if (role === 'bulkyAttacker' && sampleIsDamaging(move)) score += 3;

            chosen.forEach(other => {
                const ok = sampleMoveKind(other);
                if (sampleIsDamaging(move) && sampleIsDamaging(other)) {
                    if (move.type === other.type) score -= types.includes(move.type) ? 8 : SAMPLE_SET_CONFIG.move.redundantTypePenalty;
                    if (move.category === other.category && !types.includes(move.type)) score -= 6;
                }
                if (kind.setup && ok.setup) score -= SAMPLE_SET_CONFIG.move.redundantRolePenalty;
                if (kind.recovery && ok.recovery) score -= SAMPLE_SET_CONFIG.move.redundantRolePenalty * 2;
                if (kind.hazard && ok.hazard) score -= SAMPLE_SET_CONFIG.move.redundantRolePenalty * 2;
                if (kind.removal && ok.removal) score -= SAMPLE_SET_CONFIG.move.redundantRolePenalty * 2;
                if (kind.pivot && ok.pivot) score -= SAMPLE_SET_CONFIG.move.redundantRolePenalty * 2;
            });

            return score;
        }

        function sampleIsTwoTurnAttack(move) {
            if (!sampleIsDamaging(move)) return false;
            if (SAMPLE_SET_NEVER_AUTO_COVERAGE_MOVES.has(move.name)) return true;
            const text = `${move.name} ${move.desc || ''}`.toLowerCase();
            return /charges? on the first turn|charges? up on the first turn|dives? underwater|burrows? underground|becomes? invulnerable.*first turn|disappears?.*first turn|takes? two turns/.test(text);
        }

        function sampleSetCoherenceScore(profile, role, chosen) {
            if (!chosen.length) return 0;
            const cache = sampleGenerationMemo?.coherence;
            const key = sampleMemoKey(role, chosen);
            if (cache?.has(key)) return cache.get(key);

            const kinds = chosen.map(sampleMoveKind);
            const damaging = chosen.filter(sampleIsDamaging);
            const stabs = damaging.filter(m => profile.types.includes(m.type));
            const coverage = damaging.filter(m => !profile.types.includes(m.type));
            const setup = chosen.filter(m => sampleMoveKind(m).setup);
            const recovery = chosen.filter(m => sampleMoveKind(m).recovery);
            const hazards = chosen.filter(m => sampleMoveKind(m).hazard);
            const removal = chosen.filter(m => sampleMoveKind(m).removal);
            const pivots = chosen.filter(m => sampleMoveKind(m).pivot);
            const disruption = chosen.filter(m => sampleMoveKind(m).disruption);
            const speedControl = chosen.filter(m => sampleMoveKind(m).speedControl);
            const screens = chosen.filter(m => sampleMoveKind(m).screens);
            const statuses = chosen.filter(m => m.category === 'Status');
            let score = 0;

            // the set should have a clear identity rather than four individually good moves.
            if (['physicalSweeper','specialSweeper','setupSweeper'].includes(role)) {
                if (setup.length) score += 28;
                if (damaging.length >= 2) score += 22;
                if (stabs.length) score += 18;
                if (coverage.length === 1) score += 10;
                if (coverage.length > 1) score -= (coverage.length - 1) * 10;
                if (recovery.length && setup.length) score += 8;
                if (recovery.length && !setup.length) score -= 4;
                if (statuses.length >= 3) score -= 18;
            }

            if (role === 'wallbreaker') {
                if (damaging.length >= 2) score += 24;
                if (stabs.length) score += 18;
                if (coverage.length === 1) score += 10;
                if (coverage.length > 1) score -= (coverage.length - 1) * 9;
                if (setup.length) score -= 12;
                if (recovery.length) score -= 6;
            }

            if (role === 'bulkyAttacker') {
                if (damaging.length >= 2) score += 20;
                if (stabs.length) score += 16;
                if (recovery.length) score += 22;
                if (coverage.length === 1) score += 8;
                if (coverage.length > 1) score -= (coverage.length - 1) * 8;
                if (setup.length) score += 8;
            }

            if (role === 'defensive') {
                if (recovery.length) score += 28;
                if (statuses.length >= 2) score += 10;
                if (hazards.length) score += 18;
                if (removal.length) score += 18;
                if (disruption.length) score += 16;
                if (pivots.length) score += 8;
                if (damaging.length >= 1) score += 14;
                if (damaging.length > 2) score -= (damaging.length - 2) * 10;
                // defensive sets should strongly prefer useful utility over an off-type
                // attack that only looks attractive because of raw power/coverage.
                const defensiveCoverage = coverage.length;
                if (defensiveCoverage) score -= defensiveCoverage * 14;
                if (setup.length) score += 8;
            }

            if (role === 'support') {
                if (recovery.length) score += 20;
                if (disruption.length) score += 18;
                if (speedControl.length) score += 14;
                if (pivots.length) score += 12;
                if (damaging.length === 1) score += 14;
                if (damaging.length > 2) score -= (damaging.length - 2) * 10;
            }

            if (role === 'pivot') {
                if (pivots.length) score += 42;
                if (damaging.length >= 1) score += 18;
                if (stabs.length) score += 12;
                if (coverage.length === 1) score += 8;
                if (coverage.length > 1) score -= (coverage.length - 1) * 10;
                if (pivots.length > 1) score -= (pivots.length - 1) * 12;
            }

            if (role === 'hazard') {
                if (hazards.length) score += 40;
                if (removal.length) score += 12;
                if (recovery.length) score += 18;
                if (damaging.length >= 1) score += 12;
                if (damaging.length > 2) score -= (damaging.length - 2) * 10;
            }

            if (role === 'screens') {
                if (screens.length >= 2) score += 60;
                if (pivots.length) score += 18;
                if (damaging.length === 1) score += 10;
                if (damaging.length > 2) score -= (damaging.length - 2) * 12;
            }

            // knock off is a high-priority utility slot because it removes items and
            // remains useful even when the set is not trying to sweep immediately.
            if (chosen.some(m => m.name === 'Knock Off')) {
                score += ['defensive','support','hazard','pivot'].includes(role) ? 24 : 12;
            }

            // offensive setup sets should spend their limited slots on the actual win
            // condition. taunt can be a legitimate fourth move, but rest is not a default
            // partner for a sweeper and should never crowd out natural coverage.
            if (['physicalSweeper','specialSweeper','setupSweeper','wallbreaker'].includes(role)) {
                if (recovery.length && !['bulkyAttacker'].includes(role)) score -= recovery.length * 16;
                if (chosen.some(m => m.name === 'Taunt')) score -= 8;
                if (setup.length && damaging.length >= 2) score += 14;
                const naturalCoverage = sampleHasNaturalCoverageOptions(profile, role);
                if (setup.length && naturalCoverage.length && coverage.length === 0) score -= 28;
                if (setup.length && naturalCoverage.length && coverage.length >= 1) score += 16;
            }

            // universal redundancy control: a move is much less valuable when the set
            // already performs the same job. this is intentionally set-level rather than
            // a property of the move in isolation.
            const damagingByType = new Map();
            damaging.forEach(m => damagingByType.set(m.type, (damagingByType.get(m.type) || 0) + 1));
            for (const count of damagingByType.values()) {
                if (count > 1) score -= (count - 1) * 12;
                if (count > 2) score -= (count - 2) * 28;
            }
            if (stabs.length > 2) score -= (stabs.length - 2) * 18;

            // offensive sets should actively seek real coverage when the movepool has
            // it. a third move of an existing attacking type is not an acceptable use of
            // a slot when a useful off-type attack exists.
            if (['physicalSweeper','specialSweeper','setupSweeper','wallbreaker','bulkyAttacker','pivot'].includes(role)) {
                const naturalCoverage = sampleHasNaturalCoverageOptions(profile, role);
                if (naturalCoverage.length && coverage.length === 0 && damaging.length >= 2) score -= 22;
                if (naturalCoverage.length && coverage.length >= 1) score += 10;
            }
            if (kinds.filter(k => k.setup).length > 1) score -= 30;
            if (kinds.filter(k => k.recovery).length > 1) score -= 24;
            if (kinds.filter(k => k.hazard).length > 1) score -= 24;
            if (kinds.filter(k => k.removal).length > 1) score -= 24;

            if (cache) cache.set(key, score);
            return score;
        }

        function sampleSetPartialViability(profile, role, chosen) {
            const cache = sampleGenerationMemo?.partialViability;
            const key = sampleMemoKey(role, chosen);
            if (cache?.has(key)) return cache.get(key);
            const finish = value => { if (cache) cache.set(key, value); return value; };
            // hard constraints are checked while the set is being built. this prevents
            // the search from spending its budget on branches that can never become a
            // coherent set.
            const damaging = chosen.filter(sampleIsDamaging);
            const kinds = chosen.map(sampleMoveKind);

            if (damaging.some(sampleIsTwoTurnAttack)) return finish(false);

            if (role === 'hazard' && chosen.length >= 3 && !kinds.some(k => k.hazard)) return finish(false);
            if (role === 'pivot' && chosen.length >= 3 && !kinds.some(k => k.pivot)) return finish(false);
            if (role === 'screens' && chosen.some(m => sampleMoveKind(m).screens) &&
                !sampleIsScreensMoveAllowed(chosen.find(m => sampleMoveKind(m).screens), profile, role, chosen)) return finish(false);

            // coverage is optional, but once a set already has one off-type attack,
            // additional off-type attacks need a very strong reason to remain viable.
            const coverage = damaging.filter(m => !profile.types.includes(m.type));
            if (coverage.length > 2) return finish(false);

            // never allow three attacks of the same type on an automatic set. two can
            // be justified (e.g. a primary STAB plus a stronger secondary STAB), but
            // the third slot should be coverage or useful utility instead.
            const typeCounts = new Map();
            damaging.forEach(m => typeCounts.set(m.type, (typeCounts.get(m.type) || 0) + 1));
            if ([...typeCounts.values()].some(count => count > 2)) return finish(false);

            // when an offensive set has already committed to two attacks and the
            // movepool contains legitimate natural coverage, preserve a path for that
            // coverage instead of allowing another same-type attack to dominate the beam.
            if (['physicalSweeper','specialSweeper','setupSweeper','wallbreaker','bulkyAttacker','pivot'].includes(role) &&
                damaging.length >= 2 && coverage.length === 0 &&
                sampleHasNaturalCoverageOptions(profile, role).length > 0 &&
                chosen.length >= 3) return finish(false);

            // a setup sweeper must actually be capable of sweeping. do not allow the
            // beam to spend two or more slots on non-attacking utility when the movepool
            // contains good attacks/coverage.
            if (role === 'setupSweeper' && chosen.length >= 3 && kinds.some(k => k.setup)) {
                if (damaging.length < 2) return finish(false);
                if (sampleHasNaturalCoverageOptions(profile, role).length > 0 &&
                    !damaging.some(m => !profile.types.includes(m.type))) return finish(false);
            }

            // never build an offensive set around a status-heavy branch when there are
            // already enough attacks to perform its intended job.
            if (['physicalSweeper','specialSweeper','setupSweeper','wallbreaker'].includes(role) &&
                damaging.length >= 2 && chosen.filter(m => m.category === 'Status').length >= 2) return finish(false);

            return finish(true);
        }

        function samplePickMoves(profile, role, seed) {
            // a zero-pivot learnset must never fall through into a generic set merely
            // because the pivot role happened to rank highly or tie with another role.
            if (!sampleRoleIsFeasible(profile, role)) return [];

            const rng = sampleSetRng(seed);
            const compatible = profile.moves.filter(m =>
                m.name &&
                !sampleMoveIsBanned(m) &&
                sampleMoveCompatibleWithRole(m, profile, role)
            );
            const clean = compatible.filter(m =>
                !SAMPLE_SET_SELF_KO_MOVES.has(m.name) &&
                !SAMPLE_SET_BAD_DEFAULT_MOVES.has(m.name)
            );
            const usable = clean.length >= 4
                ? clean
                : compatible.filter(m => !SAMPLE_SET_SELF_KO_MOVES.has(m.name));

            if (usable.length < 4) return [];

            // a "hazard setter/remover" set with no hazard move, or a "pivot" set with no
            // pivot move, is a broken/misleading suggestion. fail rather than changing the
            // set identity just to reach four moves.
            if (role === 'hazard' && !usable.some(m => sampleMoveKind(m).hazard)) return [];
            if (role === 'pivot' && !usable.some(m => sampleMoveKind(m).pivot)) return [];

            const useful = m => {
                if (m.name === 'Tera Blast' && !sampleTeraBlastAllowed(profile, role, [])) return false;
                if (!sampleMoveIsActuallyUseful(m, profile, role)) return false;
                if (sampleIsTwoTurnAttack(m)) return false;
                if (sampleIsDamaging(m) && !profile.types.includes(m.type)) {
                    return sampleHasGoodCoverage(m, profile, []);
                }
                return true;
            };

            // beam-search the set instead of greedily choosing each slot independently.
            // every branch is scored as a *set in progress*, so the fourth move can
            // change the value of the first three. this is the key architectural change:
            // coverage, setup, recovery, pivots, etc. compete for the same four-slot budget.
            const candidates = usable.filter(useful);
            if (candidates.length < 4) return [];

            const beamWidth = 24;
            let beam = [{ moves: [], score: 0 }];

            for (let slot = 0; slot < 4; slot++) {
                const next = [];

                for (const stateNode of beam) {
                    const remaining = candidates.filter(m =>
                        !stateNode.moves.some(chosen => chosen.name === m.name)
                    );

                    for (const move of remaining) {
                        const chosen = [...stateNode.moves, move];

                        // off-type attacks are only allowed after the actual partial set
                        // can justify them as coverage. this eliminates moves like bounce
                        // from winning on raw BP alone.
                        if (sampleIsDamaging(move) && !profile.types.includes(move.type)) {
                            if (!sampleHasGoodCoverage(move, profile, stateNode.moves)) continue;
                            if (SAMPLE_SET_NEVER_AUTO_COVERAGE_MOVES.has(move.name)) continue;
                        }

                        if (!sampleSetPartialViability(profile, role, chosen)) continue;

                        const scoreCache = sampleGenerationMemo?.moveScore;
                        const scoreKey = sampleMoveMemoKey(role, move, stateNode.moves);
                        let moveScore;
                        if (scoreCache?.has(scoreKey)) moveScore = scoreCache.get(scoreKey);
                        else {
                            moveScore = sampleMoveScore(move, profile, role, stateNode.moves);
                            if (scoreCache) scoreCache.set(scoreKey, moveScore);
                        }
                        if (moveScore <= -6000) continue;

                        let score = stateNode.score + moveScore;
                        score += sampleSetCoherenceScore(profile, role, chosen);

                        // keep a mild preference for a distinct offensive type, but let
                        // the completed-set score decide whether a second STAB or utility
                        // move is actually better.
                        const damaging = chosen.filter(sampleIsDamaging);
                        const duplicateTypes = damaging.filter((m, i) =>
                            damaging.findIndex(x => x.type === m.type) !== i
                        ).length;
                        score -= duplicateTypes * 12;
                        const typeCounts = new Map();
                        damaging.forEach(m => typeCounts.set(m.type, (typeCounts.get(m.type) || 0) + 1));
                        for (const count of typeCounts.values()) {
                            if (count > 2) score -= 80;
                        }

                        next.push({
                            moves: chosen,
                            score: score + rng() * 0.0001
                        });
                    }
                }

                next.sort((a, b) => b.score - a.score ||
                    a.moves.map(m => m.name).join('|').localeCompare(b.moves.map(m => m.name).join('|')));
                beam = next.slice(0, beamWidth);
                if (!beam.length) return [];
            }

            const completed = beam
                .filter(node => node.moves.length === 4)
                .map(node => ({
                    moves: node.moves,
                    score: node.score + sampleSetCoherenceScore(profile, role, node.moves)
                }))
                .filter(node => {
                    const names = new Set(node.moves.map(m => m.name));
                    if (role === 'hazard' && !node.moves.some(m => sampleMoveKind(m).hazard)) return false;
                    if (role === 'pivot' && !node.moves.some(m => sampleMoveKind(m).pivot)) return false;
                    if (role === 'screens' && node.moves.filter(m => sampleMoveKind(m).screens).length < 2) return false;
                    if (role === 'setupSweeper') {
                        const setupPresent = node.moves.some(m => sampleMoveKind(m).setup);
                        const damagingMoves = node.moves.filter(sampleIsDamaging);
                        const coverageMoves = damagingMoves.filter(m => !profile.types.includes(m.type));
                        if (!setupPresent || damagingMoves.length < 2) return false;
                        if (sampleHasNaturalCoverageOptions(profile, role).length > 0 && coverageMoves.length < 1) return false;
                    }
                    return names.size === 4;
                })
                .sort((a, b) => b.score - a.score);

            return completed[0]?.moves || [];
        }

        function generateParametricSampleSet(profile, seed) {
            const def = profile.moves.find(m => ['Iron Defense','Cotton Guard','Acid Armor'].includes(m.name));
            const body = profile.moves.find(m => m.name === 'Body Press');
            if (!def || !body || profile.stats.def < 95) return null;

            // this is a named set idea, so its remaining slots must be selected around
            // the iron defense/cotton guard/acid armor + body press gameplan rather than
            // by taking the first available recovery/coverage move.
            const base = [def, body];
            const candidates = profile.moves.filter(m =>
                !base.some(x => x.name === m.name) &&
                !sampleMoveIsBanned(m) &&
                !SAMPLE_SET_SELF_KO_MOVES.has(m.name) &&
                !SAMPLE_SET_BAD_DEFAULT_MOVES.has(m.name) &&
                m.name !== 'Tera Blast' &&
                !sampleIsTwoTurnAttack(m) &&
                sampleMoveCompatibleWithRole(m, profile, 'defensive')
            );
            if (candidates.length < 2) return null;

            let best = null;
            for (const a of candidates) {
                const partial = [...base, a];
                if (sampleIsDamaging(a) && !profile.types.includes(a.type) && !sampleHasGoodCoverage(a, profile, partial.slice(0, 2))) continue;
                for (const b of candidates) {
                    if (a.name === b.name) continue;
                    const moves = [...base, a, b];
                    if (sampleIsDamaging(b) && !profile.types.includes(b.type) && !sampleHasGoodCoverage(b, profile, moves.slice(0, 3))) continue;
                    const ability = sampleChooseAbility(profile, 'defensive', moves);
                    const item = sampleChooseItem(profile, 'defensive', moves, ability);
                    const repairedMoves = sampleRepairMovesForItem(profile, 'defensive', moves, item, seed);
                    const teraType = sampleChooseTera(profile, 'defensive', repairedMoves, ability);
                    let score = sampleSetCoherenceScore(profile, 'defensive', repairedMoves);
                    score += repairedMoves.reduce((total, move, index) => total + sampleMoveScore(move, profile, 'defensive', repairedMoves.slice(0, index)), 0);
                    score += sampleAbilityFitScore(
                        (profile.abilityDetails || []).find(x => x.name === ability) || {name: ability, desc: ''},
                        profile,
                        'defensive',
                        repairedMoves
                    );
                    score += sampleItemFitScore(item, profile, 'defensive', repairedMoves, ability) * 0.5;
                    score += sampleTeraFitScore(teraType, profile, 'defensive', repairedMoves, ability) * 0.25;
                    score += sampleSetRng(seed)() * 0.0001;
                    if (!best || score > best.score) best = { moves: repairedMoves, ability, item, teraType, score };
                }
            }

            if (!best) return null;
            return {
                name: `${def.name} + Body Press`,
                role: 'Defensive Setup',
                item: best.item,
                ability: best.ability,
                nature: 'Bold',
                evs: {hp:252,atk:0,def:252,spa:0,spd:4,spe:0},
                ivs: {hp:31,atk:31,def:31,spa:31,spd:31,spe:31},
                moves: best.moves.map(m => m.name),
                teraType: best.teraType,
                level: 100
            };
        }

        function sampleChooseNatureEVs(profile, role, chosenMoves = []) {
            const s = profile.stats;
            const moves = chosenMoves || [];
            const hasCurse = moves.some(m => String(m?.name || '').toLowerCase() === 'curse');
            const hasSpeedDropSetup = moves.some(m => {
                if (!m || !m.name) return false;
                const text = `${m.name} ${m.desc || ''}`.toLowerCase();
                return /(?:lowers?|drops?).*(?:user|its).*(?:speed)/i.test(text);
            });
            const speedIsActuallySetupGoal = !hasCurse && !hasSpeedDropSetup &&
                moves.some(m => SAMPLE_SET_SETUP_SPEED_BOOST.has(m.name));
            const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
            const physical = s.atk >= s.spa;
            const fast = s.spe >= 95;
            const veryFast = s.spe >= 110;
            let nature = 'Hardy';

            if (role === 'physicalSweeper' || role === 'setupSweeper') {
                evs.atk = 252;
                if (hasCurse || hasSpeedDropSetup) {
                    // curse is not a normal speed-sweeper setup move: it actively lowers
                    // speed. match the EVs to the set we actually generated instead of
                    // blindly using the role's generic 252 atk / 252 spe template.
                    evs.hp = 252;
                    evs.def = 4;
                    nature = 'Adamant';
                } else {
                    evs.spe = 252; evs.hp = 4;
                    nature = speedIsActuallySetupGoal ? (fast ? 'Jolly' : 'Adamant') : (fast ? 'Jolly' : 'Adamant');
                }
            } else if (role === 'specialSweeper') {
                evs.spa = 252;
                if (hasSpeedDropSetup) {
                    evs.hp = 252;
                    evs.def = 4;
                    nature = 'Modest';
                } else {
                    evs.spe = 252; evs.hp = 4;
                    nature = fast ? 'Timid' : 'Modest';
                }
            } else if (role === 'wallbreaker') {
                const key = physical ? 'atk' : 'spa';
                evs[key] = 252;
                if (s.spe >= 80) { evs.spe = 252; evs.hp = 4; }
                else { evs.hp = 252; evs.spe = 4; }
                nature = key === 'atk' ? (s.spe >= 80 ? 'Jolly' : 'Adamant') : (s.spe >= 80 ? 'Timid' : 'Modest');
            } else if (role === 'bulkyAttacker') {
                const key = physical ? 'atk' : 'spa';
                evs.hp = 252;
                evs[key] = 252;
                evs[ s.def >= s.spd ? 'def' : 'spd' ] = 4;
                // don't waste a nature on speed unless the base speed is high enough
                // for the Fakemon to realistically use it as an offensive stat.
                nature = key === 'atk' ? 'Adamant' : 'Modest';
            } else if (role === 'defensive') {
                evs.hp = 252;
                if (s.def >= s.spd) { evs.def = 252; evs.spd = 4; nature = 'Bold'; }
                else { evs.spd = 252; evs.def = 4; nature = 'Calm'; }
            } else if (role === 'support') {
                evs.hp = 252;
                if (veryFast) { evs.spe = 252; evs.def = 4; nature = 'Timid'; }
                else if (s.def >= s.spd) { evs.def = 252; evs.spd = 4; nature = 'Bold'; }
                else { evs.spd = 252; evs.def = 4; nature = 'Calm'; }
            } else if (role === 'pivot') {
                const key = physical ? 'atk' : 'spa';
                evs.spe = 252;
                evs[key] = 252;
                evs.hp = 4;
                nature = key === 'atk' ? 'Jolly' : 'Timid';
            } else if (role === 'hazard') {
                evs.hp = 252;
                if (s.def >= s.spd) { evs.def = 252; evs.spd = 4; nature = 'Impish'; }
                else { evs.spd = 252; evs.def = 4; nature = 'Careful'; }
            }

            return { evs, nature };
        }

        function sampleChooseAbility(profile, role, chosenMoves = []) {
            const abilities = profile.abilityDetails?.length ? profile.abilityDetails : profile.abilities.map(name => ({name, desc:''}));
            if (!abilities.length) return '';
            const scored = abilities.map((ability, index) => ({
                name: ability.name,
                score: sampleAbilityFitScore(ability, profile, role, chosenMoves) - index * 0.001
            })).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
            return scored[0].name;
        }

        function hasHazardWeakness(types) {
            // stealth rock is the main reason boots matter in singles. rock weakness
            // (especially 2x/4x) is a meaningful signal; otherwise longevity items win.
            if (!types.length) return false;
            let mult = 1;
            for (const t of types) mult *= sampleTypeEffectiveness('Rock', t);
            return mult > 1;
        }

        function sampleItemFitScore(item, profile, role, moves, ability = '') {
            const kinds = moves.map(sampleMoveKind);
            const hasSetup = kinds.some(k => k.setup);
            const hasRecovery = kinds.some(k => k.recovery);
            const hasPivot = kinds.some(k => k.pivot);
            const hasHazard = kinds.some(k => k.hazard);
            const hasRemoval = kinds.some(k => k.removal);
            const hasStatus = moves.some(m => m.category === 'Status');
            const damaging = moves.filter(sampleIsDamaging);
            const physical = sampleRoleAttackCategory(profile, role) === 'Physical';
            const bulky = profile.stats.hp + profile.stats.def + profile.stats.spd >= 265;
            const fast = profile.stats.spe >= 95;
            const rockWeak = hasHazardWeakness(profile.types);
            const attackStat = physical ? profile.stats.atk : profile.stats.spa;
            const abilityText = String(ability || '').toLowerCase();
            let score = 0;

            // item choice is a property of the completed set. these are deliberately
            // compatibility scores rather than a chain of early returns: a set with
            // choice-locking, setup, recovery, etc. should be evaluated as one strategy.
            if (item === 'Leftovers') {
                if (hasRecovery) score += 28;
                if (bulky) score += 18;
                if (hasSetup && !bulky) score += 5;
                if (hasStatus) score += 5;
                if (hasPivot) score += 4;
            }
            if (item === 'Heavy-Duty Boots') {
                if (rockWeak) score += 30;
                if (hasPivot) score += 18;
                if (hasRemoval) score += 8;
                if (offensiveRoleForItem(role)) score += 8;
            }
            if (item === 'Life Orb') {
                if (damaging.length >= 2) score += 20;
                if (hasSetup) score += 20;
                if (attackStat >= 110) score += 14;
                if (!bulky) score += 8;
                if (hasRecovery) score += 5;
            }
            if (item === 'Expert Belt') {
                const coverage = damaging.filter(m => !profile.types.includes(m.type) && sampleHasGoodCoverage(m, profile, moves));
                if (coverage.length >= 1) score += 20;
                if (coverage.length >= 2) score += 10;
                if (damaging.length >= 3) score += 8;
                if (fast) score += 5;
            }
            if (item === 'Choice Band') {
                if (role === 'wallbreaker' && physical) score += 30;
                if (damaging.filter(m => m.category === 'Physical').length >= 2) score += 18;
                if (attackStat >= 105) score += 12;
                if (hasSetup) score -= 45;
                if (hasRecovery || hasStatus) score -= 15;
            }
            if (item === 'Choice Specs') {
                if (role === 'wallbreaker' && !physical) score += 30;
                if (damaging.filter(m => m.category === 'Special').length >= 2) score += 18;
                if (attackStat >= 105) score += 12;
                if (hasSetup) score -= 45;
                if (hasRecovery || hasStatus) score -= 15;
            }
            if (item === 'Assault Vest') {
                if (damaging.length >= 3) score += 28;
                if (!hasStatus && !hasSetup) score += 18;
                if (bulky) score += 10;
                if (hasRecovery) score -= 35;
            }
            if (item === 'Flame Orb') {
                if (/guts/.test(abilityText)) score += 80;
                else score -= 80;
            }
            if (item === 'Light Clay') {
                if (role === 'screens' && moves.filter(m => sampleMoveKind(m).screens).length >= 2) score += 100;
                else score -= 80;
            }
            if (item === 'Rocky Helmet') {
                if (['defensive','support','hazard'].includes(role) && (hasHazard || hasRemoval || bulky)) score += 24;
                if (hasRecovery) score += 5;
            }

            // do not reward an item simply because the Pokemon qualifies for it in the
            // abstract. the final set must actually make use of the item's gameplan.
            if (item !== 'Flame Orb' && /guts/.test(abilityText)) score -= 25;
            if (item === 'Heavy-Duty Boots' && role === 'wallbreaker' && !rockWeak && !hasPivot) score -= 8;
            if ((item === 'Choice Band' || item === 'Choice Specs') && damaging.length < 2) score -= 20;

            return score;
        }

        function offensiveRoleForItem(role) {
            return ['physicalSweeper','specialSweeper','setupSweeper','wallbreaker','bulkyAttacker','pivot'].includes(role);
        }

        function sampleItemIsCompatibleWithMoves(item, moves) {
            const selected = moves || [];
            const itemName = String(item || '').trim().toLowerCase();
            if (itemName === 'assault vest') {
                return selected.every(m => m && (m.category === 'Physical' || m.category === 'Special'));
            }
            return true;
        }

        function sampleChooseItem(profile, role, chosenMoves, chosenAbility = '') {
            const moves = chosenMoves || profile.moves;
            const candidates = [
                'Leftovers','Heavy-Duty Boots','Life Orb','Expert Belt',
                'Choice Band','Choice Specs','Assault Vest','Flame Orb',
                'Rocky Helmet','Light Clay'
            ];
            const ranked = candidates
                .map((item, index) => ({
                    item,
                    score: sampleItemFitScore(item, profile, role, moves, chosenAbility) - index * 0.001
                }))
                .sort((a,b) => b.score - a.score || a.item.localeCompare(b.item));

            // item-first remains the rule: av can win even when the draft currently has
            // status moves. but after applying the av repair, the requested role must
            // still exist. this prevents pivot -> chilly reception -> av -> remove chilly
            // reception -> publish a fake pivot with no pivot move.
            for (const entry of ranked) {
                const repaired = sampleRepairMovesForItem(profile, role, moves, entry.item);
                if (repaired.length !== 4) continue;
                if (role === 'pivot' && !repaired.some(m => sampleMoveKind(m).pivot)) continue;
                if (role === 'hazard' && !repaired.some(m => sampleMoveKind(m).hazard)) continue;
                return entry.item;
            }
            return ranked[0]?.item || 'Leftovers';
        }

        function sampleRepairMovesForItem(profile, role, moves, item, seed = 0) {
            let repaired = [...(moves || [])];
            if (String(item || '').trim().toLowerCase() !== 'assault vest') return repaired;

            // av is the constraint: strip status moves after the item has been chosen.
            repaired = repaired.filter(m => m && m.category !== 'Status');
            if (repaired.length >= 4) return repaired.slice(0, 4);

            // refill removed slots with the best legal damaging moves from the learnset.
            const chosenNames = new Set(repaired.map(m => m.name));
            const candidates = (profile.moves || [])
                .filter(m => m && m.category !== 'Status' && !chosenNames.has(m.name))
                .filter(m => sampleMoveIsActuallyUseful(m, profile, role))
                .map((m, index) => ({
                    move: m,
                    score: sampleMoveScore(m, profile, role, repaired) - index * 0.001
                }))
                .sort((a,b) => b.score - a.score || a.move.name.localeCompare(b.move.name));

            for (const entry of candidates) {
                if (repaired.length >= 4) break;
                repaired.push(entry.move);
            }
            return repaired.slice(0, 4);
        }

        function sampleTeraFitScore(type, profile, role, moves, ability = '') {
            const damaging = moves.filter(sampleIsDamaging);
            const hasTeraBlast = moves.some(m => m.name === 'Tera Blast');
            if (hasTeraBlast && !SAMPLE_SET_OFFENSIVE_TERA_ROLES.has(role)) return -1000;
            const stab = damaging.filter(m => m.type === type);
            const originalStab = damaging.filter(m => profile.types.includes(m.type));
            const coverage = damaging.filter(m => !profile.types.includes(m.type));
            const hasSetup = moves.some(m => sampleMoveKind(m).setup);
            const hasRecovery = moves.some(m => sampleMoveKind(m).recovery);
            let score = 0;

            // offensive tera should amplify an actual attack on this exact set.
            if (stab.length) {
                score += 34;
                score += Math.min(18, stab.length * 8);
                if (hasSetup) score += 14;
                if (role === 'wallbreaker') score += 10;
            }

            // a coverage tera is only meaningful when the set actually carries that
            // attack; never pick a tera type from the learnset alone.
            if (coverage.some(m => m.type === type)) score += 20;

            // defensive terastallization gets a small, controlled bonus for common
            // defensive types, but only when the set is actually defensive/bulky.
            if (['defensive','support','hazard','bulkyAttacker','pivot'].includes(role)) {
                if (type === 'Steel') score += 16;
                if (type === 'Fairy') score += 14;
                if (type === 'Water') score += 12;
                if (hasRecovery) score += 8;
            }

            // preserve the original typing as a fallback, not as an automatic winner.
            if (profile.types.includes(type)) score += originalStab.some(m => m.type === type) ? 7 : 2;
            return score;
        }

        function sampleChooseTera(profile, role, moves, ability = '') {
            const candidateTypes = [...new Set([
                ...moves.filter(sampleIsDamaging).map(m => m.type),
                'Steel','Fairy','Water', ...profile.types
            ])];
            return candidateTypes
                .map((type, index) => ({
                    type,
                    score: sampleTeraFitScore(type, profile, role, moves, ability) - index * 0.001
                }))
                .sort((a,b) => b.score - a.score || a.type.localeCompare(b.type))[0]?.type || profile.types[0] || 'Normal';
        }

        function sampleRoleLabel(role) {
            const configured = SAMPLE_SET_CONFIG.roleMeta[role]?.name;
            if (configured) return configured;
            // keep generated labels human-readable even if a role key is introduced
            // later using camelCase or snake_case.
            return String(role || 'Sample Set')
                .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
                .replace(/[_-]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .replace(/\b\w/g, c => c.toUpperCase());
        }

        function sampleSetIdeaSimilarity(a, b) {
            const am = new Set((a.moves || []).map(x => String(x).toLowerCase()));
            const bm = new Set((b.moves || []).map(x => String(x).toLowerCase()));
            const union = new Set([...am, ...bm]).size;
            const intersection = [...am].filter(x => bm.has(x)).length;
            const moveJaccard = union ? intersection / union : 1;
            const sameRole = String(a.role || '').toLowerCase() === String(b.role || '').toLowerCase();
            const sameItem = String(a.item || '').toLowerCase() === String(b.item || '').toLowerCase();
            const ae = a.evs || {}, be = b.evs || {};
            const dominant = evs => Object.entries(evs).filter(([,v]) => (v || 0) >= 200).map(([k]) => k).sort().join(',');
            const sameEVProfile = dominant(ae) === dominant(be);
            return { moveJaccard, sameRole, sameItem, sameEVProfile };
        }

        function sampleSetIdeaIsTooSimilar(candidate, accepted) {
            return accepted.some(existing => {
                const sim = sampleSetIdeaSimilarity(candidate, existing);
                // exact/near-exact sets are duplicates even if their labels differ.
                if (sim.moveJaccard >= 0.75) return true;
                // two sets from the same role with at least half their moves and the
                // same broad EV profile are effectively the same idea.
                if (sim.sameRole && sim.moveJaccard >= 0.50 && sim.sameEVProfile) return true;
                // don't show two sets that only differ by an item while everything else
                // is effectively identical.
                if (sim.moveJaccard >= 0.50 && sim.sameItem && sim.sameEVProfile) return true;
                return false;
            });
        }

        // cache the expensive set-generation result. opening the modal should never
        // synchronously rebuild the beam-search on every click. the cache is keyed by
        // the current Fakemon inputs, so changing the species data automatically causes
        // a fresh generation pass.
        let sampleSetSuggestionCache = { key: '', suggestions: null };
        let sampleSetGenerationInFlight = false;

        function getSampleSetSuggestionCacheKey() {
            const profile = getSampleSetProfile();
            return [
                document.getElementById('fakemon-name')?.value || '',
                Object.values(profile.stats).join(','),
                profile.types.join('/'),
                profile.abilities.join('/'),
                profile.moves.map(m => `${m.name}:${m.type}:${m.category}:${m.basePower}`).join('|'),
                state.sdMoveUsefulness ? Object.keys(state.sdMoveUsefulness).length : 0
            ].join('::');
        }

        function sampleDebugSet(set) {
            if (!set) return null;
            return {
                name: set.name, role: set.role, item: set.item, ability: set.ability,
                nature: set.nature, teraType: set.teraType, level: set.level,
                moves: Array.isArray(set.moves) ? [...set.moves] : [],
                evs: { ...(set.evs || {}) },
                ivs: { ...(set.ivs || {}) }
            };
        }

        function generateSuggestedSampleSets(force = false) {
            const cacheKey = getSampleSetSuggestionCacheKey();
            if (!force && sampleSetSuggestionCache.key === cacheKey && Array.isArray(sampleSetSuggestionCache.suggestions)) {
                return sampleSetSuggestionCache.suggestions;
            }

            const profile = getSampleSetProfile();
            if (profile.moves.length < 4) { sampleGenerationMemo = null; return []; }
            sampleGenerationMemo = {
                moveKind: new WeakMap(),
                intrinsic: new WeakMap(),
                naturalCoverage: new Map(),
                goodCoverage: new Map(),
                coherence: new Map(),
                partialViability: new Map(),
                moveScore: new Map()
            };
            const roleScores = sampleRoleScores(profile);
            const debugSample = typeof window !== 'undefined' && window.__sampleSetDebug === true;
            // debug tracing must never materially change generation cost. keep only the
            // small, diagnostic fields we need and avoid JSON cloning inside the hot loop.
            const debugProfile = debugSample ? {
                name: profile.name,
                stats: { ...(profile.stats || {}) },
                types: [...(profile.types || [])],
                abilities: [...(profile.abilities || [])],
                moves: (profile.moves || []).map(m => ({ name: m.name, type: m.type, category: m.category, basePower: m.basePower }))
            } : null;
            const debugTrace = debugSample ? { startedAt:new Date().toISOString(), cacheKey, profile:debugProfile, roleScores:{ ...roleScores }, roles:{}, suggestions:[] } : null;
            if (debugSample) window.__lastSampleSetGeneration = debugTrace;
            // infeasible roles are removed before ranking. missing a defining mechanic
            // is a hard impossibility, not merely a low score.
            const feasibleRoles = Object.keys(roleScores).filter(role => sampleRoleIsFeasible(profile, role));
            const rankedRoles = feasibleRoles.sort((a,b) => roleScores[b] - roleScores[a] || a.localeCompare(b));
            if (debugTrace) {
                debugTrace.feasibleRoles = [...feasibleRoles];
                debugTrace.rankedRoles = [...rankedRoles];
                rankedRoles.forEach(role => { debugTrace.roles[role] = { score:roleScores[role], feasible:true }; });
                Object.keys(roleScores).filter(role => !feasibleRoles.includes(role)).forEach(role => { debugTrace.roles[role] = { score:roleScores[role], feasible:false }; });
            }
            const seedSource = [document.getElementById('fakemon-name')?.value || '', Object.values(profile.stats).join(','), profile.types.join('/'), profile.abilities.join('/'), profile.moves.map(m => `${m.name}:${m.type}:${m.category}:${m.basePower}`).join('|')].join('::');
            const seed = sampleSetHash(seedSource);
            const suggestions = [];

            const consider = (set, source='unknown') => {
                if (!set || !Array.isArray(set.moves) || set.moves.length !== 4) {
                    if (debugTrace) debugTrace.suggestions.push({source,accepted:false,reason:'invalid-set',set});
                    return false;
                }
                if (sampleSetIdeaIsTooSimilar(set, suggestions)) {
                    if (debugTrace) debugTrace.suggestions.push({source,accepted:false,reason:'too-similar',set:sampleDebugSet(set)});
                    return false;
                }
                suggestions.push(set);
                if (debugTrace) debugTrace.suggestions.push({source,accepted:true,set:sampleDebugSet(set),index:suggestions.length-1});
                return true;
            };

            // parametric sets (e.g. iron defense + body press) are first-class ideas,
            // but they do not automatically crowd out unrelated roles anymore.
            consider(generateParametricSampleSet(profile, seed ^ 0x9e3779b9), 'parametric');

            // walk the entire role ranking. we intentionally do not stop after three
            // attempts: several top-scoring roles can collapse to the same four moves.
            // only genuinely distinct ideas are kept, so returning 1–3 is preferable to
            // showing three copies of the same set with different labels.
            rankedRoles.forEach((role, roleIndex) => {
                if (suggestions.length >= 3) return;
                const moves = samplePickMoves(profile, role, seed + Math.imul(roleIndex + 1, 2654435761));
                if (debugTrace) debugTrace.roles[role].pickedMoves = moves.map(m => m.name);
                if (moves.length !== 4) {
                    if (debugTrace) debugTrace.roles[role].rejected = 'move-picker-returned-fewer-than-four';
                    return;
                }
                const { evs, nature } = sampleChooseNatureEVs(profile, role, moves);
                const ability = sampleChooseAbility(profile, role, moves);
                const item = sampleChooseItem(profile, role, moves, ability);
                const repairedMoves = sampleRepairMovesForItem(profile, role, moves, item, seed);
                if (repairedMoves.length !== 4) return;
                if (role === 'pivot' && !repairedMoves.some(m => sampleMoveKind(m).pivot)) {
                    if (debugTrace) debugTrace.roles[role].rejected = 'item-repair-removed-pivot-move';
                    return;
                }
                if (role === 'hazard' && !repairedMoves.some(m => sampleMoveKind(m).hazard)) {
                    if (debugTrace) debugTrace.roles[role].rejected = 'item-repair-removed-hazard-move';
                    return;
                }
                const teraType = sampleChooseTera(profile, role, repairedMoves, ability);
                if (!sampleItemIsCompatibleWithMoves(item, repairedMoves)) {
                    if (debugTrace) debugTrace.roles[role].rejected = 'item-move-incompatible-after-repair';
                    return;
                }
                const candidate = {
                    name: sampleRoleLabel(role),
                    role: sampleRoleLabel(role),
                    item,
                    ability,
                    nature,
                    evs,
                    ivs: { hp:31, atk:31, def:31, spa:31, spd:31, spe:31 },
                    moves: repairedMoves.map(m => m.name),
                    teraType,
                    level: 100
                };
                if (debugTrace) debugTrace.roles[role].candidate = sampleDebugSet(candidate);
                consider(candidate, `role:${role}`);
            });

            const result = suggestions.slice(0, 3);
            if (debugTrace) {
                debugTrace.finishedAt = new Date().toISOString();
                debugTrace.result = result.map(sampleDebugSet);
                debugTrace.suggestionCount = suggestions.length;
                debugTrace.selectedCount = result.length;
                log.debug('SAMPLE SETS','Published sample-set debug snapshot',{snapshot:'window.__lastSampleSetGeneration',roles:rankedRoles.length,results:result.length});
                // tracing is intentionally one-shot so leaving the inspector enabled
                // cannot accidentally make every subsequent generation slower.
                window.__sampleSetDebug = false;
            }
            sampleSetSuggestionCache = {
                key: cacheKey,
                suggestions: result
            };
            sampleGenerationMemo = null;
            return result;
        }

        function openSampleSetModal() {
        log.debug('SAMPLE SETS', 'Opening sample set modal');
            const modal = document.getElementById('sample-set-modal');
            if (!modal) return;
            modal.classList.add('active');
            const container = document.getElementById('suggested-sample-sets-list');
            const alreadyLoaded = state.sdMoveUsefulness && Object.keys(state.sdMoveUsefulness).length;
            const cacheKey = getSampleSetSuggestionCacheKey();
            const hasCachedSuggestions = sampleSetSuggestionCache.key === cacheKey && Array.isArray(sampleSetSuggestionCache.suggestions);

            // never run the expensive generator in the same task that opens the modal.
            // that used to make the second opening appear to freeze because the browser
            // could not paint the loading state before the beam search began.
            if (hasCachedSuggestions) {
                if (container) container.innerHTML = '<div class="sample-set-empty-message">Loading sample sets…</div>';
                requestAnimationFrame(() => {
                    if (modal.classList.contains('active')) renderSuggestedSampleSets();
                });
                return;
            }

            if (container) container.innerHTML = '<div class="sample-set-empty-message">Loading move data…</div>';

            const generateWhenReady = () => {
                if (!modal.classList.contains('active')) return;
                if (sampleSetGenerationInFlight) return;
                sampleSetGenerationInFlight = true;
                // give the browser a paint opportunity so the loading indicator is
                // actually visible before the cpu-heavy set search starts.
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        try {
                            renderSuggestedSampleSets();
                        } finally {
                            sampleSetGenerationInFlight = false;
                        }
                    }, 0);
                });
            };

            if (alreadyLoaded) {
                generateWhenReady();
            } else {
                loadCompetitiveMoveUsefulness().then(generateWhenReady).catch(() => generateWhenReady());
            }
        }

        function closeSampleSetModal() {
            const modal = document.getElementById('sample-set-modal');
            if (modal) modal.classList.remove('active');
        }

        function addBlankSampleSet() {
            state.sampleSets.push({
                name: 'Standard Set',
                item: '',
                ability: '',
                nature: 'Hardy',
                evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
                ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
                moves: ['', '', '', ''],
                teraType: '',
                level: 100
            });
            closeSampleSetModal();
            renderSampleSets();
            (state.sampleSets || []).forEach((set, i) => {
                const icon = document.getElementById(`set-${i}-item-icon`);
                const custom = set?.itemCustomId ? (state.customItems || []).find(x => x.id === set.itemCustomId) : null;
                if (icon && custom?.artwork) { icon.src = custom.artwork; icon.style.display = ''; }
            });
            updatePreview();
            autoSave();
        }

        function addSampleSet() {
            openSampleSetModal();
        }

        function applySuggestedSampleSet(index) {
            const suggestions = generateSuggestedSampleSets();
            const set = suggestions[index];
            if (!set) return;
            state.sampleSets.push(JSON.parse(JSON.stringify(set)));
            closeSampleSetModal();
            renderSampleSets();
            updatePreview();
            autoSave();
        }

        function renderSuggestedSampleSets() {
            const container = document.getElementById('suggested-sample-sets-list');
            if (!container) return;
            let suggestions = [];
            try { suggestions = generateSuggestedSampleSets(); }
            catch (err) { log.error('SAMPLE SETS', 'Generator error', err); }
            if (!suggestions.length) {
                container.innerHTML = '<div class="sample-set-empty-message">oh nah no sample sets for u unc</div>';
                return;
            }
            container.innerHTML = suggestions.map((set, i) => {
                const spread = formatEVSpread(set.evs, set.nature, set);
                return `
                    <button type="button" class="suggested-sample-set-card" onclick="applySuggestedSampleSet(${i})">
                        <div class="suggested-sample-set-title">
                            <strong>${set.name}</strong>
                            <span>${set.item}</span>
                        </div>
                        <div class="suggested-sample-set-meta">${set.nature} · ${spread}</div>
                        <div class="suggested-sample-set-moves">${set.moves.join(' · ')}</div>
                        <div class="suggested-sample-set-footer">${set.ability || 'No ability'} · Tera ${set.teraType}</div>
                    </button>
                `;
            }).join('');
        }

        function updateSampleSet(index, field, value) {
            if (field.startsWith('evs.')) {
                const stat = field.split('.')[1];
                state.sampleSets[index].evs[stat] = parseInt(value) || 0;
            } else if (field.startsWith('ivs.')) {
                const stat = field.split('.')[1];
                state.sampleSets[index].ivs[stat] = parseInt(value) || 0;
            } else if (field.startsWith('moves.')) {
                const slot = parseInt(field.split('.')[1]);
                state.sampleSets[index].moves[slot] = value;
            } else if (field === 'level') {
                let lvl = parseInt(value) || 100;
                lvl = Math.max(1, Math.min(100, lvl));
                state.sampleSets[index].level = lvl;
            } else {
                state.sampleSets[index][field] = value;
            }
            const card = document.querySelector(`.sample-set-card[data-set-index="${index}"]`);
            if (card) {
                const fakemonName = document.getElementById('fakemon-name').value || 'Fakemon';
                const exportText = generateShowdownExport(fakemonName, state.sampleSets[index]);
                const outputEl = card.querySelector('.sample-set-output-text');
                if (outputEl) outputEl.textContent = exportText;
            }
            updatePreview();
            autoSave();
        }
        function updateSampleSetItem(setIndex, value) {
            state.sampleSets[setIndex].item = value;
            const card = document.querySelector(`.sample-set-card[data-set-index="${setIndex}"]`);
            if (card) {
                const icon = card.querySelector('.sample-set-item-icon');
                if (icon) {
                    if (value) {
                        const set = state.sampleSets[setIndex];
                        const custom = set?.itemCustomId ? (state.customItems || []).find(i => i.id === set.itemCustomId) : null;
                        if (custom?.artwork) icon.src = custom.artwork;
                        else {
                            const slug = value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
                            icon.src = 'https://play.pokemonshowdown.com/sprites/itemicons/' + slug + '.png';
                        }
                        icon.style.display = '';
                    } else {
                        icon.style.display = 'none';
                    }
                }
                const fakemonName = document.getElementById('fakemon-name').value || 'Fakemon';
                const exportText = generateShowdownExport(fakemonName, state.sampleSets[setIndex]);
                const outputEl = card.querySelector('.sample-set-output-text');
                if (outputEl) outputEl.textContent = exportText;
            }
            updatePreview();
            autoSave();
        }

        
// ==================== sample set autocomplete ====================
        function hideSampleSetDropdownDelayed(id) {
            setTimeout(() => { const el = document.getElementById(id); if (el) el.classList.remove('active'); }, 200);
        }
        function filterSampleSetItem(setIndex, value) {
            updateSampleSetItem(setIndex, value);
            const dropdown = document.getElementById(`item-dropdown-${setIndex}`);
            if (!dropdown) return;
            if (!value.trim()) { dropdown.classList.remove('active'); return; }
            const matches = Object.values(state.sdItems)
                .filter(it => it.name.toLowerCase().includes(value.toLowerCase()))
                .slice(0, 8);
            const customItems = (state.customItems || [])
                .filter(it => it?.name && it.name.toLowerCase().includes(value.toLowerCase()))
                .slice(0, 8)
                .map(it => ({ ...it, __customItem: true }));
            const combined = [...matches.map(it => ({ ...it, __customItem: false })), ...customItems]
                .filter((it, idx, arr) => arr.findIndex(x => x.name.toLowerCase() === it.name.toLowerCase()) === idx)
                .slice(0, 8);
            renderDropdown(dropdown, combined, (item) => {
                const input = dropdown.previousElementSibling;
                input.value = item.name;
                updateSampleSetItem(setIndex, item.name);
                state.sampleSets[setIndex].itemCustom = !!item.__customItem;
                state.sampleSets[setIndex].itemCustomId = item.__customItem ? item.id : null;
                state.sampleSets[setIndex].itemDesc = item.__customItem ? (item.desc || '') : '';
                autoSave();
                dropdown.classList.remove('active');
            }, false);
            const add = document.createElement('div');
            add.className = 'autocomplete-item sample-set-add-custom-item';
            add.innerHTML = '<span>＋ Add Custom Item</span>';
            add.addEventListener('mousedown', (e) => {
                e.preventDefault();
                dropdown.classList.remove('active');
                api.openCustomItemModal?.('', { setIndex });
            });
            dropdown.appendChild(add);
        }
        function filterSampleSetMove(setIndex, slot, value) {
            updateSampleSet(setIndex, `moves.${slot}`, value);
            const dropdown = document.getElementById(`move-dropdown-${setIndex}-${slot}`);
            if (!dropdown) return;
            if (!value.trim()) { dropdown.classList.remove('active'); return; }
            const pool = [...state.learnset];
            const matches = pool
                .filter(m => m.name.toLowerCase().includes(value.toLowerCase()))
                .filter((m, idx, arr) => arr.findIndex(x => x.name === m.name) === idx)
                .slice(0, 8);
            renderDropdown(dropdown, matches, (item) => {
                const input = dropdown.previousElementSibling;
                input.value = item.name;
                updateSampleSet(setIndex, `moves.${slot}`, item.name);
                dropdown.classList.remove('active');
            }, true);
        }

        function removeSampleSet(index) {
            state.sampleSets.splice(index, 1);
            renderSampleSets();
            updatePreview();
            autoSave();
        }
        function copySampleSet(index) {
            const set = state.sampleSets[index];
            const fakemonName = document.getElementById('fakemon-name').value || 'Fakemon';
            const text = generateShowdownExport(fakemonName, set);
            navigator.clipboard.writeText(text).then(() => api.showToast('Set copied to clipboard!', 'success'));
        }
        function copySampleSetText(text) {
            navigator.clipboard.writeText(text).then(() => api.showToast('Set copied to clipboard!', 'success'));
        }
        function generateShowdownExport(name, set) {
            let lines = [];
            // name @ item
            if (set.item) lines.push(`${name} @ ${set.item}`);
            else lines.push(name);
            // ability
            if (set.ability) lines.push(`Ability: ${set.ability}`);
            // level (Showdown omits this line entirely at the default of 100)
            if (set.level && set.level !== 100) lines.push(`Level: ${set.level}`);
            // tera type
            if (set.teraType) lines.push(`Tera Type: ${set.teraType}`);
            // EVs
            const evParts = [];
            if (set.evs.hp) evParts.push(`${set.evs.hp} HP`);
            if (set.evs.atk) evParts.push(`${set.evs.atk} Atk`);
            if (set.evs.def) evParts.push(`${set.evs.def} Def`);
            if (set.evs.spa) evParts.push(`${set.evs.spa} SpA`);
            if (set.evs.spd) evParts.push(`${set.evs.spd} SpD`);
            if (set.evs.spe) evParts.push(`${set.evs.spe} Spe`);
            if (evParts.length) lines.push(`EVs: ${evParts.join(' / ')}`);
            // nature
            if (set.nature) lines.push(`${set.nature} Nature`);
            // IVs
            const ivParts = [];
            if (set.ivs.hp !== 31) ivParts.push(`${set.ivs.hp} HP`);
            if (set.ivs.atk !== 31) ivParts.push(`${set.ivs.atk} Atk`);
            if (set.ivs.def !== 31) ivParts.push(`${set.ivs.def} Def`);
            if (set.ivs.spa !== 31) ivParts.push(`${set.ivs.spa} SpA`);
            if (set.ivs.spd !== 31) ivParts.push(`${set.ivs.spd} SpD`);
            if (set.ivs.spe !== 31) ivParts.push(`${set.ivs.spe} Spe`);
            if (ivParts.length) lines.push(`IVs: ${ivParts.join(' / ')}`);
            // moves
            set.moves.forEach(m => { if (m) lines.push(`- ${m}`); });
            return lines.join('\n');
        }
                
// ==================== stat calculation ====================
        function getNatureBoostLabel(nature) {
            const data = NATURE_DATA[nature];
            if (!data || data.up === data.down) return '<span style="color:var(--text-muted);">Neutral</span>';
            return `<span style="color:#cc4444;font-weight:700;">+${STAT_NAMES[data.up]}</span> / <span style="color:#4466cc;font-weight:700;">−${STAT_NAMES[data.down]}</span>`;
        }

        function calcStat(base, ev, iv, nature, statKey, level) {
            level = level || 100;
            iv = iv || 31;
            ev = ev || 0;
            let natureMult = 1.0;
            const data = NATURE_DATA[nature];
            if (data && data.up !== data.down) {
                if (data.up === statKey) natureMult = 1.1;
                if (data.down === statKey) natureMult = 0.9;
            }
            if (statKey === 'hp') {
                return Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + level + 10;
            }
            return Math.floor((Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + 5) * natureMult);
        }

        function getAllAbilities() {
            return state.abilities.filter(a => a.name).map(a => a.name);
        }

                function updateSampleSetEV(setIndex, statKey, value) {
            const ev = parseInt(value) || 0;
            const set = state.sampleSets[setIndex];
            const otherEVs = Object.entries(set.evs).filter(([k,v]) => k !== statKey).reduce((s,[k,v]) => s + (v||0), 0);
            const maxAllowed = 508 - otherEVs;
            const clampedEV = Math.max(0, Math.min(ev, maxAllowed, 252));

            if (clampedEV !== ev && ev > clampedEV) {
                const card = document.querySelector(`.sample-set-card[data-set-index="${setIndex}"]`);
                const now = Date.now();
                if (!card._lastEvToast || now - card._lastEvToast > 2000) {
                    api.showToast('Cannot exceed 508 total EVs!', 'error');
                    card._lastEvToast = now;
                }
            }

            set.evs[statKey] = clampedEV;

            const card = document.querySelector(`.sample-set-card[data-set-index="${setIndex}"]`);
            if (card) {
                const calcEl = document.getElementById(`set-${setIndex}-stat-${statKey}`);
                if (calcEl) {
                    const row = calcEl.closest('.sample-set-stat-row');
                    if (row) {
                        const track = row.querySelector('.sample-set-ev-track');
                        if (track) {
                            const slider = track.querySelector('.sample-set-ev-slider');
                            const fill = track.querySelector('.sample-set-ev-fill');
                            if (slider) slider.value = clampedEV;
                            if (fill) fill.style.width = (clampedEV / 252 * 100) + '%';
                        }
                        const input = row.querySelector('.sample-set-ev-input-compact');
                        if (input) input.value = clampedEV;
                    }
                }

                const fakemonName = document.getElementById('fakemon-name').value || 'Fakemon';
                const exportText = generateShowdownExport(fakemonName, set);
                const outputEl = card.querySelector('.sample-set-output-text');
                if (outputEl) outputEl.textContent = exportText;
                const statKeys = ['hp','atk','def','spa','spd','spe'];
                const totalEVs = statKeys.reduce((sum, k) => sum + (set.evs[k] || 0), 0);
                const evRemaining = 508 - totalEVs;
                const evText = card.querySelector('.sample-set-ev-total-text');
                if (evText) evText.textContent = `${totalEVs} / 508 EVs ${evRemaining >= 0 ? '(' + evRemaining + ' remaining)' : '(' + Math.abs(evRemaining) + ' over!)'}`;
                const guessBtn = card.querySelector('.sample-set-guess-btn');
                if (guessBtn) guessBtn.textContent = formatEVSpread(set.evs, set.nature, set);
            }

            updateStatDisplay(setIndex, statKey, clampedEV.toString(), null);
            autoSave();
        }

        // heuristic EV spread guesser, in the spirit of smogon's "sample set" spreads:
        // pick the stronger attacking stat, decide whether this is a speed-based or
        // bulky-based set from the fakemon's base speed, then dump EVs accordingly.
        function getGuessSpreadRole(set) {
            const base = getSampleSetProfile().stats;
            const evs = set?.evs || {};
            const nature = NATURE_DATA[set?.nature];
            const physical = (evs.atk || 0) >= (evs.spa || 0);
            const fast = (evs.spe || 0) >= 200;
            if ((evs.spd || 0) >= 200 && (evs.hp || 0) >= 160) return 'Specially Defensive';
            if ((evs.def || 0) >= 200 && (evs.hp || 0) >= 160) return 'Physically Defensive';
            if ((evs.spe || 0) >= 200 && (evs.atk || 0) >= 200) return 'Fast Physical Attacker';
            if ((evs.spe || 0) >= 200 && (evs.spa || 0) >= 200) return 'Fast Special Attacker';
            if ((evs.atk || 0) >= 200 && (evs.hp || 0) >= 160) return 'Bulky Physical Attacker';
            if ((evs.spa || 0) >= 200 && (evs.hp || 0) >= 160) return 'Bulky Special Attacker';
            if (nature && nature.up === 'atk') return physical ? 'Physical Attacker' : 'Mixed Attacker';
            if (nature && nature.up === 'spa') return 'Special Attacker';
            if (base.atk >= base.spa) return fast ? 'Fast Physical Attacker' : 'Bulky Physical Attacker';
            return fast ? 'Fast Special Attacker' : 'Bulky Special Attacker';
        }

        function formatEVSpread(evs, natureName, set) {
            const labels = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
            const order = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
            const parts = order
                .filter(key => (evs?.[key] || 0) > 0)
                .map(key => `${evs[key]} ${labels[key]}`);
            const spread = parts.length ? parts.join(' / ') : '0 EVs';
            const nature = NATURE_DATA[natureName];
            const natureText = nature && nature.up !== nature.down
                ? ` / (+${STAT_NAMES[nature.up]}, -${STAT_NAMES[nature.down]})`
                : '';
            return `${getGuessSpreadRole(set || { evs, nature: natureName })}: ${spread}${natureText}`;
        }

        function guessEVSpread(setIndex) {
            const set = state.sampleSets[setIndex];
            if (!set) return;

            const base = {
                hp: parseInt(document.getElementById('stat-hp').value) || 60,
                atk: parseInt(document.getElementById('stat-atk').value) || 60,
                def: parseInt(document.getElementById('stat-def').value) || 60,
                spa: parseInt(document.getElementById('stat-spa').value) || 60,
                spd: parseInt(document.getElementById('stat-spd').value) || 60,
                spe: parseInt(document.getElementById('stat-spe').value) || 60
            };

            // figure out whether this set leans physical or special. prefer looking at
            // the actual moves chosen (ignoring status moves); fall back to comparing
            // base atk vs base SpA if no damaging moves are set yet.
            let physicalCount = 0, specialCount = 0;
            set.moves.forEach(name => {
                if (!name) return;
                const move = getSdMoveByName(name);
                if (!move) return;
                if (move.category === 'Physical') physicalCount++;
                else if (move.category === 'Special') specialCount++;
            });
            let offStat;
            if (physicalCount || specialCount) offStat = physicalCount >= specialCount ? 'atk' : 'spa';
            else offStat = base.atk >= base.spa ? 'atk' : 'spa';

            // speedy attackers invest in speed; slow/bulky ones dump the rest into HP.
            const isFast = base.spe >= 90;
            const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
            evs[offStat] = 252;
            if (isFast) {
                evs.spe = 252;
                evs.hp = 4;
            } else {
                evs.hp = 252;
                // PUT the last 4 EVs in whichever defensive stat is weaker.
                evs[base.def <= base.spd ? 'def' : 'spd'] = 4;
            }

            const natureTable = {
                atk: isFast ? 'Jolly' : 'Adamant',
                spa: isFast ? 'Timid' : 'Modest'
            };

            set.evs = evs;
            set.nature = natureTable[offStat];

            renderSampleSets();
            updatePreview();
            autoSave();
        }

        function setNatureBoost(setIndex, statKey, direction) {
            const set = state.sampleSets[setIndex];
            const current = NATURE_DATA[set.nature];
            let newUp = current.up;
            let newDown = current.down;

            if (direction === 'up') {
                if (current.up === statKey) {
                    // toggle off - set to neutral
                    newUp = statKey; newDown = statKey;
                } else {
                    newUp = statKey;
                    // keep current down if it's different
                    if (newDown === statKey) newDown = current.down;
                }
            } else {
                if (current.down === statKey) {
                    // toggle off - set to neutral
                    newUp = statKey; newDown = statKey;
                } else {
                    newDown = statKey;
                    // keep current up if it's different
                    if (newUp === statKey) newUp = current.up;
                }
            }

            const newNature = findNatureByBoosts(newUp, newDown);
            set.nature = newNature;

            // update nature select without full re-render
            const card = document.querySelector(`.sample-set-card[data-set-index="${setIndex}"]`);
            if (card) {
                const natureSelect = card.querySelector('.sample-set-field select');
                // find the nature select (it's the one with nature options)
                const selects = card.querySelectorAll('select');
                selects.forEach(sel => {
                    if (sel.value === set.nature || Array.from(sel.options).some(o => o.value === set.nature)) {
                        sel.value = set.nature;
                    }
                });
            }

            renderNatureStats(setIndex);
            autoSave();
        }

        function renderNatureStats(setIndex) {
            const set = state.sampleSets[setIndex];
            const baseStats = {
                hp: parseInt(document.getElementById('stat-hp').value) || 60,
                atk: parseInt(document.getElementById('stat-atk').value) || 60,
                def: parseInt(document.getElementById('stat-def').value) || 60,
                spa: parseInt(document.getElementById('stat-spa').value) || 60,
                spd: parseInt(document.getElementById('stat-spd').value) || 60,
                spe: parseInt(document.getElementById('stat-spe').value) || 60
            };
            const statKeys = ['hp','atk','def','spa','spd','spe'];
            const data = NATURE_DATA[set.nature];

            const card = document.querySelector(`.sample-set-card[data-set-index="${setIndex}"]`);
            if (!card) return;

            statKeys.forEach(key => {
                const base = baseStats[key];
                const ev = set.evs[key] || 0;
                const iv = set.ivs[key] || 31;
                const calc = calcStat(base, ev, iv, set.nature, key, set.level);
                const isBoosted = data && data.up === key && data.up !== data.down;
                const isReduced = data && data.down === key && data.up !== data.down;
                const barFill = Math.min((calc / 500) * 100, 100);
                const barColor = isBoosted ? '#cc4444' : isReduced ? '#4466cc' : '#888';

                const calcEl = document.getElementById(`set-${setIndex}-stat-${key}`);
                if (calcEl) {
                    calcEl.textContent = calc;
                    const bar = calcEl.closest('.sample-set-stat-row')?.querySelector('.sample-set-stat-bar-fill');
                    if (bar) {
                        bar.style.width = barFill + '%';
                        bar.style.background = barColor;
                    }
                }

                // update row class for styling
                const row = document.getElementById(`set-${setIndex}-stat-${key}`).closest('.sample-set-stat-row');
                if (row) {
                    row.classList.remove('stat-boosted', 'stat-reduced');
                    if (isBoosted) row.classList.add('stat-boosted');
                    if (isReduced) row.classList.add('stat-reduced');
                }

                // update + / - button states
                const plusBtn = row.querySelector('.nature-plus');
                const minusBtn = row.querySelector('.nature-minus');
                if (plusBtn) plusBtn.classList.toggle('active', isBoosted);
                if (minusBtn) minusBtn.classList.toggle('active', isReduced);
            });

            // update export text
            const fakemonName = document.getElementById('fakemon-name').value || 'Fakemon';
            const exportText = generateShowdownExport(fakemonName, set);
            const outputEl = card.querySelector('.sample-set-output-text');
            if (outputEl) outputEl.textContent = exportText;

            updatePreview();
        }

function updateStatDisplay(setIndex, statKey, evVal, ivVal) {
            const set = state.sampleSets[setIndex];
            const baseStats = {
                hp: parseInt(document.getElementById('stat-hp').value) || 60,
                atk: parseInt(document.getElementById('stat-atk').value) || 60,
                def: parseInt(document.getElementById('stat-def').value) || 60,
                spa: parseInt(document.getElementById('stat-spa').value) || 60,
                spd: parseInt(document.getElementById('stat-spd').value) || 60,
                spe: parseInt(document.getElementById('stat-spe').value) || 60
            };
            const ev = evVal !== null ? parseInt(evVal) || 0 : (set.evs[statKey] || 0);
            const iv = ivVal !== null ? parseInt(ivVal) || 0 : (set.ivs[statKey] || 31);
            const calc = calcStat(baseStats[statKey], ev, iv, set.nature, statKey, set.level);
            const el = document.getElementById(`set-${setIndex}-stat-${statKey}`);
            const card = document.querySelector(`.sample-set-card[data-set-index="${setIndex}"]`);
            if (el) el.textContent = calc;

            if (card) {
                const row = el ? el.closest('.sample-set-stat-row') : null;
                if (row) {
                    const data = NATURE_DATA[set.nature];
                    const isBoosted = data && data.up === statKey && data.up !== data.down;
                    const isReduced = data && data.down === statKey && data.up !== data.down;
                    const barFill = Math.min((calc / 500) * 100, 100);
                    const barColor = isBoosted ? '#cc4444' : isReduced ? '#4466cc' : '#888';
                    const bar = row.querySelector('.sample-set-stat-bar-fill');
                    if (bar) {
                        bar.style.width = barFill + '%';
                        bar.style.background = barColor;
                    }
                    const evDisplay = row.querySelector('.sample-set-ev-value');
                    if (evDisplay) evDisplay.textContent = ev;
                    const slider = row.querySelector('.sample-set-ev-slider');
                    const fill = row.querySelector('.sample-set-ev-fill');
                    if (slider && evVal !== null) slider.value = ev;
                    if (fill && evVal !== null) fill.style.width = (ev / 252 * 100) + '%';
                }

                const fakemonName = document.getElementById('fakemon-name').value || 'Fakemon';
                const exportText = generateShowdownExport(fakemonName, set);
                const outputEl = card.querySelector('.sample-set-output-text');
                if (outputEl) outputEl.textContent = exportText;
            }
            updatePreview();
        }

        
        function renderSampleSets() {
            const container = document.getElementById('sample-sets-list');
            const fakemonName = document.getElementById('fakemon-name').value || 'Fakemon';
            const baseStats = {
                hp: parseInt(document.getElementById('stat-hp').value) || 60,
                atk: parseInt(document.getElementById('stat-atk').value) || 60,
                def: parseInt(document.getElementById('stat-def').value) || 60,
                spa: parseInt(document.getElementById('stat-spa').value) || 60,
                spd: parseInt(document.getElementById('stat-spd').value) || 60,
                spe: parseInt(document.getElementById('stat-spe').value) || 60
            };
            const allAbilities = getAllAbilities();
            const statKeys = ['hp','atk','def','spa','spd','spe'];
            const statLabels = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

            container.innerHTML = state.sampleSets.map((set, i) => {
                const exportText = generateShowdownExport(fakemonName, set);
                const totalEVs = statKeys.reduce((sum, k) => sum + (set.evs[k] || 0), 0);
                const evRemaining = 508 - totalEVs;

                const statRows = statKeys.map(key => {
                    const base = baseStats[key];
                    const ev = set.evs[key] || 0;
                    const iv = set.ivs[key] || 31;
                    const calc = calcStat(base, ev, iv, set.nature, key, set.level);
                    const data = NATURE_DATA[set.nature];
                    const isBoosted = data && data.up === key && data.up !== data.down;
                    const isReduced = data && data.down === key && data.up !== data.down;
                    const natureClass = isBoosted ? 'stat-boosted' : isReduced ? 'stat-reduced' : '';
                    const barFill = Math.min((calc / 500) * 100, 100);
                    const barColor = isBoosted ? '#cc4444' : isReduced ? '#4466cc' : '#888';

                    return `
                        <div class="sample-set-stat-row ${natureClass}">
                            <div class="sample-set-stat-col stat-name-col">
                                <div class="sample-set-stat-label">${statLabels[key]}</div>
                                <div class="sample-set-nature-btns">
                                    <button class="nature-btn nature-plus ${isBoosted ? 'active' : ''}" onclick="setNatureBoost(${i}, '${key}', 'up')" title="Boost ${statLabels[key]}">+</button>
                                    <button class="nature-btn nature-minus ${isReduced ? 'active' : ''}" onclick="setNatureBoost(${i}, '${key}', 'down')" title="Reduce ${statLabels[key]}">−</button>
                                </div>
                            </div>
                            <div class="sample-set-stat-base">${base}</div>
                            <input type="number" class="sample-set-ev-input-compact" min="0" max="252" step="4" value="${ev}" 
                                onchange="updateSampleSetEV(${i},'${key}',this.value)">
                            <div class="sample-set-stat-col slider-col">
                                <div class="sample-set-stat-bar-above">
                                    <div class="sample-set-stat-bar-fill" style="width:${barFill}%;background:${barColor}"></div>
                                </div>
                                <div class="sample-set-ev-track">
                                    <div class="sample-set-ev-fill" style="width:${(ev/252)*100}%"></div>
                                    <input type="range" class="sample-set-ev-slider" min="0" max="252" step="4" value="${ev}" 
                                        oninput="updateSampleSetEV(${i},'${key}',this.value)">
                                </div>
                            </div>
                            <div class="sample-set-stat-iv-wrap">
                                <input type="number" class="sample-set-iv-input" min="0" max="31" value="${iv}" 
                                    onchange="updateSampleSet(${i},'ivs.${key}',this.value); updateStatDisplay(${i},'${key}',null,this.value)">
                            </div>
                            <div class="sample-set-stat-calc" id="set-${i}-stat-${key}">${calc}</div>
                        </div>
                    `;
                }).join('');

                let abilityOptions = '<option value="">None</option>';
                allAbilities.forEach(a => {
                    abilityOptions += `<option value="${a}" ${set.ability === a ? 'selected' : ''}>${a}</option>`;
                });

                const natureOptions = NATURES.map(n => {
                    const label = getNatureOptionLabel(n);
                    return `<option value="${n}" ${set.nature === n ? 'selected' : ''}>${label}</option>`;
                }).join('');

                return `
                    <div class="sample-set-card" data-set-index="${i}">
                        <button class="sample-set-delete" onclick="removeSampleSet(${i})" title="Delete"><i data-lucide="trash-2" style="width:16px;height:16px;"></i></button>
                        <div class="sample-set-header">
                            <input type="text" class="sample-set-name" value="${set.name}" placeholder="Set name" oninput="updateSampleSet(${i},'name',this.value)">
                        </div>
                        <div class="sample-set-row">
                            <div class="sample-set-field">
                                <label>Item</label>
                                <div class="sample-set-item-wrap">
                                    <img class="sample-set-item-icon" id="set-${i}-item-icon" src="${set.item ? 'https://play.pokemonshowdown.com/sprites/itemicons/' + set.item.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '') + '.png' : ''}" alt="" style="${set.item ? '' : 'display:none;'}" onerror="this.style.display='none'">
                                    <div class="autocomplete-container" style="flex:1;">
                                        <input type="text" class="sample-set-item-input" value="${set.item}" placeholder="e.g., Leftovers"
                                            oninput="filterSampleSetItem(${i}, this.value)" onblur="hideSampleSetDropdownDelayed('item-dropdown-${i}')">
                                        <div class="autocomplete-dropdown" id="item-dropdown-${i}"></div>
                                    </div>
                                </div>
                            </div>
                            <div class="sample-set-field">
                                <label>Ability</label>
                                <select onchange="updateSampleSet(${i},'ability',this.value)">${abilityOptions}</select>
                            </div>
                            <div class="sample-set-field">
                                <label>Nature</label>
                                <select onchange="updateSampleSet(${i},'nature',this.value); renderNatureStats(${i})">${natureOptions}</select>
                            </div>
                        </div>
                        <div class="sample-set-row">
                            <div class="sample-set-field">
                                <label>Level</label>
                                <input type="number" min="1" max="100" value="${set.level || 100}" placeholder="100"
                                    onchange="updateSampleSet(${i},'level',this.value)">
                            </div>
                            <div class="sample-set-field wide">
                                <label>Tera Type</label>
                                <div class="type-dropdown" id="tera-type-${i}-dropdown">
                                    <button class="type-dropdown-trigger" type="button" onclick="toggleTypeDropdown('tera-type-${i}')">
                                        <span class="type-dropdown-value" id="tera-type-${i}-value">${set.teraType ? `<span class="type-pill type-${set.teraType.toLowerCase()}">${set.teraType}</span>` : 'None'}</span>
                                        <span class="type-dropdown-arrow">▼</span>
                                    </button>
                                    <div class="type-dropdown-menu" id="tera-type-${i}-menu">${buildTypeMenuOptions(t => `selectTeraType(${i}, '${t}')`, true, 'None')}</div>
                                </div>
                            </div>
                        </div>
                        <div class="sample-set-ev-total-row">
                            <div class="sample-set-ev-total-text">${totalEVs} / 508 EVs ${evRemaining >= 0 ? '(' + evRemaining + ' remaining)' : '(' + Math.abs(evRemaining) + ' over!)'}</div>
                            <button type="button" class="sample-set-guess-btn btn btn-secondary btn-sm" onclick="guessEVSpread(${i})" title="Guess a competitive EV spread from this Fakemon's base stats and moves">${formatEVSpread(set.evs, set.nature, set)}</button>
                        </div>
                        <div class="sample-set-stats-section">
                            <div class="sample-set-stats-header">
                                <span>Stat</span><span>Base</span><span>EV</span><span>Slider</span><span>IV</span><span>Total</span>
                            </div>
                            ${statRows}
                        </div>
                        <div style="margin-top:8px;">
                            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:700;margin-bottom:4px;">Moves</div>
                            <div class="sample-set-moves">
                                ${[0,1,2,3].map(slot => `
                                    <div class="autocomplete-container">
                                        <input type="text" class="sample-set-move-input" value="${set.moves[slot]}" placeholder="Move ${slot+1}"
                                            oninput="filterSampleSetMove(${i}, ${slot}, this.value)" onblur="hideSampleSetDropdownDelayed('move-dropdown-${i}-${slot}')">
                                        <div class="autocomplete-dropdown" id="move-dropdown-${i}-${slot}"></div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                        <div class="sample-set-output">
                            <button class="sample-set-copy" onclick="copySampleSet(${i})" title="Copy to clipboard"><i data-lucide="copy" style="width:14px;height:14px;"></i></button>
                            <span class="sample-set-output-text">${exportText}</span>
                        </div>
                    </div>
                `;
            }).join('');
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        function showDetailPopup(title, content) {
            document.querySelectorAll('.move-detail-popup, .overlay-dark').forEach(el => el.remove());
            const overlay = document.createElement('div');
            overlay.className = 'overlay-dark';
            const popup = document.createElement('div');
            popup.className = 'move-detail-popup';
            popup.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;position:sticky;top:0;background:var(--bg-card);padding-bottom:4px;">
                    <h3>${title}</h3>
                    <button class="modal-close" type="button">&times;</button>
                </div>
                ${content}
            `;
            const close = () => {
                overlay.classList.remove('active');
                popup.classList.remove('active');
                setTimeout(() => { overlay.remove(); popup.remove(); }, 150);
            };
            overlay.onclick = close;
            popup.querySelector('.modal-close').onclick = close;
            document.body.appendChild(overlay);
            document.body.appendChild(popup);
            // double rAF so the initial (pre-.active) state paints first, guaranteeing
            // the transition actually runs instead of jumping straight to the end state.
            requestAnimationFrame(() => requestAnimationFrame(() => {
                overlay.classList.add('active');
                popup.classList.add('active');
            }));
        }

        

if (typeof window !== 'undefined') {
    window.__generateSuggestedSampleSets = (force = false) => generateSuggestedSampleSets(force);
    window.__getSampleSetProfile = () => getSampleSetProfile();
    window.__getSampleRoleScores = profile => sampleRoleScores(profile || getSampleSetProfile());
}

export { updateSampleSet, updateSampleSetItem, hideSampleSetDropdownDelayed, filterSampleSetItem, filterSampleSetMove, removeSampleSet, copySampleSet, copySampleSetText, generateShowdownExport, openSampleSetModal, closeSampleSetModal, addBlankSampleSet, addSampleSet, applySuggestedSampleSet, renderSuggestedSampleSets, getNatureBoostLabel, calcStat, getAllAbilities, updateSampleSetEV, guessEVSpread, setNatureBoost, renderNatureStats, updateStatDisplay, renderSampleSets, showDetailPopup, sampleMoveIsActuallyUseful };