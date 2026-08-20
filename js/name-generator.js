// ==================== fakemon name generator v4 ====================
// Pokémon/Fakemon-style name generator.
//
// Philosophy:
//   1. Keep the semantic roots from the user's traits.
//   2. Turn those roots into short, name-friendly stems.
//   3. Build names by overlapping, trimming, and gently mutating stems.
//   4. Generate many candidates, then score them for memorability,
//      pronunciation, semantic relevance, and a natural creature-name feel.
//
// Public API is intentionally unchanged:
//   generateFakemonName(traits, seed)
//   generateFakemonNames(traits, count, seed)

const TYPE_CONCEPTS = {
    Normal:   ['normal','basic','plain','feral','common'],
    Fire:     ['fire','flame','flare','ember','blaze','cinder','scorch'],
    Water:    ['water','aqua','wave','tide','river','rain','mist'],
    Electric: ['electric','volt','spark','static','jolt','charge','surge'],
    Grass:    ['grass','flora','leaf','vine','bloom','root','sprout'],
    Ice:      ['ice','frost','frozen','rime','snow','chill','glacier'],
    Fighting: ['fight','martial','brawn','karate','combat','punch'],
    Poison:   ['poison','toxic','venom','noxious','bane','sludge'],
    Ground:   ['ground','earth','terra','dust','clay','sand','dune'],
    Flying:   ['flying','air','sky','wing','feather','gale','gust'],
    Psychic:  ['psychic','mind','mental','dream','oracle','mystic'],
    Bug:      ['bug','insect','beetle','swarm','shell','wing'],
    Rock:     ['rock','stone','crag','pebble','shale','boulder'],
    Ghost:    ['ghost','spirit','specter','wraith','shade','haunt'],
    Dragon:   ['dragon','drake','wyrm','scale','claw','saur'],
    Dark:     ['dark','shadow','night','dusk','gloom','shade'],
    Steel:    ['steel','metal','iron','alloy','chrome','armor'],
    Fairy:    ['fairy','fae','magic','glimmer','pixie','charm']
};

const CREATURE_CONCEPTS = {
    mole: ['mole','burrow','tunnel','digger'],
    beetle: ['beetle','scarab','shell','carapace'],
    fox: ['fox','vulpine','vulp','tail','clever'],
    wolf: ['wolf','fang','howl','lupine'],
    bird: ['bird','avian','wing','feather','plume'],
    owl: ['owl','hoot','nightbird','wise'],
    snake: ['snake','serpent','coil','viper'],
    dragon: ['dragon','drake','wyrm','scale'],
    frog: ['frog','croak','pond','hopper'],
    turtle: ['turtle','shell','tortoise'],
    crab: ['crab','claw','pincer','shell'],
    bat: ['bat','wing','nocturnal','echo'],
    cat: ['cat','feline','purr','whisker'],
    bear: ['bear','claw','ursa','grizzly'],
    deer: ['deer','antler','fawn','hart'],
    fish: ['fish','fin','scale','gill'],
    spider: ['spider','web','silk','arachnid'],
    jellyfish: ['jellyfish','jelly','medusa','tentacle'],
    plant: ['plant','sprout','leaf','flora'],
    tree: ['tree','bark','root','grove'],
    flower: ['flower','petal','bloom','flora'],
    lizard: ['lizard','gecko','scale','saurian'],
    horse: ['horse','mane','hoof','gallop'],
    rabbit: ['rabbit','hare','hop','bunny'],
    mouse: ['mouse','mice','whisker','squeak'],
    monkey: ['monkey','ape','chimp','primate'],
    shark: ['shark','fin','jaw','reef'],
    octopus: ['octopus','tentacle','ink','cephalopod'],
    ghost: ['ghost','spirit','specter','shade'],
    robot: ['robot','machine','servo','gear'],
    dinosaur: ['dinosaur','raptor','rex','saur'],
    penguin: ['penguin','floe','icebird','waddle'],
    moth: ['moth','wing','dust','cocoon'],
    ant: ['ant','colony','formic','worker'],
    slug: ['slug','slime','mucus','mollusk'],
    worm: ['worm','burrow','wriggle','earthworm'],
    stone: ['stone','rock','crag','pebble'],
    metal: ['metal','iron','steel','alloy'],
    star: ['star','stellar','astral','nova'],
    moon: ['moon','lunar','crescent','night'],
    cloud: ['cloud','mist','vapor','cirrus'],
    key: ['key','lock','ward','unlock'],
    clock: ['clock','time','chrono','tick']
};

