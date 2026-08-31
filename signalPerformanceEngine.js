const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'signal-performance.json');
const MAX_EVENTS = Math.max(1000, Number(process.env.SIGNAL_PERFORMANCE_MAX_EVENTS) || 20000);

function load() {
  try { if (!fs.existsSync(FILE)) return []; const x=JSON.parse(fs.readFileSync(FILE,'utf8')); return Array.isArray(x)?x:[]; }
  catch(e){ console.error('[PERFORMANCE] load:',e.message); return []; }
}
function save(rows){ try { fs.writeFileSync(FILE, JSON.stringify(rows.slice(-MAX_EVENTS),null,2)); } catch(e){ console.error('[PERFORMANCE] save:',e.message); } }
function n(v,d=null){ const x=Number(v); return Number.isFinite(x)?x:d; }
function bucket(v,size=10){ const x=n(v); if(x===null)return null; const lo=Math.floor(x/size)*size; return `${lo}-${lo+size-1}`; }
function snapshot(input={}){
  const ez=input.entryZone||{}; const ss=input.signalStrength||{}; const cc=input.candleConfirmation||{}; const d=input.signalDiagnostics||{};
  return {
    setupId: input.setupId||null, symbol: input.symbol||null, direction: input.signal||input.direction||d.bestDirection||null,
    stage: input.stage||input.action||input.decision||null, price:n(input.currentPrice??input.livePrice??input.price),
    score:n(input.score??d.bestDirectionScore,0), requiredScore:n(input.requiredScore??d.requiredScore??d.effectiveMinScore,0),
    edge:n(input.edge??d.actualEdge,0), marketBias:input.marketBias||d.marketBias||null,
    signalStage:input.signalStage||d.signalStage||null, contextDirection:d.contextDirection||null, setupDirection:d.setupDirection||null,
    aligned:d.contextSetupAligned===true, conflict:d.contextSetupConflict===true,
    entryStatus:ez.status||input.entryStatus||null, entryQuality:ez.currentEntryQuality||input.entryQuality||null,
    entryScore:n(ez.currentEntryScore??input.entryScore), fvgId:ez.fvgId||null, fvgTimeframe:ez.timeframe||null,
    strength:n(ss.score??input.strengthScore), strengthLevel:ss.level||null, strengthRecommendation:ss.recommendation||input.strength||null,
    candleConfirmed:cc.confirmed===true, candleFinal:cc.finalStatus||cc.status||null,
    dataAgeStatus:input.signalAge?.status||d.dataAgeStatus||null,
    strategy:input.strategyName||input.strategy||null,
    scoreBucket:bucket(input.score??d.bestDirectionScore), strengthBucket:bucket(ss.score??input.strengthScore)
  };
}
function recordStage(input){
  const s=snapshot(input); if(!s.symbol||!['UP','DOWN'].includes(s.direction)||!s.stage)return null;
  const rows=load(); const now=Date.now();
  const setupId=s.setupId||`${s.symbol.replace('/','')}-${s.direction}-${now}`;
  const last=[...rows].reverse().find(r=>(r.setupId===setupId||( !r.setupId&&r.symbol===s.symbol&&r.direction===s.direction))&&now-r.atMs<10*60*1000);
  if(last && last.stage===s.stage && now-last.atMs<15000) return last;
  const rec={id:`${setupId}-${s.stage}-${now}`,setupId,at:new Date(now).toISOString(),atMs:now,...s};
  rows.push(rec); save(rows); console.log('[PERFORMANCE]',s.symbol,s.direction,'| stage:',s.stage,'| score:',s.score,'| strength:',s.strength??'-'); return rec;
}
function stats(){
  const rows=load(); const counts={}; rows.forEach(r=>counts[r.stage]=(counts[r.stage]||0)+1);
  const setups=new Map(); rows.forEach(r=>{ const key=r.setupId||`${r.symbol}|${r.direction}|legacy`; if(!setups.has(key))setups.set(key,[]); setups.get(key).push(r); });
  let getReady=0,toTrade=0,toSkip=0;
  for(const ev of setups.values()){ const gr=ev.find(x=>x.stage==='GET_READY'); if(!gr)continue; getReady++; const later=ev.filter(x=>x.atMs>=gr.atMs); if(later.some(x=>x.stage==='TRADE'))toTrade++; if(later.some(x=>x.stage==='SKIP'))toSkip++; }
  return {events:rows.length,counts,getReady:{total:getReady,toTrade,toSkip,conversionToTradePct:getReady?+(toTrade/getReady*100).toFixed(1):0}};
}
function estimateAccuracy(input, signalHistory=[]){
  const s=snapshot(input); const completed=(signalHistory||[]).filter(r=>r.status==='COMPLETED'&&r.signal===s.direction);
  const scored=completed.map(r=>{
    let similarity=0;
    if(r.symbol===s.symbol) similarity+=2;
    if(bucket(r.score)===s.scoreBucket) similarity+=2;
    if(r.entryQuality&&s.entryQuality&&String(r.entryQuality)===String(s.entryQuality)) similarity+=2;
    if(r.strengthScore!=null&&s.strength!=null&&bucket(r.strengthScore)===s.strengthBucket) similarity+=2;
    if(r.candleConfirmed!=null&&Boolean(r.candleConfirmed)===s.candleConfirmed) similarity+=1;
    return {r,similarity};
  }).filter(x=>x.similarity>=2).sort((a,b)=>b.similarity-a.similarity).slice(0,200);
  const wins=scored.filter(x=>x.r.result==='WIN').length, losses=scored.filter(x=>x.r.result==='LOSS').length, decided=wins+losses;
  return {estimatedPct:decided?+(wins/decided*100).toFixed(1):null,sampleSize:decided,wins,losses,confidence:decided>=100?'HIGH':decided>=30?'MEDIUM':decided>=10?'LOW':'INSUFFICIENT',note:decided<10?'Not enough similar completed paper signals yet':null};
}
module.exports={recordStage,getPerformanceStats:stats,estimateAccuracy};
