import { state, api } from './app.js';

import { NATURE_DATA, NATURES, STAT_NAMES } from './data.js';
import { buildTypeMenuOptions, getSdMoveByName, loadCompetitiveMoveUsefulness, renderDropdown, selectTeraType } from './editor.js';
import { updatePreview } from './editor-core.js';
// ==================== SAMPLE SETS ====================
        // Competitive sample-set generator.
        //
        // This is intentionally local/deterministic: it never calls an AI or external
        // generation API.  The only move data it consumes is the Fakemon's current
        // learnset plus the Showdown move metadata already loaded into state.sdMoves.
        //
        // The scoring tables below are deliberately kept in one place so the generator
        // can be tuned without rewriting the selection algorithm.
        const SAMPLE_SET_CONFIG = {
            roles: {
                physicalSweeper: { name: 'Physical Sweeper', attack: 'atk', natureFast: 'Jolly', natureSlow: 'Adamant' },
                specialSweeper: { name: 'Special Sweeper', attack: 'spa', natureFast: 'Timid', natureSlow: 'Modest' },
                wallbreaker: { name: 'Wallbreaker', attack: null, natureFast: null, natureSlow: null },
                bulkyAttacker: { name: 'Bulky Attacker', attack: null, natureFast: null, natureSlow: null },
                defensive: { name: 'Defensive', attack: null, natureFast: null, natureSlow: null },
                support: { name: 'Support', attack: null, natureFast: null, natureSlow: null },
                pivot: { name: 'Pivot', attack: null, natureFast: null, natureSlow: null },
                setupSweeper: { name: 'Setup Sweeper', attack: null, natureFast: null, natureSlow: null },
                hazard: { name: 'Hazard Setter/Remover', attack: null, natureFast: null, natureSlow: null }
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
            roles: {
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

        // Competitive-set filters. These are intentionally explicit so the generator
        // prefers moves that actually belong on a serious set instead of merely having
        // high BP or being technically legal.
        const SAMPLE_SET_BAD_DEFAULT_MOVES = new Set([
            // Generic/weak attacks that should never be auto-selected for a competitive
            // sample set. These remain perfectly legal in the Fakemon's learnset and can
            // still be selected manually.
            'Covet','Thief','Tackle','Pound','Scratch','Constrict','Present','Round','Snore',
            'Bide','Rage','Fury Attack','Fury Swipes','Take Down','Submission','Headbutt',
            'Mega Drain','Absorb','Vine Whip','Razor Leaf','Ember','Water Gun','Bubble',
            'Powder Snow','Gust','Peck','Pursuit','Astonish','Lick','Aerial Ace',
            'Quick Attack','Feint','Vacuum Wave','Mach Punch','Bullet Punch',
            'Nuzzle','Pounce','Mud Shot','Bulldoze','Rock Smash','Low Sweep',
            'Fling','Natural Gift','Echoed Voice','Uproar','Swift','Snarl',
            'Struggle Bug','Infestation','Inflict',
            'Focus Energy','Laser Focus'
        ]);

        // Additional low-value status/utility moves. The sample-set generator is
        // deliberately conservative: if a status move does not have a clear competitive
        // job, it should never be used merely to fill the fourth slot.
        const SAMPLE_SET_LOW_VALUE_UTILITY_MOVES = new Set([
            'Safeguard','Mist','Lucky Chant','Sweet Scent','Odor Sleuth','Foresight',
            'Flash','Sand Attack','Smokescreen','Kinesis','Mud-Slap','Tail Whip',
            'Growl','Leer','String Shot','Scary Face','Baby-Doll Eyes','Play Nice',
            'Tickle','Noble Roar','Screech','Fake Tears','Metal Sound','Defog',
            'Harden','Withdraw','Defense Curl','Minimize','Double Team','Swagger',
            'Flatter','Teeter Dance','Confide','Charm','Captivate','Attract',
            'Sweet Kiss','Flatter','Supersonic','Confusion','Kinesis','Smog',
            'Poison Gas','Smokescreen','Sand Attack','Water Sport','Mud Sport',
            'Lucky Chant','Magic Coat'
        ]);
        const SAMPLE_SET_SELF_KO_MOVES = new Set([
            'Explosion','Self-Destruct','Misty Explosion','Final Gambit','Memento','Healing Wish','Lunar Dance'
        ]);
        const SAMPLE_SET_COVERAGE_TYPES = ['Normal','Fire','Water','Electric','Grass','Ice','Fighting','Poison','Ground','Flying','Psychic','Bug','Rock','Ghost','Dragon','Dark','Steel','Fairy'];
        // Premium attacks that should survive competitive-usefulness filtering even when
        // they have little/no sample-set frequency. These are not blanket auto-picks;
        // they still have to fit the Fakemon's role, category, typing, and movepool.
        const SAMPLE_SET_PREMIUM_ATTACKS = new Set([
            'V-create','Gigaton Hammer','Make It Rain','Fleur Cannon','Bolt Beak','Fishious Rend',
            'Headlong Rush','Glacial Lance','Astral Barrage','Collision Course','Electro Drift',
            'Population Bomb','Last Respects','Rage Fist','Expanding Force','Surging Strikes'
        ]);

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
            // Name/description fallback catches custom *status* recovery moves, but
            // deliberately avoids broad 'heal/regain' matching that can misclassify
            // offensive draining attacks as recovery.
            kinds.recovery ||= (move.category === 'Status' && /(?:recover|heals? the user|restores? the user's hp|restores? hp|regains? hp|fully restores? hp|wish|rest$)/.test(lower));
            kinds.setup ||= /raises? (its |the )?(attack|sp\\. attack|special attack|speed|defen|sp\\. def|all stats)|boosts? .*stat/.test(lower);
            kinds.hazard ||= /stealth rock|spikes|toxic spikes|sticky web/.test(lower);
            kinds.removal ||= /remove.*hazard|clear.*hazard|defog|rapid spin/.test(lower);
            kinds.pivot ||= /switch.*out|user.*switches|switches out/.test(lower) && move.category === 'Status';
            return kinds;
        }

        function sampleIsDamaging(move) {
            return move.category === 'Physical' || move.category === 'Special';
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

            // Use the whole stat line, not isolated thresholds. This gives the role
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
                setupSweeper: 0, hazard: 0
            };

            // Offensive profile: reward both the stat and the existence of genuinely
            // usable attacks of that category. A 120 Atk stat with only bad moves should
            // not beat a 105 SpA stat with a great movepool.
            scores.physicalSweeper += Math.max(0, physicalAdvantage) * 0.55 + Math.max(0, stats.atk - 80) * 0.7;
            scores.specialSweeper += Math.max(0, specialAdvantage) * 0.55 + Math.max(0, stats.spa - 80) * 0.7;
            scores.physicalSweeper += goodPhysical.length * 7 + (hasPhysicalSTAB ? 12 : 0);
            scores.specialSweeper += goodSpecial.length * 7 + (hasSpecialSTAB ? 12 : 0);
            scores.wallbreaker += Math.max(0, stats.atk - 90) * 0.55 + Math.max(0, stats.spa - 90) * 0.55;
            scores.wallbreaker += (goodPhysical.length + goodSpecial.length) * 3;
            scores.wallbreaker += damaging.filter(m => (m.basePower || 0) >= 100 && sampleMoveIsActuallyUseful(m)).length * 7;

            // Speed is meaningful only when the offensive profile can capitalize on it.
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

            // Bulk is relative to offensive stats. High bulk + high offense points to a
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

            // Recovery is a major role signal. This prevents a bulky mon with Moonlight /
            // Synthesis / Recover from being treated as a pure sweeper just because its
            // Attack stat is high.
            if (recovery.length) {
                if (physicalBulk >= 170 || specialBulk >= 170) scores.defensive += 18;
                if (bulk >= 270) scores.bulkyAttacker += 10;
            }

            scores.pivot += pivot.length * 30 + Math.max(0, stats.spe - 70) * 0.35 + utility.length * 2;
            scores.setupSweeper += setup.length * 30 + Math.max(0, stats.spe - 75) * 0.45;
            scores.defensive += defensiveSetup.length * 8;
            scores.bulkyAttacker += defensiveSetup.length * 4;
            scores.hazard += hazards.length * 34 + removal.length * 20 + utility.length * 3;

            if (stats.atk >= 110 && hasPhysicalSTAB) scores.physicalSweeper += 10;
            if (stats.spa >= 110 && hasSpecialSTAB) scores.specialSweeper += 10;
            if (stats.hp >= 100 && (stats.def >= 100 || stats.spd >= 100)) scores.defensive += 10;
            if (types.length === 2) scores.bulkyAttacker += 2;

            // Ability synergy is still a nudge, but now uses the role's actual stat profile.
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

            return scores;
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
                hazard: { attack: 'either', require: 'utility', preferHazard: true }
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

            // Directly match common competitive ability archetypes to the Fakemon's actual data.
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
            if (/contrary/.test(n)) score += profile.moves.some(m => /lower|drop|v-create|leaf storm|superpower|overheat/i.test(m.name + ' ' + (m.desc || ''))) ? 28 : -4;
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

            // Ability/move interaction must be evaluated against the moves that will
            // actually be on the generated set, not merely anything in the full learnset.
            // This is especially important for Contrary: Swords Dance + Contrary is
            // actively counter-synergistic, while V-create/Superpower/Leaf Storm/etc.
            // can make Contrary excellent when their stat drops are part of the set.
            const chosen = chosenMoves || [];
            const chosenNames = chosen.map(m => String(m.name || '').toLowerCase());
            const chosenText = chosen.map(m => `${m.name} ${m.desc || ''}`).join(' ').toLowerCase();
            const hasChosen = (...names) => names.some(x => chosenNames.includes(String(x).toLowerCase()));
            const hasSelfDropMove = /(?:v-create|superpower|close combat|leaf storm|overheat|draco meteor|make it rain|psychic noise)/.test(chosenText)
                || chosen.some(m => /(?:lowers|lowered|drop|drops).*(?:user|its|attack|defen|sp\. atk|sp\. def|speed)/i.test(String(m.desc || '')));
            const hasDirectRaise = chosen.some(m => /(?:raises|boosts).*(?:user|its).*(?:attack|defen|sp\. atk|sp\. def|speed|stats)/i.test(String(m.desc || '')))
                || hasChosen('Swords Dance','Nasty Plot','Calm Mind','Iron Defense','Amnesia','Acid Armor','Cotton Guard','Bulk Up','Dragon Dance','Quiver Dance','Coil','Curse','Shell Smash','Rock Polish','Agility','Autotomize');

            if (/contrary/.test(n)) {
                if (hasSelfDropMove) score += 42;
                else score -= 28;
                if (hasDirectRaise) score -= 55;
                if (hasChosen('Swords Dance','Nasty Plot','Calm Mind','Iron Defense','Amnesia','Acid Armor','Cotton Guard','Bulk Up','Dragon Dance','Quiver Dance','Coil','Curse','Shell Smash','Rock Polish','Agility','Autotomize')) score -= 70;
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

            // Use the actual description as a final semantic-ish deterministic signal.
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
            // A damaging move must use the offensive category the set is built around.
            // This is a hard compatibility rule: it prevents things like Eruption from
            // appearing on a physical sweeper simply because its raw BP is high.
            if (sampleIsDamaging(move)) {
                const category = sampleRoleAttackCategory(profile, role);
                if (category !== 'either' && move.category !== category) return false;
            }
            if (!sampleSetupFitsRole(move, profile, role)) return false;
            return true;
        }

        function sampleCompetitiveUsefulness(move) {
            const weights = state.sdMoveUsefulness || {};
            const exact = weights[move.name];
            if (exact != null) return exact;
            // Custom/Fakemon moves are not in Smogon data. Give them a neutral baseline
            // and let the local role/coverage/ability rules decide their value.
            return 1;
        }

        // Hard blacklist for sample-set generation. These moves are legal, but are
        // deliberately never allowed to enter an automatically generated sample set.
        // This prevents the final-slot fallback from turning into generic low-value
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
            // One hard gate for all permanently banned sample-set moves.
            if (SAMPLE_SET_BANNED_MOVES.has(move.name)) return true;
            if (SAMPLE_SET_BAD_DEFAULT_MOVES.has(move.name)) return true;
            if (SAMPLE_SET_LOW_VALUE_UTILITY_MOVES.has(move.name)) return true;
            return false;
        }

        function sampleMoveIsActuallyUseful(move, profile = null, role = null) {
            if (!move || !move.name) return false;
            if (sampleMoveIsBanned(move)) return false;
            if (SAMPLE_SET_BAD_DEFAULT_MOVES.has(move.name)) return false;
            if (SAMPLE_SET_SELF_KO_MOVES.has(move.name)) return false;
            const kind = sampleMoveKind(move);
            if (kind.hazard || kind.removal || kind.pivot || kind.setup || kind.defensiveSetup || kind.disruption || kind.speedControl || kind.screens) return true;
            // Only status moves with explicit recovery semantics count as recovery.
            if (kind.recovery && move.category === 'Status') return true;
            if (!sampleIsDamaging(move)) return false;
            const bp = Number(move.basePower || 0);
            const usefulness = sampleCompetitiveUsefulness(move);
            const accuracy = move.accuracy === true || move.accuracy == null || Number(move.accuracy) >= 75;
            // Usage is a preference, not a legality/usefulness gate. Strong/signature
            // attacks such as V-create and Gigaton Hammer must remain viable even when
            // they have little or no ladder usage history.
            if (!accuracy) return (SAMPLE_SET_PREMIUM_ATTACKS.has(move.name) && bp >= 100 && Number(move.accuracy) >= 65) || (bp >= 120 && Number(move.accuracy) >= 65);
            if (SAMPLE_SET_PREMIUM_ATTACKS.has(move.name) && bp >= 90) return true;
            if (bp >= 120) return true;
            if (bp >= 100) return true;
            if (bp >= 80 && usefulness >= 1.05) return true;
            return bp >= 60 && usefulness >= 2.0;
        }

        function sampleHasGoodCoverage(move, profile, chosen) {
            if (!sampleIsDamaging(move) || profile.types.includes(move.type)) return false;
            if (!sampleMoveIsActuallyUseful(move)) return false;
            const chosenGood = chosen.filter(sampleMoveIsActuallyUseful);
            const stabTypes = profile.types;
            let best = 1;
            for (const defender of SAMPLE_SET_COVERAGE_TYPES) {
                const stabBest = Math.max(...stabTypes.map(t => sampleTypeEffectiveness(t, defender)));
                const cov = sampleTypeEffectiveness(move.type, defender);
                if (stabBest < 2 && cov >= 2) best = Math.max(best, cov);
            }
            // Don't call a coverage move "coverage" if it merely adds another neutral hit.
            if (best < 2) return false;
            if (chosenGood.some(m => !profile.types.includes(m.type) && m.type === move.type)) return false;
            return true;
        }

        function sampleMoveScore(move, profile, role, chosen) {
            const { stats, types } = profile;
            const kind = sampleMoveKind(move);
            const req = sampleRoleMoveRequirements(role);
            let score = 0;

            if (!sampleMoveCompatibleWithRole(move, profile, role)) return -10000;
            if (SAMPLE_SET_BAD_DEFAULT_MOVES.has(move.name)) return -9000;
            if (kind.selfKO) return -8500;

            const usefulness = sampleCompetitiveUsefulness(move);
            score += usefulness * SAMPLE_SET_CONFIG.move.usefulness;
            if (!sampleIsDamaging(move) && !kind.recovery && !kind.hazard && !kind.removal && !kind.pivot && !kind.disruption && !kind.speedControl && !kind.screens && !kind.setup && !kind.defensiveSetup) score -= 40;

            if (sampleIsDamaging(move)) {
                if (types.includes(move.type)) score += SAMPLE_SET_CONFIG.move.stab;
                // Coverage is a bonus only when it is genuinely good. It is never a
                // requirement, so a mediocre coverage move cannot beat a useful STAB,
                // recovery, setup, or utility move just because it is super effective.
                score += sampleCoverageScore(move, types, chosen);
                // Strong attacks deserve to compete on their actual combat value, not
                // merely on usage frequency. This is especially important for legal
                // Fakemon movepools containing moves such as V-create or Gigaton Hammer.
                score += Math.min(10, (move.basePower || 0) * 0.05);
                if (SAMPLE_SET_PREMIUM_ATTACKS.has(move.name)) score += 12;
                if ((move.basePower || 0) >= 120 && (move.accuracy === true || move.accuracy == null || Number(move.accuracy) >= 80)) score += 8;
                if (move.accuracy === true || move.accuracy === undefined) score += SAMPLE_SET_CONFIG.move.accuracy;
                else if (typeof move.accuracy === 'number') score += (move.accuracy / 100) * SAMPLE_SET_CONFIG.move.accuracy;
                if (move.priority > 0) score += SAMPLE_SET_CONFIG.move.priority;
                if (req.attack === move.category) score += 15;
                if (!sampleMoveIsActuallyUseful(move)) score -= 25;
                if ((move.basePower || 0) < 60) score -= SAMPLE_SET_CONFIG.move.lowPowerPenalty;
            }

            // Stat-aware offensive fit. The same move is worth more when it matches the
            // Fakemon's genuinely superior attacking stat.
            if (sampleIsDamaging(move)) {
                if (move.category === 'Physical') score += Math.max(-4, Math.min(12, (stats.atk - stats.spa) * 0.18));
                if (move.category === 'Special') score += Math.max(-4, Math.min(12, (stats.spa - stats.atk) * 0.18));
            }

            if (kind.setup) score += req.preferSetup ? SAMPLE_SET_CONFIG.move.setup : -12;
            if (kind.recovery) {
                score += req.preferRecovery ? SAMPLE_SET_CONFIG.move.recovery : (role === 'physicalSweeper' || role === 'specialSweeper' || role === 'wallbreaker' ? -5 : 8);
                if (['defensive','support','hazard','bulkyAttacker'].includes(role)) score += 18;
            }
            if (kind.hazard) score += req.preferHazard ? SAMPLE_SET_CONFIG.move.hazard : (['defensive','support','hazard'].includes(role) ? 10 : -4);
            if (kind.removal) score += ['defensive','support','pivot','hazard'].includes(role) ? SAMPLE_SET_CONFIG.move.removal : 2;
            if (kind.pivot) score += role === 'pivot' ? SAMPLE_SET_CONFIG.move.pivot : 3;
            if (kind.speedControl) score += ['support','pivot'].includes(role) ? SAMPLE_SET_CONFIG.move.speedControl : 1;
            if (kind.disruption) score += ['support','defensive','pivot'].includes(role) ? SAMPLE_SET_CONFIG.move.disruption : 2;
            if (kind.screens) score += role === 'support' ? 16 : -6;
            score += sampleAbilityScore(move, profile, role);

            // Defensive roles should not spend slots on four attacks if they have real
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
                if (kind.pivot && ok.pivot) score -= SAMPLE_SET_CONFIG.move.redundantRolePenalty;
            });

            return score;
        }

        function samplePickMoves(profile, role, seed) {
            const rng = sampleSetRng(seed);
            const compatible = profile.moves.filter(m => m.name && !sampleMoveIsBanned(m) && sampleMoveCompatibleWithRole(m, profile, role));
            const clean = compatible.filter(m => !SAMPLE_SET_SELF_KO_MOVES.has(m.name) && !SAMPLE_SET_BAD_DEFAULT_MOVES.has(m.name));
            const usable = clean.length >= 4 ? clean : compatible.filter(m => !SAMPLE_SET_SELF_KO_MOVES.has(m.name));
            if (usable.length < 4) return [];
            const chosen = [];
            const pickBest = (pool, mandatory=false) => {
                const candidates = pool.filter(m => !chosen.some(c => c.name === m.name)).map(m => ({move:m,score:sampleMoveScore(m,profile,role,chosen)+rng()*0.0001})).sort((a,b)=>b.score-a.score||a.move.name.localeCompare(b.move.name));
                if (!candidates.length) return null;
                if (mandatory) { chosen.push(candidates[0].move); return candidates[0].move; }
                const top = candidates.slice(0, Math.min(3,candidates.length));
                const pick = top[Math.floor(rng()*top.length)].move; chosen.push(pick); return pick;
            };
            const defensiveRole=['defensive','support','hazard'].includes(role), bulkyRole=role==='bulkyAttacker';
            const offensiveRole=['physicalSweeper','specialSweeper','setupSweeper','wallbreaker','bulkyAttacker'].includes(role);
            const useful=m=>sampleMoveIsActuallyUseful(m,profile,role);
            const attacks=usable.filter(m=>sampleIsDamaging(m)&&useful(m));
            const goodStabs=attacks.filter(m=>profile.types.includes(m.type));
            const goodCoverage=attacks.filter(m=>!profile.types.includes(m.type)&&sampleHasGoodCoverage(m,profile,chosen));
            const recovery=usable.filter(m=>sampleMoveKind(m).recovery && m.category === 'Status' && !sampleIsDamaging(m));
            const setup=usable.filter(m=>sampleMoveKind(m).setup&&sampleSetupFitsRole(m,profile,role));
            const hazards=usable.filter(m=>sampleMoveKind(m).hazard);
            const removal=usable.filter(m=>sampleMoveKind(m).removal);
            const pivot=usable.filter(m=>sampleMoveKind(m).pivot);
            const realUtility=usable.filter(m=>{const k=sampleMoveKind(m);return k.hazard||k.removal||k.pivot||k.disruption||k.speedControl||k.screens;});

            // Defensive sets: recovery is a structural slot, and at least one genuinely
            // useful attack is preferred. Draining attacks are not recovery for this purpose.
            if (defensiveRole || bulkyRole) {
                if (recovery.length) pickBest(recovery, true);
                if (goodStabs.length) pickBest(goodStabs, true);
                if (role==='hazard' && hazards.length) pickBest(hazards, true);
                else if (role==='pivot' && pivot.length) pickBest(pivot, true);
                else if (removal.length) pickBest(removal, true);
            }
            if (['physicalSweeper','specialSweeper','setupSweeper'].includes(role) && setup.length) pickBest(setup, true);
            if (offensiveRole && !chosen.some(sampleIsDamaging)) {
                if (goodStabs.length) pickBest(goodStabs, true);
            }
            // Prefer a second distinct STAB before coverage when it is actually good.
            const firstStabType = chosen.find(m=>sampleIsDamaging(m)&&profile.types.includes(m.type))?.type;
            const secondStab = goodStabs.filter(m=>m.type!==firstStabType);
            if (offensiveRole && secondStab.length && chosen.length<4) pickBest(secondStab);
            // Coverage is optional: only use a genuinely good coverage move when one exists.
            if (offensiveRole && goodCoverage.length && chosen.length<4) pickBest(goodCoverage);

            while(chosen.length<4){
                const remaining=usable.filter(m=>!chosen.some(c=>c.name===m.name));
                if(!remaining.length) break;
                const pool = remaining.filter(m => {
                    const k=sampleMoveKind(m);
                    if (sampleIsDamaging(m)) return useful(m);
                    // Only genuinely role-relevant status moves may fill a slot.
                    // Do not fall back to arbitrary legal utility such as Safeguard.
                    return k.hazard||k.removal||k.pivot||k.disruption||k.speedControl||k.screens||k.setup||k.defensiveSetup || (k.recovery && m.category==='Status');
                });
                if (!pool.length) break;
                const candidates=pool.map(m=>{
                    let score=sampleMoveScore(m,profile,role,chosen);
                    if (sampleIsDamaging(m) && !profile.types.includes(m.type) && !sampleHasGoodCoverage(m,profile,chosen)) score-=18;
                    if (!sampleIsDamaging(m) && !sampleMoveKind(m).recovery && ['physicalSweeper','specialSweeper','wallbreaker','bulkyAttacker'].includes(role)) score-=22;
                    if (defensiveRole && sampleIsDamaging(m) && chosen.some(c=>sampleIsDamaging(c))) score+=6;
                    return {move:m,score:score+rng()*0.0001};
                }).sort((a,b)=>b.score-a.score||a.move.name.localeCompare(b.move.name));
                if(!candidates.length) break;
                chosen.push(candidates[0].move);
            }
            return chosen.length===4?chosen:[];
        }

        function generateParametricSampleSet(profile, seed) {
            const def=profile.moves.find(m=>['Iron Defense','Cotton Guard','Acid Armor'].includes(m.name));
            const body=profile.moves.find(m=>m.name==='Body Press');
            if(!def||!body||profile.stats.def<95) return null;
            const pool=[def,body];
            const recovery=profile.moves.filter(m=>!sampleMoveIsBanned(m)&&sampleMoveKind(m).recovery && m.category === 'Status' && !sampleIsDamaging(m));
            const coverage=profile.moves.filter(m=>!sampleMoveIsBanned(m)&&sampleIsDamaging(m)&&!profile.types.includes(m.type)&&sampleHasGoodCoverage(m,profile,pool));
            const stab=profile.moves.filter(m=>!sampleMoveIsBanned(m)&&sampleIsDamaging(m)&&profile.types.includes(m.type)&&sampleMoveIsActuallyUseful(m));
            const utility=profile.moves.filter(m=>!sampleMoveIsBanned(m)&&sampleMoveIsActuallyUseful(m,profile,'defensive')&&(()=>{const k=sampleMoveKind(m);return k.hazard||k.removal||k.disruption||k.pivot;})());
            const third=recovery[0]||coverage[0]||stab[0]||utility[0]; if(third&&!pool.includes(third)) pool.push(third);
            const fourth=coverage.find(m=>!pool.includes(m))||stab.find(m=>!pool.includes(m))||utility.find(m=>!pool.includes(m)); if(fourth) pool.push(fourth);
            if(pool.length!==4) return null;
            const ability = sampleChooseAbility(profile, 'defensive', pool);
            return {name:`${def.name} + Body Press`,role:'Defensive Setup',item:'Leftovers',ability,nature:'Bold',evs:{hp:252,atk:0,def:252,spa:0,spd:4,spe:0},ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},moves:pool.map(m=>m.name),teraType:profile.types.includes('Fighting')?'Fighting':(profile.types[0]||'Fighting'),level:100};
        }

        function sampleChooseNatureEVs(profile, role) {
            const s = profile.stats;
            const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
            const physical = s.atk >= s.spa;
            const fast = s.spe >= 95;
            const veryFast = s.spe >= 110;
            let nature = 'Hardy';

            if (role === 'physicalSweeper' || role === 'setupSweeper') {
                evs.atk = 252; evs.spe = 252; evs.hp = 4;
                nature = fast ? 'Jolly' : 'Adamant';
            } else if (role === 'specialSweeper') {
                evs.spa = 252; evs.spe = 252; evs.hp = 4;
                nature = fast ? 'Timid' : 'Modest';
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
                // Don't waste a nature on Speed unless the base Speed is high enough
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
            // Stealth Rock is the main reason Boots matter in singles. Rock weakness
            // (especially 2x/4x) is a meaningful signal; otherwise longevity items win.
            if (!types.length) return false;
            let mult = 1;
            for (const t of types) mult *= sampleTypeEffectiveness('Rock', t);
            return mult > 1;
        }

        function sampleChooseItem(profile, role, chosenMoves, chosenAbility = '') {
            const moves = chosenMoves || profile.moves;
            const kinds = moves.map(sampleMoveKind);
            const hasSetup = kinds.some(k => k.setup);
            const hasRecovery = kinds.some(k => k.recovery);
            const hasPivot = kinds.some(k => k.pivot);
            const hasHazard = kinds.some(k => k.hazard);
            const hasRemoval = kinds.some(k => k.removal);
            const hasStatus = moves.some(m => m.category === 'Status');
            const abilityText = (chosenAbility || profile.abilities.join(' ')).toLowerCase();
            const physical = sampleRoleAttackCategory(profile, role) === 'Physical';
            const fast = profile.stats.spe >= 95;
            const bulky = profile.stats.hp + profile.stats.def + profile.stats.spd >= 265;
            const rockWeak = hasHazardWeakness(profile.types);

            if (/guts/.test(abilityText) && !['defensive','support','hazard'].includes(role)) return 'Flame Orb';
            if (/magic guard/.test(abilityText) && ['physicalSweeper','specialSweeper','setupSweeper','wallbreaker'].includes(role) && !bulky) return 'Life Orb';

            // Longevity is the default for bulky roles. Life Orb is intentionally never
            // selected for a Bulky Attacker, Defensive, Support, Pivot, or Hazard set.
            if (role === 'defensive' || role === 'support' || role === 'hazard') {
                if (hasRecovery) return 'Leftovers';
                if (hasHazard || hasRemoval) return 'Rocky Helmet';
                return 'Leftovers';
            }
            if (role === 'bulkyAttacker') {
                if (hasRecovery || bulky) return 'Leftovers';
                if (!hasStatus && !hasSetup && (physical ? profile.stats.atk : profile.stats.spa) >= 105) return 'Assault Vest';
                return 'Leftovers';
            }
            if (role === 'pivot') {
                if (rockWeak && hasPivot) return 'Heavy-Duty Boots';
                return hasRecovery ? 'Leftovers' : 'Heavy-Duty Boots';
            }
            if (role === 'wallbreaker') return physical ? 'Choice Band' : 'Choice Specs';

            if (['physicalSweeper','specialSweeper','setupSweeper'].includes(role)) {
                // Setup sweepers prefer a safer setup item unless the ability specifically
                // wants Life Orb. Fast offensive sets can use Expert Belt when they have
                // real coverage, otherwise Leftovers/Lum Berry are safer defaults.
                if (hasSetup && hasStatus) return 'Lum Berry';
                if (hasSetup && bulky) return 'Leftovers';
                const goodCoverage = moves.some(m => sampleHasGoodCoverage(m, profile, moves));
                if (goodCoverage && fast) return 'Expert Belt';
                if (hasSetup && fast && !bulky && goodCoverage && profile.stats[physical ? 'atk' : 'spa'] >= 110) return 'Life Orb';
                if (hasSetup && !bulky) return 'Leftovers';
                return fast ? 'Expert Belt' : 'Leftovers';
            }
            return 'Leftovers';
        }

        function sampleChooseTera(profile, role, moves) {
            const stabTypes = profile.types.filter(t => moves.some(m => m.type === t && sampleIsDamaging(m)));
            if (role === 'physicalSweeper' || role === 'specialSweeper' || role === 'setupSweeper' || role === 'wallbreaker') {
                if (stabTypes.length) return stabTypes[0];
                const damage = moves.filter(sampleIsDamaging).sort((a,b) => (b.basePower||0) - (a.basePower||0));
                if (damage[0]) return damage[0].type;
            }
            if (profile.types.includes('Steel')) return 'Steel';
            if (profile.types.includes('Fairy')) return 'Fairy';
            if (profile.types.includes('Water')) return 'Water';
            return profile.types[0] || 'Normal';
        }

        function sampleRoleLabel(role) {
            const configured = SAMPLE_SET_CONFIG.roles[role]?.name;
            if (configured) return configured;
            // Keep generated labels human-readable even if a role key is introduced
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
                // Exact/near-exact sets are duplicates even if their labels differ.
                if (sim.moveJaccard >= 0.75) return true;
                // Two sets from the same role with at least half their moves and the
                // same broad EV profile are effectively the same idea.
                if (sim.sameRole && sim.moveJaccard >= 0.50 && sim.sameEVProfile) return true;
                // Don't show two sets that only differ by an item while everything else
                // is effectively identical.
                if (sim.moveJaccard >= 0.50 && sim.sameItem && sim.sameEVProfile) return true;
                return false;
            });
        }

        function generateSuggestedSampleSets() {
            const profile = getSampleSetProfile();
            if (profile.moves.length < 4) return [];
            const roleScores = sampleRoleScores(profile);
            const rankedRoles = Object.keys(roleScores).sort((a,b) => roleScores[b] - roleScores[a] || a.localeCompare(b));
            const seedSource = [document.getElementById('fakemon-name')?.value || '', Object.values(profile.stats).join(','), profile.types.join('/'), profile.abilities.join('/'), profile.moves.map(m => `${m.name}:${m.type}:${m.category}:${m.basePower}`).join('|')].join('::');
            const seed = sampleSetHash(seedSource);
            const suggestions = [];

            const consider = set => {
                if (!set || !Array.isArray(set.moves) || set.moves.length !== 4) return false;
                if (sampleSetIdeaIsTooSimilar(set, suggestions)) return false;
                suggestions.push(set);
                return true;
            };

            // Parametric sets (e.g. Iron Defense + Body Press) are first-class ideas,
            // but they do not automatically crowd out unrelated roles anymore.
            consider(generateParametricSampleSet(profile, seed ^ 0x9e3779b9));

            // Walk the entire role ranking. We intentionally do not stop after three
            // attempts: several top-scoring roles can collapse to the same four moves.
            // Only genuinely distinct ideas are kept, so returning 1–3 is preferable to
            // showing three copies of the same set with different labels.
            rankedRoles.forEach((role, roleIndex) => {
                if (suggestions.length >= 3) return;
                const moves = samplePickMoves(profile, role, seed + Math.imul(roleIndex + 1, 2654435761));
                if (moves.length !== 4) return;
                const { evs, nature } = sampleChooseNatureEVs(profile, role);
                const ability = sampleChooseAbility(profile, role, moves);
                consider({
                    name: sampleRoleLabel(role),
                    role: sampleRoleLabel(role),
                    item: sampleChooseItem(profile, role, moves, ability),
                    ability,
                    nature,
                    evs,
                    ivs: { hp:31, atk:31, def:31, spa:31, spd:31, spe:31 },
                    moves: moves.map(m => m.name),
                    teraType: sampleChooseTera(profile, role, moves),
                    level: 100
                });
            });

            return suggestions.slice(0, 3);
        }
        function openSampleSetModal() {
            const modal = document.getElementById('sample-set-modal');
            if (!modal) return;
            renderSuggestedSampleSets();
            modal.classList.add('active');
            loadCompetitiveMoveUsefulness().then(() => {
                if (modal.classList.contains('active')) renderSuggestedSampleSets();
            });
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
            catch (err) { console.error('[Sample Sets] generator error:', err); }
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
                        const slug = value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
                        icon.src = 'https://play.pokemonshowdown.com/sprites/itemicons/' + slug + '.png';
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

        
// ==================== SAMPLE SET AUTOCOMPLETE ====================
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
            renderDropdown(dropdown, matches, (item) => {
                const input = dropdown.previousElementSibling;
                input.value = item.name;
                updateSampleSetItem(setIndex, item.name);
                dropdown.classList.remove('active');
            }, false);
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
            // Name @ Item
            if (set.item) lines.push(`${name} @ ${set.item}`);
            else lines.push(name);
            // Ability
            if (set.ability) lines.push(`Ability: ${set.ability}`);
            // Level (Showdown omits this line entirely at the default of 100)
            if (set.level && set.level !== 100) lines.push(`Level: ${set.level}`);
            // Tera Type
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
            // Nature
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
            // Moves
            set.moves.forEach(m => { if (m) lines.push(`- ${m}`); });
            return lines.join('\n');
        }
                