const THEME_CONCEPTS = {
    ancient: ['ancient','relic','fossil','elder','ruin'],
    royal: ['royal','regal','crown','noble','king'],
    mystic: ['mystic','arcane','rune','oracle','magic'],
    tech: ['tech','circuit','machine','digital','gear'],
    seasonal: ['season','spring','summer','autumn','winter'],
    ocean: ['ocean','abyss','coral','reef','tide'],
    forest: ['forest','grove','thicket','woodland','glade'],
    desert: ['desert','dune','mirage','arid','sand'],
    volcanic: ['volcano','magma','lava','caldera','ash'],
    celestial: ['celestial','star','nova','orbit','cosmic'],
    toxic: ['toxic','venom','sludge','acid','poison'],
    holy: ['holy','halo','divine','seraph','sacred'],
    feral: ['feral','wild','savage','beast','primal']
};

const ABILITY_HINTS = {
    infiltrator: ['infiltrate','slip','breach','shadow'],
    burrow: ['burrow','tunnel','dig','earth'],
    sand: ['sand','dune','grit'],
    veil: ['veil','shroud','mist','cover'],
    swift: ['swift','speed','dash','quick'],
    guard: ['guard','ward','shield','protect'],
    armor: ['armor','shell','plate','iron'],
    regenerator: ['renew','heal','mend','restore'],
    intimidate: ['intimidate','snarl','fear','fang'],
    levitate: ['float','drift','hover','air'],
    drought: ['drought','sun','scorch','dry'],
    drizzle: ['rain','drizzle','drop','mist'],
    static: ['static','spark','jolt','electric'],
    poison: ['poison','venom','toxic'],
    flame: ['flame','fire','ember','blaze'],
    frost: ['frost','ice','chill','rime'],
    stone: ['stone','rock','crag'],
    iron: ['iron','steel','metal'],
    ore: ['ore','mine','vein'],
    tunnel: ['tunnel','burrow','dig'],
    mole: ['mole','burrow','digger'],
    beetle: ['beetle','scarab','shell']
};

const GENERIC_CONCEPTS = ['mystery','spark','bloom','whisker','ember','ripple','shadow','gleam','puff','crackle','flutter','thrum'];

// Onomatopoeic roots give us a second naming style: names that feel like the
// sound, movement, cry, or impact associated with the creature.
const SOUND_BY_TYPE = {
    Normal: ['puff','huff','sniff','snort','thump','clop','chirp'],
    Fire: ['fwoosh','roar','boom','crackle','sizzle','fizz','whoom'],
    Water: ['splash','splish','plop','drip','gurgle','swish','sploosh'],
    Electric: ['zap','bzzt','buzz','jolt','crack','snap','whirr'],
    Grass: ['rustle','swish','crunch','snap','flutter','sway','sigh'],
    Ice: ['crack','crick','tinkle','chime','crunch','snap','shiver'],
    Fighting: ['bam','wham','pow','thump','smack','slam','thud'],
    Poison: ['hiss','sizzle','drip','glug','gloop','slurp','blorp'],
    Ground: ['thud','thump','rumble','crunch','stomp','clomp','crack'],
    Flying: ['whoosh','whizz','flap','flutter','swoop','swish','whirr'],
    Psychic: ['hum','hmm','chime','ting','pulse','whoom','hush'],
    Bug: ['buzz','bzz','click','chitter','scritch','whirr','drone'],
    Rock: ['clack','clunk','crack','thud','rumble','grind','knock'],
    Ghost: ['whoo','wail','hush','creak','rattle','moan','whisper'],
    Dragon: ['roar','growl','rumble','thrum','boom','bellow','snarl'],
    Dark: ['hush','whisper','rustle','growl','snarl','click','creak'],
    Steel: ['clang','clank','clink','ting','whirr','grind','thunk'],
    Fairy: ['tinkle','ding','chime','giggle','puff','flutter','ting']
};

