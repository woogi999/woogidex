import { log } from './log.js';
import { state } from './app.js';
import { sampleMoveIsActuallyUseful } from './sample-sets.js';
import { POKEMON_TYPES, TYPE_EFFECTIVENESS, STAT_NAMES } from './data.js';

const STAT_KEYS = ['hp','atk','def','spa','spd','spe'];
const GEN_MAX_DEX = {1:151,2:251,3:386,4:493,5:649,6:721,7:809,8:905,9:1025};
const GEN_FORMAT = {1:'gen1ou',2:'gen2ou',3:'gen3ou',4:'gen4ou',5:'gen5ou',6:'gen6ou',7:'gen7ou',8:'gen8ou',9:'gen9ou'};
let usageCache = {};
let usagePromise = {};
let tierDataCache = {};
let tierDataPromise = {};
let analysisTimer = null;
let analysisBusy = false;
let lastAnalysisKey = '';

const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
// Matchup cards previously built their own sprite URLs with a hardcoded
// 'gen5ani' directory and a crude id slug, so they never reacted to the
// "Use 2D sprites" setting and mishandled forme suffixes (e.g. Ogerpon
// masks). getPokemonTemplateSprite (pokedex.js) is the app's real sprite
// helper - it reads the actual toggle and slugs formes correctly - but it
// can't be imported directly here (pokedex.js -> app.js -> analysis.js
// would be circular). By the time any matchup card is rendered, app.js has
// already attached every module's exports to `window`, so calling it off
// `window` is safe and keeps this in sync with the rest of the app.
function matchupSpriteHtml(p){
  const id=String(p?.id||p?.name||'missingno').toLowerCase().replace(/[^a-z0-9-]+/g,'-');
  if(typeof window!=='undefined' && typeof window.getPokemonTemplateSprite==='function'){
    const url=window.getPokemonTemplateSprite(p);
    return `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='https://play.pokemonshowdown.com/sprites/gen5/${id}.png';">`;
  }
  const spriteDir=(typeof window!=='undefined' && typeof window.getUse2DSprites==='function' && window.getUse2DSprites()) ? 'gen5ani' : 'ani';
  return `<img src="https://play.pokemonshowdown.com/sprites/${spriteDir}/${id}.gif" alt="" loading="lazy" onerror="this.onerror=null;this.src='https://play.pokemonshowdown.com/sprites/gen5/${id}.png';">`;
}
const clamp=(n,a=0,b=100)=>Math.max(a,Math.min(b,n));
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const normalizeName=v=>String(v||'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]/g,'');

// TYPE_EFFECTIVENESS is keyed by exact capitalized type names ('Ground', not
// 'ground'/'GROUND'/'ground '). Move/species data pulled from external sources
// isn't guaranteed to match that casing exactly, and a raw TYPE_EFFECTIVENESS[x]
// lookup fails *silently* (returns undefined, which every caller then treats as
// a neutral 1x via `?? 1`) instead of throwing - so a casing mismatch doesn't
// error, it just quietly deletes every weakness/resistance/immunity from the
// analysis. Build a normalized lookup table once so every access is resilient
// to that regardless of source casing/whitespace.
const TYPE_KEY_LOOKUP=new Map(Object.keys(TYPE_EFFECTIVENESS).map(k=>[k.trim().toLowerCase(),k]));
function typeEffectivenessOf(attackType,defendType){
  const atkKey=TYPE_KEY_LOOKUP.get(String(attackType||'').trim().toLowerCase());
  if(!atkKey) return 1;
  const row=TYPE_EFFECTIVENESS[atkKey]||{};
  const defKey=TYPE_KEY_LOOKUP.get(String(defendType||'').trim().toLowerCase());
  if(!defKey) return 1;
  // A missing entry in a real row means "neutral" (1x) by chart convention -
  // this is the ONE legitimate place a fallback to 1 belongs, because here
  // both type names are already confirmed valid/normalized.
  const v=row[defKey];
  return Number.isFinite(v)?v:1;
}

function percentile(values,value){
  if(!values.length)return 50;
  let less=0,equal=0;
  for(const v of values){if(v<value)less++;else if(v===value)equal++;}
  return ((less+equal*.5)/values.length)*100;
}
function weightedPercentile(entries,value){
  const valid=(entries||[]).filter(x=>Number.isFinite(x.value)&&Number.isFinite(x.weight)&&x.weight>0);
  if(!valid.length)return null;
  const total=valid.reduce((a,x)=>a+x.weight,0);
  let less=0,equal=0;
  for(const x of valid){if(x.value<value)less+=x.weight;else if(x.value===value)equal+=x.weight;}
  return ((less+equal*.5)/total)*100;
}
function abilityNames(raw){
  if(Array.isArray(raw))return raw.map(x=>typeof x==='string'?x:x?.name).filter(Boolean);
  if(raw&&typeof raw==='object')return Object.values(raw).map(x=>typeof x==='string'?x:x?.name).filter(Boolean);
  return raw?[String(raw)]:[];
}
// Curated, deliberately conservative lists. This is not exhaustive competitive
// tiering of every ability - it exists so an obviously game-changing ability
// (Speed Boost, Huge Power, weather setters, etc.) nudges the score the same
// direction a real teambuilder would react, and an obviously crippling one
// (Truant, Slow Start, etc.) pulls it back down instead of being ignored.
// A small set of abilities are so competitively defining (format-warping, not
// just "good") that they deserve a tier above STRONG_ABILITIES rather than
// being bucketed alongside Intimidate/Regenerator. Wonder Guard, Neutralizing
// Gas, and Good As Gold were previously entirely absent from either list, so
// a Fakemon running one of them scored as if its ability were neutral.
const ELITE_ABILITIES=new Set([
  'Wonder Guard','Neutralizing Gas','Good As Gold','Magic Guard','Imposter',
  'Parental Bond','Water Bubble','Huge Power','Pure Power','Speed Boost'
]);
const STRONG_ABILITIES=new Set([
  'Drought','Drizzle','Sand Stream','Snow Warning',
  'Intimidate','Regenerator','Prankster','Magic Bounce','Levitate','Tough Claws','Adaptability',
  'Protean','Libero','Water Absorb','Volt Absorb','Flash Fire','Guts','Moxie','Sheer Force',
  'Technician','Unaware','Multiscale','Poison Heal','Contrary','Simple','Beast Boost',
  'Mold Breaker','Download','Grassy Surge','Electric Surge','Psychic Surge','Stakeout',
  'Serene Grace','Skill Link','Triage','Orichalcum Pulse','Desolate Land','Primordial Sea',
  'Tinted Lens','Sand Force','Solar Power'
]);
// Only abilities with a genuine, mechanical downside belong here (skipped turns,
// halved stats, forced disadvantage, etc.). Purely flavorful/situational abilities
// (Forecast, Pickup, Damp, Run Away, Honey Gather, Illuminate, Own Tempo, Justified,
// Anger Point, ...) are competitively "do nothing" rather than "actively bad", so
// they don't belong here - a mon running one of those isn't worse off than a mon
// with a genuinely neutral/unlisted ability.
const WEAK_ABILITIES=new Set([
  'Truant','Slow Start','Defeatist','Normalize','Klutz','Stall','Wimp Out','Emergency Exit'
]);
function abilityQuality(names){
  // Best-case ability chosen (competitively, a mon is built around its best ability).
  // Returns -1 (crippling), 0 (neutral/unknown), 1 (strong), or 2 (elite/format-
  // defining) plus which name mattered. Elite outranks strong outranks weak,
  // regardless of set order, so a mon with both an elite and a strong ability
  // is credited for the elite one.
  //
  // A weak ability only drags the score down when it's the mon's *only* option -
  // if it also has any other ability (even an unlisted/neutral one), a real
  // teambuilder just runs the other one and the weak ability is never chosen,
  // so it's ignored rather than penalized.
  let best={score:0,name:null};
  let weak=null;
  let allWeak=true;
  for(const n of names||[]){
    if(ELITE_ABILITIES.has(n) && best.score<2) best={score:2,name:n};
    else if(STRONG_ABILITIES.has(n) && best.score<1) best={score:1,name:n};
    else if(WEAK_ABILITIES.has(n)){ if(!weak) weak=n; }
    else allWeak=false;
  }
  if(best.score===0 && weak && allWeak) return {score:-1,name:weak};
  return best;
}
function uniqueDex(){
  const seen=new Set();
  return Object.values(state.sdPokedex||{}).filter(p=>{
    if(!p?.name||!p?.stats||!p?.types||!p.num||p.num<0)return false;
    // Mega/Primal/Gmax (and other "battle only" forms) only exist while holding a
    // specific item or mid-battle, and their stats are deliberately inflated far
    // beyond anything a normal, always-active Fakemon should be compared against.
    // Nearly all of them are National Dex Uber, which was dragging ordinary,
    // reasonably-built fakemon toward an Ubers verdict just for having decent
    // stats that happened to be in the same ballpark as a Mega's boosted total.
    if(p.battleOnly) return false;
    if(/(^|-)(mega|primal)(-|$)|-gmax$/i.test(String(p.forme||''))) return false;
    const key=`${p.num}|${normalizeName(p.name)}|${normalizeName(p.forme||'')}`;
    if(seen.has(key))return false;
    seen.add(key);return true;
  });
}
function moveIndex(){
  if(!state.__analysisMoveIndex){
    const idx=new Map();
    for(const [k,m] of Object.entries(state.sdMoves||{})){
      idx.set(normalizeName(k),{...m,id:k});
      if(m?.name)idx.set(normalizeName(m.name),{...m,id:k});
    }
    state.__analysisMoveIndex=idx;
  }
  return state.__analysisMoveIndex;
}
function moveData(raw){
  const name=typeof raw==='string'?raw:raw?.name;
  if(!name)return null;
  return moveIndex().get(normalizeName(name)) || (typeof raw==='object'?raw:null);
}
function learnsetRecord(p){
  // Showdown's learnsets.json doesn't give every cosmetic-movepool forme its
  // own entry - many formes (Ogerpon's masks, Rotom forms, etc.) share the
  // base species' learnset, filed under the base species' lowercase id. The
  // previous candidate list included the raw, capitalized `baseSpecies`
  // display name but never normalized it, so it could never match the actual
  // (lowercase, no-punctuation) key - silently leaving affected formes with
  // zero attacking moves instead of throwing an error.
  const candidates=[
    p?.id,
    normalizeName(p?.id),
    normalizeName(p?.name),
    normalizeName(p?.baseSpecies),
    p?.name,
    p?.baseSpecies,
    String(p?.id||'').replace(/-/g,'')
  ].filter(Boolean);
  for(const id of candidates){if(state.sdLearnsets?.[id])return state.sdLearnsets[id];}
  return null;
}
function learnsetMoves(p){
  const l=learnsetRecord(p); if(!l)return [];
  return Object.keys(l).map(moveData).filter(Boolean);
}
function typeMultipliers(types){
  return POKEMON_TYPES.map(type=>({type,mult:(types||[]).reduce((m,t)=>m*typeEffectivenessOf(type,t),1)}));
}
function typingProfile(types){
  const m=typeMultipliers(types);
  const weak=m.filter(x=>x.mult>1).length;
  const resist=m.filter(x=>x.mult>0&&x.mult<1).length;
  const immune=m.filter(x=>x.mult===0).length;
  const severe=m.filter(x=>x.mult>=4).length;
  const score=clamp(55+resist*5.5+immune*8-weak*5.5-severe*8-(mean(m.map(x=>Math.min(4,x.mult)))-1)*16);
  return {weak,resist,immune,severe,score,m};
}
function getTarget(){
  const stats={};STAT_KEYS.forEach(k=>stats[k]=Number(document.getElementById(`stat-${k}`)?.value)||0);
  return {
    name:document.getElementById('fakemon-name')?.value||'Current Fakemon',
    types:[document.getElementById('fakemon-type1')?.value,document.getElementById('fakemon-type2')?.value].filter(Boolean),
    stats,abilities:state.abilities||[],learnset:state.learnset||[]
  };
}
function fakeDex(f){
  return {id:`woogidex-${f.id}`,name:f.name||'Unnamed Fakemon',num:99999,types:[f.type1,f.type2].filter(Boolean),stats:Object.fromEntries(STAT_KEYS.map(k=>[k,Number(f.stats?.[k])||0])),abilities:f.abilities||[],learnset:f.learnset||[],fake:true};
}
function poolFor(cfg){
  if(cfg.pool==='collection')return (state.fakemonDB||[]).map(fakeDex);
  if(cfg.pool==='folder')return (state.fakemonDB||[]).filter(f=>(f.folderId||null)===(cfg.folder||null)).map(fakeDex);
  if(cfg.pool==='pokemon'){
    const wanted=normalizeName(cfg.comparePokemon||'');
    return uniqueDex().filter(p=>normalizeName(p.name)===wanted || normalizeName(p.id)===wanted);
  }
  const max=GEN_MAX_DEX[cfg.gen]||1025;
  return uniqueDex().filter(p=>cfg.natdex||Number(p.num)<=max);
}
function getUsageFormat(cfg){
  // Smogon's stats API uses the canonical format IDs directly. National Dex is
  // always the current Gen 9 National Dex format because that is how Smogon
  // publishes National Dex usage data.
  return cfg.natdex ? 'gen9nationaldex' : (GEN_FORMAT[cfg.gen] || 'gen9ou');
}
function getTierFormats(cfg){
  if(cfg.natdex){
    return {ou:'gen9nationaldex',uu:'gen9nationaldexuu',ru:'gen9nationaldexru',nu:'gen9nationaldexnu',pu:'gen9nationaldexpu',ubers:'gen9nationaldexubers'};
  }
  const g=cfg.gen||9;
  return {ou:`gen${g}ou`,uu:`gen${g}uu`,ru:`gen${g}ru`,nu:`gen${g}nu`,pu:`gen${g}pu`,zu:`gen${g}zu`,ubers:`gen${g}ubers`};
}
function parseUsageNumber(value){
  if(value&&typeof value==='object'){
    // Smogon stats store usage as raw/real/weighted fractions. Weighted is
    // the best single number for competitive usage comparisons.
    const preferred=value.weighted ?? value.real ?? value.raw;
    return parseUsageNumber(preferred);
  }
  if(typeof value==='number' && Number.isFinite(value)) return value;
  if(typeof value==='string'){
    const n=Number.parseFloat(value.replace('%','').trim());
    return Number.isFinite(n)?n:0;
  }
  return 0;
}
function extractUsageTable(raw){
  // The current @pkmn/smogon stats files use a top-level `pokemon` object:
  // { battles, pokemon: { "Great Tusk": { usage: {weighted: ...}, ... } } }.
  // Older processed files may use `data`, so keep that as a fallback.
  const table=raw?.pokemon && typeof raw.pokemon==='object' ? raw.pokemon
    : raw?.data && typeof raw.data==='object' ? raw.data
    : {};
  const out={};
  for(const [name,entry] of Object.entries(table)){
    if(!entry || typeof entry!=='object' || Array.isArray(entry)) continue;
    const usage=parseUsageNumber(entry.usage);
    if(usage>0) out[normalizeName(name)]=usage;
  }
  return out;
}
async function loadUsage(format){
    log.info('ANALYSIS', 'Loading usage data', { format });
  if(usageCache[format]) return usageCache[format];
  if(usagePromise[format]) return usagePromise[format];
  usagePromise[format]=fetch(`https://pkmn.github.io/smogon/data/stats/${format}.json`,{cache:'no-cache'})
    .then(async r=>{
      if(!r.ok) throw new Error(`Usage stats request failed (${r.status})`);
      return r.json();
    })
    .then(raw=>{
      const out=extractUsageTable(raw);
      usageCache[format]=out;
      log.info('ANALYSIS', 'Loaded usage entries', { format, count: Object.keys(out).length });
      return out;
    })
    .catch(err=>{
      log.warn('ANALYSIS', 'Usage stats unavailable', { format, error: err });
      usageCache[format]={};
      return usageCache[format];
    });
  return usagePromise[format];
}
async function loadOfficialTierData(cfg){
  // Showdown's live formats-data contains the current tier and National Dex tier.
  // We parse each species entry independently so one malformed/nested entry cannot
  // accidentally carry a tier over to every following Pokémon.
  const gen = Number(cfg.gen || 9);
  const key = cfg.natdex ? `gen${gen}-natdex` : `gen${gen}`;
  if(tierDataCache[key]) return tierDataCache[key];
  if(tierDataPromise[key]) return tierDataPromise[key];
  const url = cfg.natdex
    ? 'https://raw.githubusercontent.com/smogon/pokemon-showdown/master/data/formats-data.ts'
    : (gen === 9
      ? 'https://raw.githubusercontent.com/smogon/pokemon-showdown/master/data/formats-data.ts'
      : `https://raw.githubusercontent.com/smogon/pokemon-showdown/master/data/mods/gen${gen}/formats-data.ts`);
  tierDataPromise[key]=fetch(url,{cache:'no-cache'}).then(r=>{
    if(!r.ok) throw new Error(`Tier data request failed (${r.status})`);
    return r.text();
  }).then(text=>{
    const out={};
    // formats-data.ts is a TypeScript object, and individual species entries can
    // contain nested objects (for example viableMoves). A regex that searches for
    // the next `},` can therefore swallow multiple species and attach the wrong
    // tier to them. Parse only top-level species blocks line-by-line instead.
    const lines=text.split(/\r?\n/);
    let currentId='';
    let tier='';
    let natDexTier='';
    const flush=()=>{
      if(currentId && (tier || natDexTier)) out[normalizeName(currentId)]={tier,natDexTier};
      currentId=''; tier=''; natDexTier='';
    };
    for(const line of lines){
      // Showdown's source uses tabs for indentation:
      // \t<species>: {, then \t\ttier / \t\tnatDexTier.
      // Accept tabs or spaces so this remains robust to formatting changes.
      const species=line.match(/^[\t ]{1,4}([a-z0-9]+):\s*\{\s*$/);
      if(species){ flush(); currentId=species[1]; continue; }
      if(!currentId) continue;
      const tierMatch=line.match(/^[\t ]{2,8}tier:\s*["']([^"']+)["']/);
      const natMatch=line.match(/^[\t ]{2,8}natDexTier:\s*["']([^"']+)["']/);
      if(tierMatch) tier=tierMatch[1];
      if(natMatch) natDexTier=natMatch[1];
    }
    flush();
    tierDataCache[key]=out;
    log.info('ANALYSIS', 'Loaded official tier records', { count: Object.keys(out).length });
    return out;
  }).catch(err=>{
    log.warn('ANALYSIS', 'Official tier data unavailable', err);
    tierDataCache[key]={};
    return tierDataCache[key];
  });
  return tierDataPromise[key];
}
function officialTierOf(name,tierData,cfg){
  const candidates=[
    normalizeName(name),
    normalizeName(String(name||'').replace(/[- ](alola|galar|hisui|paldea|totem)$/i,'')),
  ];
  for(const id of candidates){
    const rec=tierData?.[id];
    if(!rec) continue;
    let tier=cfg?.natdex ? rec.natDexTier : rec.tier;
    // Never substitute National Dex tiers into a standard-generation analysis.
    // `tier: "Illegal"` means the species is not legal in that generation, and
    // `LC`/`NFE` are not standard competitive viability tiers for this analysis.
    // National Dex explicitly opts into natDexTier above.
    if(!tier || /^(illegal|lc|nfe)$/i.test(tier)) continue;
    if(/^uber$/i.test(tier)) tier='Ubers';
    return tier;
  }
  return null;
}
function usageOf(name,usage){return usage?.[normalizeName(name)]||0;}
function usageRank(name,usage){
  const value=usageOf(name,usage); if(!value) return Infinity;
  return 1+Object.values(usage).filter(v=>v>value).length;
}
function usageTierEvidence(name,tierUsage,officialTiers,cfg){
  const official=officialTierOf(name,officialTiers,cfg);
  if(official){
    const tierKey=official.toLowerCase()==='ubers'?'ubers':official.toLowerCase();
    const usage=usageOf(name,tierUsage[tierKey]);
    const tierClass={UUBL:'OU',RUBL:'UU',NUBL:'RU',PUBL:'NU',ZUBL:'PU',Uber:'Ubers',AG:'Ubers'}[official]||official;
    return {tier:official,tierClass,usage,rank:usage?usageRank(name,tierUsage[tierKey]):Infinity,official:true};
  }
  // Fallback only when official tier data could not resolve this species/form.
  const order=['ubers','ou','uu','ru','nu','pu','zu'];
  for(const tier of order){
    const u=usageOf(name,tierUsage[tier]);
    if(u>0){
      const actual=tier==='ubers'?'Ubers':tier.toUpperCase();
      return {tier:actual,tierClass:actual,usage:u,rank:usageRank(name,tierUsage[tier]),official:false};
    }
  }
  return null;
}
function analysisTypePills(types){
  return (types||[]).filter(Boolean).map(t=>{
    const cls=`type-pill type-${String(t).toLowerCase().replace(/[^a-z0-9]+/g,'-')}`;
    return `<span class="${cls}">${esc(t)}</span>`;
  }).join(' ');
}
const PIVOT_MOVE_NAMES_GLOBAL=new Set(['U-turn','Volt Switch','Flip Turn','Parting Shot','Teleport','Chilly Reception']);
function summarySeedFromTarget(t){
  // Deterministic personality seed derived only from the Fakemon's own data.
  // Analysis settings such as generation/pool are deliberately excluded.
  const stable={
    name:t?.name||'',
    types:(t?.types||[]).map(String),
    stats:Object.fromEntries(STAT_KEYS.map(k=>[k,Number(t?.stats?.[k])||0])),
    abilities:abilityNames(t?.abilities).map(String).sort(),
    learnset:((t?.learnset||[]).map(m=>typeof m==='string'?m:m?.name).filter(Boolean).map(String).sort())
  };
  const text=JSON.stringify(stable);
  let h=2166136261;
  for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}
  return h>>>0;
}
function seededPick(arr,rng){
  if(!arr?.length)return '';
  rng.value=(Math.imul(rng.value,1664525)+1013904223)>>>0;
  return arr[rng.value%arr.length];
}
function summaryAttackScore(move, types, stats){
  const name=String(move?.name||'');
  const desc=String(move?.desc||'').toLowerCase();
  const bp=Number(move?.basePower||0);
  const acc=Number(move?.accuracy);
  const isStab=(types||[]).includes(move?.type);
  let score=bp*0.16 + (isStab?18:0);
  if(bp>=70) score+=8;
  if(bp>=100) score+=4;
  if(Number.isFinite(acc)){ if(acc>=95) score+=7; else if(acc>=90) score+=3; else if(acc<80) score-=12; }
  if(Number(move?.priority||0)>0) score+=8;
  if(/flinch|burn|paraly|poison|sleep|freeze|confus|lower.*stat|boost.*user|drain|heals? the user/.test(desc)) score+=5;
  if(/recharge|must recharge|user cannot move|hyper beam|giga impact/.test(`${name} ${desc}`)) score-=55;
  if(/must recharge|recharge next turn/.test(desc)) score-=25;
  if(/two turns|two-turn|charges? first|user digs|user flies|user dives|user bounces/.test(desc)) score-=18;
  if(/user is hurt by|recoil/.test(desc)) score-=7;
  if(/lower.*accuracy|accuracy.*lower/.test(desc)) score-=2;
  return score;
}
function pickSummaryAttacks(moves, types, stats){
  const bannedHighCost=new Set(['Hyper Beam','Giga Impact','Frenzy Plant','Blast Burn','Hydro Cannon','Roar of Time','Eternabeam','Meteor Assault','Steel Beam','Rock Wrecker']);
  const damaging=(moves||[]).filter(m=>m && (m.category==='Physical'||m.category==='Special') && !bannedHighCost.has(String(m.name||'')));
  return damaging.map(m=>({m,score:summaryAttackScore(m,types,stats)}))
    .sort((a,b)=>b.score-a.score)
    .filter(x=>x.score>16)
    .slice(0,3)
    .map(x=>x.m);
}
function makeCasualSummary(t,tf,tier,matchup,selectedFormat,statCombination,roleScore,typePct,cap,summarySeed){
  const types=(t.types||[]).filter(Boolean),typeText=types.length?types.join(' / '):'plain typing';
  const stats=t.stats||{},bestStat=Object.entries(stats).sort((a,b)=>Number(b[1])-Number(a[1]))[0];
  const tierText=tier.tier||'the lower tiers',tierKey=String(tierText).toLowerCase();
  const moves=tf.moves||[],names=moves.map(m=>String(m.name||'')).filter(Boolean),useful=tf.usefulMoves||[];
  const attacks=pickSummaryAttacks(useful,types,stats);
  const recovery=(tf.recoveryMovesList||[]).map(m=>m.name).filter(Boolean).slice(0,3);
  const pivots=names.filter(n=>PIVOT_MOVE_NAMES_GLOBAL.has(n));
  const setup=names.filter(n=>/^(Swords Dance|Nasty Plot|Calm Mind|Bulk Up|Dragon Dance|Quiver Dance|Shell Smash|Shift Gear|Curse|Iron Defense|Agility|Trailblaze|Growth|Victory Dance|Tail Glow|Work Up|Hone Claws|Rock Polish|Autotomize)$/i.test(n));
  const offensiveSetupNames=names.filter(n=>/^(Swords Dance|Nasty Plot|Bulk Up|Dragon Dance|Quiver Dance|Shell Smash|Shift Gear|Curse|Agility|Trailblaze|Growth|Victory Dance|Tail Glow|Work Up|Hone Claws|Rock Polish|Autotomize)$/i.test(n));
  const defensiveSetupNames=names.filter(n=>/^(Calm Mind|Iron Defense|Amnesia|Cotton Guard|Acid Armor|Cosmic Power|Stockpile)$/i.test(n));
  const capDefensive=Number(cap?.PT||0)>=150 || Number(cap?.ST||0)>=150;
  const setupSweeperSignal=
    offensiveSetupNames.length>=1 &&
    (Number(stats.Atk||0)>=110 || Number(stats.SpA||stats.Spa||0)>=110) &&
    attacks.length>=2 &&
    Math.max(Number(stats.Atk||0),Number(stats.SpA||stats.Spa||0))>=120 &&
    !(defensiveSetupNames.length>=1 && capDefensive) &&
    !(capDefensive && Number(tf.recoveryMoves||0)>=1 && Number(tf.defensiveTools||0)>=2);
  const fmt=x=>x?.p?.name||'something',good=(matchup?.good||[]).slice(0,3),bad=(matchup?.bad||[]).slice(0,3);
  const roleEntries=Object.entries(tf.roleSignals||{}).sort((a,b)=>b[1]-a[1]);
  const role=choosePrimaryRole(tf);
  const safeRole=role==='setupSweeper' && !setupSweeperSignal ? choosePrimaryRole({...tf,roleSignals:{...tf.roleSignals,setupSweeper:0}}) : role;
  const defensiveMon=
    safeRole==='defensive' ||
    ((Number(cap?.PT||0)>=150 || Number(cap?.ST||0)>=150) &&
      (Number(tf.recoveryMoves||0)>=1 || Number(tf.defensiveTools||0)>=2 || Number(tf.bulk||0)>=245)) ||
    (Number(cap?.PT||0)>=180 && Number(cap?.ST||0)>=130);

  const roleText={physicalSweeper:'physical sweeper',specialSweeper:'special sweeper',wallbreaker:'wallbreaker',bulkyAttacker:'bulky attacker',defensive:'defensive mon',support:'support mon',pivot:'pivot',setupSweeper:'setup sweeper',hazard:'hazard setter',screens:'screens'}[safeRole]||safeRole;
  const variety=Math.min(28,(new Set(moves.map(m=>m.category))).size*5+Math.min(8,tf.coverageTypes*3));
  const utility=Math.min(22,tf.setup*4+tf.recoveryMoves*4+tf.pivot*5+tf.hazards*3+tf.removal*3+Math.min(4,tf.statusUtility));
  const identity=Math.min(20,(typePct>=75?7:3)+(roleScore>=70?6:3)+(attacks.length>=2?4:2)+(moves.length>=6?3:1));
  const funRating=Math.max(1,Math.min(10,Math.round((variety+utility+identity)/9)));
  const power=Math.max(0,Math.min(100,(Number(tier.score)||50)*.45+(Number(tier.reliability)||50)*.05+(Number(statCombination)||50)*.15+(Number(roleScore)||50)*.15+(Number(matchup?.weightedScore)||50)*.20));
  const rng={value:(Number(summarySeed)>>>0)||summarySeedFromTarget(t)};
  const pick=a=>seededPick(a,rng);
  const tone=power>=82?'monster':power>=68?'strong':power>=53?'solid':power>=38?'niche':'struggling';
  const monName=String(t.name||t.species||'this thing');
  const merchantThing=pick([`${roleText} merchant`,`${typeText} merchant`,`free-turn merchant`,`setup merchant`,`damage merchant`]);
  const toneSets={
    monster:{open:['oh NAH what is ts','ts gas gng','aw hell nah..','oh my days bruv','jarvis get ts out of here','okay, who let this thing cook','HOLY STALLFEST','this is getting suspiciously silly','bro cooked and then some','nah this is actually diabolical','somebody call the tier police'],closers:['i would absolutely test this at the top end first','this is the kind of kit i would watch very closely in real games','honestly, i would be a little scared to give this too much free space','if this starts getting free turns, somebody is getting cooked','this thing has no business being this comfortable','i would not be shocked if this gets a suspect test eventually','respectfully, this might need a leash']},
    strong:{open:['ts gas gng','oh my days bruv','okay yeah, this one has sauce','oh NAH what is ts','yeah, this one is kinda cooking','aw hell nah.. i see the vision','jarvis get ts out of here','this is a certified hood classic','okay this one actually has bars','we might have a top-tier merchant here'],closers:['i would be pretty confident testing this aggressively','this is absolutely worth throwing into serious teams','i would keep an eye on how often it gets free turns','give this one an inch and it is taking the whole kitchen','i would absolutely abuse the good turns here','this is the kind of mon that quietly wins games','solid pick, would not overthink it']},
    solid:{open:['okay, i see the vision','ts gas gng, in moderation','oh my days bruv, there is actually something here','this one has a little sauce','would. next question','okay this is kinda fun','we have a concept here and it is not bad','this one is a solid little rotation piece','okay, respectable. respectable.'],closers:['i would start testing it and see what sticks','this feels like a fun one to actually build around','i would give it a few different team shells before judging it too hard','there is enough here to make me curious, which is a win already','not flashy, but i would not be mad running it','a perfectly fine Tuesday-night teammate']},
    niche:{open:['okay, this one is a specialist','i can see the angle here','ts so deep bro','this is definitely a matchup artist','okay, this is a very specific little merchant','oh my days bruv, this has a job and it knows it','we found the niche merchant','okay, this is a one-trick pony, but the trick is decent'],closers:['i would build around its best jobs instead of asking it to do everything','this one could surprise people with the right support','i would test the narrow gameplan first and expand from there','do not make it do eight jobs. let the little merchant have its lane','respect the lane, respect the merchant']},
    struggling:{open:['okay, we have a little gremlin to workshop','aw hell nah.. okay, back to the kitchen','jarvis get ts out of here, but wait, there might be a point here','ts so deep bro','oh my days bruv, we have work to do','this one needs the squad holding its hand','okay, somebody find this thing a niche','we are so back? no, not yet'],closers:['i would start with a very supportive team and see what it can steal','this one needs its good situations to happen on purpose','i would treat this as a project mon and see where it surprises us','the numbers are not doing cartwheels, so let the weirdness carry','give the little guy one job and let it commit','this is a lower-tier legend in the making, maybe']}
  };
  const paragraphs=[];
  const chaoticBits=[
    `${merchantThing}. i am not elaborating.`,
    `${pick(['ts so deep bro','jarvis get ts out of here','HOLY STALLFEST','would. next question'])}`,
    `${pick(['this thing is kinda suspicious','i fear the kitchen may be open','somebody is going to click this move and immediately regret it','this has the energy of a set that starts as a joke and ends up on three teams'])}`,
    `${pick(['okay, somebody let this thing cook','yeah, i am keeping an eye on this one','this is exactly the kind of set that gets out of hand fast','i have questions. mostly about who approved this'])}`
  ];
  const opening=pick(toneSets[tone].open);
  const identityLine=`the ${typeText} typing and ${roleText} role give this thing a pretty clear identity.`;
  paragraphs.push(`${opening}. ${identityLine}`);
  if((rng.value>>>0)%100 < (power>=82?30:power>=68?40:28)) paragraphs.push(pick(chaoticBits));

  const topicPool=[];
  if(bestStat&&Number(bestStat[1])>=110){
    const v={hp:[`that ${STAT_NAMES[bestStat[0]]} stat is doing a lot of the work at ${bestStat[1]}. this is the kind of number you actually build around.`,`okay, ${bestStat[1]} ${STAT_NAMES[bestStat[0]]} is kinda absurd. that stat is absolutely part of the gameplan.`,`the ${STAT_NAMES[bestStat[0]]} is sitting at ${bestStat[1]}, and yeah, i would be taking advantage of that every chance i get.`,`you do not accidentally end up at ${bestStat[1]} ${STAT_NAMES[bestStat[0]]}. that is a stat this mon should be actively abusing.`]};
    topicPool.push(pick(v[STAT_NAMES[bestStat[0]].toLowerCase()]||Object.values(v).flat()));
  }
  if(attacks.length) topicPool.push(pick([
    `for offense, ${attacks.slice(0,3).map(m=>m.name).join(', ')} are the buttons i would be pressing first. the coverage is giving this thing something to work with.`,
    `${attacks.slice(0,3).map(m=>m.name).join(', ')} are the attacks that jump out first. i would start there, then see which one actually earns the fourth moveslot.`,
    `the offensive side is pretty clear: ${attacks.slice(0,3).map(m=>m.name).join(', ')} all give it real ways to make progress.`,
    `i like ${attacks.slice(0,3).map(m=>m.name).join(', ')} here. those are actual gameplan moves, not just moves that look funny on paper.`
  ]));
  if(recovery.length) topicPool.push(pick([
    `${recovery.join(', ')} gives this thing real staying power. if it gets free turns, it can keep coming back for more.`,
    `the recovery is a big deal here. ${recovery.join(', ')} means chip damage is not automatically solving the problem.`,
    `having ${recovery.join(', ')} changes how you have to approach this. you cannot just assume one round of chip is enough.`,
    `${recovery.join(', ')} is doing exactly what a good recovery move should do, which is making every good turn matter a little more.`
  ]));
  if(pivots.length) topicPool.push(pick([
    `${pivots.join(', ')} gives it a clean way to keep momentum. get in, make something happen, then keep the pace moving.`,
    `the pivoting from ${pivots.join(', ')} is really useful here. it lets this thing play aggressively without committing to every fight.`,
    `${pivots.join(', ')} is the kind of utility i would absolutely squeeze value out of. good positioning can make this look way stronger.`,
    `i would not sleep on ${pivots.join(', ')}. getting the right matchup on demand is half the battle.`
  ]));
  if(setupSweeperSignal && !defensiveMon) topicPool.push(pick([
    `${setup.slice(0,2).join(' + ')} is where the ceiling gets spicy. give it one clean turn and suddenly the opponent has homework.`,
    `the setup package is the scary part. ${setup.slice(0,2).join(' + ')} can turn one passive turn into a very different game.`,
    `if you are bringing ${setup.slice(0,2).join(' + ')}, you are basically asking for one free turn. if you get it, things can get ugly fast.`,
    `${setup.slice(0,2).join(' + ')} gives this a much higher ceiling than the raw stats alone suggest.`
  ]));
  if(tf.statusUtility>=2) topicPool.push(pick([
    `there is enough status utility here to make switching uncomfortable. sometimes the best damage is just making the next turn miserable.`,
    `the status options give it another way to make progress when clicking attacks is not ideal.`,
    `status utility is doing some sneaky work here. this does not have to win the damage race every turn to be annoying.`,
    `i like the status angle because it gives this thing something useful to do even when the matchup is not immediately favorable.`
  ]));
  if(tf.hazards||tf.removal) topicPool.push(pick([
    `the field control is worth paying attention to. this can create value before it ever has to start trading hits.`,
    `hazards and removal give this thing some actual team value outside of its main role. that is good role compression.`,
    `the field-control tools make the set more flexible. it can still contribute when the obvious gameplan is not available.`,
    `i would take the hazard or removal options seriously. they give the team another reason to bring this even when the matchup is awkward.`
  ]));
  if(Number(tf.speed||0)>=100) topicPool.push(pick([
    `the Speed is doing more than just making the number look pretty. moving first changes which attacks are actually realistic in practice.`,
    `that Speed stat means a lot of the damage here comes with a very important bonus: you often get to click it first.`,
    `the speed tier is one of the reasons the offensive numbers are actually scary. fast damage is a different conversation from slow damage.`,
    `being this fast gives it way more freedom to pressure things before they get their own plan online.`
  ]));
  if(defensiveMon) topicPool.push(pick([
    `this is not a damage-race mon. the real value is how many turns it can buy for the team while making the opponent work for every bit of progress.`,
    `the CAP tankiness ratings are backing up the defensive role here. this has the stat architecture to absorb hits instead of just hoping the matchup goes its way.`,
    `the important number here is not how hard it hits back. it is how much punishment it can take before the opponent actually gets somewhere.`,
    `this looks much better when you judge it as a wall. strong physical and/or special tankiness changes the value of every safe switch-in.`,
    `the defensive profile gives this thing a different win condition: come in, deny progress, heal or disrupt, and make the opponent spend turns solving it.`,
    `trying to judge this like a sweeper undersells it. the bulk is buying turns, and those turns are where the recovery, hazards, status, or support moves start paying off.`,
    `the CAP PT/ST spread is doing real work here. this can be useful even when its own damage output is not particularly impressive.`,
    `this is the kind of mon where a "bad" damage matchup can still be playable if the opponent cannot actually break it before it gets to recover or disrupt them.`
  ]));
  if(tf.bulk>=260) topicPool.push(pick([
    `the bulk is quietly doing a ton here. this is not just about surviving one hit, it is about getting enough turns to actually use the kit.`,
    `the defensive numbers give it room to make mistakes. that matters a lot more than a pretty stat screen sometimes suggests.`,
    `this is bulky enough that opponents cannot always solve it by simply clicking their strongest neutral move.`,
    `the bulk changes the way the matchup plays out. it has more opportunities to recover, pivot, set up, or fire back.`
  ]));
  if(tf.coverageTypes>=4) topicPool.push(pick([
    `the coverage is doing real work. there are enough different attacking angles here that guessing the wrong switch can get punished.`,
    `having ${tf.coverageTypes} coverage types gives this a lot of room to customize the set around whatever the team is missing.`,
    `the move coverage is one of the more useful parts of the kit. it does not have to run the same four moves every game.`,
    `the coverage makes this harder to wall blindly. you can build it toward the matchups you actually care about.`
  ]));
  if(defensiveMon) topicPool.push(pick([
    `the CAP tankiness ratings are backing this up. PT/ST are doing real work here, so i would value safe entries and staying power over raw damage.`,
    `this thing gets paid in turns, not OHKOs. the defensive profile gives it chances to come in, absorb pressure, and turn those turns into utility.`,
    `the physical and special bulk are important because they change the matchup math itself. surviving the hit is often the whole point.`,
    `this looks much more convincing when you judge it as a wall. if the opponent cannot break it quickly, the recovery and utility start snowballing.`,
    `do not force this into a sweeper job just because it owns a setup move. the CAP bulk profile says the defensive gameplan is a much bigger part of the identity.`,
    `the useful question here is not "how hard does it hit?" it is "how many turns does it buy?" the answer looks pretty good from the tankiness side.`
  ]));
  if(power>=75 && cap?.BSR>=700) topicPool.push(pick([
    `the stat architecture is doing a lot of the heavy lifting. the raw numbers give the moveset plenty of room to cook.`,
    `the overall stat profile is strong enough that the movepool does not have to perform miracles to make this work.`,
    `the stats are giving this thing a very high floor. even before getting fancy with the set, there is already plenty to work with.`,
    `this has enough raw stat power that small optimization choices can turn into surprisingly big matchup differences.`
  ]));
  if(power<50 && cap?.BSR<500) topicPool.push(pick([
    `the raw stats are not exactly carrying the operation, so the moves and positioning have to do the work. give it a clear job and let it commit.`,
    `this is not winning games by brute force. the value is going to come from picking the right turns and squeezing everything out of the useful parts of the kit.`,
    `the numbers are a little stingy, so i would avoid trying to make this do everything. one focused job is probably the better route.`,
    `this needs a gameplan more than it needs another random coverage move. play to the stats it actually has.`
  ]));
  if(typePct>=75) topicPool.push(pick([
    `the typing is doing some serious work here. the resistances and immunities give it chances to enter the field that the raw stats alone would not create.`,
    `this typing gives the mon some very real switch-in opportunities. those free entries are where the rest of the kit starts looking better.`,
    `the defensive typing is one of the reasons this can afford to play aggressively. there are actually attacks it can come in on.`,
    `the type combination is pulling its weight. good resistances are basically free turns when the opponent has to respect them.`
  ]));

  const topics=[];
  const topicCount=Math.min(topicPool.length, power>=70?3:power>=50?2:2);
  while(topicPool.length && topics.length<topicCount) topics.push(topicPool.splice(rng.value%topicPool.length,1)[0]), rng.value=(Math.imul(rng.value,1664525)+1013904223)>>>0;
  paragraphs.push(...topics);

  const matchupScore=matchup?.weightedScore;
  if(matchupScore!=null && (good.length||bad.length)){
    const matchupLines=[];
    if(defensiveMon && matchupScore>=60) matchupLines.push(pick([
      `the defensive matchup picture is actually pretty encouraging at ${Math.round(matchupScore)}/100. ${good.length?`the fact that ${good.slice(0,2).map(fmt).join(' and ')} struggle to make progress is exactly what you want from this role.`:'a lot of opponents are going to have to work for their progress.'}`,
      `around ${Math.round(matchupScore)}/100, and for a defensive mon that is a pretty healthy place to be. the important part is that opponents are not getting easy damage into it.`,
      `this is a much better matchup profile when you look at survival instead of raw damage. at ${Math.round(matchupScore)}/100, the wall is doing its actual job.`,
      `the matchup number is ${Math.round(matchupScore)}/100, but the interesting part is why. this thing is not winning by deleting opponents, it is winning by refusing to get deleted itself.`
    ]));
    else if(defensiveMon && matchupScore<60) matchupLines.push(pick([
      `the matchup score is ${Math.round(matchupScore)}/100, but i would not read that like an offensive mon's score. the important question is whether the opponent can actually break it before it creates value.`,
      `around ${Math.round(matchupScore)}/100. that looks middling on paper, but this is a wall, not a sweeper. if the opponent needs multiple turns to break it, the matchup can still be perfectly playable.`,
      `the raw matchup number is ${Math.round(matchupScore)}/100, so i would check the actual damage rolls before calling these bad. defensive mons get value from surviving hits, not from winning the damage race.`,
      `this lands around ${Math.round(matchupScore)}/100. the number is not telling the whole story here because the whole point is to absorb pressure, recover, and make progress through utility.`
    ]));
    else if(matchupScore>=65) matchupLines.push(`the overall matchup picture is looking pretty friendly at ${Math.round(matchupScore)}/100. ${good.length?`i especially like how it lines up with ${good.slice(0,2).map(fmt).join(' and ')}.`:'the broad spread is doing you some favors.'}`);
    else if(matchupScore<=35) matchupLines.push(`the matchup picture is the part i would respect most here. it is around ${Math.round(matchupScore)}/100, so team support and smart positioning are going to matter a lot.`);
    else matchupLines.push(pick([
      `the matchup spread is pretty mixed at ${Math.round(matchupScore)}/100. pick the fights this thing actually wants and let the teammates handle the awkward ones.`,
      `this one lands around ${Math.round(matchupScore)}/100, so i would play to its good spots instead of asking it to win every matchup on its own.`,
      `the spread is pretty middle-of-the-road at ${Math.round(matchupScore)}/100. the right partners can make the difference here.`,
      `around ${Math.round(matchupScore)}/100 overall. honestly, this feels like a mon that gets way better when the team is built with its bad matchups in mind.`,
      `the matchup spread is mixed at ${Math.round(matchupScore)}/100. let it take the fights it likes and do not force the ugly ones.`,
      `this is sitting around ${Math.round(matchupScore)}/100. not bad, not free, just very much a pick-your-spots kind of mon.`,
      `the matchups are a mixed bag at ${Math.round(matchupScore)}/100. give it clean entries and good partners and it should be fine.`,
      `at ${Math.round(matchupScore)}/100, this is more about choosing the right battle than trying to brute-force every matchup.`
    ]));
    if(good.length && bad.length && power>=55) matchupLines.push(pick([
      `the fun part is the contrast. ${good[0]?.p?.name||'the good matchups'} gives it room to cook, while ${bad[0]?.p?.name||'the rough matchups'} is where i would have a teammate ready.`,
      `play into ${good[0]?.p?.name||'the favorable matchups'} when you can, and keep an answer for ${bad[0]?.p?.name||'the nasty ones'}. simple enough.`,
      `the good games are genuinely nice, and the bad games are exactly why team building exists.`,
      `${good[0]?.p?.name||'the favorable side'} looks like a good time. ${bad[0]?.p?.name||'the rough side'} looks like a problem for somebody else on the team.`,
      `this has some very real good games and some very real "please send a teammate" games. build accordingly.`,
      `when ${good[0]?.p?.name||'the good matchup'} shows up, let this thing work. when ${bad[0]?.p?.name||'the bad matchup'} shows up, do not be a hero.`
    ]));
    else if(good.length && power>=60) matchupLines.push(pick([`i really like the games into ${good.map(fmt).join(', ')}. those are the spots where this can look way better than the raw numbers suggest.`,`when ${good[0]?.p?.name||'the favorable matchups'} shows up, i would be very happy to have this thing in the back pocket.`]));
    else if(bad.length) matchupLines.push(pick([`i would have a plan for ${bad.map(fmt).join(', ')}. those are the games where i would rather have this paired with a teammate that patches the hole.`,`the rough side is mostly ${bad.slice(0,2).map(fmt).join(' and ')}. do not make this mon solve those problems alone.`]));
    paragraphs.push(...matchupLines);
  }

  if(defensiveMon) paragraphs.push(pick([
    `i would build around the turns this thing brings, not around forcing it to deal huge damage. recovery, hazards, status, and good switch-ins are where the value is.`,
    `the cleanest set is probably the one that makes its defensive job obvious. give it recovery if it has it, give it useful utility, and let the bulk keep creating turns.`,
    `do not judge this by how many things it can OHKO. judge it by how many things fail to 2HKO it and how much work it can do in the turns that buys.`,
    `the team should take advantage of the free turns this creates. bring it into the hits it is built to absorb, make progress while it is there, then keep it healthy.`,
    `if the role is defensive, commit to it. the stats are valuable because they let the rest of the team breathe, not because they make a pretty damage screenshot.`
  ]));
  if(tone==='monster' || tone==='strong') paragraphs.push(pick(['i would not overcomplicate the set. give it a clean job, good support, and let the stats do their thing.','this is where i would start testing the greedy options first, because the ceiling looks worth exploring.','if the first few games feel unfair, that is useful information. keep an eye on how easily it converts free turns.']));
  else if(tone==='solid') paragraphs.push(pick(['i would keep the set flexible. this feels like the kind of mon that gets better once you know exactly what the team needs.','do not chase the fanciest set first. find the boring set that wins games, then get weird.','the best version of this probably looks simple on paper and surprisingly annoying in practice.']));
  else paragraphs.push(pick(['i would make the team do some of the heavy lifting here. get this into the games it actually wants and it can still earn its keep.','this is a good candidate for a focused role instead of a kitchen sink set.','give it the right teammates and let the niche do the talking.']));

  if((rng.value>>>0)%100 < 42) paragraphs.push(pick([
    `${merchantThing}. that is the whole review.`,
    `${pick(['oh NAH what is ts','ts gas gng','would. next question','jarvis get ts out of here'])} i have seen enough.`,
    `${monName} is a ${pick(['good gal','gremlin','merchant','certified nonsense'])}. respectfully.`,
    `i am putting this one in the ${pick(['do not give it free turns','someone test this immediately','why is this working','back to the kitchen'])} folder.`
  ]));
  const isUbers=/^ubers$/i.test(String(tierText));
  const ubersLines=[
    `even MAHORAGA HIMSELF cannot defeat this. Ubers it is.`,
    `guess what tier i will put this mon in! it starts with U and ends with BERS.`,
    `call me Master Oogway, the way i am locking this mon up in Ubers.`,
    `not even Saul Goodman can bail this mon out of Ubers.`,
    `yeah, i have seen enough. Ubers. somebody take the keys away.`,
    `this one walked into the analysis and immediately got the Ubers sentence.`,
    `Ubers is not even a suggestion here. that is where i am putting this thing.`,
    `i was going to be reasonable about the tiering, then this mon showed up. Ubers.`,
    `the spreadsheet has spoken, and unfortunately it said Ubers.`,
    `okay, pack it up. this thing is going straight to Ubers.`,
    `Ubers feels less like a tier and more like a containment facility for this one.`,
    `yeahhh, this is an Ubers problem now. i do not make the rules.`,
    `like AI data centers, nobody wants this thing near them. Ubers.`,
    `someone asked where this belongs. apparently the answer is Ubers and i am not arguing.`
  ];
  if(isUbers) paragraphs.push(pick(ubersLines));
  else if(power>=78) paragraphs.push(`my read is ${tierText} for ${selectedFormat}. ${pick(toneSets[tone].closers)}.`);
  else if(power>=55) paragraphs.push(pick([
    `${tierText} feels like a pretty reasonable starting point for ${selectedFormat}. ${pick(toneSets[tone].closers)}.`,
    `i would start around ${tierText} in ${selectedFormat} and see how it actually plays. ${pick(toneSets[tone].closers)}.`,
    `for now, ${tierText} feels like the right neighborhood in ${selectedFormat}. ${pick(toneSets[tone].closers)}.`,
    `my first stop would be ${tierText} in ${selectedFormat}. ${pick(toneSets[tone].closers)}.`,
    `i would test this around ${tierText} in ${selectedFormat}. ${pick(toneSets[tone].closers)}.`
  ]));
  else paragraphs.push(pick([
    `i would start around ${tierText} in ${selectedFormat}. ${pick(toneSets[tone].closers)}.`,
    `my first guess is ${tierText} in ${selectedFormat}. ${pick(toneSets[tone].closers)}.`,
    `i would give it a look around ${tierText} for ${selectedFormat}. ${pick(toneSets[tone].closers)}.`,
    `for now, ${tierText} is where i would start in ${selectedFormat}. ${pick(toneSets[tone].closers)}.`
  ]));
  paragraphs.push(pick(['go throw it into some actual games and see what breaks first.','this is the part where the battle sim gets to bully my spreadsheet.','now make the thing fight people. spreadsheets can only yap so much.','build a couple versions, play them, then come back and make the weird one.']))
  return paragraphs.slice(0,9).join('\n\n');
}

function detailedProfile(mon){
  const moves=mon.fake?(mon.learnset||[]).map(moveData).filter(Boolean):learnsetMoves(mon);
  const unique=[...new Map(moves.map(m=>[normalizeName(m.name),m])).values()];
  const useful=unique.filter(m=>{
    try{return sampleMoveIsActuallyUseful(m, {stats:mon.stats||{},types:mon.types||[],abilities:abilityNames(mon.abilities),moves:unique}, null);}catch{return false;}
  });
  const damaging=unique.filter(m=>m.category==='Physical'||m.category==='Special');
  const usefulDamaging=useful.filter(m=>m.category==='Physical'||m.category==='Special');
  const stab=usefulDamaging.filter(m=>(mon.types||[]).includes(m.type));
  const physical=usefulDamaging.filter(m=>m.category==='Physical');
  const special=usefulDamaging.filter(m=>m.category==='Special');
  const status=unique.filter(m=>m.category==='Status');
  const moveText=m=>`${m.name||''} ${m.desc||''}`.toLowerCase();
  const setup=unique.filter(m=>/swords dance|nasty plot|calm mind|bulk up|dragon dance|quiver dance|shell smash|shift gear|curse|iron defense|agility|trailblaze|growth|victory dance|tail glow|work up|hone claws|rock polish|autotomize/.test(moveText(m))).length;
  // Only explicit, meaningful self-recovery counts as "good recovery" in Analysis.
  // Do not infer recovery from descriptions: moves like Life Dew, Aqua Ring, draining
  // attacks, Healing Wish, etc. are not equivalent to Recover/Roost-style recovery.
  const RELIABLE_RECOVERY_MOVE_NAMES=new Set([
    'Recover','Roost','Slack Off','Synthesis','Moonlight','Morning Sun','Milk Drink',
    'Soft-Boiled','Shore Up','Wish','Strength Sap'
  ]);
  const recoveryMoves=unique.filter(m=>RELIABLE_RECOVERY_MOVE_NAMES.has(String(m.name||'')));
  const recovery=recoveryMoves.length;
  const recoveryMovesList=recoveryMoves;
  const recoveryQuality=recoveryMoves.length ? Math.min(100,65+recoveryMoves.length*12) : 0;
  const hazards=unique.filter(m=>/stealth rock|spikes|toxic spikes|sticky web|ceaseless edge|stone axe/i.test(String(m.name||''))).length;
  const removal=unique.filter(m=>/rapid spin|defog|court change|mortal spin/i.test(String(m.name||''))).length;
  // Baton Pass is banned and must never be treated as a competitive pivot option.
  const pivot=unique.filter(m=>PIVOT_MOVE_NAMES_GLOBAL.has(String(m.name||''))).length;
  const statusUtility=unique.filter(m=>/toxic|will-o-wisp|thunder wave|spore|sleep powder|glare|taunt|encore|knock off|trick|haze|whirlwind|roar/i.test(moveText(m))).length;
  const defensiveSetup=unique.filter(m=>/iron defense|amnesia|cotton guard|acid armor|cosmic power|stockpile/i.test(String(m.name||''))).length;
  const bestPower=Math.max(0,...usefulDamaging.map(m=>Number(m.basePower)||0));
  const stabPower=Math.max(0,...stab.map(m=>Number(m.basePower)||0));
  const coverageTypes=[...new Set(usefulDamaging.filter(m=>!(mon.types||[]).includes(m.type)).map(m=>m.type))];
  const {hp,atk,def,spa,spd,spe}=mon.stats;
  const bulk=Math.sqrt(Math.max(0,hp*Math.max(1,(def+spd)/2)));
  const physicalBulk=Math.sqrt(Math.max(0,hp*def));
  const specialBulk=Math.sqrt(Math.max(0,hp*spd));
  const offensive=Math.max(atk,spa)+bestPower*.35+stabPower*.22+setup*7+Math.min(20,usefulDamaging.length)*1.2;
  const offensivePhysical=physical.reduce((sum,m)=>sum+Math.min(120,Number(m.basePower)||0),0);
  const offensiveSpecial=special.reduce((sum,m)=>sum+Math.min(120,Number(m.basePower)||0),0);
  const redundancyPenalty=Math.max(0,usefulDamaging.length-4)*5 + Math.max(0,stab.length-2)*3;
  const defensiveTools=recoveryMoves.length+hazards+removal+pivot+Math.min(3,statusUtility)+defensiveSetup;
  const offensiveTools=usefulDamaging.length+setup+Math.min(3,coverageTypes.length);
  // Role inference is deliberately multi-factor. A setup move is evidence of
  // a possible gameplan, not proof that the Pokémon is a sweeper.
  const offensiveStat=Math.max(atk,spa);
  const physicalReady=atk>=95 && physical.length>=2;
  const specialReady=spa>=95 && special.length>=2;
  const fastEnough=spe>=90;
  const offensiveSetupNames=unique.filter(m=>/swords dance|nasty plot|dragon dance|quiver dance|shell smash|shift gear|victory dance|bulk up|curse|tail glow|work up|hone claws|rock polish|autotomize|agility|trailblaze|growth/i.test(String(m.name||'')));
  const defensiveSetupNames=unique.filter(m=>/iron defense|amnesia|cotton guard|acid armor|cosmic power|stockpile|calm mind/i.test(String(m.name||'')));
  const offensiveSetup=offensiveSetupNames.length;
  const defensiveSetupCount=defensiveSetupNames.length;
  const cap=capStatRatings({hp,atk,def,spa,spd,spe});
  const capDefensive=(cap.PT>=150 || cap.ST>=150);
  const strongCapDefense=(cap.PT>=180 && cap.ST>=130) || (cap.ST>=180 && cap.PT>=130);
  const defensiveBuild=
    capDefensive &&
    (recovery>=1 || defensiveTools>=2 || bulk>=245 || defensiveSetupCount>=1);
  const strongDefensiveBuild=
    strongCapDefense ||
    (recovery>=1 && (physicalBulk>=175 || specialBulk>=175)) ||
    (defensiveSetupCount>=1 && (physicalBulk>=180 || specialBulk>=180));
  const offensiveStatReady=(atk>=110 || spa>=110);
  const strongOffensiveStat=offensiveStat>=120;
  const setupOffenseFit=
    offensiveSetup>=1 &&
    offensiveStatReady &&
    usefulDamaging.length>=2 &&
    (fastEnough || spe>=80) &&
    strongOffensiveStat;
  const setupSweeperEligible=
    setupOffenseFit &&
    !strongDefensiveBuild &&
    !(defensiveSetupCount>=1 && defensiveBuild) &&
    !(recovery>=1 && capDefensive && defensiveTools>=2);
  const roleSignals={
    physicalSweeper: physicalReady*18 + Math.max(0,atk-100)*0.45 + physical.length*5 + (fastEnough?10:0) + (setupSweeperEligible&&atk>=spa?8:0),
    specialSweeper: specialReady*18 + Math.max(0,spa-100)*0.45 + special.length*5 + (fastEnough?10:0) + (setupSweeperEligible&&spa>atk?8:0),
    wallbreaker: Math.max(0,offensiveStat-105)*0.75 + usefulDamaging.filter(m=>(Number(m.basePower)||0)>=90).length*7 + (coverageTypes.length>=2?8:0) + (spe<85?8:0),
    bulkyAttacker: Math.max(0,bulk-235)*0.24 + Math.max(0,offensiveStat-90)*0.35 + recoveryQuality*0.14 + usefulDamaging.length*2,
    defensive:
      Math.max(0,physicalBulk-145)*0.44 +
      Math.max(0,specialBulk-145)*0.44 +
      recoveryQuality*0.34 +
      defensiveTools*4 +
      (cap.PT>=150?10:0) +
      (cap.ST>=150?10:0) +
      (defensiveSetupCount>=1?8:0) +
      (recovery>=1 && capDefensive?10:0),
    support: defensiveTools*6 + Math.max(0,bulk-240)*0.16 + Math.min(12,statusUtility*2) + (offensiveStat<100?6:0),
    pivot: pivot*28 + (spe>=70?8:0) + Math.min(8,statusUtility*2) + (usefulDamaging.length>=2?4:0),
    setupSweeper: setupSweeperEligible ? offensiveSetup*12 + (fastEnough?10:0) + usefulDamaging.length*3 + Math.max(0,offensiveStat-115)*0.3 : 0,
    hazard: hazards*40 + removal*8 + Math.min(6,statusUtility*2),
    screens: unique.some(m=>/reflect|light screen|aurora veil/i.test(String(m.name||''))) ? 50 + (pivot?15:0) + (spe>=90?10:0) : 0
  };
  const learn=learnsetRecord(mon);
  const moveDepth=mon.fake?unique.length:Math.max(unique.length,Object.keys(learn||{}).length);
  return {
    typing:typingProfile(mon.types),moves:unique,usefulMoves:useful,moveDepth,stabCount:stab.length,
    physical:physical.length,special:special.length,status:status.length,setup,recovery,hazards,removal,pivot,
    statusUtility,defensiveSetup,offensiveSetup,defensiveSetupCount,bestPower,stabPower,bulk,physicalBulk,specialBulk,speed:spe,offensive,
    offensivePhysical,offensiveSpecial,redundancyPenalty,recoveryQuality,recoveryMoves:recoveryMoves.length,recoveryMovesList,
    coverageTypes:coverageTypes.length,defensiveTools,offensiveTools,roleSignals,
    hp,atk,def,spa,spd,spe,
    maxOffensiveStat:Math.max(atk,spa),
    roleEligible:{setupSweeper:setupSweeperEligible,physicalSweeper:physicalReady,specialSweeper:specialReady},
    abilities:abilityNames(mon.abilities),bst:hp+atk+def+spa+spd+spe,
    primaryRole:choosePrimaryRole({hp,atk,def,spa,spd,spe,bulk,physicalBulk,specialBulk,
      recoveryMoves:recoveryMoves.length,defensiveTools,defensiveSetupCount,offensiveSetup,
      maxOffensiveStat:Math.max(atk,spa),usefulMoves:useful,roleSignals})
  };
}

function choosePrimaryRole(tf){
  const rs=tf?.roleSignals||{};
  const cap=capStatRatings({
    hp:Number(tf?.hp)||0, atk:Number(tf?.atk)||0, def:Number(tf?.def)||0,
    spa:Number(tf?.spa)||0, spd:Number(tf?.spd)||0, spe:Number(tf?.spe)||0
  });
  const PT=Number(cap?.PT)||0, ST=Number(cap?.ST)||0;
  const bulk=Number(tf?.bulk)||0, pbulk=Number(tf?.physicalBulk)||0, sbulk=Number(tf?.specialBulk)||0;
  const recovery=Number(tf?.recoveryMoves)||0, tools=Number(tf?.defensiveTools)||0;
  const defensiveSetup=Number(tf?.defensiveSetupCount)||0;
  const offensiveSetup=Number(tf?.offensiveSetup)||0;
  const maxOff=Number(tf?.maxOffensiveStat)||0;
  const useful=Number(tf?.usefulMoves?.length)||0;
  const speed=Number(tf?.spe)||0;

  const defensiveEvidence=
    (PT>=150 || ST>=150) &&
    (recovery>=1 || tools>=2 || bulk>=245 || defensiveSetup>=1);

  const strongDefensiveEvidence=
    (PT>=180 && ST>=130) ||
    (ST>=180 && PT>=130) ||
    (recovery>=1 && (pbulk>=175 || sbulk>=175)) ||
    (defensiveSetup>=1 && (pbulk>=180 || sbulk>=180));

  const genuineSetupEvidence=
    offensiveSetup>=1 &&
    maxOff>=120 &&
    useful>=2 &&
    speed>=80 &&
    Number(rs.setupSweeper||0)>=55 &&
    Number(rs.setupSweeper||0)>=Number(rs.defensive||0)*1.10;

  // Defensive identity wins unless the setup role has strong independent
  // offensive evidence. This is the single role decision used by summaries,
  // tiers, and matchup logic.
  if(strongDefensiveEvidence && !genuineSetupEvidence) return 'defensive';
  if(defensiveEvidence && !genuineSetupEvidence &&
     Number(rs.defensive||0)>=Number(rs.setupSweeper||0)*0.85) return 'defensive';

  const ranked=Object.entries(rs)
    .filter(([k])=>k!=='setupSweeper' || genuineSetupEvidence)
    .sort((a,b)=>b[1]-a[1]);
  return ranked[0]?.[0]||'wallbreaker';
}

function cheapProfile(mon){
  const s=mon.stats||{}; const hp=Number(s.hp)||0,def=Number(s.def)||0,spd=Number(s.spd)||0,atk=Number(s.atk)||0,spa=Number(s.spa)||0,spe=Number(s.spe)||0;
  const typing=typingProfile(mon.types);
  const bulk=Math.sqrt(Math.max(0,hp*Math.max(1,(def+spd)/2)));
  const offensive=Math.max(atk,spa)+Math.min(160,Math.max(atk,spa)*.55);
  return {typing,bulk,offensive,speed:spe,bst:hp+atk+def+spa+spd+spe,abilities:abilityNames(mon.abilities),types:mon.types||[]};
}
function similarity(target,p,tf,pf,usage){
  // Exact-data matches should be exactly 100%. This is important when the user
  // compares a Fakemon copied from a vanilla species.
  const sameStats=STAT_KEYS.every(k=>Number(target.stats?.[k]||0)===Number(p.stats?.[k]||0));
  const sameTypes=JSON.stringify((target.types||[]).map(String))===JSON.stringify((p.types||[]).map(String));
  const targetAbilities=abilityNames(target.abilities).map(normalizeName).sort();
  const pokemonAbilities=abilityNames(p.abilities).map(normalizeName).sort();
  const sameAbilities=JSON.stringify(targetAbilities)===JSON.stringify(pokemonAbilities);
  if(sameStats && sameTypes && sameAbilities) return 100;

  const stat=mean(STAT_KEYS.map(k=>100-Math.min(100,Math.abs((target.stats?.[k]||0)-(p.stats?.[k]||0))*1.15)));
  const typeOverlap=(target.types||[]).filter(t=>(p.types||[]).includes(t)).length/Math.max(1,Math.max(target.types?.length||0,p.types?.length||0));
  const type=100-Math.min(100,Math.abs(tf.typing.score-pf.typing.score)*1.2);
  // Compare the same cheap role values on both sides. The old version compared
  // detailed target offense to cheap Pokémon offense, which prevented exact
  // matches from ever reaching 100%.
  const targetCheap={bulk:tf.bulk,offensive:Math.max(target.stats?.atk||0,target.stats?.spa||0)+Math.min(160,Math.max(target.stats?.atk||0,target.stats?.spa||0)*.55),speed:target.stats?.spe||0};
  const role=100-Math.min(100,Math.abs(targetCheap.bulk-pf.bulk)*.48+Math.abs(targetCheap.offensive-pf.offensive)*.32+Math.abs(targetCheap.speed-pf.speed)*.58);
  const sharedAbility=targetAbilities.some(a=>pokemonAbilities.includes(a))?100:0;
  return clamp(stat*.42+typeOverlap*100*.16+type*.10+role*.27+sharedAbility*.05);
}

// A handful of moves change their effective type depending on the user's
// forme/held mask rather than having a fixed type in the generic move data.
// The shared move index has no per-Pokemon awareness, so without this
// override every Ogerpon forme is scored as if its signature move were the
// base Grass-type Ivy Cudgel, which badly misrepresents Hearthflame (Fire),
// Wellspring (Water), and Cornerstone (Rock) in both directions of a matchup.
function normalizeForForme(move, mon){
  if(!move) return move;
  const moveName=normalizeName(move.name);
  if(moveName!=='ivycudgel') return move;
  const forme=normalizeName(mon?.forme||mon?.name||'');
  let type=move.type;
  if(forme.includes('wellspring')) type='Water';
  else if(forme.includes('hearthflame')) type='Fire';
  else if(forme.includes('cornerstone')) type='Rock';
  else type='Grass';
  return type===move.type ? move : {...move,type};
}
function getAnalysisMoves(mon){
  const moves=(mon?.fake ? mon.learnset||[] : learnsetMoves(mon)).map(moveData).filter(Boolean).map(m=>normalizeForForme(m,mon));
  const unique=[...new Map(moves.map(m=>[normalizeName(m.name),m])).values()];
  const useful=unique.filter(m=>{
    try{return sampleMoveIsActuallyUseful(m,{stats:mon?.stats||{},types:mon?.types||[],abilities:abilityNames(mon?.abilities),moves:unique},null);}catch{return false;}
  });
  const pool=(useful.length>=4?useful:unique).filter(m=>isRealisticDamageMove(m));
  return pool;
}

function isRealisticDamageMove(move){
  if(!move || !['Physical','Special'].includes(move.category)) return false;
  const bp=Number(move.basePower)||0;
  const moveName=String(move.name||'').trim();
  const dynamicPowerMoves=new Set([
    'Stored Power','Power Trip','Punishment','Rage Fist','Electro Ball',
    'Gyro Ball','Low Kick','Grass Knot','Heavy Slam','Heat Crash',
    'Wring Out','Crush Grip','Facade','Hex','Acrobatics','Payback',
    'Flail','Reversal','Eruption','Water Spout','Dragon Energy',
    'Last Respects','Weather Ball','Terrain Pulse','Nature Power'
  ]);
  const descForPower=String(move.desc||move.description||'').toLowerCase();
  const dynamicPowerDescription=/(?:power|damage) (?:is|will be|depends|varies|changes|calculated).*?(?:based|depending|number|stat|weight|hp|status|boost|turn|condition)/i.test(descForPower);
  if(bp<=0 && !dynamicPowerMoves.has(moveName) && !dynamicPowerDescription) return false;

  const name=String(move.name||'').toLowerCase().trim();
  const desc=String(move.desc||move.description||'').toLowerCase();
  const text=`${name} ${desc}`;

  // The matchup model is intentionally conservative. Only use attacks whose
  // damage is reasonably reproducible from the information we actually have.
  const blockedNames=[
    'explosion','self-destruct','misty explosion',
    'future sight','doom desire',
    'focus punch','shell trap','beak blast',
    'counter','mirror coat','metal burst',
    'endeavor','final gambit','comeuppance',
    'venoshock'
  ];
  if(blockedNames.includes(name)) return false;

  const unrealistic=[
    /(?:two|2)[ -]?turn/,
    /must recharge|recharge(?:s|d)? after/,
    /user faints|user sacrifices itself|user faints/,
    /fails if|only works if|only if/,
    /when .* is (?:asleep|poisoned|burned|paralyzed|frozen|confused)/,
    /if the (?:user|target) (?:has|is|was|gets)/,
    /target is asleep|target is poisoned|target is burned|target is paralyzed|target is frozen/,
    /based on (?:the target's|the user's|target's|user's)/,
    /current hp|remaining hp|missing hp/,
    /weight of|user's weight|target's weight/,
    /ally|adjacent ally|partner/,
    /delayed|future turn|after two turns|two turns later/,
    /takes .* turn to/,
    /revenge|retaliat|avenges/,
    /damage doubles|power doubles|power is doubled/,
    /if .* (?:moves first|moves last|went first|went last)/,
    /last move|previous move|move used last/,
    /stockpile|charge|rampage|outrage.*confus/,
    /hits (?:2|2-5|2 to 5|2–5) times|2-5 times/
  ];
  if(unrealistic.some(rx=>rx.test(text))) return false;

  return true;
}

function battleStatsFromBase(stats={}){
  // We only know the displayed base stats. To make damage/OHKO math meaningful
  // without inventing a custom EV spread, model a neutral level-100 Pokémon with
  // 31 IVs, 0 EVs, no item, and no temporary boosts.
  const b=k=>Math.max(0,Number(stats[k])||0);
  return {
    hp:2*b('hp')+31+110,
    atk:2*b('atk')+31+5,
    def:2*b('def')+31+5,
    spa:2*b('spa')+31+5,
    spd:2*b('spd')+31+5,
    spe:2*b('spe')+31+5
  };
}

function damageRange(attacker, defender, move){
  if(!move || !['Physical','Special'].includes(move.category)) return null;
  const bp=Number(move.basePower)||0;
  if(bp<=0) return null;
  const a=battleStatsFromBase(attacker?.stats||{});
  const d=battleStatsFromBase(defender?.stats||{});
  const attack=move.category==='Physical'?a.atk:a.spa;
  const defense=move.category==='Physical'?d.def:d.spd;
  if(attack<=0||defense<=0) return null;

  // Type immunities from abilities are part of the matchup, not optional flavor.
  // The previous implementation only looked at typing, so Water Absorb was
  // effectively invisible to the matchup engine.
  const defenderAbilities=abilityNames(defender?.abilities).map(normalizeName);
  const attackerAbilities=abilityNames(attacker?.abilities).map(normalizeName);
  const bypassesAbility=attackerAbilities.some(a=>['moldbreaker','teravolt','turboblaze','myceliummight'].includes(a));
  const abilityImmunity={
    water:['waterabsorb','stormdrain','dryskin'],
    electric:['voltabsorb','motordrive','lightningrod'],
    fire:['flashfire'],
    grass:['sapsipper'],
    ground:['levitate','eartheater']
  };
  const immuneByAbility=!bypassesAbility && (abilityImmunity[normalizeName(move.type)]||[]).some(a=>defenderAbilities.includes(a));
  const typeMult=immuneByAbility ? 0 : (defender?.types||[]).reduce((x,t)=>x*typeEffectivenessOf(move.type,t),1);
  if(typeMult===0) return {move,damageMin:0,damageMax:0,expected:0,typeMult,stab:0,accuracy:0,ohkoChance:0,possibleOHKO:false,guaranteedOHKO:false,abilityImmune:immuneByAbility};

  const stab=(attacker?.types||[]).includes(move.type)?1.5:1;
  const accuracyRaw=Number(move.accuracy);
  const accuracy=Number.isFinite(accuracyRaw)?Math.max(0,Math.min(100,accuracyRaw)):100;

  // Ability modifiers. No external team/turn state is tracked, so only
  // abilities whose effect is fully determined by the attacker's own kit are
  // modeled - self-sufficient weather setters (a Pokemon with Drought always
  // has sun up while it's out, so its own boosted moves are a real, reliable
  // part of its damage output), flat attack multipliers, and STAB/power
  // modifiers. Field effects that depend on a teammate or the opponent (e.g.
  // an ally's Drought, Electric Terrain from something else) are still
  // deliberately omitted, since assuming them would be guessing team context
  // this tool doesn't have.
  const moveTypeNorm=normalizeName(move.type);
  const moveText=`${String(move.name||'')} ${String(move.desc||move.description||'')}`.toLowerCase();
  const hasSecondaryEffect=/chance to|10% chance|20% chance|30% chance|100% chance to (?:lower|raise|confuse|flinch|burn|paralyze|poison|freeze)/.test(moveText);
  const selfWeather=
    attackerAbilities.includes('drought')||attackerAbilities.includes('orichalcumpulse')||attackerAbilities.includes('desolateland') ? 'sun' :
    attackerAbilities.includes('drizzle')||attackerAbilities.includes('primordialsea') ? 'rain' :
    attackerAbilities.includes('sandstream') ? 'sand' :
    attackerAbilities.includes('snowwarning') ? 'snow' : null;
  let abilityAttackMult=1, abilityPowerMult=1, abilityStabMult=1;
  if(attackerAbilities.includes('hugepower')||attackerAbilities.includes('purepower')){
    if(move.category==='Physical') abilityAttackMult*=2;
  }
  if(attackerAbilities.includes('adaptability')) abilityStabMult=(stab>1?2:1)/stab; // turns 1.5x STAB into 2x
  if(attackerAbilities.includes('technician') && bp<=60) abilityPowerMult*=1.5;
  if(attackerAbilities.includes('sheerforce') && hasSecondaryEffect) abilityPowerMult*=1.3;
  if(selfWeather==='sun'){
    if(moveTypeNorm==='fire') abilityPowerMult*=1.5;
    else if(moveTypeNorm==='water') abilityPowerMult*=0.5;
    // Orichalcum Pulse (Koraidon) is an Atk boost on top of sun's Fire boost,
    // not a Fire-type-exclusive effect - it applies to any physical attack.
    if(attackerAbilities.includes('orichalcumpulse') && move.category==='Physical') abilityAttackMult*=1.33;
    if(attackerAbilities.includes('solarpower') && move.category==='Special') abilityAttackMult*=1.5;
  } else if(selfWeather==='rain'){
    if(moveTypeNorm==='water') abilityPowerMult*=1.5;
    else if(moveTypeNorm==='fire') abilityPowerMult*=0.5;
  } else if(selfWeather==='sand'){
    // Sand Force boosts Rock/Ground/Steel moves; only meaningful when the
    // attacker is also its own sand setter under this self-sufficient model.
    if(attackerAbilities.includes('sandforce') && ['rock','ground','steel'].includes(moveTypeNorm)) abilityPowerMult*=1.3;
  }
  if(attackerAbilities.includes('tintedlens') && typeMult<1) abilityPowerMult*=2;

  const base=Math.floor(Math.floor(Math.floor((2*100/5+2)*bp*attack*abilityAttackMult/defense)/50)+2);
  // Crit/item/terrain information is still unavailable, so those remain
  // deliberately omitted - only the ability effects above are modeled.
  const modifier=stab*abilityStabMult*typeMult*abilityPowerMult;
  const rolls=Array.from({length:16},(_,i)=>(85+i)/100);
  const damages=rolls.map(r=>Math.floor(base*modifier*r));
  const damageMin=Math.min(...damages),damageMax=Math.max(...damages);
  const expectedRaw=damages.reduce((a,b)=>a+b,0)/damages.length;
  const expected=expectedRaw*(accuracy/100);
  const hp=battleStatsFromBase(defender?.stats||{}).hp;
  const koRolls=damages.filter(x=>x>=hp).length;
  const ohkoChance=(accuracy/100)*(koRolls/16);
  return {
    move,
    category:move.category,
    power:bp,
    attackStat:move.category==='Physical'?'atk':'spa',
    defenseStat:move.category==='Physical'?'def':'spd',
    attack,defense,hp,
    typeMult,stab,accuracy,
    damageMin,damageMax,expected,
    possibleOHKO:damageMax>=hp,
    guaranteedOHKO:damageMin>=hp,
    ohkoChance
  };
}

function moveStrategicScore(result, defender){
  if(!result) return -Infinity;
  const mult=Number(result.typeMult)||0;
  const expected=Number(result.expected)||0;
  const bp=Number(result.power)||0;
  const accuracy=(Number(result.accuracy)||100)/100;
  if(expected<=0 || mult<=0) return -Infinity;
  const effectivenessPriority=mult>=4?4:mult>=2?3:mult===1?1:0;
  return effectivenessPriority*1000000 + expected*100 + Math.min(20,bp/10) + accuracy;
}

function strategicallyRelevantMoves(candidates){
  const usable=candidates.filter(x=>x && Number(x.expected)>0 && Number(x.typeMult)>0);
  if(!usable.length)return [];
  const groups={se:[],neutral:[],resisted:[]};
  for(const r of usable){
    if(Number(r.typeMult)>1)groups.se.push(r);
    else if(Number(r.typeMult)===1)groups.neutral.push(r);
    else groups.resisted.push(r);
  }
  const cmp=(a,b)=>{
    const ea=Number(a.typeMult)||0, eb=Number(b.typeMult)||0;
    if(eb!==ea)return eb-ea;
    return (Number(b.expected)||0)-(Number(a.expected)||0) ||
      (Number(b.damageMax)||0)-(Number(a.damageMax)||0) ||
      (Number(b.accuracy)||100)-(Number(a.accuracy)||100);
  };
  Object.values(groups).forEach(g=>g.sort(cmp));
  const selected=[], seen=new Set(), seenTypes=new Set();
  const add=(r,force=false)=>{
    if(!r||selected.length>=10)return false;
    const n=normalizeName(r.move?.name), t=normalizeName(r.move?.type), c=r.category||r.move?.category||'';
    if(!n||seen.has(n))return false;
    const key=t+':'+c;
    if(!force && selected.length<10 && seenTypes.has(key))return false;
    selected.push(r);seen.add(n);seenTypes.add(key);return true;
  };
  // Hard priority: take the strongest SE coverage first. Keep several distinct
  // types/categories so a matchup reflects actual coverage instead of one move.
  for(const r of groups.se){ if(selected.length>=10)break; add(r,selected.length<6); }
  // If fewer than 5 SE attacks exist, fill remaining slots with the strongest
  // neutral attacks, then resisted attacks only as fallback.
  for(const r of groups.neutral){ if(selected.length>=10)break; add(r,false); }
  for(const r of groups.resisted){ if(selected.length>=10)break; add(r,false); }
  // Guarantee the top damage representatives are retained even when they share
  // a category/type with another selected move.
  for(const r of [...groups.se,...groups.neutral]){ if(selected.length>=10)break; add(r,true); }
  return selected.slice(0,10);
}

function bestDamageOutput(attacker, defender){
  const candidates=getAnalysisMoves(attacker)
    .map(m=>damageRange(attacker,defender,m))
    .filter(Boolean);
  if(!candidates.length)return {best:null,all:[],topMoves:[],hasAttack:false,bestSuperEffective:null,bestNeutral:null,bestResisted:null};

  const relevant=strategicallyRelevantMoves(candidates);
  const se=relevant.filter(x=>Number(x.typeMult)>1);
  const neutral=relevant.filter(x=>Number(x.typeMult)===1);
  const resisted=relevant.filter(x=>Number(x.typeMult)>0 && Number(x.typeMult)<1);
  // The primary attack is ALWAYS the strongest usable SE attack. Neutral damage is
  // only relevant if no SE coverage exists. This is deliberately not a raw-DPS sort.
  const best=se[0]||neutral[0]||resisted[0]||null;
  return {
    best,all:candidates,topMoves:relevant,hasAttack:true,
    bestSuperEffective:se[0]||null,bestNeutral:neutral[0]||null,bestResisted:resisted[0]||null,
    superEffectiveMoves:se,neutralMoves:neutral,resistedMoves:resisted
  };
}

function speedRelation(attacker, defender){
  const a=Number(attacker?.stats?.spe)||0;
  const d=Number(defender?.stats?.spe)||0;
  if(a>d)return 'outspeeds';
  if(a<d)return 'underspeeds';
  return 'speed tie';
}

function matchupDetails(attacker, defender){
  const offense=bestDamageOutput(attacker,defender);
  const reverse=bestDamageOutput(defender,attacker);
  const aSpeed=Number(attacker?.stats?.spe)||0;
  const dSpeed=Number(defender?.stats?.spe)||0;
  const speed=speedRelation(attacker,defender);
  const attackerHP=battleStatsFromBase(attacker?.stats||{}).hp;
  const defenderHP=battleStatsFromBase(defender?.stats||{}).hp;

  // Use the strongest coverage attack first, but also inspect the next several
  // strategically distinct attacks. This prevents a single awkward move from
  // deciding the entire matchup.
  const pressure=offense.best?.expected||0;
  const enemyPressure=reverse.best?.expected||0;
  const myHits=pressure>0?Math.ceil(defenderHP/pressure):Infinity;
  const enemyHits=enemyPressure>0?Math.ceil(attackerHP/enemyPressure):Infinity;
  const firstStrike=aSpeed>dSpeed?'attacker':dSpeed>aSpeed?'defender':'tie';
  const attackerWinsRace=Number.isFinite(myHits)&&(!Number.isFinite(enemyHits)||myHits<enemyHits||(myHits===enemyHits&&firstStrike!=='defender'));
  const defenderWinsRace=Number.isFinite(enemyHits)&&(!Number.isFinite(myHits)||enemyHits<myHits||(enemyHits===myHits&&firstStrike!=='attacker'));

  // A second check uses the top three relevant attacks on each side. This is a
  // coverage sanity check: if the opponent has several ways to hit us SE, the
  // matchup must not be rescued by one favorable neutral move.
  const weightedPressure=moves=>{
    const arr=(moves||[]).slice(0,3).map(x=>Number(x.expected)||0);
    return arr.length?(arr[0]*.65+(arr[1]||arr[0])*.23+(arr[2]||arr[1]||arr[0])*.12):0;
  };
  const myCoveragePressure=weightedPressure(offense.topMoves);
  const enemyCoveragePressure=weightedPressure(reverse.topMoves);
  const myCoveragePct=defenderHP?myCoveragePressure/defenderHP:0;
  const enemyCoveragePct=attackerHP?enemyCoveragePressure/attackerHP:0;

  let raceScore=50;
  if(attackerWinsRace&&!defenderWinsRace)raceScore=100;
  else if(defenderWinsRace&&!attackerWinsRace)raceScore=0;
  // If the hit counts tie, first strike decides. If they do not tie, the faster
  // side can still be favored when the damage exchange is materially better.
  if(raceScore===50){
    const ratio=(myCoveragePct+0.001)/(enemyCoveragePct+0.001);
    raceScore=clamp(50+Math.log(ratio)*35+(aSpeed>dSpeed?8:dSpeed>aSpeed?-8:0));
  }

  return {
    offense,reverse,speed,
    attackerSpeed:aSpeed,defenderSpeed:dSpeed,
    attackerOutspeeds:aSpeed>dSpeed,defenderOutspeeds:dSpeed>aSpeed,
    pressure,enemyPressure,myHits,enemyHits,firstStrike,raceScore,
    attackerWinsRace,defenderWinsRace,
    attackerMoves:offense.topMoves||[],defenderMoves:reverse.topMoves||[],
    attackerBestSE:offense.bestSuperEffective,defenderBestSE:reverse.bestSuperEffective,
    myCoveragePressure,enemyCoveragePressure,myCoveragePct,enemyCoveragePct
  };
}


function movePressure(attacker, defender){
  // Compatibility wrapper for the broader analysis: use the actual best
  // expected damage rather than a base-power/stat-ratio proxy.
  return bestDamageOutput(attacker,defender).best?.expected||0;
}

function defensivePressure(defender, attacker){
  const d=defender?.stats||{}, a=attacker?.stats||{};
  const physical=Math.sqrt(Math.max(1,(Number(d.hp)||0)*(Number(d.def)||0)));
  const special=Math.sqrt(Math.max(1,(Number(d.hp)||0)*(Number(d.spd)||0)));
  const incoming=fastMatchupScore(attacker,defender);
  const type=defensiveTypeMatchup(defender?.types,attacker?.types);
  const bulk=Math.max(physical,special);
  const recovery=defender?.__analysisRecovery?1.08:1;
  return {bulk,type,incoming,recovery};
}

function sigmoidScore(value, low, high){
  if(!Number.isFinite(value)) return 0;
  const x=(value-low)/Math.max(1,high-low);
  return clamp(100/(1+Math.exp(-5*(x-.5))));
}

const CAP_SPEED_FACTOR_TABLE=[
  [10,0.00],[15,0.01],[20,0.02],[25,0.04],[30,0.06],[35,0.12],
  [40,0.17],[45,0.23],[50,0.29],[55,0.37],[60,0.42],[65,0.49],
  [70,0.55],[75,0.62],[80,0.65],[85,0.71],[90,0.77],[95,0.82],
  [100,0.87],[105,0.92],[110,0.94],[115,0.95],[120,0.97],[130,0.98],
  [150,0.99],[999,1.00]
];

function capSpeedFactor(baseSpeed){
  const s=Math.max(0,Number(baseSpeed)||0);
  for(const [max,factor] of CAP_SPEED_FACTOR_TABLE){
    if(s<=max)return factor;
  }
  return 1;
}

function capNormalizeStats(tf){
  const hp=Math.max(1,Number(tf.hp)||0)/4+18;
  return {
    hp,
    atk:(Number(tf.atk)||0)+18,
    def:(Number(tf.def)||0)+18,
    spa:(Number(tf.spa)||0)+18,
    spd:(Number(tf.spd)||0)+18,
    speedFactor:capSpeedFactor(tf.spe)
  };
}

function capStatRatings(tf){
  const n=capNormalizeStats(tf);
  const PT=n.hp*n.def/35;
  const ST=n.hp*n.spd/35;
  const PS=n.atk*(n.atk*n.speedFactor+315)/(n.atk*(1-n.speedFactor)+315);
  const SS=n.spa*(n.spa*n.speedFactor+315)/(n.spa*(1-n.speedFactor)+315);
  const modifier=x=>x>100?(3*x*x-600*x+81200)/51200:1;
  const MPT=modifier(PT),MPS=modifier(PS),MST=modifier(ST),MSS=modifier(SS);
  const M=MPT*MPS*MST*MSS;
  const bsr=Math.round(PT*ST*(PS+SS)*M/(56*(PT+ST)));
  const safeRatio=(a,b)=>Math.max(1e-9,a)/Math.max(1e-9,b);
  const ODB=55*Math.log(safeRatio(Math.max(PS,SS),Math.max(PT,ST)));
  const PSB=55*Math.log(safeRatio(PT*PS,ST*SS));
  const category=bsr>1400?'Exaggerated':
    bsr>=900?'Too Good':
    bsr>=580?'Fantastic':
    bsr>=420?'Excellent':
    bsr>=300?'Very Good':
    bsr>=250?'Quite Good':
    bsr>=210?'Good':
    bsr>=175?'Average':
    bsr>=143?'Below Average':
    bsr>=127?'Poor':
    bsr>=100?'Bad':'Horrible';
  return {
    normalized:n,PT,ST,PS,SS,ODB,PSB,
    modifiers:{MPT,MPS,MST,MSS,M},
    BSR:bsr,category,
    maxTankiness:Math.max(PT,ST),
    maxSweepiness:Math.max(PS,SS)
  };
}

function capStatPowerScore(cap){
  const b=Number(cap?.BSR)||0;
  // This is a display/combination score, not a tier conversion.
  // It follows CAP's BSR bands while leaving the actual tier decision to the
  // metagame + matchup model.
  if(b>=1400)return 100;
  if(b>=900)return 94+Math.min(6,(b-900)/83.333);
  if(b>=580)return 82+(b-580)/40;
  if(b>=420)return 72+(b-420)/16;
  if(b>=300)return 60+(b-300)/12;
  if(b>=250)return 54+(b-250)/10;
  if(b>=210)return 49+(b-210)/10;
  if(b>=175)return 44+(b-175)/8.75;
  if(b>=143)return 38+(b-143)/5.333;
  if(b>=127)return 32+(b-127)/2.667;
  if(b>=100)return 24+(b-100)/3.846;
  return Math.max(5,24*b/100);
}

function intrinsicPowerProfile(tf, abilityInfo){
  const cap=capStatRatings(tf);
  const statPower=capStatPowerScore(cap);

  const recovery=Number(tf.recovery)||0;
  const setup=Number(tf.setup)||0;
  const defensiveTools=Number(tf.defensiveTools)||0;
  const offensiveTools=Number(tf.offensiveTools)||0;
  const physicalBulk=Number(tf.physicalBulk)||0;
  const specialBulk=Number(tf.specialBulk)||0;
  const atk=Number(tf.atk)||0;
  const spa=Number(tf.spa)||0;
  const spe=Number(tf.spe)||0;

  // CAP BSR is the foundation. Kit synergies are deliberately separate so
  // stats alone do not decide a tier, but a ridiculous stat architecture
  // cannot be hidden by a crude matchup approximation.
  const bulkPower=clamp((cap.PT*.55+cap.ST*.45)/1.55);
  const offensePower=clamp((cap.PS*.6+cap.SS*.4)/1.55);
  // Lacking a dedicated recovery move is only a real liability if the kit has
  // nothing else to fall back on. A specialist utility kit (hazard removal,
  // a safe pivot move, and real status control) lets a wall keep functioning
  // and keep making progress without ever needing to heal off damage itself -
  // Parting Shot into a fresh attacker or Mortal Spin clearing hazards does a
  // lot of the same job Recover/Roost would. Only apply the full "no recovery"
  // penalty when the mon doesn't have that kind of specialist toolkit to lean on.
  const noRecoveryPenalty=recovery?0:(defensiveTools>=4?1:5);
  const counterplay=clamp(
    50 +
    (spe<60?9:spe<80?4:spe>=110?-7:0) +
    (tf.typing.weak>=5?7:tf.typing.weak>=3?3:-3) +
    (tf.typing.severe>=1?6:0) +
    (recovery? -8:noRecoveryPenalty) +
    (setup? -5:0) +
    (recovery&&setup ? -8:0) +
    (defensiveTools<=1?5:0)
  );

  // These are kit synergies layered on top of the CAP stat architecture.
  const setupBulkSynergy=setup>=1 && (cap.PT>=150 || cap.ST>=125) ? 15 : 0;
  const setupRecoverySynergy=setup>=1 && recovery>=1 ? 15 : 0;
  const recoveryBulkSynergy=recovery>=1 && cap.PT>=180 && cap.ST>=120 ? 18 : 0;
  const recoveryExtremeSynergy=recovery>=1 && cap.BSR>=900 ? 12 : 0;
  const setupExtremeSynergy=setup>=1 && cap.BSR>=900 ? 12 : 0;
  const roleCompression=(recovery&&tf.pivot?5:0)+(tf.statusUtility>=2&&recovery?4:0)+(tf.hazards&&tf.removal?4:0);

  // Move quality was previously uncredited here entirely - a mon's tier score
  // was driven almost purely by raw stat architecture (BSR) plus a few narrow
  // setup/recovery combos, so two Pokemon with identical stats scored
  // identically regardless of whether one had genuinely strong STAB/coverage
  // and the other had a mediocre movepool. This rewards strong STAB power,
  // real coverage breadth, and a healthy offensive toolkit directly, capped so
  // it can meaningfully lift a well-equipped unique mon without letting move
  // count alone fake its way to a high score.
  const moveQuality=clamp(
    Math.max(0,(Number(tf.stabPower)||0)-80)*.28 +
    Math.max(0,(Number(tf.bestPower)||0)-80)*.16 +
    Math.min(16,(Number(tf.coverageTypes)||0)*4) +
    Math.min(10,Math.max(0,(Number(tf.offensiveTools)||0)-3)*2.5)
  ,0,32);

  // Symmetrically, a specialized defensive/utility kit was uncredited too. CAP's
  // BSR formula multiplies physical and special bulk together, so a mon that
  // specializes hard into one side of bulk (a very common real wall pattern -
  // e.g. strong Special Defense with only middling Defense) posts a lower BSR
  // than a mon with the same total bulk spread evenly, even when a genuinely
  // excellent utility kit (recovery + hazard/status control + a safe pivot
  // move) is exactly what makes that kind of specialist actually good. This
  // credits that kit directly rather than trying to rebalance the BSR formula
  // itself (which is meant to mirror CAP's own math). Gated to mons with at
  // least moderate bulk on one side, so it rewards a genuine specialist wall
  // rather than inflating an unrelated frail utility mon.
  const isBulkySide=cap.PT>=110 || cap.ST>=140;
  const recoveryTerm=(Number(tf.recoveryQuality)||0)>=70?12:(Number(tf.recoveryQuality)||0)>0?6:0;
  const defensiveUtility=isBulkySide?clamp(
    recoveryTerm +
    Math.min(10,(Number(tf.removal)||0)*10) +
    Math.min(8,(Number(tf.pivot)||0)*8) +
    Math.min(8,Math.min(3,Number(tf.statusUtility)||0)*3) +
    Math.min(6,(Number(tf.hazards)||0)*6) +
    ((Number(tf.defensiveTools)||0)>=4?6:(Number(tf.defensiveTools)||0)>=2?3:0)
  ,0,36):0;

  // An elite, format-defining ability (Wonder Guard, Neutralizing Gas, Good As
  // Gold, etc.) or a strong one should meaningfully move a Fakemon's own tier
  // estimate, not just show up as a text bullet. abilityInfo.score is -1/0/1/2
  // from abilityQuality(); scale it into the same 0-100 space as the rest of
  // this profile.
  const abilityBonus=abilityInfo?.score>=2?16:abilityInfo?.score===1?7:abilityInfo?.score===-1?-10:0;

  const extremeStatCount=[
    Number(tf.hp)>=140?1:0,
    Number(tf.def)>=160?1:0,
    Number(tf.spd)>=120?1:0,
    Math.max(atk,spa)>=155?1:0,
    spe>=130?1:0
  ].reduce((a,b)=>a+b,0);

  const brokenDefensiveSetup=setup>=1&&recovery>=1&&cap.PT>=220&&cap.ST>=150;
  const brokenBulkRecovery=recovery>=1&&cap.PT>=250&&cap.ST>=160;
  const brokenOffensiveSetup=setup>=1&&cap.PS>=180&&spe>=90&&offensiveTools>=3;

  const brokenKit=brokenDefensiveSetup||brokenBulkRecovery||brokenOffensiveSetup;
  const synergy=setupBulkSynergy+setupRecoverySynergy+recoveryBulkSynergy+
    recoveryExtremeSynergy+setupExtremeSynergy+roleCompression;

  // Preserve a 0-100 intrinsic scale, but let CAP's nonlinear BSR do the
  // heavy lifting instead of a pile of arbitrary stat bonuses.
  // defensiveUtility is weighted a bit higher than moveQuality: CAP's BSR is
  // built around offensive stat architecture, so it structurally has nothing
  // to say about a mon whose entire competitive job is pivoting, clearing
  // hazards, and spreading status. Without a stronger multiplier here, a real
  // defensive specialist (good bulk + full utility kit, no big offensive
  // stats) was scoring like an unremarkable mon instead of like the wall it is.
  const score=clamp(statPower*.68+Math.min(18,synergy)+Math.min(8,extremeStatCount*2)+moveQuality*.4+defensiveUtility*.55+abilityBonus);

  return {
    score,
    statPower,
    bulkPower,
    offensePower,
    counterplay,
    moveQuality,
    defensiveUtility,
    abilityBonus,
    cap,
    brokenKit,
    brokenDefensiveSetup,
    brokenBulkRecovery,
    brokenOffensiveSetup,
    components:{
      BSR:cap.BSR,
      statPower,
      PT:cap.PT,
      ST:cap.ST,
      PS:cap.PS,
      SS:cap.SS,
      ODB:cap.ODB,
      PSB:cap.PSB,
      synergy,
      counterplay,
      moveQuality,
      defensiveUtility,
      abilityBonus
    }
  };
}

// Accepts either a raw types array or a Pokemon-shaped object (falls back to
// its .types) so a caller passing the wrong shape degrades gracefully instead
// of silently scoring every matchup as perfectly neutral.
function coerceTypes(v){
  if(Array.isArray(v)) return v.filter(Boolean);
  if(v && Array.isArray(v.types)) return v.types.filter(Boolean);
  return [];
}
function offensiveTypeMatchup(attackingTypes, defendingTypes){
  const atk = coerceTypes(attackingTypes);
  const def = coerceTypes(defendingTypes);
  if (!atk.length || !def.length) return 1;

  let best = 0;
  for (const a of atk) {
    let mult = 1;
    for (const d of def) mult *= typeEffectivenessOf(a,d);
    best = Math.max(best, mult);
  }
  return best || 1;
}

function defensiveTypeMatchup(defendingTypes, attackingTypes){
  const def = coerceTypes(defendingTypes);
  const atk = coerceTypes(attackingTypes);
  if (!def.length || !atk.length) return 1;

  let worst = 1;
  for (const a of atk) {
    let mult = 1;
    for (const d of def) mult *= typeEffectivenessOf(a,d);
    worst = Math.max(worst, mult);
  }
  return worst;
}

function fastMatchupScore(attacker,defender){
  const a=attacker?.stats||{},d=defender?.stats||{};
  const speed=Number(a.spe)||0, enemySpeed=Number(d.spe)||0;
  const offType=offensiveTypeMatchup(attacker?.types,defender?.types);
  const inType=defensiveTypeMatchup(attacker?.types,defender?.types);
  const pressure=movePressure(attacker,defender);
  const enemyPressure=movePressure(defender,attacker);
  const atkPressure=clamp(50+Math.log10(Math.max(1,pressure)/Math.max(1,enemyPressure))*24);
  const typeScore=offType===0?-25:offType>=4?24:offType>=2?17:offType===1?4:offType<=.5?-10:0;
  const switchScore=inType===0?22:inType<=.25?19:inType<=.5?12:inType<=1?4:inType>=4?-22:inType>=2?-13:0;
  const speedScore=speed>=enemySpeed?(speed>=enemySpeed*1.12?10:5):(speed*1.12<enemySpeed?-10:-4);
  return clamp(50+(atkPressure-50)*.50+typeScore+switchScore+speedScore);
}
function tierComparablePool(pool, tierUsage, assignedTier, officialTiers, cfg){
  const wanted=String(assignedTier||'').toLowerCase()==='uber'?'ubers':String(assignedTier||'').toLowerCase();
  if(!wanted) return {pool:[],usage:{}};
  const usage=tierUsage?.[wanted]||{};

  // IMPORTANT: usage files are not tier lists. They can contain LC/NFE/lower-tier
  // Pokémon that received a tiny amount of OU usage. Previously, when
  // officialTierOf() returned null for LC/NFE/Illegal, the fallback below accepted
  // any Pokémon with usage > 0, which is how Surskit/Haunter could leak into OU.
  // Only use usage as evidence after an official tier check when a record exists.
  const comparable=pool.filter(p=>{
    const name=p?.name||p?.id||'';
    const ids=[
      normalizeName(name),
      normalizeName(String(name).replace(/[- ](alola|galar|hisui|paldea|totem)$/i,''))
    ];
    const officialRecord=ids.map(id=>officialTiers?.[id]).find(Boolean);
    if(officialRecord){
      const official=officialTierOf(name,officialTiers,cfg);
      if(!official) return false; // Explicit LC/NFE/Illegal (or otherwise unusable) tier.
      const cls=String(official).toLowerCase()==='uber'?'ubers':String(official).toLowerCase();
      return cls===wanted && usageOf(name,usage)>0;
    }
    // No official record: usage can be used as a last-resort fallback.
    return usageOf(name,usage)>0;
  });
  return {pool:comparable,usage};
}

function buildMatchupProfile(target,pool,usage,targetProfile){
  // A defensive role must not be judged by the same one-hit damage race as a
  // sweeper. CAP's PT/ST ratings give us an independent read on whether the
  // stat architecture is actually built to absorb hits.
  const targetTf=targetProfile||null;
  const targetCap=targetTf?capStatRatings(targetTf):capStatRatings({
    hp:target?.stats?.hp,atk:target?.stats?.atk,def:target?.stats?.def,
    spa:target?.stats?.spa,spd:target?.stats?.spd,spe:target?.stats?.spe
  });
  const targetRoleSignals=targetTf?.roleSignals||{};
  const targetRecovery=Number(targetTf?.recovery||0);
  const targetDefensiveTools=Number(targetTf?.defensiveTools||0);
  const targetDefensive=
    (targetTf && choosePrimaryRole(targetTf)==='defensive') ||
    String(targetTf?.primaryRole||'').toLowerCase()==='defensive' ||
    ((Number(targetCap?.PT)>=150 || Number(targetCap?.ST)>=150) &&
      (targetRecovery>=1 || targetDefensiveTools>=2 || Number(targetTf?.bulk||0)>=245 || Number(targetTf?.defensiveSetupCount||0)>=1)) ||
    (Number(targetCap?.PT)>=180 && Number(targetCap?.ST)>=130);

  const rows=pool.filter(p=>p?.stats&&usageOf(p.name,usage)>0).map(p=>{
    const u=usageOf(p.name,usage);
    const details=matchupDetails(target,p);
    const enemy=details.reverse;
    const mine=details.offense;
    const myBest=mine.best || mine.bestSuperEffective;
    const theirBest=enemy.best || enemy.bestSuperEffective;
    const myPct=myBest?.expected ? (myBest.expected/battleStatsFromBase(p?.stats||{}).hp) : 0;
    const theirPct=theirBest?.expected ? (theirBest.expected/battleStatsFromBase(target?.stats||{}).hp) : 0;

    // Matchups are evaluated as a battle race, not as a contest of maximum damage.
    // If the target is slower and the opponent KOs it before it gets to act, a
    // theoretical OHKO from the target is not a favorable matchup.
    const incomingExpectedPct=theirPct;
    const incomingMaxPct=(theirBest?.damageMax)?theirBest.damageMax/battleStatsFromBase(target?.stats||{}).hp:incomingExpectedPct;
    const targetRecovery=Number(targetTf?.recoveryMoves||0);
    const hasRecovery=targetRecovery>0;
    const recoverySustain=(hasRecovery && incomingExpectedPct<0.50) ? 12 : 0;
    const raceScore=details.raceScore;
    // Damage balance is an explicit part of the matchup.  A mon should not be
    // called favorable merely because it has a theoretical OHKO if it is taking
    // substantially more damage in return.  Normalize both sides by their own HP
    // so this compares actual pressure rather than raw damage numbers.
    const damageBalance= myPct<=0
      ? (theirPct>0 ? 0 : 50)
      : clamp(50 + 100*Math.log((myPct+0.01)/(theirPct+0.01)));
    const damageDisadvantage=theirPct>myPct;
    const damagePressureScore=clamp(
      damageBalance - (damageDisadvantage ? Math.min(25,(theirPct-myPct)*60) : 0)
    );
    const survivalScore=clamp(100-incomingExpectedPct*100);
    const breakability=details.enemyHits===Infinity ? 100 : details.enemyHits>=4 ? 82 : details.enemyHits===3 ? 68 : details.enemyHits===2 ? 38 : 5;

    // A "close call": the KO race is won by exactly one hit's margin (e.g. a
    // 1HKO vs. a 2HKO) while the losing side is still landing real, meaningful
    // damage (not just chip). The final score can come out as a confident
    // 100/0 in these cases (whoever needs fewer hits wins the race outright),
    // but the actual battle is genuinely close - decided by speed ties, roll
    // variance, crits, or which mon happens to be on the field first - so it
    // shouldn't be presented as a clean, confident "good"/"bad" verdict.
    const hitMargin=(Number.isFinite(details.myHits)&&Number.isFinite(details.enemyHits))
      ? Math.abs(details.myHits-details.enemyHits) : Infinity;
    const bothThreaten=myPct>=0.4 && theirPct>=0.4;
    const closeCall=hitMargin<=1 && bothThreaten;

    // The KO race is the primary gate.  Damage balance is the second gate.
    // Recovery/bulk can improve a genuinely winnable wall matchup, but it cannot
    // turn a matchup around when the opponent gets the KO first.
    const defensiveScore=clamp(
      raceScore*.62 +
      damagePressureScore*.23 +
      survivalScore*.10 +
      breakability*.05 +
      (hasRecovery && !damageDisadvantage && incomingExpectedPct<0.50 ? 5 : 0)
    );
    const score=clamp(
      raceScore*.58 +
      damagePressureScore*.32 +
      survivalScore*.10
      + (targetDefensive ? (damageDisadvantage ? -8 : 4) : 0)
    );
    return {
      p,usage:u,score,targetScore:score,enemyScore:fastMatchupScore(p,target),
      matchup:details,
      bestMove:mine.best,
      enemyBestMove:enemy.best,
      speed:details.speed,
      defensiveEvaluation:targetDefensive,
      closeCall,
      defensiveMetrics:{
        capPT:Number(targetCap?.PT)||0,capST:Number(targetCap?.ST)||0,
        expectedIncomingPct:incomingExpectedPct,maxIncomingPct:incomingMaxPct,
        survivalScore,breakability,hasRecovery,raceScore,damageBalance,damageDisadvantage,
        myHits:details.myHits,enemyHits:details.enemyHits
      }
    };
  });
  rows.sort((a,b)=>b.usage-a.usage);
  const total=rows.reduce((s,x)=>s+x.usage,0);
  const weightedRaw=total?rows.reduce((s,x)=>s+x.score*x.usage,0)/total:50;
  // Pull sparse/rough matchup estimates toward neutral instead of treating every
  // imperfect approximation as a real loss. This is meant to protect noisy small
  // samples from looking artificially bad - but a symmetric pull toward 50 also
  // drags DOWN a genuinely strong performance just as hard as it props up a weak
  // one. A unique typing/kit is exactly what ends up with a smaller comparable
  // pool (fewer close peers to test against), so under a heavy pull this
  // "protection" was instead the main way unique Pokémon got undervalued: their
  // real, earned favorable matchups were being diluted toward mediocre. Keep the
  // safeguard, but make it much lighter - full weight is restored by a modest
  // pool size (12, not 24), and even at zero coverage the raw signal keeps most
  // of its weight instead of being cut nearly in half.
  const coverageFactor=Math.min(1,rows.length/12);
  const weightedScore=50+(weightedRaw-50)*(.80+.20*coverageFactor);
  const sortedByImpact=[...rows].sort((a,b)=>b.usage*Math.abs(b.score-50)-a.usage*Math.abs(a.score-50));
  // Close calls are excluded from the good/bad display slots specifically -
  // they're real matchups and still count toward weightedScore/wins/losses/
  // coverage above, just not confident enough to present as a clean verdict.
  const good=[...rows].sort((a,b)=>b.usage*(b.score-50)-a.usage*(a.score-50)).filter(x=>x.score>=60 && !x.closeCall).slice(0,6);
  const bad=[...rows].sort((a,b)=>a.usage*(a.score-50)-b.usage*(b.score-50)).filter(x=>x.score<=40 && !x.closeCall).slice(0,6);
  const top=rows.slice(0,Math.min(20,rows.length));
  const topWeighted=top.length?top.reduce((s,x)=>s+x.score*x.usage,0)/Math.max(1,top.reduce((s,x)=>s+x.usage,0)):50;
  const favorableShare=rows.length?rows.filter(x=>x.score>=58).length/rows.length:0;
  const unfavorableShare=rows.length?rows.filter(x=>x.score<=42).length/rows.length:0;
  return {rows,weightedScore,topWeighted,matchupPct:rows.length?percentile(rows.map(x=>x.score),weightedScore):50,good,bad,wins:rows.filter(x=>x.score>=60).length,losses:rows.filter(x=>x.score<=40).length,coverage:rows.length,favorableShare,unfavorableShare,sortedByImpact};
}
function matchupTierBand(matchup,roleScore,tf,metagameFit,intrinsic){
  const m=matchup?.weightedScore??50;
  const top=matchup?.topWeighted??50;
  const utility=clamp(roleScore);
  const statPower=clamp(intrinsic?.statPower??50);
  const kitPower=clamp(intrinsic?.score??50);
  const counterplay=clamp(intrinsic?.counterplay??50);
  const bsr=Number(intrinsic?.cap?.BSR)||0;

  // CAP stat architecture is the primary pillar of the prediction. Matchups are
  // contextual evidence rather than the dominant driver. that tells us how much raw stat architecture can support
  // the kit. It is never converted directly into a tier.
  // utility (role-fit: defensive/support/pivot/hazard signals) was previously
  // underweighted relative to statPower. Raw CAP stat architecture (statPower)
  // is built around offensive output and structurally can't see a mon whose
  // real value is pivoting, removing hazards, and spreading status - so a
  // defensive specialist with a genuinely strong utility kit but unremarkable
  // offensive stats was getting graded almost entirely on the part of its kit
  // that isn't its job. Shift a little weight from statPower to utility.
  const core=clamp(
    m*.22 +
    top*.05 +
    clamp(metagameFit??50)*.10 +
    utility*.11 +
    statPower*.35 +
    kitPower*.17
  );

  // CAP's own scale calls 900+ "Too Good" and 1400+ "Exaggerated".
  // We use those as competitive-ceiling evidence, not as automatic tiers.
  // An extreme BSR combined with an actual win condition is enough to stop
  // the matchup approximation from burying a clearly broken design.
  const hasRealWinCondition=(tf.setup>=1||tf.recovery>=1||tf.offensiveTools>=5||tf.defensiveTools>=5);
  if(bsr>=1400 && hasRealWinCondition) return 'Ubers';
  if(bsr>=900 && tf.setup>=1 && tf.recovery>=1 && counterplay<58) return 'Ubers';
  if(bsr>=1050 && (tf.setup>=1||tf.recovery>=1) && m>=45) return 'Ubers';

  const adjusted=clamp(
    core +
    (statPower-50)*.10 -
    Math.max(0,counterplay-55)*.06
  );

  if(adjusted>=79)return'Ubers';
  if(adjusted>=66)return'OU';
  if(adjusted>=54)return'UU';
  if(adjusted>=45)return'RU';
  if(adjusted>=36)return'NU';
  if(adjusted>=27)return'PU';
  return'ZU';
}
function estimateTier(base,closest,tierUsage,officialTiers,targetProfile,cfg,matchup,roleScore,tf,metagameFit,intrinsic){
  const known=officialTierOf(targetProfile?.name||'',officialTiers,cfg);
  if(known)return{tier:known,score:clamp(base),reliability:100,anchor:known,usageEvidence:[],weighted:{},bestMatch:100,agreement:1};
  const tier=matchupTierBand(matchup,roleScore,tf,metagameFit,intrinsic);
  const score=clamp(
    (matchup?.weightedScore??50)*.18 +
    (matchup?.topWeighted??50)*.05 +
    (matchup?.matchupPct??50)*.03 +
    clamp(metagameFit??50)*.10 +
    clamp(roleScore)*.09 +
    clamp(intrinsic?.statPower??50)*.38 +
    clamp(intrinsic?.score??50)*.17
  );
  const reliability=clamp(48+(matchup?.coverage||0)*1.0+Math.abs((matchup?.weightedScore??50)-50)*.2+(intrinsic?.score>=80?8:0));
  return{
    tier,score,reliability,anchor:null,usageEvidence:[],weighted:{},
    bestMatch:closest?.[0]?.score||0,agreement:0,
    intrinsic:intrinsic?.score??50,counterplay:intrinsic?.counterplay??50
  };
}
function renderBars(obj){return Object.entries(obj).map(([k,v])=>`<div class="analysis-stat-row"><span>${esc(STAT_NAMES[k]||k)}</span><div class="analysis-bar"><i style="width:${clamp(v)}%"></i></div><b>${Math.round(v)}%</b></div>`).join('');}
function getCfg(){return {pool:document.getElementById('analysis-pool')?.value||'generation',gen:Number(document.getElementById('analysis-gen')?.value||9),natdex:!!document.getElementById('analysis-natdex')?.checked,folder:document.getElementById('analysis-folder')?.value||'',comparePokemon:document.getElementById('analysis-pokemon')?.value||''};}
function analysisPoolChanged(){
  const pool=document.getElementById('analysis-pool')?.value;if(!pool)return;
  document.getElementById('analysis-gen-wrap').style.display=(pool==='generation'?'':'none');
  document.getElementById('analysis-folder-wrap').style.display=(pool==='folder'?'':'none');
  document.getElementById('analysis-pokemon-wrap').style.display=(pool==='pokemon'?'':'none');
  document.getElementById('analysis-natdex-wrap').style.display=(pool==='generation'?'':'none');
  scheduleAnalysis();
}
function scheduleAnalysis(){
  clearTimeout(analysisTimer);
  analysisTimer=setTimeout(()=>runFakemonAnalysis(),160);
}
function ensurePanel(){
  const el=document.getElementById('tab-analysis');if(!el)return;
  // Re-rendering the panel must invalidate the previous result key. Otherwise reopening
  // the Analysis tab can see the same key and incorrectly decide there is nothing to do.
  lastAnalysisKey='';
  analysisBusy=false;
  clearTimeout(analysisTimer);
  el.innerHTML=`<div class="analysis-shell">
    <div class="analysis-controls panel-lite">
      <div class="analysis-control"><label>Compare Against</label><select id="analysis-pool" onchange="analysisPoolChanged()"><option value="generation">Generation</option><option value="pokemon">Single Pokémon</option><option value="collection">My Collection</option><option value="folder">Collection Folder</option></select></div>
      <div id="analysis-gen-wrap" class="analysis-control"><label>Generation</label><select id="analysis-gen" onchange="scheduleAnalysis()">${[9,8,7,6,5,4,3,2,1].map(g=>`<option value="${g}">Gen ${g}</option>`).join('')}</select></div>
      <div id="analysis-pokemon-wrap" class="analysis-control" style="display:none"><label>Pokémon</label><select id="analysis-pokemon" onchange="scheduleAnalysis()">${uniqueDex().map(p=>`<option value="${esc(p.id||p.name)}">${esc(p.name)}</option>`).join('')}</select></div>
      <div id="analysis-folder-wrap" class="analysis-control" style="display:none"><label>Folder</label><select id="analysis-folder" onchange="scheduleAnalysis()">${(state.folders||[]).filter(f=>f.type==='fakemon').map(f=>`<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</select></div>
      <div id="analysis-natdex-wrap" class="analysis-check"><label><input type="checkbox" id="analysis-natdex" onchange="scheduleAnalysis()"> National Dex pool</label></div>
    </div>
    <div id="analysis-status" class="analysis-status"><span class="analysis-spinner"></span><span>${state.sdLoaded?'Preparing analysis…':'Loading data…'}</span></div>
    <div id="analysis-results"></div>
  </div>`;
  document.getElementById('analysis-pool').value='generation';
  document.getElementById('analysis-gen').value='9';
  document.getElementById('analysis-natdex').checked=false;
  analysisPoolChanged();
}
async function runFakemonAnalysis(){
  const results=document.getElementById('analysis-results');
  if(!results||analysisBusy)return;
  if(!state.sdLoaded||!Object.keys(state.sdPokedex||{}).length){const s=document.getElementById('analysis-status');if(s)s.innerHTML='<span class="analysis-spinner"></span><span>Loading data…</span>';return;}
  const cfg=getCfg();
  const selectedFormat = cfg.natdex
    ? `National Dex${cfg.gen ? ` Gen ${cfg.gen}` : ''}`
    : `Gen ${cfg.gen || 9}`;
  const key=JSON.stringify([cfg.pool,cfg.gen,cfg.natdex,cfg.folder,cfg.comparePokemon,getTarget().stats,getTarget().types,state.abilities?.map(a=>a.name),state.learnset?.map(m=>m.name)]);
  if(key===lastAnalysisKey && results.innerHTML.trim())return;
  lastAnalysisKey=key;analysisBusy=true;
  let status=document.getElementById('analysis-status');
  status.innerHTML='<span class="analysis-spinner"></span><span>Preparing comparison…</span>';
  try{
    // Only fetch the small usage dataset. The previous implementation fetched the enormous
    // competitive set database and then repeatedly walked every learnset, which could freeze the UI.
    const formats=getTierFormats(cfg);
    status=document.getElementById('analysis-status');
    status.innerHTML='<span class="analysis-spinner"></span><span>Loading usage statistics…</span>';
    const [ouUsage,uuUsage,ruUsage,nuUsage,puUsage,zuUsage,ubersUsage]=await Promise.all([
      loadUsage(formats.ou),loadUsage(formats.uu),loadUsage(formats.ru),
      loadUsage(formats.nu),loadUsage(formats.pu),
      formats.zu?loadUsage(formats.zu):Promise.resolve({}),
      loadUsage(formats.ubers)
    ]);
    const tierUsage={ou:ouUsage,uu:uuUsage,ru:ruUsage,nu:nuUsage,pu:puUsage,zu:zuUsage,ubers:ubersUsage};
    const officialTiers=await loadOfficialTierData(cfg);
    const usage=ouUsage;
    const pool=poolFor(cfg).filter(p=>p?.stats);
    if(!pool.length)throw new Error('The selected comparison pool is empty.');
    const t=getTarget();
    const target=fakeDex({id:'current',name:t.name,type1:t.types[0],type2:t.types[1],stats:t.stats,abilities:t.abilities,learnset:t.learnset});
    status.innerHTML='<span class="analysis-spinner"></span><span>Calculating stat percentiles…</span>';
    const tf=detailedProfile(target);
    const statPct=Object.fromEntries(STAT_KEYS.map(k=>[k,percentile(pool.map(p=>Number(p.stats?.[k])||0),Number(t.stats[k])||0)]));
    const cheap=pool.map(p=>({p,f:cheapProfile(p)}));
    const bulkPct=percentile(cheap.map(x=>x.f.bulk),tf.bulk);
    const speedPct=percentile(cheap.map(x=>x.f.speed),tf.speed);
    const offPct=percentile(cheap.map(x=>x.f.offensive),tf.offensive);
    const typePct=percentile(cheap.map(x=>x.f.typing.score),tf.typing.score);
    const bstValues=pool.map(p=>STAT_KEYS.reduce((sum,k)=>sum+(Number(p.stats?.[k])||0),0));
    const targetBst=STAT_KEYS.reduce((sum,k)=>sum+(Number(t.stats[k])||0),0);
    const bstPct=percentile(bstValues,targetBst);
    const metagameEntries=pool.filter(p=>usageOf(p.name,usage)>0).map(p=>({p,weight:usageOf(p.name,usage)}));
    const metagameStatPct=Object.fromEntries(STAT_KEYS.map(k=>[k,weightedPercentile(metagameEntries.map(x=>({value:Number(x.p.stats?.[k])||0,weight:x.weight})),Number(t.stats[k])||0)]));
    const metagameCheap=metagameEntries.map(x=>({p:x.p,f:cheapProfile(x.p),weight:x.weight}));
    const metagameBulkPct=weightedPercentile(metagameCheap.map(x=>({value:x.f.bulk,weight:x.weight})),tf.bulk);
    const metagameSpeedPct=weightedPercentile(metagameCheap.map(x=>({value:x.f.speed,weight:x.weight})),tf.speed);
    const metagameOffPct=weightedPercentile(metagameCheap.map(x=>({value:x.f.offensive,weight:x.weight})),tf.offensive);
    const metagameTypePct=weightedPercentile(metagameCheap.map(x=>({value:x.f.typing.score,weight:x.weight})),tf.typing.score);
    // One score for the *combination* of stats. This rewards useful distributions
    // rather than simply rewarding a high BST: bulk, offense, speed and total stats
    // all have to contribute.
    const statCombination=clamp(.40*bulkPct+.32*offPct+.18*speedPct+.10*bstPct);
    const metagameStatCombination=metagameStatPct.hp==null?null:clamp(.40*(metagameBulkPct??bulkPct)+.32*(metagameOffPct??offPct)+.18*(metagameSpeedPct??speedPct)+.10*bstPct);
    // Analysis uses the same competitive move-quality vocabulary as Sample Sets,
    // but evaluates the whole kit instead of changing the Sample Set generator.
    // The score is intentionally interaction-heavy: coherent gameplans get rewarded,
    // while isolated traits do not simply stack linearly.
    const primaryRole=choosePrimaryRole(tf);
    const roleValues=Object.entries(tf.roleSignals||{}).sort((a,b)=>b[1]-a[1]);
    const secondaryRole=(roleValues.find(([k])=>k!==primaryRole)?.[0])||primaryRole;
    const roleFit=clamp((roleValues[0]?.[1]||0)*0.75+(roleValues[1]?.[1]||0)*0.25);
    const offensiveSynergy=clamp(
      (statCombination*.42) +
      (offPct*.20) +
      (Math.min(100,tf.bestPower*.55)*.14) +
      (Math.min(100,tf.stabCount*22)*.10) +
      (Math.min(100,tf.coverageTypes*24)*.06) +
      (tf.setup&&offPct>=60?12:0)
    );
    const defensiveSynergy=clamp(
      (typePct*.30) +
      (bulkPct*.25) +
      (tf.recoveryQuality*.18) +
      (Math.min(100,tf.defensiveTools*14)*.12) +
      (tf.pivot&&tf.recovery?12:0) +
      (tf.hazards&&tf.removal?8:0) +
      (tf.statusUtility>=2&&tf.bulk>=220?8:0)
    );
    const coherence=clamp(
      (roleFit*.35) +
      (Math.max(offensiveSynergy,defensiveSynergy)*.25) +
      (Math.min(offensiveSynergy,defensiveSynergy)*.15) +
      (tf.setup&&tf.offensiveTools>=3?8:0) +
      (tf.recoveryMoves>=1&&tf.defensiveTools>=3?8:0) +
      (tf.pivot&&tf.offensiveTools>=2?7:0) +
      - tf.redundancyPenalty
    );
    const roleScore=clamp(34 + coherence*.44 + roleFit*.24 + (tf.defensiveTools>=3 ? Math.min(12,tf.defensiveTools*2) : 0) + (tf.typing.resist+tf.typing.immune>=6?6:0) - (tf.typing.weak>=6?7:0) - (tf.typing.severe>=2?8:0));
    const metagameFit=metagameStatCombination==null?clamp(.45*statCombination+.25*typePct+.30*roleScore):clamp(.42*metagameStatCombination+.18*(metagameTypePct??typePct)+.18*(metagameOffPct??offPct)+.12*(metagameSpeedPct??speedPct)+.10*roleScore);
    const base=clamp(.32*statCombination+.18*typePct+.15*offensiveSynergy+.12*defensiveSynergy+.08*roleScore+.15*metagameFit);
    const abilityInfo=abilityQuality(tf.abilities);
    const abilityAdjustedBase=clamp(base + abilityInfo.score*3);
    const intrinsic=intrinsicPowerProfile(tf,abilityInfo);
    status.innerHTML='<span class="analysis-spinner"></span><span>Testing matchups across the selected metagame…</span>';
    // First pass uses the selected environment to estimate the tier. Once that
    // tier is known, the displayed matchup set is rebuilt from comparable-tier
    // Pokémon so the cards answer the useful question: "how does this stack up
    // against the mons it would actually be sharing a tier with?"
    const broadMatchup=buildMatchupProfile(target,pool,usage,tf);
    const closest=cheap.map(x=>({p:x.p,score:similarity(target,x.p,tf,x.f,0)})).sort((a,b)=>b.score-a.score).slice(0,8);
    const targetForTier={...tf,bulkPct,stats:t.stats,name:t.name,primaryRole:choosePrimaryRole(tf)};
    const tier=estimateTier(abilityAdjustedBase,closest,tierUsage,officialTiers,targetForTier,cfg,broadMatchup,roleScore,tf,metagameFit,intrinsic);
    const comparable=tierComparablePool(pool,tierUsage,tier.tier,officialTiers,cfg);

    // Never fall back to the entire generation pool while still weighting it with
    // tier-specific usage. That mixes all legal Pokémon with OU/UU/etc. usage and
    // can re-introduce LC/NFE/lower-tier Pokémon such as Surskit/Haunter.
    // If the same-tier sample is small, keep the sample small rather than changing
    // the population underneath the weights.
    const matchupPool=comparable.pool;
    const matchupUsage=comparable.usage;
    const matchup=buildMatchupProfile(target,matchupPool,matchupUsage,tf);
    matchup.comparableTier=tier.tier;
    matchup.comparablePoolSize=comparable.pool.length;
    matchup.usingComparableTier=true;
    // TEMP DEBUG: exposes the last computed matchup profile to the console so
    // individual matchup rows (score, offense/reverse best move, damage %) can
    // be inspected directly. Safe to remove once the issue is found.
    window.__lastMatchup=matchup;
    window.__lastAnalysis={
      timestamp:new Date().toISOString(),
      config:JSON.parse(JSON.stringify(cfg)),
      selectedFormat,
      target:JSON.parse(JSON.stringify(t)),
      targetProfile:JSON.parse(JSON.stringify(tf)),
      statPct:JSON.parse(JSON.stringify(statPct)),
      metagameStatPct:JSON.parse(JSON.stringify(metagameStatPct)),
      statCombination,metagameStatCombination,bulkPct,speedPct,offPct,typePct,bstPct,
      metagameBulkPct,metagameSpeedPct,metagameOffPct,metagameTypePct,
      primaryRole,secondaryRole,roleFit,offensiveSynergy,defensiveSynergy,coherence,roleScore,
      metagameFit,base,abilityInfo:JSON.parse(JSON.stringify(abilityInfo)),
      intrinsic:JSON.parse(JSON.stringify(intrinsic)),
      tier:JSON.parse(JSON.stringify(tier)),
      matchup:window.__lastMatchup,
      usageFormats:Object.fromEntries(Object.entries(tierUsage).map(([k,v])=>[k,Object.keys(v||{}).length])),
      poolSize:pool.length,metagameEntries:metagameEntries.length,
      comparablePoolSize:comparable.pool.length,usingComparableTier:comparable.pool.length>=6
    };
    log.debug('ANALYSIS','Published analysis debug snapshot',{
      format:selectedFormat,role:primaryRole,score:tier.score,matchup:matchup.weightedScore,
      rows:matchup.rows.length, snapshot:'window.__lastAnalysis'
    });
    const strengths=[],weaknesses=[];
    Object.entries(statPct).sort((a,b)=>b[1]-a[1]).slice(0,2).filter(x=>x[1]>=70).forEach(([k,v])=>strengths.push(`${STAT_NAMES[k]} is ${Math.round(v)}th percentile`));
    Object.entries(statPct).sort((a,b)=>a[1]-b[1]).slice(0,2).filter(x=>x[1]<=35).forEach(([k,v])=>weaknesses.push(`${STAT_NAMES[k]} is ${Math.round(v)}th percentile`));
    if(metagameStatCombination!=null && metagameStatCombination>=70)strengths.push(`Stat profile is ${Math.round(metagameStatCombination)}th-percentile quality among usage-weighted ${esc(selectedFormat)} Pokémon`);
     if(tf.typing.resist+tf.typing.immune>=6)strengths.push(`${tf.typing.resist} resistances and ${tf.typing.immune} immunities provide strong switch-in potential`);
    if(tf.recoveryMoves>=1)strengths.push('Reliable recovery is available');
    if(tf.pivot)strengths.push('Pivoting adds role compression');
    if(tf.hazards||tf.removal)strengths.push('Hazard utility adds team value');
    if(tf.setup)strengths.push('Setup options increase its ceiling');
    if(matchup?.weightedScore>=65)strengths.push(`Usage-weighted matchup profile is ${Math.round(matchup.weightedScore)}/100`);
    if(abilityInfo.score>0)strengths.push(`${abilityInfo.name} is a strong ability that meaningfully raises its floor`);
     if(intrinsic.statPower>=70)strengths.push(`CAP stat rating is ${Math.round(intrinsic.cap.BSR)} BSR (${intrinsic.cap.category})`);
    if(intrinsic.cap.PT>=140)strengths.push(`Physical tankiness is ${Math.round(intrinsic.cap.PT)}`);
    if(intrinsic.cap.ST>=140)strengths.push(`Special tankiness is ${Math.round(intrinsic.cap.ST)}`);
    if(intrinsic.cap.PS>=140)strengths.push(`Physical sweepiness is ${Math.round(intrinsic.cap.PS)}`);
    if(intrinsic.cap.SS>=140)strengths.push(`Special sweepiness is ${Math.round(intrinsic.cap.SS)}`);
    if(intrinsic.score>=80)strengths.push(`Intrinsic kit power is ${Math.round(intrinsic.score)}/100 before matchup context`);
     if(intrinsic.brokenKit)strengths.push('The stat / recovery / setup combination has a very high competitive ceiling');
     if(intrinsic.counterplay>=65)weaknesses.push(`There are meaningful counterplay hooks (${Math.round(intrinsic.counterplay)}/100)`);
    if(tf.typing.weak>=5)weaknesses.push(`${tf.typing.weak} attacking types hit it super effectively`);
    // Low Speed alone isn't a weakness for a defensive/pivot kit - a slow pivot
    // (U-turn/Volt Switch/Teleport/etc. while under 70 Speed) is a deliberate,
    // desirable combination: it lets the mon eat a hit, then safely bring in
    // the check that actually wants to be on the field, without giving the
    // opponent a free turn to punish the switch. Only call it a weakness when
    // there's no pivot option to fall back on.
    if(tf.speed<70 && !tf.pivot){
      weaknesses.push('Low Speed can leave it vulnerable to offensive pressure');
    } else if(tf.speed<70 && tf.pivot){
      strengths.push('Low Speed pairs with pivot moves for safe, controlled switches (slow pivoting)');
    }
    if(matchup?.weightedScore<=42)weaknesses.push(`Usage-weighted matchup profile is only ${Math.round(matchup.weightedScore)}/100`);
    if(abilityInfo.score<0)weaknesses.push(`${abilityInfo.name} is a genuinely crippling ability`);
    results.innerHTML=`
      <div class="analysis-profile panel-lite">
        <div class="analysis-profile-main">
          <div class="analysis-kicker">Estimated competitive profile</div>
          <div class="analysis-profile-tier">${esc(tier.tier)}</div>
          <div class="analysis-score">${Math.round(tier.score)}/100 · ${Math.round(tier.reliability)}% confidence</div>
        </div>
        <div class="analysis-profile-summary">
          <div class="analysis-discord-message"><img class="analysis-discord-avatar" src="inoue_profile.gif" alt="Inoue"><div class="analysis-discord-body"><div class="analysis-discord-name">Inoue</div><div class="analysis-discord-text">${esc(makeCasualSummary(t,tf,tier,matchup,selectedFormat,statCombination,roleScore,typePct,intrinsic.cap,summarySeedFromTarget(t)))}</div></div></div>
        </div>
        <div class="analysis-profile-note"><strong>Take it with a grain of salt.</strong> This is an estimate, not an official competitive ranking.</div>
      </div>

      <div class="analysis-two-col analysis-strength-row">
        <div class="analysis-card panel-lite analysis-strength-card"><h3><span class="analysis-section-icon analysis-positive">↑</span>Strengths</h3><ul>${(strengths.length?strengths:['No major strength crossed the current thresholds.']).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>
        <div class="analysis-card panel-lite analysis-strength-card"><h3><span class="analysis-section-icon analysis-negative">↓</span>Weaknesses</h3><ul>${(weaknesses.length?weaknesses:['No major weakness crossed the current thresholds.']).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>
      </div>

      <div class="analysis-detail-grid">
        <div class="analysis-card panel-lite"><h3>Typing & role</h3><div class="analysis-big">${Math.round(typePct)}th</div><p><span class="analysis-type-list">${analysisTypePills(t.types)||'<span>None</span>'}</span> · ${tf.typing.weak} weaknesses · ${tf.typing.resist} resistances · ${tf.typing.immune} immunities</p><p>${tf.recoveryMoves?'Recovery · ':''}${tf.pivot?'Pivot · ':''}${tf.hazards?'Hazards · ':''}${tf.removal?'Removal · ':''}${tf.setup?'Setup · ':''}${tf.statusUtility?'Status utility':''}</p><div class="analysis-role-score">Role value <b>${Math.round(roleScore)}/100</b></div></div>

        <div class="analysis-card panel-lite"><h3>Stat combination</h3><div class="analysis-big">${Math.round(statCombination)}/100</div><p>Overall quality of the stat spread relative to the selected pool.</p><div class="analysis-stat-combo"><div><span>Bulk</span><b>${Math.round(bulkPct)}th</b></div><div><span>Offense</span><b>${Math.round(offPct)}th</b></div><div><span>Speed</span><b>${Math.round(speedPct)}th</b></div><div><span>BST</span><b>${Math.round(bstPct)}th</b></div></div></div>

        <div class="analysis-card panel-lite"><h3>Selected environment</h3><p><strong>${esc(selectedFormat)}</strong></p><p>${metagameEntries.length} usage-weighted Pokémon represented</p><div class="analysis-stat-combo"><div><span>Stat profile</span><b>${metagameStatCombination==null?'-':Math.round(metagameStatCombination)+'/100'}</b></div><div><span>Bulk</span><b>${metagameBulkPct==null?'-':Math.round(metagameBulkPct)+'th'}</b></div><div><span>Offense</span><b>${metagameOffPct==null?'-':Math.round(metagameOffPct)+'th'}</b></div><div><span>Speed</span><b>${metagameSpeedPct==null?'-':Math.round(metagameSpeedPct)+'th'}</b></div><div><span>Matchups</span><b>${matchup.weightedScore==null?'-':Math.round(matchup.weightedScore)+'/100'}</b></div></div></div>

        <div class="analysis-card panel-lite"><h3>CAP stat rating</h3><div class="analysis-big">${Math.round(intrinsic.cap.BSR)}</div><p>${esc(intrinsic.cap.category)} · CAP's nonlinear stat rating. This is a stat-power measure, not an automatic tier.</p><div class="analysis-stat-combo"><div><span>PT</span><b>${Math.round(intrinsic.cap.PT)}</b></div><div><span>ST</span><b>${Math.round(intrinsic.cap.ST)}</b></div><div><span>PS</span><b>${Math.round(intrinsic.cap.PS)}</b></div><div><span>SS</span><b>${Math.round(intrinsic.cap.SS)}</b></div><div><span>ODB</span><b>${intrinsic.cap.ODB.toFixed(1)}</b></div><div><span>PSB</span><b>${intrinsic.cap.PSB.toFixed(1)}</b></div></div><p>Kit ceiling <b>${Math.round(intrinsic.score)}/100</b> · Matchups <b>${Math.round(matchup.weightedScore||50)}/100</b></p></div>
      </div>

      <div class="analysis-card panel-lite analysis-matchups-card">
        <div class="analysis-matchups-header"><div><h3>Metagame matchups</h3><p>${matchup.usingComparableTier?`Usage-weighted matchups against ${esc(tier.tier)} Pokémon.`:'Using the selected environment because there were not enough same-tier Pokémon to make a useful sample.'}</p></div><div class="analysis-matchups-score"><span>Overall</span><b>${matchup.weightedScore==null?'-':Math.round(matchup.weightedScore)+'/100'}</b></div></div>
        <div class="analysis-matchup-columns">
          <div class="analysis-matchup-group favorable"><h4><span>✓</span> Looks good into</h4>
            <div class="analysis-matchup-list">${(matchup.good||[]).map(x=>`<div class="analysis-matchup-card"><div class="analysis-matchup-icon">${matchupSpriteHtml(x.p)}</div><div class="analysis-matchup-info"><strong>${esc(x.p.name)}</strong><span>Matchup score reflects speed internally</span></div><b class="analysis-matchup-score">${Math.round(x.score)}</b></div>`).join('')||'<div class="analysis-muted">No clear favorable matchups.</div>'}</div>
          </div>
          <div class="analysis-matchup-group unfavorable"><h4><span>×</span> Looks rough into</h4>
            <div class="analysis-matchup-list">${(matchup.bad||[]).map(x=>`<div class="analysis-matchup-card"><div class="analysis-matchup-icon">${matchupSpriteHtml(x.p)}</div><div class="analysis-matchup-info"><strong>${esc(x.p.name)}</strong><span>Matchup score reflects speed internally</span></div><b class="analysis-matchup-score">${Math.round(x.score)}</b></div>`).join('')||'<div class="analysis-muted">No clear unfavorable matchups.</div>'}</div>
          </div>
        </div>
      </div>
`;

    const loadedUsageCount=Object.values(tierUsage).reduce((n,t)=>n+Object.keys(t||{}).length,0);
    status.innerHTML=`<span class="analysis-ok">✓</span><span>Analysis updated · ${pool.length} comparison Pokémon · ${metagameEntries.length} usage-weighted in ${esc(selectedFormat)} · ${loadedUsageCount} usage records loaded</span>`;
    if(typeof lucide!=='undefined')lucide.createIcons();
  }catch(e){
    log.error('ANALYSIS', 'Analysis failed', e);
    status.innerHTML='<span class="analysis-error">Analysis failed</span>';
    results.innerHTML=`<div class="analysis-error panel-lite">${esc(e.message||'Analysis failed.')}</div>`;
  }finally{analysisBusy=false;}
}
function openAnalysisTab(){const tab=document.querySelector('.tab[onclick*="analysis"]');if(tab)switchTab(tab,'analysis');}
export {ensurePanel as renderAnalysis,runFakemonAnalysis,analysisPoolChanged,openAnalysisTab,scheduleAnalysis};