// ==================== STAT CALCULATION ====================
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

        // Heuristic EV spread guesser, in the spirit of Smogon's "sample set" spreads:
        // pick the stronger attacking stat, decide whether this is a speed-based or
        // bulky-based set from the Fakemon's base Speed, then dump EVs accordingly.
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

            // Figure out whether this set leans physical or special. Prefer looking at
            // the actual moves chosen (ignoring Status moves); fall back to comparing
            // base Atk vs base SpA if no damaging moves are set yet.
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

            // Speedy attackers invest in Speed; slow/bulky ones dump the rest into HP.
            const isFast = base.spe >= 90;
            const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
            evs[offStat] = 252;
            if (isFast) {
                evs.spe = 252;
                evs.hp = 4;
            } else {
                evs.hp = 252;
                // Put the last 4 EVs in whichever defensive stat is weaker.
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
                    // Toggle off - set to neutral
                    newUp = statKey; newDown = statKey;
                } else {
                    newUp = statKey;
                    // Keep current down if it's different
                    if (newDown === statKey) newDown = current.down;
                }
            } else {
                if (current.down === statKey) {
                    // Toggle off - set to neutral
                    newUp = statKey; newDown = statKey;
                } else {
                    newDown = statKey;
                    // Keep current up if it's different
                    if (newUp === statKey) newUp = current.up;
                }
            }

            const newNature = findNatureByBoosts(newUp, newDown);
            set.nature = newNature;

            // Update nature select without full re-render
            const card = document.querySelector(`.sample-set-card[data-set-index="${setIndex}"]`);
            if (card) {
                const natureSelect = card.querySelector('.sample-set-field select');
                // Find the nature select (it's the one with nature options)
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

                // Update row class for styling
                const row = document.getElementById(`set-${setIndex}-stat-${key}`).closest('.sample-set-stat-row');
                if (row) {
                    row.classList.remove('stat-boosted', 'stat-reduced');
                    if (isBoosted) row.classList.add('stat-boosted');
                    if (isReduced) row.classList.add('stat-reduced');
                }

                // Update + / - button states
                const plusBtn = row.querySelector('.nature-plus');
                const minusBtn = row.querySelector('.nature-minus');
                if (plusBtn) plusBtn.classList.toggle('active', isBoosted);
                if (minusBtn) minusBtn.classList.toggle('active', isReduced);
            });

            // Update export text
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
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
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
            // Double rAF so the initial (pre-.active) state paints first, guaranteeing
            // the transition actually runs instead of jumping straight to the end state.
            requestAnimationFrame(() => requestAnimationFrame(() => {
                overlay.classList.add('active');
                popup.classList.add('active');
            }));
        }

        

export { updateSampleSet, updateSampleSetItem, hideSampleSetDropdownDelayed, filterSampleSetItem, filterSampleSetMove, removeSampleSet, copySampleSet, copySampleSetText, generateShowdownExport, openSampleSetModal, closeSampleSetModal, addBlankSampleSet, addSampleSet, applySuggestedSampleSet, renderSuggestedSampleSets, getNatureBoostLabel, calcStat, getAllAbilities, updateSampleSetEV, guessEVSpread, setNatureBoost, renderNatureStats, updateStatDisplay, renderSampleSets, showDetailPopup, sampleMoveIsActuallyUseful };