const SOUND_BY_CREATURE = {
    fox: ['yip','yap','yelp','huff','sniff','chuff'],
    wolf: ['howl','awoo','growl','grr','snarl','huff'],
    dog: ['woof','bark','ruff','yap','yip','arf'],
    cat: ['mew','meow','mrow','purr','hiss','mrrp'],
    bird: ['chirp','tweet','cheep','trill','flap','caw'],
    owl: ['hoot','whoo','hoo','hush','flutter'],
    snake: ['hiss','ssst','rattle','shh'],
    frog: ['croak','ribbit','plop','plip','glug','burble'],
    beetle: ['buzz','bzz','click','clack','whirr','scritch'],
    bee: ['buzz','bzz','hum','drone','whirr'],
    butterfly: ['flutter','flit','flap','fuff'],
    moth: ['flutter','flap','buzz','whirr'],
    spider: ['click','scritch','skritch','scuttle'],
    mouse: ['squeak','peep','sniff','chitter','scurry'],
    rabbit: ['thump','sniff','snuffle','squeak','scritch'],
    bear: ['growl','grr','huff','snort','grunt','thump'],
    horse: ['neigh','whinny','snort','clop','gallop'],
    cow: ['moo','huff','clop','bell'],
    pig: ['oink','snort','grunt','squeal'],
    duck: ['quack','waddle','splash','flap'],
    goose: ['honk','hiss','flap','splash'],
    monkey: ['chatter','chitter','whoop','ooh','aah'],
    lion: ['roar','growl','snarl','thump'],
    tiger: ['growl','roar','snarl','pounce'],
    shark: ['chomp','splash','swish','snap','thrash'],
    fish: ['blub','blup','splash','swish','glub'],
    dolphin: ['click','chirp','splash','whistle'],
    whale: ['song','boom','splash','spout'],
    octopus: ['squelch','squish','slurp','plop','splash'],
    turtle: ['thump','clunk','scrape','plod'],
    crab: ['clack','click','snap','scritch'],
    bat: ['squeak','chirp','flutter','whirr'],
    lizard: ['click','chirp','hiss','scritch'],
    penguin: ['honk','chirp','splash','waddle'],
    slug: ['slurp','squelch','squish','plop'],
    worm: ['wriggle','squish','slurp','scritch'],
    robot: ['beep','boop','click','whirr','bzzt'],
    clock: ['tick','tock','ding','dong','chime'],
    key: ['click','clink','jingle','chink'],
    bell: ['ding','dong','chime','tinkle'],
    crystal: ['ting','chime','clink','tinkle'],
    volcano: ['boom','rumble','fwoosh','crackle'],
    thunder: ['boom','rumble','crack','roar'],
    cloud: ['puff','poof','whoosh','fluff'],
    flower: ['flutter','puff','sway','rustle'],
    tree: ['creak','crack','rustle','groan'],
    mushroom: ['puff','pop','plop','poof'],
    cactus: ['prick','snap','pop','crunch'],
    rocket: ['whoosh','zoom','blast','vroom'],
    train: ['choo','chug','clack','toot'],
    car: ['vroom','beep','honk','zoom'],
    machine: ['whirr','clank','beep','click']
};

const SOUND_BY_THEME = {
    ancient: ['rumble','creak','crack','thrum','boom'],
    royal: ['chime','ding','fanfare','clang','tada'],
    mystic: ['hush','hum','chime','ting','whoom'],
    tech: ['beep','boop','click','whirr','ping','bzzt'],
    seasonal: ['rustle','crunch','drip','pitter','flutter'],
    ocean: ['splash','whoosh','swish','gurgle','plip'],
    forest: ['rustle','crunch','creak','chirp','thump'],
    desert: ['whoosh','whistle','scrape','crunch','hiss'],
    volcanic: ['boom','rumble','fwoosh','sizzle','crack'],
    celestial: ['ping','chime','ting','hum','twinkle'],
    toxic: ['hiss','sizzle','glug','gloop','drip'],
    holy: ['chime','ding','hush','ting','hum'],
    feral: ['growl','snarl','roar','huff','thump']
};

