import { state } from './app.js';
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
function abilityNames(raw){
  if(Array.isArray(raw))return raw.map(x=>typeof x==='string'?x:x?.name).filter(Boolean);
  if(raw&&typeof raw==='object')return Object.values(raw).map(x=>typeof x==='string'?x:x?.name).filter(Boolean);
  return raw?[String(raw)]:[];
}
function uniqueDex(){
  const seen=new Set();
  return Object.values(state.sdPokedex||{}).filter(p=>{
    if(!p?.name||!p?.stats||!p?.types||!p.num||p.num<0)return false;
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
  return {ou:`gen${g}ou`,uu:`gen${g}uu`,ru:`gen${g}ru`,nu:`gen${g}nu`,pu:`gen${g}pu`,ubers:`gen${g}ubers`};
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
  if(!cfg.natdex && Number(cfg.gen||9)!==9) return {};
  const key = cfg.natdex ? 'gen9-natdex' : 'gen9';
  if(tierDataCache[key]) return tierDataCache[key];
  if(tierDataPromise[key]) return tierDataPromise[key];
  const url = 'https://raw.githubusercontent.com/smogon/pokemon-showdown/master/data/formats-data.ts';
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
      const species=line.match(/^  ([a-z0-9]+):\s*\{\s*$/);
      if(species){ flush(); currentId=species[1]; continue; }
      if(!currentId) continue;
      const tierMatch=line.match(/^\s{4}tier:\s*["']([^"']+)["']/);
      const natMatch=line.match(/^\s{4}natDexTier:\s*["']([^"']+)["']/);
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
    if(!tier) continue;
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
    const tierClass={UUBL:'OU',RUBL:'UU',NUBL:'RU',PUBL:'NU',ZUBL:'NU',Uber:'Ubers',AG:'Ubers'}[official]||official;
    return {tier:official,tierClass,usage,rank:usage?usageRank(name,tierUsage[tierKey]):Infinity,official:true};
  }
  // Fallback only when official tier data could not resolve this species/form.
  const order=['ubers','ou','uu','ru','nu','pu'];
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
function pickRandom(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function makeCasualSummary(t, tf, tier, closest, statCombination, roleScore, typePct){
  const types=(t.types||[]).filter(Boolean);
  const typeText=types.length?types.join(' / '):'plain typing';
  const stats=t.stats||{};
  const bestStat=Object.entries(stats).sort((a,b)=>Number(b[1])-Number(a[1]))[0];
  const speed=Number(stats.spe)||0;
  const closestName=closest?.[0]?.p?.name;
  const tierText=tier.tier||'the lower tiers';
  const tierKey=String(tierText).toLowerCase();

  // same sentence shape every time; only the little bits of slang are shuffled
  // so the message feels like something a person dropped in Discord.
  const tierOpeners={
    ubers:['oh NAH ts crazy twin','INSTANT BAN for you unc','bro WHAT is this','nah this is actually CRAZY'],
    ou:['this is goated twin','okay yeah this one is NICE','this one is kinda cooking','yeah i see the vision'],
    uu:['okayyy this one has sauce','this one is actually pretty clean','yeah this has some juice','okay i kinda mess with this'],
    ru:['not bad twin there is something here','okay i see the vision','this one has a little sauce','yeah we can work with this'],
    nu:['we might need to cook this one a little more','the vision is there trust','okay this one needs a little help','not cooked yet but i see it'],
    pu:['back to the kitchen with this one','we got a concept here but it needs work','okay unc we are still cooking','the idea is there somewhere'],
    zu:['yeah we need to cook this one from scratch','this one needs some serious help','the concept is fighting for its life','back to the lab with this one']
  };
  let opener=pickRandom(tierOpeners[tierKey]||['okay lets see what this thing is cooking']);

  const hooks=[];
  if(typePct>=85) hooks.push(pickRandom(['that typing is kinda NASTY','that typing is doing WORK','that typing is looking CLEAN']));
  if(speed>=120) hooks.push(pickRandom(['bro is MOVING','this thing is SPEEDING','good luck outspeeding this thing']));
  else if(speed>=105) hooks.push(pickRandom(['the Speed is pretty nice','it is quick enough to matter','it is not exactly sitting around']));
  else if(speed<=55) hooks.push(pickRandom(['it is definitely on the slower side','the Speed is gonna be a headache','yeah this thing is NOT winning races']));
  if(bestStat && Number(bestStat[1])>=130) hooks.push(pickRandom([
    `${STAT_NAMES[bestStat[0]]} is doing SERIOUS work`,
    `that ${STAT_NAMES[bestStat[0]]} stat is kinda ridiculous`,
    `the ${STAT_NAMES[bestStat[0]]} stat is carrying HARD`
  ]));
  if(tf.recovery && tf.pivot) hooks.push(pickRandom(['the healing and pivoting combo is nasty','recovery plus pivoting is a REALLY good combo','being able to heal and pivot is huge']));
  else if(tf.recovery) hooks.push(pickRandom(['the healing gives it real staying power','having recovery makes this way harder to wear down','the recovery gives it a lot of breathing room']));
  else if(tf.pivot) hooks.push(pickRandom(['the pivoting gives it a lot of options','being able to pivot is really nice here','the pivoting is doing some REAL work']));
  if(tf.typing.resist+tf.typing.immune>=7) hooks.push(pickRandom(['it has a LOT of useful switch-ins','it can come in on a pretty wide range of attacks','the number of useful switch-ins is kinda wild']));
  if(statCombination>=85) hooks.push(pickRandom(['the stat spread is SERIOUSLY strong','the stats are looking really healthy','the overall stat spread is doing NUMBERS']));
  if(tf.setup && (tf.offensive||statCombination>=70)) hooks.push(pickRandom(['it can snowball if it gets a free turn','give this thing a setup turn and it gets UGLY','it has the tools to snowball pretty fast']));
  if(tf.offensive>=125) hooks.push(pickRandom(['it can actually hit pretty hard','the offensive pressure is NO JOKE','it has enough firepower to make switches hurt']));

  const roleBits=[];
  if(tf.recovery) roleBits.push('reliable healing');
  if(tf.pivot) roleBits.push('pivoting');
  if(tf.hazards) roleBits.push('hazard setting');
  if(tf.removal) roleBits.push('hazard removal');
  if(tf.setup) roleBits.push('setup options');
  if(tf.statusUtility) roleBits.push('status moves');
  const roleText=roleBits.slice(0,2).join(' and ') || 'a straightforward game plan';

  let sentence=`this is a ${typeText} Pokémon with ${roleText}. `;
  if(bestStat && Number(bestStat[1])>=110) sentence+=`${STAT_NAMES[bestStat[0]]} is its standout stat. `;
  else if(speed<=60) sentence+='it is definitely on the slower side. ';
  else if(speed>=110) sentence+='it has enough Speed to keep up with a lot of threats. ';
  else sentence+='its stats are fairly balanced. ';
  if(hooks.length) sentence+=hooks.slice(0,2).join(' ')+'. ';
  if(closestName) sentence+=`it is closest to ${closestName} here, and the model puts it around ${tierText}.`;
  else sentence+=`overall, the model puts it around ${tierText}.`;
  return `${opener}. ${sentence}`;
}
function detailedProfile(mon){
  const moves=mon.fake?(mon.learnset||[]).map(moveData).filter(Boolean):learnsetMoves(mon);
  const unique=[...new Map(moves.map(m=>[normalizeName(m.name),m])).values()];
  const damaging=unique.filter(m=>Number(m.basePower)>0);
  const stab=damaging.filter(m=>(mon.types||[]).includes(m.type));
  const physical=damaging.filter(m=>m.category==='Physical');
  const special=damaging.filter(m=>m.category==='Special');
  const status=unique.filter(m=>m.category==='Status');
  const setup=unique.filter(m=>/swords dance|nasty plot|calm mind|bulk up|dragon dance|quiver dance|shell smash|shift gear|curse|iron defense|agility|trailblaze|growth/i.test(`${m.name} ${m.desc||''}`)).length;
  const recovery=unique.filter(m=>/recover|roost|wish|moonlight|synthesis|slack off|soft-boiled|shore up|morning sun|strength sap|rest/i.test(`${m.name} ${m.desc||''}`)).length;
  const hazards=unique.filter(m=>/stealth rock|spikes|toxic spikes|sticky web|ceaseless edge|stone axe/i.test(m.name||'')).length;
  const removal=unique.filter(m=>/rapid spin|defog|court change|mortal spin/i.test(m.name||'')).length;
  const pivot=unique.filter(m=>/u-turn|volt switch|flip turn|parting shot|teleport|chilly reception|baton pass/i.test(m.name||'')).length;
  const statusUtility=unique.filter(m=>/toxic|will-o-wisp|thunder wave|spore|sleep powder|glare|taunt|encore|knock off|trick|haze|whirlwind|roar/i.test(`${m.name} ${m.desc||''}`)).length;
  const bestPower=Math.max(0,...damaging.map(m=>Number(m.basePower)||0));
  const stabPower=Math.max(0,...stab.map(m=>Number(m.basePower)||0));
  const {hp,atk,def,spa,spd,spe}=mon.stats;
  const bulk=Math.sqrt(Math.max(0,hp*Math.max(1,(def+spd)/2)));
  const offensive=Math.max(atk,spa)+bestPower*.35+stabPower*.22+setup*7+Math.min(20,physical.length+special.length)*1.2;
  const learn=learnsetRecord(mon);
  const moveDepth=mon.fake?unique.length:Math.max(unique.length,Object.keys(learn||{}).length);
  return {typing:typingProfile(mon.types),moves:unique,moveDepth,stabCount:stab.length,physical:physical.length,special:special.length,status:status.length,setup,recovery,hazards,removal,pivot,statusUtility,bestPower,stabPower,bulk,speed:spe,offensive,abilities:abilityNames(mon.abilities),bst:hp+atk+def+spa+spd+spe};
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
function estimateTier(base,closest,tierUsage,officialTiers,targetProfile,cfg){
  // Tier prediction is anchored to *actual usage placement* first and our
  // synthetic score second. This prevents a bulky, role-compressed Pokémon
  // from being promoted just because its raw profile scores well.
  let score=base;
  const evidence=closest.map(x=>({
    ...x,
    evidence:usageTierEvidence(x.p.name,tierUsage,officialTiers,cfg)
  })).filter(x=>x.evidence);

  const weighted={Ubers:0,OU:0,UU:0,RU:0,NU:0,PU:0};
  for(const x of evidence){
    const w=Math.pow(Math.max(0,x.score)/100,3);
    weighted[x.evidence.tierClass]=(weighted[x.evidence.tierClass]||0)+w;
  }
  const evidenceTotal=Object.values(weighted).reduce((a,b)=>a+b,0);
  let anchor='';
  if(evidenceTotal){
    anchor=Object.entries(weighted).sort((a,b)=>b[1]-a[1])[0][0];
    const anchorShare=weighted[anchor]/evidenceTotal;
    // Only let usage anchor the tier when the closest analogues actually agree.
    if(anchorShare>=0.48){
      if(anchor==='Ubers') score+=22;
      else if(anchor==='OU') score+=18;
      else if(anchor==='UU') score+=8;
      else if(anchor==='RU') score-=3;
      else if(anchor==='NU') score-=7;
      else if(anchor==='PU') score-=10;
    }
  }

  // A high-quality defensive profile should improve the viability score, but it
  // should not by itself promote a mon into a higher usage tier.
  if(targetProfile.typing.score>=80 && targetProfile.recovery>=1 && (targetProfile.pivot||targetProfile.removal||targetProfile.hazards)) score+=4;

  const st=targetProfile.stats||{};
  const highSpread=[st.hp,st.atk,st.def,st.spa,st.spd,st.spe].filter(v=>v>=100).length;
  const veryHigh=Object.values(st).filter(v=>v>=120).length;
  const bst=targetProfile.bst||0;
  // Keep the explicit extreme-stat safeguard for Arceus-like designs, but make
  // it independent from defensive role score inflation.
  const extremeStats=(bst>=720 && highSpread>=5 && score>=78) ||
    (bst>=680 && highSpread>=5 && veryHigh>=3 && targetProfile.speed>=100 && score>=86);

  score=clamp(score);
  let tier=score>=78?'OU':score>=64?'UU':score>=54?'RU':score>=44?'NU':'PU';

  // Usage evidence can promote/demote the heuristic only when the analogue
  // signal is reasonably strong. This is intentionally conservative around
  // neighboring tiers.
  if(anchor==='OU' && weighted.OU>=0.75*(evidenceTotal||1) && score>=66) tier='OU';
  else if(anchor==='UU' && weighted.UU>=0.75*(evidenceTotal||1) && score<78) tier='UU';
  else if(anchor==='RU' && weighted.RU>=0.75*(evidenceTotal||1) && score<70) tier='RU';
  else if(anchor==='NU' && weighted.NU>=0.75*(evidenceTotal||1) && score<62) tier='NU';
  else if(anchor==='PU' && weighted.PU>=0.75*(evidenceTotal||1) && score<54) tier='PU';

  // ubers is deliberately separate from usage. a pokemon showing up in the
  // ubers usage file does NOT mean it belongs to ubers; lower-tier pokemon can
  // appear there because of sample teams, tours, testing, or unusual formats.
  // this is especially important for bulky mons like Alomomola.
  // only an extreme stat profile can trigger the automatic ubers result here.
  // an exact-match vanilla pokemon is handled by the normal tier anchor above,
  // so it cannot be promoted just because it has any ubers usage.
  if(extremeStats) tier='Ubers';

  const usageCoverage=Object.values(tierUsage).some(x=>Object.keys(x||{}).length);
  const confidence=clamp(58+(evidence.length?Math.min(24,evidence.length*4):0)+(usageCoverage?15:0)+(anchor?8:0));
  return {tier,score,confidence,anchor,usageEvidence:evidence,weighted};
}
function renderBars(obj){return Object.entries(obj).map(([k,v])=>`<div class="analysis-stat-row"><span>${esc(STAT_NAMES[k]||k)}</span><div class="analysis-bar"><i style="width:${clamp(v)}%"></i></div><b>${Math.round(v)}%</b></div>`).join('');}
function getCfg(){return {pool:document.getElementById('analysis-pool')?.value||'generation',gen:Number(document.getElementById('analysis-gen')?.value||9),natdex:!!document.getElementById('analysis-natdex')?.checked,folder:document.getElementById('analysis-folder')?.value||''};}
function analysisPoolChanged(){
  const pool=document.getElementById('analysis-pool')?.value;if(!pool)return;
  document.getElementById('analysis-gen-wrap').style.display='';
  document.getElementById('analysis-folder-wrap').style.display=(pool==='folder'?'':'none');
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
      <div class="analysis-control"><label>Compare Against</label><select id="analysis-pool" onchange="analysisPoolChanged()"><option value="generation">Generation</option><option value="collection">My Collection</option><option value="folder">Collection Folder</option></select></div>
      <div id="analysis-gen-wrap" class="analysis-control"><label>Generation</label><select id="analysis-gen" onchange="scheduleAnalysis()">${[9,8,7,6,5,4,3,2,1].map(g=>`<option value="${g}">Gen ${g}</option>`).join('')}</select></div>
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
  const key=JSON.stringify([cfg.pool,cfg.gen,cfg.natdex,cfg.folder,getTarget().stats,getTarget().types,state.abilities?.map(a=>a.name),state.learnset?.map(m=>m.name)]);
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
    const [ouUsage,uuUsage,ruUsage,nuUsage,puUsage,ubersUsage]=await Promise.all([
      loadUsage(formats.ou),loadUsage(formats.uu),loadUsage(formats.ru),
      loadUsage(formats.nu),loadUsage(formats.pu),loadUsage(formats.ubers)
    ]);
    const tierUsage={ou:ouUsage,uu:uuUsage,ru:ruUsage,nu:nuUsage,pu:puUsage,ubers:ubersUsage};
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
    // One score for the *combination* of stats. This rewards useful distributions
    // rather than simply rewarding a high BST: bulk, offense, speed and total stats
    // all have to contribute.
    const statCombination=clamp(.34*bulkPct+.28*offPct+.18*speedPct+.20*bstPct);
    const roleScore=clamp(48
      +(tf.recovery?12:0)+(tf.pivot?9:0)+(tf.removal?7:0)+(tf.hazards?6:0)
      +(tf.setup?7:0)+(tf.statusUtility>=2?5:tf.statusUtility?2:0)
      +(tf.typing.resist+tf.typing.immune>=6?8:0)
      -(tf.typing.weak>=6?6:0)-(tf.typing.severe>=2?6:0)
    );
    const base=clamp(.45*statCombination+.25*typePct+.30*roleScore);
    status.innerHTML='<span class="analysis-spinner"></span><span>Finding closest competitive analogues…</span>';
    // Similarity is deliberately cheap: only stats, typing, abilities and bulk/offense. Detailed
    // move parsing is done for the target only, avoiding thousands of learnset traversals.
    const closest=cheap.map(x=>({p:x.p,score:similarity(target,x.p,tf,x.f,0)})).sort((a,b)=>b.score-a.score).slice(0,8);
    const targetForTier={...tf,bulkPct,stats:t.stats};
    const tier=estimateTier(base,closest,tierUsage,officialTiers,{...targetForTier,name:t.name},cfg);
    const strengths=[],weaknesses=[];
    Object.entries(statPct).sort((a,b)=>b[1]-a[1]).slice(0,2).filter(x=>x[1]>=70).forEach(([k,v])=>strengths.push(`${STAT_NAMES[k]} is ${Math.round(v)}th percentile`));
    Object.entries(statPct).sort((a,b)=>a[1]-b[1]).slice(0,2).filter(x=>x[1]<=35).forEach(([k,v])=>weaknesses.push(`${STAT_NAMES[k]} is ${Math.round(v)}th percentile`));
    if(tf.typing.resist+tf.typing.immune>=6)strengths.push(`${tf.typing.resist} resistances and ${tf.typing.immune} immunities provide strong switch-in potential`);
    if(tf.recovery)strengths.push('Reliable recovery is available');
    if(tf.pivot)strengths.push('Pivoting adds role compression');
    if(tf.hazards||tf.removal)strengths.push('Hazard utility adds team value');
    if(tf.setup)strengths.push('Setup options increase its ceiling');
    if(tf.typing.weak>=5)weaknesses.push(`${tf.typing.weak} attacking types hit it super effectively`);
    if(tf.speed<70)weaknesses.push('Low Speed can leave it vulnerable to offensive pressure');
    const rows=closest.map(x=>{const ev=usageTierEvidence(x.p.name,tierUsage,officialTiers,cfg);const tierUsageValue=ev?.usage||0;return `<tr><td><strong>${esc(x.p.name)}</strong></td><td>${Math.round(x.score)}%</td><td><div class="analysis-type-list">${analysisTypePills(x.p.types)}</div></td><td>${Object.values(x.p.stats||{}).join(' / ')}</td><td>${tierUsageValue?(tierUsageValue*100).toFixed(2)+'%':'—'}</td></tr>`;}).join('');
    results.innerHTML=`
      <div class="analysis-summary-grid">
        <div class="analysis-hero panel-lite"><div class="analysis-kicker">Estimated competitive profile</div><div class="analysis-tier">${esc(tier.tier)}</div><div class="analysis-score">${Math.round(tier.score)}/100 · ${Math.round(tier.confidence)}% confidence</div><div class="analysis-discord-message"><img class="analysis-discord-avatar" src="inoue_profile.gif" alt="Inoue"><div class="analysis-discord-body"><div class="analysis-discord-name">Inoue</div><div class="analysis-discord-text">${esc(makeCasualSummary(t,tf,tier,closest,statCombination,roleScore,typePct))}</div></div></div><div class="analysis-disclaimer"><strong>Take it with a grain of salt.</strong> This is an estimate, not an official competitive ranking.</div></div>
        <div class="analysis-card panel-lite"><h3>Typing & role</h3><div class="analysis-big">${Math.round(typePct)}th</div><p><span class="analysis-type-list">${analysisTypePills(t.types)||'<span>None</span>'}</span> · ${tf.typing.weak} weaknesses · ${tf.typing.resist} resistances · ${tf.typing.immune} immunities</p><p>${tf.recovery?'Recovery · ':''}${tf.pivot?'Pivot · ':''}${tf.hazards?'Hazards · ':''}${tf.removal?'Removal · ':''}${tf.setup?'Setup · ':''}${tf.statusUtility?'Status utility':''}</p><div class="analysis-role-score">Role value <b>${Math.round(roleScore)}/100</b></div></div>
        <div class="analysis-card panel-lite"><h3>Stat combination</h3><div class="analysis-big">${Math.round(statCombination)}/100</div><p>Overall quality of the stat spread relative to the selected pool.</p><div class="analysis-stat-combo"><div><span>Bulk</span><b>${Math.round(bulkPct)}th</b></div><div><span>Offense</span><b>${Math.round(offPct)}th</b></div><div><span>Speed</span><b>${Math.round(speedPct)}th</b></div><div><span>BST</span><b>${Math.round(bstPct)}th</b></div></div></div>
      </div>
      <div class="analysis-two-col"><div class="analysis-card panel-lite"><h3>Strengths</h3><ul>${(strengths.length?strengths:['No major strength crossed the current thresholds.']).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div><div class="analysis-card panel-lite"><h3>Weaknesses</h3><ul>${(weaknesses.length?weaknesses:['No major weakness crossed the current thresholds.']).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div></div>
      <div class="analysis-card panel-lite"><h3>Closest Pokémon comparisons</h3><div class="analysis-table-wrap"><table class="analysis-table"><thead><tr><th>Pokémon</th><th>Similarity</th><th>Typing</th><th>Base stats</th><th>Usage</th></tr></thead><tbody>${rows}</tbody></table></div></div>
`;
    const loadedUsageCount=Object.values(tierUsage).reduce((n,t)=>n+Object.keys(t||{}).length,0);
    status.innerHTML=`<span class="analysis-ok">✓</span><span>Analysis updated · ${pool.length} comparison Pokémon · ${loadedUsageCount} usage records loaded</span>`;
    if(typeof lucide!=='undefined')lucide.createIcons();
  }catch(e){
    console.error('[Analysis]',e);
    status.innerHTML='<span class="analysis-error">Analysis failed</span>';
    results.innerHTML=`<div class="analysis-error panel-lite">${esc(e.message||'Analysis failed.')}</div>`;
  }finally{analysisBusy=false;}
}
function openAnalysisTab(){const tab=document.querySelector('.tab[onclick*="analysis"]');if(tab)switchTab(tab,'analysis');}
export {ensurePanel as renderAnalysis,runFakemonAnalysis,analysisPoolChanged,openAnalysisTab,scheduleAnalysis};
