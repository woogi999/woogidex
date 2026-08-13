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
const clamp=(n,a=0,b=100)=>Math.max(a,Math.min(b,n));
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const normalizeName=v=>String(v||'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]/g,'');

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
const STRONG_ABILITIES=new Set([
  'Speed Boost','Huge Power','Pure Power','Drought','Drizzle','Sand Stream','Snow Warning',
  'Intimidate','Regenerator','Prankster','Magic Bounce','Levitate','Tough Claws','Adaptability',
  'Protean','Libero','Water Absorb','Volt Absorb','Flash Fire','Guts','Moxie','Sheer Force',
  'Technician','Unaware','Multiscale','Poison Heal','Contrary','Simple','Beast Boost',
  'Mold Breaker','Download','Grassy Surge','Electric Surge','Psychic Surge','Stakeout',
  'Serene Grace','Skill Link','Triage'
]);
const WEAK_ABILITIES=new Set([
  'Truant','Slow Start','Defeatist','Normalize','Klutz','Stall','Justified','Anger Point',
  'Illuminate','Run Away','Honey Gather','Pickup','Damp','Own Tempo','Wimp Out',
  'Emergency Exit','Slow Start','Stall','Forecast'
]);
function abilityQuality(names){
  // Best-case ability chosen (competitively, a mon is built around its best ability),
  // returns -1 (crippling), 0 (neutral/unknown), or 1 (strong) plus which name mattered.
  let best={score:0,name:null};
  for(const n of names||[]){
    if(STRONG_ABILITIES.has(n) && best.score<1) best={score:1,name:n};
    else if(WEAK_ABILITIES.has(n) && best.score===0) best={score:-1,name:n};
  }
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
  const candidates=[p?.id,p?.name,p?.baseSpecies,normalizeName(p?.name),String(p?.id||'').replace(/-/g,'')].filter(Boolean);
  for(const id of candidates){if(state.sdLearnsets?.[id])return state.sdLearnsets[id];}
  return null;
}
function learnsetMoves(p){
  const l=learnsetRecord(p); if(!l)return [];
  return Object.keys(l).map(moveData).filter(Boolean);
}
function typeMultipliers(types){
  return POKEMON_TYPES.map(type=>({type,mult:(types||[]).reduce((m,t)=>m*(TYPE_EFFECTIVENESS[type]?.[t]??1),1)}));
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
      console.info(`[Analysis] Loaded ${Object.keys(out).length} usage entries for ${format}`);
      return out;
    })
    .catch(err=>{
      console.warn(`[Analysis] Usage stats unavailable for ${format}`,err);
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
    console.info(`[Analysis] Loaded ${Object.keys(out).length} official tier records`);
    return out;
  }).catch(err=>{
    console.warn('[Analysis] Official tier data unavailable',err);
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
  const meaningfulSetup=setup.filter(n=>/^(Swords Dance|Nasty Plot|Calm Mind|Bulk Up|Dragon Dance|Quiver Dance|Shell Smash|Shift Gear|Curse|Victory Dance|Tail Glow)$/i.test(n));
  const setupSweeperSignal=meaningfulSetup.length>=1 && setup.length>=2 && (Number(stats.Atk||0)>=100 || Number(stats.SpA||stats.Spa||0)>=100 || Number(stats.Spe||0)>=90) && attacks.length>=2;
  const fmt=x=>x?.p?.name||'something',good=(matchup?.good||[]).slice(0,3),bad=(matchup?.bad||[]).slice(0,3);
  const role=Object.entries(tf.roleSignals||{}).sort((a,b)=>b[1]-a[1])[0]?.[0]||'wallbreaker';
  const safeRole=role==='setupSweeper' && !setupSweeperSignal ? (Object.entries(tf.roleSignals||{}).filter(([k])=>k!=='setupSweeper').sort((a,b)=>b[1]-a[1])[0]?.[0]||'wallbreaker') : role;
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
    monster:{open:['oh NAH what is ts','ts gas gng','aw hell nah..','oh my days bruv','jarvis get ts out of here','okay, who let this thing cook','HOLY STALLFEST','this is getting suspiciously silly'],closers:['i would absolutely test this at the top end first','this is the kind of kit i would watch very closely in real games','honestly, i would be a little scared to give this too much free space','if this starts getting free turns, somebody is getting cooked','this thing has no business being this comfortable']},
    strong:{open:['ts gas gng','oh my days bruv','okay yeah, this one has sauce','oh NAH what is ts','yeah, this one is kinda cooking','aw hell nah.. i see the vision','jarvis get ts out of here','this is a certified problem merchant'],closers:['i would be pretty confident testing this aggressively','this is absolutely worth throwing into serious teams','i would keep an eye on how often it gets free turns','give this one an inch and it is taking the whole kitchen','i would absolutely abuse the good turns here']},
    solid:{open:['okay, i see the vision','ts gas gng, in moderation','oh my days bruv, there is actually something here','this one has a little sauce','would. next question','okay this is kinda fun','we have a concept here and it is not bad'],closers:['i would start testing it and see what sticks','this feels like a fun one to actually build around','i would give it a few different team shells before judging it too hard','there is enough here to make me curious, which is a win already']},
    niche:{open:['okay, this one is a specialist','i can see the angle here','ts so deep bro','this is definitely a matchup artist','okay, this is a very specific little merchant','oh my days bruv, this has a job and it knows it','we found the niche merchant'],closers:['i would build around its best jobs instead of asking it to do everything','this one could surprise people with the right support','i would test the narrow gameplan first and expand from there','do not make it do eight jobs. let the little merchant have its lane']},
    struggling:{open:['okay, we have a little gremlin to workshop','aw hell nah.. okay, back to the kitchen','jarvis get ts out of here, but wait, there might be a point here','ts so deep bro','oh my days bruv, we have work to do','this one needs the squad holding its hand','okay, somebody find this thing a niche'],closers:['i would start with a very supportive team and see what it can steal','this one needs its good situations to happen on purpose','i would treat this as a project mon and see where it surprises us','the numbers are not doing cartwheels, so let the weirdness carry','give the little guy one job and let it commit']}
  };
  const paragraphs=[];
  const chaoticBits=[
    `${pick(['oh NAH what is ts','ts gas gng','aw hell nah..','oh my days bruv'])} the ${typeText} typing is doing something here.`,
    `${merchantThing} detected. i am not elaborating.`,
    `${pick(['ts so deep bro','jarvis get ts out of here','HOLY STALLFEST','would. next question'])}`,
    `${pick(['this thing is kinda suspicious','i fear the kitchen may be open','somebody is going to click this move and immediately regret it','this has the energy of a set that starts as a joke and ends up on three teams'])}`
  ];
  paragraphs.push(`${pick(toneSets[tone].open)}. the ${typeText} typing and ${roleText} role give it ${power>=68?'a pretty serious':'a pretty specific'} identity.`);
  if((rng.value>>>0)%100 < (power>=68?58:32)) paragraphs.push(pick(chaoticBits));

  const topicPool=[];
  if(bestStat&&Number(bestStat[1])>=110) topicPool.push(`that ${STAT_NAMES[bestStat[0]]} stat is doing a lot of the work at ${bestStat[1]}. that is a number i would actually build around.`);
  if(attacks.length) topicPool.push(`for offense, ${attacks.slice(0,3).map(m=>m.name).join(', ')} are the toys i would start messing with. there is plenty of room to find a favorite set.`);
  if(recovery.length) topicPool.push(`${recovery.join(', ')} gives this thing some staying power. i like anything that can keep showing up without immediately falling apart.`);
  if(pivots.length) topicPool.push(`${pivots.join(', ')} gives it a nice way to keep the pace moving. i would absolutely abuse that momentum.`);
  if(setupSweeperSignal) topicPool.push(`${setup.slice(0,2).join(' + ')} is where the ceiling gets spicy. give it one clean turn and things can get silly.`);
  if(tf.statusUtility>=2) topicPool.push(`there is enough utility in the kit to make it annoying in a good way. forcing awkward turns is real value.`);
  if(tf.hazards||tf.removal) topicPool.push(`the field control options are worth paying attention to. this can contribute even when it is not trying to be the star of the show.`);
  if(power>=75 && cap?.BSR>=700) topicPool.push(`the stat architecture is doing its part too. the raw numbers give the rest of the kit plenty of room to breathe.`);
  if(power<50 && cap?.BSR<500) topicPool.push(`the raw stats are not going to bail it out every game, so i would lean hard into its best utility and positioning.`);

  const topics=[];
  const topicCount=Math.min(topicPool.length, power>=70?3:power>=50?2:2);
  while(topicPool.length && topics.length<topicCount) topics.push(topicPool.splice(rng.value%topicPool.length,1)[0]), rng.value=(Math.imul(rng.value,1664525)+1013904223)>>>0;
  paragraphs.push(...topics);

  const matchupScore=matchup?.weightedScore;
  if(matchupScore!=null && (good.length||bad.length)){
    const matchupLines=[];
    if(matchupScore>=65) matchupLines.push(`the overall matchup picture is looking pretty friendly at ${Math.round(matchupScore)}/100. ${good.length?`i especially like how it lines up with ${good.slice(0,2).map(fmt).join(' and ')}.`:'the broad spread is doing you some favors.'}`);
    else if(matchupScore<=35) matchupLines.push(`the matchup picture is the part i would respect most here. it is around ${Math.round(matchupScore)}/100, so team support and smart positioning are going to matter a lot.`);
    else matchupLines.push(`the matchup spread is pretty mixed at ${Math.round(matchupScore)}/100. that makes team fit more important than trying to force this into every matchup.`);
    if(good.length && bad.length && power>=55) matchupLines.push(pick([
      `the fun part is the contrast. ${good[0]?.p?.name||'the good matchups'} can give it room to work, while ${bad[0]?.p?.name||'the rough matchups'} are the ones i would plan for ahead of time.`,
      `i would play to the favorable side first and keep a clean answer for ${bad[0]?.p?.name||'the nastier counterplay'}.`,
      `the good games look genuinely useful, but i would not pretend the bad ones disappear. that is where the team around it earns its paycheck.`
    ]));
    else if(good.length && power>=60) matchupLines.push(pick([`i really like the games into ${good.map(fmt).join(', ')}. those are the spots where this can look way better than the raw numbers suggest.`,`when ${good[0]?.p?.name||'the favorable matchups'} shows up, i would be very happy to have this thing in the back pocket.`]));
    else if(bad.length) matchupLines.push(pick([`i would have a plan for ${bad.map(fmt).join(', ')}. those are the games where i would rather have this paired with a teammate that patches the hole.`,`the rough side is mostly ${bad.slice(0,2).map(fmt).join(' and ')}. do not make this mon solve those problems alone.`]));
    paragraphs.push(...matchupLines);
  }

  if(tone==='monster' || tone==='strong') paragraphs.push(pick(['i would not overcomplicate the set. give it a clean job, good support, and let the stats do their thing.','this is where i would start testing the greedy options first, because the ceiling looks worth exploring.','if the first few games feel unfair, that is useful information. keep an eye on how easily it converts free turns.']));
  else if(tone==='solid') paragraphs.push(pick(['i would keep the set flexible. this feels like the kind of mon that gets better once you know exactly what the team needs.','do not chase the fanciest set first. find the boring set that wins games, then get weird.','the best version of this probably looks simple on paper and surprisingly annoying in practice.']));
  else paragraphs.push(pick(['i would make the team do some of the heavy lifting here. get this into the games it actually wants and it can still earn its keep.','this is a good candidate for a focused role instead of a kitchen sink set.','give it the right teammates and let the niche do the talking.']));

  if((rng.value>>>0)%100 < 42) paragraphs.push(pick([
    `${merchantThing}. that is the whole review.`,
    `${pick(['oh NAH what is ts','ts gas gng','would. next question','jarvis get ts out of here'])} i have seen enough.`,
    `${monName} is giving ${pick(['problem','gremlin','merchant','certified nonsense'])} energy. respectfully.`,
    `i am putting this one in the ${pick(['do not give it free turns','someone test this immediately','why is this working','back to the kitchen'])} folder.`
  ]));
  if(power>=78) paragraphs.push(`my read is ${tierText} for ${selectedFormat}. ${pick(toneSets[tone].closers)}.`);
  else if(power>=55) paragraphs.push(`${tierText} feels like a fair starting point for ${selectedFormat}. ${pick(toneSets[tone].closers)}.`);
  else paragraphs.push(`i would start around ${tierText} in ${selectedFormat}. ${pick(toneSets[tone].closers)}.`);
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
  const roleSignals={
    physicalSweeper: Math.max(0,atk-90)*0.5 + physical.length*6 + ((mon.types||[]).some(t=>physical.some(m=>m.type===t))?14:0) + (spe>=90?10:0) + (setup>=2?Math.min(12,setup*4):0),
    specialSweeper: Math.max(0,spa-90)*0.5 + special.length*6 + ((mon.types||[]).some(t=>special.some(m=>m.type===t))?14:0) + (spe>=90?10:0) + (setup>=2?Math.min(12,setup*4):0),
    wallbreaker: Math.max(0,Math.max(atk,spa)-100)*0.7 + usefulDamaging.filter(m=>(Number(m.basePower)||0)>=100).length*8 + offensiveTools*2,
    bulkyAttacker: Math.max(0,bulk-240)*0.2 + Math.max(0,Math.max(atk,spa)-95)*0.4 + recoveryQuality*0.12 + usefulDamaging.length*2,
    defensive: Math.max(0,physicalBulk-155)*0.35 + Math.max(0,specialBulk-155)*0.35 + recoveryQuality*0.3 + defensiveTools*4,
    support: defensiveTools*6 + Math.max(0,bulk-240)*0.15,
    pivot: pivot*30 + (spe>=70?8:0) + Math.min(4,statusUtility)*2,
    setupSweeper: (setup>=2 && (atk>=100 || spa>=100 || spe>=90) && usefulDamaging.length>=2) ? setup*18 + (spe>=75?12:0) + usefulDamaging.length*4 : 0,
    hazard: hazards*40 + removal*8 + Math.min(3,statusUtility)*2,
    screens: unique.some(m=>/reflect|light screen|aurora veil/i.test(String(m.name||''))) ? 50 + (pivot?15:0) + (spe>=90?10:0) : 0
  };
  const learn=learnsetRecord(mon);
  const moveDepth=mon.fake?unique.length:Math.max(unique.length,Object.keys(learn||{}).length);
  return {
    typing:typingProfile(mon.types),moves:unique,usefulMoves:useful,moveDepth,stabCount:stab.length,
    physical:physical.length,special:special.length,status:status.length,setup,recovery,hazards,removal,pivot,
    statusUtility,defensiveSetup,bestPower,stabPower,bulk,physicalBulk,specialBulk,speed:spe,offensive,
    offensivePhysical,offensiveSpecial,redundancyPenalty,recoveryQuality,recoveryMoves:recoveryMoves.length,recoveryMovesList,
    coverageTypes:coverageTypes.length,defensiveTools,offensiveTools,roleSignals,
    hp,atk,def,spa,spd,spe,
    maxOffensiveStat:Math.max(atk,spa),
    abilities:abilityNames(mon.abilities),bst:hp+atk+def+spa+spd+spe
  };
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

function movePressure(attacker, defender){
  const moves=(attacker?.fake?attacker.learnset||[]:learnsetMoves(attacker)).map(moveData).filter(Boolean);
  const types=attacker?.types||[];
  const stats=attacker?.stats||{};
  const d=defender?.stats||{};
  let best=0;
  for(const m of moves){
    if(!['Physical','Special'].includes(m.category)) continue;
    const bp=Number(m.basePower)||0;
    if(bp<=0) continue;
    const atk=m.category==='Physical'?(Number(stats.atk)||0):(Number(stats.spa)||0);
    const def=m.category==='Physical'?(Number(d.def)||0):(Number(d.spd)||0);
    if(atk<=0||def<=0) continue;
    const typeMult=(defender?.types||[]).reduce((x,t)=>x*(TYPE_EFFECTIVENESS[m.type]?.[t]??1),1);
    if(typeMult===0) continue;
    const stab=types.includes(m.type)?1.5:1;
    const accuracy=Number(m.accuracy);
    const accFactor=Number.isFinite(accuracy)?Math.max(.55,accuracy/100):1;
    const priority=Number(m.priority||0)>0?1.08:1;
    const setupBoost=/swords dance|nasty plot|calm mind|dragon dance|quiver dance|shell smash|shift gear|bulk up|curse/i.test(`${m.name||''} ${m.desc||''}`)?1.08:1;
    const pressure=(atk/Math.max(1,def))*bp*typeMult*stab*accFactor*priority*setupBoost;
    best=Math.max(best,pressure);
  }
  // Keep a stat-only fallback for a sparse Fakemon movepool.
  if(!best){
    const atk=Math.max(Number(stats.atk)||0,Number(stats.spa)||0);
    const def=Math.max(Number(d.def)||0,Number(d.spd)||0);
    const typeMult=offensiveTypeMatchup(attacker,defender);
    best=(atk/Math.max(1,def))*100*typeMult;
  }
  return best;
}
function defensivePressure(defender, attacker){
  const d=defender?.stats||{}, a=attacker?.stats||{};
  const physical=Math.sqrt(Math.max(1,(Number(d.hp)||0)*(Number(d.def)||0)));
  const special=Math.sqrt(Math.max(1,(Number(d.hp)||0)*(Number(d.spd)||0)));
  const incoming=fastMatchupScore(attacker,defender);
  const type=defensiveTypeMatchup(defender,attacker);
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
  const counterplay=clamp(
    50 +
    (spe<60?9:spe<80?4:spe>=110?-7:0) +
    (tf.typing.weak>=5?7:tf.typing.weak>=3?3:-3) +
    (tf.typing.severe>=1?6:0) +
    (recovery? -8:5) +
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
  const score=clamp(statPower*.68+Math.min(18,synergy)+Math.min(8,extremeStatCount*2));

  return {
    score,
    statPower,
    bulkPower,
    offensePower,
    counterplay,
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
      counterplay
    }
  };
}

function offensiveTypeMatchup(attackingTypes, defendingTypes){
  const atk = Array.isArray(attackingTypes) ? attackingTypes.filter(Boolean) : [];
  const def = Array.isArray(defendingTypes) ? defendingTypes.filter(Boolean) : [];
  if (!atk.length || !def.length) return 1;

  let best = 0;
  for (const a of atk) {
    let mult = 1;
    const row = TYPE_CHART[a] || {};
    for (const d of def) mult *= Number(row[d] ?? 1);
    best = Math.max(best, mult);
  }
  return best || 1;
}

function defensiveTypeMatchup(defendingTypes, attackingTypes){
  const def = Array.isArray(defendingTypes) ? defendingTypes.filter(Boolean) : [];
  const atk = Array.isArray(attackingTypes) ? attackingTypes.filter(Boolean) : [];
  if (!def.length || !atk.length) return 1;

  let worst = 1;
  for (const a of atk) {
    let mult = 1;
    const row = TYPE_CHART[a] || {};
    for (const d of def) mult *= Number(row[d] ?? 1);
    worst = Math.max(worst, mult);
  }
  return worst;
}

function fastMatchupScore(attacker,defender){
  const a=attacker?.stats||{},d=defender?.stats||{};
  const speed=Number(a.spe)||0, enemySpeed=Number(d.spe)||0;
  const offType=offensiveTypeMatchup(attacker,defender);
  const inType=defensiveTypeMatchup(attacker,defender);
  const pressure=movePressure(attacker,defender);
  const enemyPressure=movePressure(defender,attacker);
  const atkPressure=clamp(50+Math.log10(Math.max(1,pressure)/Math.max(1,enemyPressure))*24);
  const typeScore=offType===0?-25:offType>=4?24:offType>=2?17:offType===1?4:offType<=.5?-10:0;
  const switchScore=inType===0?22:inType<=.25?19:inType<=.5?12:inType<=1?4:inType>=4?-22:inType>=2?-13:0;
  const speedScore=speed>=enemySpeed?(speed>=enemySpeed*1.12?10:5):(speed*1.12<enemySpeed?-10:-4);
  return clamp(50+(atkPressure-50)*.50+typeScore+switchScore+speedScore);
}
function buildMatchupProfile(target,pool,usage){
  const rows=pool.filter(p=>p?.stats&&usageOf(p.name,usage)>0).map(p=>{
    const u=usageOf(p.name,usage);
    const score=fastMatchupScore(target,p);
    // A matchup should be informative without becoming a giant penalty for a
    // Fakemon that simply has unusual tools. Unknown interactions stay near 50.
    return {p,usage:u,score,targetScore:score,enemyScore:fastMatchupScore(p,target)};
  });
  rows.sort((a,b)=>b.usage-a.usage);
  const total=rows.reduce((s,x)=>s+x.usage,0);
  const weightedRaw=total?rows.reduce((s,x)=>s+x.score*x.usage,0)/total:50;
  // Pull sparse/rough matchup estimates toward neutral instead of treating every
  // imperfect approximation as a real loss. This prevents unique kits from being
  // systematically pushed downward.
  const coverageFactor=Math.min(1,rows.length/24);
  const weightedScore=50+(weightedRaw-50)*(.55+.45*coverageFactor);
  const sortedByImpact=[...rows].sort((a,b)=>b.usage*Math.abs(b.score-50)-a.usage*Math.abs(a.score-50));
  const good=[...rows].sort((a,b)=>b.usage*(b.score-50)-a.usage*(a.score-50)).filter(x=>x.score>=60).slice(0,6);
  const bad=[...rows].sort((a,b)=>a.usage*(a.score-50)-b.usage*(b.score-50)).filter(x=>x.score<=40).slice(0,6);
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

  // Matchups remain the practical center of the prediction. CAP BSR is a
  // second pillar that tells us how much raw stat architecture can support
  // the kit. It is never converted directly into a tier.
  const core=clamp(
    m*.38 +
    top*.10 +
    clamp(metagameFit??50)*.12 +
    utility*.08 +
    statPower*.25 +
    kitPower*.07
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
    (matchup?.weightedScore??50)*.32 +
    (matchup?.topWeighted??50)*.10 +
    (matchup?.matchupPct??50)*.05 +
    clamp(metagameFit??50)*.10 +
    clamp(roleScore)*.08 +
    clamp(intrinsic?.statPower??50)*.25 +
    clamp(intrinsic?.score??50)*.10
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
    const roleValues=Object.entries(tf.roleSignals||{}).sort((a,b)=>b[1]-a[1]);
    const primaryRole=roleValues[0]?.[0]||'wallbreaker';
    const secondaryRole=roleValues[1]?.[0]||primaryRole;
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
    const matchup=buildMatchupProfile(target,pool,usage);
    const closest=cheap.map(x=>({p:x.p,score:similarity(target,x.p,tf,x.f,0)})).sort((a,b)=>b.score-a.score).slice(0,8);
    const targetForTier={...tf,bulkPct,stats:t.stats,name:t.name};
    const tier=estimateTier(abilityAdjustedBase,closest,tierUsage,officialTiers,targetForTier,cfg,matchup,roleScore,tf,metagameFit,intrinsic);
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
    if(tf.speed<70)weaknesses.push('Low Speed can leave it vulnerable to offensive pressure');
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

        <div class="analysis-card panel-lite"><h3>Selected environment</h3><p><strong>${esc(selectedFormat)}</strong></p><p>${metagameEntries.length} usage-weighted Pokémon represented</p><div class="analysis-stat-combo"><div><span>Stat profile</span><b>${metagameStatCombination==null?'—':Math.round(metagameStatCombination)+'/100'}</b></div><div><span>Bulk</span><b>${metagameBulkPct==null?'—':Math.round(metagameBulkPct)+'th'}</b></div><div><span>Offense</span><b>${metagameOffPct==null?'—':Math.round(metagameOffPct)+'th'}</b></div><div><span>Speed</span><b>${metagameSpeedPct==null?'—':Math.round(metagameSpeedPct)+'th'}</b></div><div><span>Matchups</span><b>${matchup.weightedScore==null?'—':Math.round(matchup.weightedScore)+'/100'}</b></div></div></div>

        <div class="analysis-card panel-lite"><h3>CAP stat rating</h3><div class="analysis-big">${Math.round(intrinsic.cap.BSR)}</div><p>${esc(intrinsic.cap.category)} · CAP's nonlinear stat rating. This is a stat-power measure, not an automatic tier.</p><div class="analysis-stat-combo"><div><span>PT</span><b>${Math.round(intrinsic.cap.PT)}</b></div><div><span>ST</span><b>${Math.round(intrinsic.cap.ST)}</b></div><div><span>PS</span><b>${Math.round(intrinsic.cap.PS)}</b></div><div><span>SS</span><b>${Math.round(intrinsic.cap.SS)}</b></div><div><span>ODB</span><b>${intrinsic.cap.ODB.toFixed(1)}</b></div><div><span>PSB</span><b>${intrinsic.cap.PSB.toFixed(1)}</b></div></div><p>Kit ceiling <b>${Math.round(intrinsic.score)}/100</b> · Matchups <b>${Math.round(matchup.weightedScore||50)}/100</b></p></div>
      </div>

      <div class="analysis-card panel-lite analysis-matchups-card">
        <div class="analysis-matchups-header"><div><h3>Metagame matchups</h3><p>Usage-weighted matchup estimates against the selected environment.</p></div><div class="analysis-matchups-score"><span>Overall</span><b>${matchup.weightedScore==null?'—':Math.round(matchup.weightedScore)+'/100'}</b></div></div>
        <div class="analysis-matchup-columns">
          <div class="analysis-matchup-group favorable"><h4><span>✓</span> Looks good into</h4>
            <div class="analysis-matchup-list">${(matchup.good||[]).map(x=>`<div class="analysis-matchup-card"><div class="analysis-matchup-icon"><img src="https://play.pokemonshowdown.com/sprites/gen5ani/${String(x.p?.id||x.p?.name||'missingno').toLowerCase().replace(/[^a-z0-9-]+/g,'-')}.gif" alt="" loading="lazy" onerror="this.onerror=null;this.src='https://play.pokemonshowdown.com/sprites/gen5/${String(x.p?.id||x.p?.name||'missingno').toLowerCase().replace(/[^a-z0-9-]+/g,'-')}.png';"></div><div class="analysis-matchup-info"><strong>${esc(x.p.name)}</strong><span>Favorable matchup</span></div><b class="analysis-matchup-score">${Math.round(x.score)}</b></div>`).join('')||'<div class="analysis-muted">No clear favorable matchups.</div>'}</div>
          </div>
          <div class="analysis-matchup-group unfavorable"><h4><span>×</span> Looks rough into</h4>
            <div class="analysis-matchup-list">${(matchup.bad||[]).map(x=>`<div class="analysis-matchup-card"><div class="analysis-matchup-icon"><img src="https://play.pokemonshowdown.com/sprites/gen5ani/${String(x.p?.id||x.p?.name||'missingno').toLowerCase().replace(/[^a-z0-9-]+/g,'-')}.gif" alt="" loading="lazy" onerror="this.onerror=null;this.src='https://play.pokemonshowdown.com/sprites/gen5/${String(x.p?.id||x.p?.name||'missingno').toLowerCase().replace(/[^a-z0-9-]+/g,'-')}.png';"></div><div class="analysis-matchup-info"><strong>${esc(x.p.name)}</strong><span>Unfavorable matchup</span></div><b class="analysis-matchup-score">${Math.round(x.score)}</b></div>`).join('')||'<div class="analysis-muted">No clear unfavorable matchups.</div>'}</div>
          </div>
        </div>
      </div>
`;

    const loadedUsageCount=Object.values(tierUsage).reduce((n,t)=>n+Object.keys(t||{}).length,0);
    status.innerHTML=`<span class="analysis-ok">✓</span><span>Analysis updated · ${pool.length} comparison Pokémon · ${metagameEntries.length} usage-weighted in ${esc(selectedFormat)} · ${loadedUsageCount} usage records loaded</span>`;
    if(typeof lucide!=='undefined')lucide.createIcons();
  }catch(e){
    console.error('[Analysis]',e);
    status.innerHTML='<span class="analysis-error">Analysis failed</span>';
    results.innerHTML=`<div class="analysis-error panel-lite">${esc(e.message||'Analysis failed.')}</div>`;
  }finally{analysisBusy=false;}
}
function openAnalysisTab(){const tab=document.querySelector('.tab[onclick*="analysis"]');if(tab)switchTab(tab,'analysis');}
export {ensurePanel as renderAnalysis,runFakemonAnalysis,analysisPoolChanged,openAnalysisTab,scheduleAnalysis};