// Extra creature/theme vocabulary expands semantic coverage without changing
// the existing input contract. These roots are intentionally short and
// name-friendly rather than full dictionary words.
const EXTRA_CREATURE_CONCEPTS = {
    dog: ['hound','pup','bark','woof'], lion: ['lion','mane','roar','pride'],
    tiger: ['tiger','stripe','pounce','fang'], bear: ['bear','ursa','claw','grizz'],
    bee: ['bee','honey','hive','buzz'], butterfly: ['butter','flutter','wing','flit'],
    dolphin: ['dolphin','click','echo','fin'], whale: ['whale','song','echo','spout'],
    mushroom: ['mushroom','spore','cap','puff'], cactus: ['cactus','spine','prick','dry'],
    crystal: ['crystal','prism','gem','glint'], volcano: ['volcano','magma','lava','ash'],
    thunder: ['thunder','storm','rumble','bolt'], rocket: ['rocket','blast','boost','zoom'],
    train: ['train','engine','rail','chug'], car: ['car','motor','wheel','vroom'],
    bell: ['bell','chime','ring','gong'], music: ['music','note','melody','rhythm'],
    drum: ['drum','beat','thump','boom'], sword: ['sword','blade','slash','clang'],
    hammer: ['hammer','bonk','smash','thunk'], shield: ['shield','guard','clang','thunk'],
    mirror: ['mirror','reflect','glint','shimmer'], shadow: ['shadow','shade','hush','stalk']
};

// Small name-friendly transformations. These are deliberately conservative:
// the goal is to preserve recognizable roots instead of producing random noise.
const SOUND_SWAPS = [
    ['ph','f'], ['ck','k'], ['qu','kw'], ['x','ks'], ['c','k'],
    ['ee','i'], ['oo','u'], ['ou','o'], ['ae','a'], ['ie','i']
];

const STARTS = ['', 'a', 'e', 'i', 'o', 'u'];
const ENDINGS = ['', 'a', 'i', 'o', 'y', 'on', 'en', 'in', 'el', 'er', 'is', 'ia', 'o'];

const VOWELS = 'aeiou';
const isVowel = ch => VOWELS.includes(String(ch).toLowerCase());

