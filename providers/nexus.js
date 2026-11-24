'use strict';
const crypto=require('node:crypto');
const page=require('../lib/mmhub/page');
const {fetchPublic}=require('../lib/mmhub/publishedSources');
const tagged=require('../lib/media/taggedHlsRow');
const ACTION='6083fa9bf317439b0ab1f882f7ba7ccd49d1369361';
// Public player-format key, not a user's credential. Kept server-side.
const FORMAT_KEY='nexus-super-secret-key-999';
const UA=require('../lib/mmhub/linkedResolver').UA;
const _deps={read:fetchPublic,catalog:page.read,now:Date.now};
let blockedUntil=0;
function tokenData(body){
 for(const line of String(body||'').split(/\r?\n/))if(/^1:/.test(line)){try{return JSON.parse(line.slice(2));}catch{}}
 try{return JSON.parse(body);}catch{return null;}
}
function decodeUrl(value,key=FORMAT_KEY){
 const input=String(value||'');if(input.length>16384)return null;
 let out=input;
 if(/^[a-f0-9]+$/i.test(input)&&input.length%2===0){if(!key)return null;out=Buffer.from(input,'hex').map((b,i)=>b^key.charCodeAt(i%key.length)).toString('utf8');}
 try{const u=new URL(out);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}
}
async function solve(seed,prefix='000',{deadline,signal,now=Date.now,maxIterations=200000}={}){
 if(typeof seed!=='string'||seed.length>512||!/^[a-f0-9]{1,6}$/i.test(prefix))return null;
 for(let n=0;n<Math.min(maxIterations,200000);n++){
  if(n%256===0){if(signal?.aborted)throw signal.reason;if(deadline&&now()>=deadline)return null;await new Promise(resolve=>setImmediate(resolve));}
  if(crypto.createHash('sha256').update(`${seed}:${n}`).digest('hex').startsWith(prefix.toLowerCase()))return String(n);
 }
 return null;
}
function quota(response){
 if(response.status===429||/quota|daily.{0,20}limit|rate.{0,10}limit|limit.{0,10}exceed/i.test(String(response.text||'').slice(0,1500))){
  blockedUntil=_deps.now()+Math.min(3600_000,Math.max(60_000,Number(response.retryAfter)*1000||15*60_000));
  throw Object.assign(new Error('Nexus upstream quota reached'),{status:429,retryAfter:Math.ceil((blockedUntil-_deps.now())/1000)});
 }
}
async function getNexusStreams(tmdbId,mediaType='movie',season=null,episode=null){
 if(blockedUntil>_deps.now())throw Object.assign(new Error('Nexus quota cooldown active'),{status:429});
 const type=mediaType==='movie'?'movie':'tv';if(type==='tv'&&!(season&&episode))return Object.assign([],{notListed:true});
 const deadline=_deps.now()+16000;
 const signal=AbortSignal.timeout(16000);
 const ctx={tmdbId:String(tmdbId),type,season,episode};
 const listed=await _deps.catalog(ctx,{signal});if(!listed)throw new Error('Nexus catalog unavailable');
 const server=listed.servers.find(s=>/^nexus$/i.test(s.name));if(!server)return Object.assign([],{notListed:true});
 const root=new URL(server.url).origin;
 const cfg=require('../lib/selfheal/config');
 const action=cfg.cfg('nexus','nextAction',ACTION),formatKey=cfg.cfg('nexus','formatKey',FORMAT_KEY);
 if(!/^[a-f0-9]{40,64}$/i.test(action))throw new Error('Nexus action configuration invalid');
 const read=async(url,options={})=>{const left=deadline-_deps.now();if(left<=0)throw new Error('Nexus budget spent');const r=await _deps.read(url,{...options,signal:AbortSignal.any([signal,AbortSignal.timeout(Math.min(6000,left))])});quota(r);return r;};
 const url=`${root}/${type}/${tmdbId}`+(type==='tv'?`/${season}/${episode}`:'');
 const headers={'User-Agent':UA,Referer:url};
 const reply=await read(url,{method:'POST',headers:{...headers,'Next-Action':action,Accept:'text/x-component','Content-Type':'text/plain;charset=UTF-8'},body:JSON.stringify([type==='tv'?`${tmdbId}-s${season}e${episode}`:String(tmdbId),type])});
 if(reply.status===404)return Object.assign([],{notListed:true});
 if(reply.status!==200)throw new Error(`Nexus token HTTP ${reply.status}`);
 const token=tokenData(reply.text);
 if(!token?.token||!token.nonce||token.timestamp==null)throw new Error('Nexus token schema changed');
 const query=new URLSearchParams({mediaType:type,tmdbId:String(tmdbId),token:String(token.token),nonce:String(token.nonce),timestamp:String(token.timestamp)});
 if(type==='tv'){query.set('season',String(season));query.set('episode',String(episode));}
 if(token.challengeSeed){
  const answer=await solve(token.challengeSeed,token.difficulty||'000',{deadline,now:_deps.now,signal});
  if(answer==null)throw new Error('Nexus public challenge budget exhausted');
  query.set('challengeSeed',token.challengeSeed);query.set('challengeAnswer',answer);
 }
 const result=await read(`${root}/api/extract?${query}`,{headers});
 if(result.status!==200)throw new Error(`Nexus extract HTTP ${result.status}`);
 let body;try{body=JSON.parse(result.text);}catch{throw new Error('Nexus extraction schema changed');}
 const candidates=[];
 for(const server of (body.servers||[]).slice(0,4))for(const item of server.audioTracks?.length?server.audioTracks:[{url:server.url}]){
  const url=decodeUrl(item.url,formatKey);if(url&&!candidates.some(x=>x.url===url))candidates.push({url,headers:{'User-Agent':UA,...server.headers}});
 }
 const rows=[];
 for(const candidate of candidates.slice(0,6)){
  const master=await read(candidate.url,{headers:candidate.headers});if(master.status!==200)continue;
  const row=tagged.rowFromMaster(master.text,candidate.url,{provider:'nexus',display:'Nexus',headers:candidate.headers});
  if(row)rows.push({...row,providerGroup:'MultiMovies',serverLabel:'Nexus'});
 }
 if(!rows.length)throw new Error('Nexus returned no supported media manifests');
 return rows;
}
module.exports={getNexusStreams,decodeUrl,tokenData,solve,_deps,_reset(){blockedUntil=0;},CANARY_TITLE:{tmdbId:'579974',mediaType:'movie'}};