function cap(word) {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function pick(arr, rng) {
    return arr[Math.floor(rng() * arr.length)];
}

function makeRng(seed) {
    if (seed == null) return Math.random;
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function normalizeRoot(root) {
    let s = String(root || '').toLowerCase().replace(/[^a-z]/g, '');
    for (const [from, to] of SOUND_SWAPS) s = s.replace(new RegExp(from, 'g'), to);
    return s;
}

function stem(root, rng) {
    let s = normalizeRoot(root);
    if (!s) return '';

    // Remove overly dictionary-like tails while retaining the recognizable core.
    s = s.replace(/(ing|ed|ly|ness|ous|ful|tion|ment)$/i, '');

    // Prefer a compact 2–6 letter stem. Cut after a vowel when possible.
    if (s.length > 6) {
        const limit = rng() < 0.65 ? 5 : 6;
        let cut = -1;
        for (let i = limit; i >= 3; i--) {
            if (isVowel(s[i - 1])) { cut = i; break; }
        }
        s = s.slice(0, cut > 0 ? cut : limit);
    }

    // Avoid harsh leading/trailing clusters.
    s = s.replace(/^[^aeiou]{3,}/, m => m.slice(-2));
    s = s.replace(/[^aeiou]{3,}$/i, m => m.slice(0, 2));
    return s;
}

function conceptsForType(type) {
    return TYPE_CONCEPTS[type] || [];
}

function conceptsForFreeText(text, bank) {
    if (!text) return [];
    const lower = String(text).toLowerCase();
    const hits = [];
    for (const key of Object.keys(bank)) {
        if (lower.includes(key)) hits.push(...bank[key]);
    }
    return hits;
}

function gatherConcepts(traits) {
    const pools = [];
    const soundPools = [];
    const t1 = conceptsForType(traits.type1);
    const t2 = conceptsForType(traits.type2);
    if (t1.length) pools.push(t1);
    if (t2.length) pools.push(t2);

    const freeText = [traits.species, traits.theme, traits.notes].filter(Boolean).join(' ');
    const creatureBank = { ...CREATURE_CONCEPTS, ...EXTRA_CREATURE_CONCEPTS };
    const creature = conceptsForFreeText(freeText, creatureBank);
    const theme = conceptsForFreeText(freeText, THEME_CONCEPTS);
    const ability = conceptsForFreeText(traits.ability || '', ABILITY_HINTS);
    if (creature.length) pools.push(creature);
    if (theme.length) pools.push(theme);
    if (ability.length) pools.push(ability);
    if (!pools.length) pools.push(GENERIC_CONCEPTS);

    if (SOUND_BY_TYPE[traits.type1]) soundPools.push(SOUND_BY_TYPE[traits.type1]);
    if (SOUND_BY_TYPE[traits.type2]) soundPools.push(SOUND_BY_TYPE[traits.type2]);
    const lower = freeText.toLowerCase();
    for (const key of Object.keys(SOUND_BY_CREATURE)) {
        if (lower.includes(key)) soundPools.push(SOUND_BY_CREATURE[key]);
    }
    for (const key of Object.keys(SOUND_BY_THEME)) {
        if (lower.includes(key)) soundPools.push(SOUND_BY_THEME[key]);
    }
    if (!soundPools.length) soundPools.push(['puff','pop','buzz','whoosh','chime','thump','chirp','crackle']);
    return { pools, soundPools };
}

function flattenWeightedConcepts(pools, rng) {
    // One or two roots are enough. Three roots often makes a name feel stuffed.
    const unique = [];
    const seen = new Set();
    for (const pool of pools) {
        for (const root of pool) {
            const s = normalizeRoot(root);
            if (s && !seen.has(s)) {
                seen.add(s);
                unique.push({ root: s, pool });
            }
        }
    }
    return unique;
}

function trimForBlend(s, max) {
    if (s.length <= max) return s;
    for (let i = max; i >= 3; i--) {
        if (isVowel(s[i - 1])) return s.slice(0, i);
    }
    return s.slice(0, max);
}

function blendRoots(a, b, rng) {
    if (!a) return b;
    if (!b) return a;

    // Exact overlap: flare + flare should not become flareflare.
    if (a === b) return a;

    // Find the longest shared suffix/prefix, but only accept meaningful overlap.
    let best = 0;
    const max = Math.min(3, a.length, b.length);
    for (let n = max; n >= 1; n--) {
        if (a.slice(-n) === b.slice(0, n)) {
            best = n;
            break;
        }
    }
    if (best > 0) return a + b.slice(best);

    const av = isVowel(a.at(-1));
    const bv = isVowel(b[0]);

    if (av && bv) {
        // Usually retain the first vowel and start the second root at its next consonant.
        let j = 0;
        while (j < b.length && isVowel(b[j])) j++;
        if (j > 0 && j < b.length && rng() < 0.8) return a + b.slice(j);
    }

    if (!av && !bv) {
        // If both seams are hard, keep only one consonant from the second root.
        if (a.length >= 3 && b.length >= 3 && rng() < 0.8) {
            return a + b.slice(1);
        }
    }

    return a + b;
}

function mutateName(name, rng) {
    let s = name.toLowerCase();

    // Gentle vowel variation — never wholesale random syllable replacement.
    if (rng() < 0.22) {
        const vowelMap = { a: ['a','e'], e: ['e','i'], i: ['i','e'], o: ['o','u'], u: ['u','o'] };
        const chars = s.split('');
        const positions = chars.map((c, i) => isVowel(c) ? i : -1).filter(i => i >= 0);
        if (positions.length) {
            const pos = pick(positions, rng);
            chars[pos] = pick(vowelMap[chars[pos]], rng);
            s = chars.join('');
        }
    }

    // Rarely soften a hard internal consonant.
    if (rng() < 0.14) {
        s = s.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/qu/g, 'kw');
    }

    return s;
}

function addEnding(name, rng) {
    if (name.length >= 9 || rng() >= 0.28) return name;
    if (/[aeiou]$/.test(name)) return name;
    const ending = pick(ENDINGS, rng);
    return ending ? name + ending : name;
}

function syllableCount(name) {
    const groups = name.toLowerCase().match(/[aeiouy]+/g);
    return groups ? groups.length : 0;
}

function hasAwkwardCluster(word) {
    const s = word.toLowerCase();
    if (/(.)\1\1/.test(s)) return true;
    if (/[bcdfghjklmnpqrstvwxyz]{4}/.test(s)) return true;
    if (/[aeiou]{3}/.test(s)) return true;
    if (/^([^aeiou]{3,})/.test(s) || /([^aeiou]{3,})$/.test(s)) return true;
    return false;
}

const BANNED_SUBSTRINGS = [
    'sex','cum','fuk','fuc','ass','anal','dik','nazi','kkk'
];

function isReasonableName(name) {
    if (!name || name.length < 4 || name.length > 12) return false;
    if (!/^[A-Za-z]+$/.test(name)) return false;
    if (hasAwkwardCluster(name)) return false;
    const lower = name.toLowerCase();
    if (BANNED_SUBSTRINGS.some(s => lower.includes(s))) return false;

    const vowels = (lower.match(/[aeiou]/g) || []).length;
    if (!vowels || vowels / lower.length < 0.27) return false;

    const syllables = syllableCount(lower);
    if (syllables < 2 || syllables > 4) return false;
    return true;
}

function scoreName(name, roots, traits) {
    const s = name.toLowerCase();
    let score = 0;
    const syllables = syllableCount(s);

    // Strong preference for the classic compact 2–3 syllable zone.
    if (syllables === 2) score += 30;
    else if (syllables === 3) score += 34;
    else if (syllables === 4) score += 10;

    if (s.length >= 5 && s.length <= 9) score += 20;
    else if (s.length <= 11) score += 8;

    // Vowel rhythm: alternating consonant/vowel patterns are easy to say.
    let transitions = 0;
    for (let i = 1; i < s.length; i++) {
        if (isVowel(s[i]) !== isVowel(s[i - 1])) transitions++;
    }
    score += Math.min(18, transitions * 3);

    // Reward useful pieces of the actual concepts. This keeps the name anchored.
    for (const root of roots) {
        if (root.length >= 3 && s.includes(root.slice(0, Math.min(4, root.length)))) score += 18;
        else if (root.length >= 3 && s.includes(root.slice(0, 3))) score += 10;
    }

    // Avoid names that are too literal / dictionary-like.
    const dictionaryish = ['water','fire','grass','stone','shadow','dragon','rabbit','metal','ghost','bird','flower'];
    if (dictionaryish.includes(s)) score -= 50;

    // Penalize repetitive vowels and overly symmetrical shapes.
    if (/(.)\1/.test(s)) score -= 6;
    if (/^(.{2,4})\1$/.test(s)) score -= 15;

    // Mild preference for a pleasant final vowel or sonorant.
    if (/[aeiowy]$/.test(s)) score += 8;
    if (/[lrnm]$/.test(s)) score += 4;

    // Penalize long runs of identical sound families.
    if (/^[aeiou]/.test(s)) score += 2;
    if (/[^aeiou]{3}/.test(s)) score -= 10;

    return score;
}

const SOUND_STEMS = {
    puff: ['puf','puff','pofa'], pop: ['pop','poka','popp'],
    boom: ['bom','boma','bomu','boom'], bam: ['bam','bama','bamm'],
    wham: ['wam','wama','wham'], pow: ['pau','powa','pow'],
    thump: ['thum','tump','thuma'], thud: ['thud','tuda','tud'],
    slam: ['slam','sela','slama'], smack: ['smak','sma','smaka'],
    crack: ['krak','crak','kraa'], crackle: ['krak','kraka','krakl'],
    fwoosh: ['fwo','fuw','fwoa'], whoom: ['wum','woma','whoa'],
    roar: ['ror','roa','rora'], growl: ['grau','graw','goru'],
    snarl: ['snar','snera','snara'], bellow: ['belo','bela'],
    sizzle: ['siz','siza','sizo'], fizz: ['fiz','fiza','fizo'],
    hiss: ['his','hisa','hisu'], psst: ['pisa','pist'],
    splash: ['spla','spla','spla'], splish: ['splis','spli'],
    plop: ['plop','plopa','plupi'], plip: ['plip','plipa'],
    drip: ['drip','dripa','dripi'], gurgle: ['gurg','gura','gurgi'],
    glug: ['glug','gulu','gluga'], gloop: ['glup','glopa','glupi'],
    slurp: ['slur','suru','slupa'], squelch: ['skel','skela','squel'],
    squish: ['skwi','squi','suka'], swish: ['swis','swi','suwa'],
    whoosh: ['wush','woshi','wusha'], swoosh: ['swu','swoshi','swoa'],
    whizz: ['wiz','wiza','wizu'], whirr: ['wir','wira','wiro'],
    flutter: ['flut','fluta','fluri'], flap: ['flap','flapa','fla'],
    buzz: ['buz','buza','bizo'], bzz: ['buz','bzi','bzua'],
    click: ['klik','kli','clika'], clack: ['klak','claka','kli'],
    clang: ['klang','klana','clang'], clank: ['klank','klana','clanka'],
    clink: ['klim','klink','clina'], clunk: ['klun','klunka','clu'],
    thunk: ['thun','thunka','tuno'], rumble: ['rum','ruma','rumbu'],
    thrum: ['thru','thrum','truma'], grind: ['grin','grinda','grida'],
    crunch: ['krun','kruncha','cruna'], rustle: ['rus','rusta','rusi'],
    chirp: ['chir','chiri','chiru'], tweet: ['twi','twiya','twet'],
    cheep: ['chip','chipi','chepa'], trill: ['tril','trila','trilli'],
    hoot: ['hut','huta','huti'], whoo: ['wu','wua','who'],
    croak: ['kro','kroa','kroki'], ribbit: ['ribi','riba','ribi'],
    squeak: ['sque','skwi','squi'], peep: ['pip','pipa','pepi'],
    yip: ['yip','yipa','yipi'], yap: ['yap','yapa','yapi'],
    yelp: ['yel','yela','yelpi'], bark: ['bar','bara','barka'],
    woof: ['wuf','wufa','wufi'], purr: ['pur','pura','puri'],
    meow: ['mya','miau','mewo'], mrow: ['mro','mra','mru'],
    howl: ['hau','howa','horo'], awoo: ['awu','awoa','awo'],
    snort: ['snor','snora','snorti'], huff: ['huf','hufa','hufi'],
    chuff: ['chuf','chufa','chufi'], grunt: ['grun','gruna','grunti'],
    clop: ['klop','clopa','clopi'], stomp: ['stom','stoma','stompi'],
    clomp: ['klom','kloma','clompi'], scrape: ['skrap','skra','skre'],
    scritch: ['skrit','skri','skrita'], skritch: ['skrit','skri','skrita'],
    chitter: ['chit','chita','chiri'], chatter: ['chat','chata','chatter'],
    beep: ['bip','bipa','bepo'], boop: ['bup','bopa','bupo'],
    blip: ['blip','blipa','blipi'], blop: ['blop','blopa','blopi'],
    bloop: ['blup','blupa','blupi'], ping: ['pin','pinga','pini'],
    pong: ['pon','ponga','pongi'], ding: ['din','dinga','dini'],
    dong: ['don','donga','dongi'], chime: ['chim','chima','chimi'],
    tinkle: ['tink','tinka','tiki'], ting: ['tin','tinga','tini'],
    hum: ['hum','huma','humi'], hush: ['hus','husa','hushi'],
    whisper: ['wis','wisha','wisp'], creak: ['krek','kreka','krei'],
    rattle: ['rat','rata','ratt'], jingle: ['jin','jinga','jini'],
    chomp: ['chom','choma','chump'], munch: ['mun','muna','muncha'],
    gnaw: ['na','nawa','nau'], nom: ['nom','noma','nomo'],
    vroom: ['vru','vroma','vrom'], zoom: ['zum','zuma','zumi'],
    choo: ['chu','chua','chuno'], chug: ['chug','chuga','chugi'],
    honk: ['hon','honka','honki'], toot: ['tut','tuta','toti'],
    zap: ['zap','zapa','zapi'], jolt: ['jol','jola','jolti'],
    snap: ['snap','sna','snapa'], zing: ['zin','zinga','zini'],
    glint: ['glin','glinta','glimi'], twinkle: ['twin','twina','twili']
};

function soundStem(root, rng) {
    const key = normalizeRoot(root);
    const variants = SOUND_STEMS[key];
    if (variants?.length) return pick(variants, rng);
    let s = key;
    if (!s) return '';
    if (s.length > 5) s = trimForBlend(s, 5);
    return s;
}

function buildSoundCandidate(soundPools, conceptPools, rng) {
    const sounds = flattenWeightedConcepts(soundPools, rng);
    const concepts = flattenWeightedConcepts(conceptPools, rng);
    if (!sounds.length) return null;

    const rawSound = pick(sounds, rng).root;
    const sound = soundStem(rawSound, rng);
    if (!sound) return null;

    let result = sound;
    let roots = [sound];
    if (concepts.length && rng() < 0.82) {
        const concept = stem(pick(concepts, rng).root, rng);
        if (concept) {
            const short = trimForBlend(concept, 3);
            // Prefer sound + concept because it preserves the audible hook.
            result = rng() < 0.68
                ? blendRoots(sound, short, rng)
                : blendRoots(short, sound, rng);
            roots.push(concept);
        }
    }

    // Give a sound-root a small species-name ending instead of leaving it as
    // a dictionary sound word (e.g. Buzz -> Buzza, Zap -> Zapi).
    if (result.length < 8 && rng() < 0.55 && !/[aeiou]$/.test(result)) {
        result = blendRoots(result, pick(['a','i','o','u','on','en'], rng), rng);
    }
    result = mutateName(result, rng);
    if (result.length > 10) result = trimForBlend(result, 10);
    return { name: cap(result), roots, sound: true };
}

function buildCandidate(pools, rng) {
    const all = flattenWeightedConcepts(pools, rng);
    if (!all.length) return null;

    const first = pick(all, rng).root;
    let second = pick(all, rng).root;
    let guard = 0;
    while (second === first && guard++ < 5) second = pick(all, rng).root;

    let a = stem(first, rng);
    let b = stem(second, rng);
    if (!a || !b) return null;

    a = trimForBlend(a, rng() < 0.7 ? 5 : 6);
    b = trimForBlend(b, rng() < 0.75 ? 4 : 5);

    // Roughly one in five names uses a single especially good root.
    let result;
    if (rng() < 0.18) {
        result = a;
        if (result.length < 5) result = blendRoots(a, b.slice(0, 2), rng);
    } else {
        result = blendRoots(a, b, rng);
    }

    result = addEnding(result, rng);
    result = mutateName(result, rng);

    // Very occasionally add a tiny vowel onset to avoid a harsh start.
    if (/^[^aeiou]{2}/.test(result) && rng() < 0.35) {
        result = pick(STARTS.slice(1), rng) + result;
    }

    if (result.length > 12) result = result.slice(0, 12);
    return { name: cap(result), roots: [a, b], sound: false };
}

function generateFakemonNames(traits = {}, count = 5, seed = null) {
    const rng = makeRng(seed);
    const { pools, soundPools } = gatherConcepts(traits);
    const existing = new Set((traits.existingNames || []).map(n => String(n).toLowerCase()));
    const candidates = [];
    const seen = new Set();
    const attempts = Math.max(220, count * 100);

    for (let i = 0; i < attempts; i++) {
        // Onomatopoeia is a subtle accent, not a primary naming style.
        // Keep most candidates rooted in the semantic Fakemon-name style.
        const candidate = rng() < 0.08
            ? buildSoundCandidate(soundPools, pools, rng)
            : buildCandidate(pools, rng);
        if (!candidate) continue;
        const name = candidate.name;
        const key = name.toLowerCase();
        if (!isReasonableName(name) || seen.has(key) || existing.has(key)) continue;

        seen.add(key);
        let score = scoreName(name, candidate.roots, traits) + rng() * 10;
        if (candidate.sound) {
            score += 2;
            // Reward sound-like spellings without allowing them to dominate.
            if (/^(ba|bo|bu|ca|chi|cho|cl|cr|dr|fl|gl|pl|pr|qu|sh|sk|sl|sn|sp|squ|sw|th|tr|wh|wo|za|zi)/i.test(name)) score += 1;
            if (/(.)\1/.test(key)) score += 1;
        }
        candidates.push({ name, score, sound: !!candidate.sound });
    }

    candidates.sort((a, b) => b.score - a.score);
    const results = [];
    let soundCount = 0;
    const targetSounds = count >= 5 ? 1 : 0;

    // If the best semantic candidates leave room, allow at most one subtle
    // sound-inspired name into a larger suggestion set.
    for (const candidate of candidates) {
        if (!candidate.sound || soundCount >= targetSounds) continue;
        const tooSimilar = results.some(existingName => {
            const e = existingName.toLowerCase();
            return candidate.name.toLowerCase().slice(0, 4) === e.slice(0, 4) || candidate.name.toLowerCase().slice(-3) === e.slice(-3);
        });
        if (tooSimilar) continue;
        results.push(candidate.name);
        soundCount++;
        if (results.length >= count) break;
    }

    for (const candidate of candidates) {
        if (results.includes(candidate.name)) continue;
        const s = candidate.name.toLowerCase();
        const tooSimilar = results.some(existingName => {
            const e = existingName.toLowerCase();
            return s.slice(0, 4) === e.slice(0, 4) || s.slice(-3) === e.slice(-3);
        });
        if (tooSimilar) continue;
        results.push(candidate.name);
        if (results.length >= count) break;
    }

    return results;
}

function generateFakemonName(traits = {}, seed = null) {
    return generateFakemonNames(traits, 1, seed)[0] || null;
}

export { generateFakemonName, generateFakemonNames };
