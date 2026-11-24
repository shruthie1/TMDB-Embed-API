'use strict';
const parser=require('./embedded');
const {fetchPublic}=require('./publishedSources');
const {rowFromMaster}=require('../media/taggedHlsRow');
const {remaining}=require('./extractorConfig');
const {knownLanguage}=require('../../utils/streamSchema');
const {quotaError}=require('./upstreamFailure');
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const names={multimovies:'VidBolt',vidrift:'Vidrift',insertunit:'Insertunit',vidout:'VIDOUT'};
function serviceFor(url,platform=''){
 let host;try{host=new URL(url).hostname;}catch{return null;}
 if(['vidbolt.xyz','vidbolt.pro'].includes(host))return 'multimovies';
 if(['embed.vidrift.net','embed.vidrift.in'].includes(host))return 'vidrift';
 if(host==='api.insertunit.ws')return 'insertunit';
 if(host==='vidout.pages.dev')return 'vidout';
 if(/^(?:vidrift|vidbolt|vidout|insertunit)$/i.test(platform))return platform.toLowerCase()==='vidbolt'?'multimovies':platform.toLowerCase();
 return null;
}
function taggedChild(row,provider,label){
 const audio=(row.audio||[]).map(a=>({...a,tagged:true,language:knownLanguage(a.languageCode)}));
 return {...row,provider,serverLabel:label,providerGroup:'MultiMovies',audioTagsOnly:true,audio,languages:[...new Set(audio.map(a=>a.language).filter(Boolean))]};
}
async function resolveLinked(start,ctx,{provider,display,budgetMs=16000,read=fetchPublic,resolveService=require('./resolveContext').resolve,seedText=null,headers={},signal,runtimeMinutes=id=>require('../selfheal/proof').runtimeMinutes(id)}={}){
 const errors=[];
 const deadline=Date.now()+budgetMs,seen=new Set(),services=new Set(),urls=new Set(),out=[];
 const requestHeaders={'User-Agent':UA,Referer:new URL(start).origin+'/',...headers};
 async function bounded(promise) {
  const left=remaining(deadline,budgetMs);let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Linked source budget spent')),left);})]);}finally{clearTimeout(timer);}
 }
 async function visit(url,depth,text=null){
  if(signal?.aborted)throw signal.reason;
  try{const normalized=new URL(url);normalized.hash='';url=normalized.href;}catch{return;}
  if(depth>4||seen.size>=8||seen.has(url))return;
  seen.add(url);remaining(deadline,8000);
  let body=text;
  if(body==null){const response=await read(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(remaining(deadline,8000))]):AbortSignal.timeout(remaining(deadline,8000)),headers:requestHeaders});
   if(signal?.aborted)throw signal.reason;
   const limited=quotaError(response);if(limited)throw limited;
   if(response.status>=300&&response.status<400&&response.location){await visit(new URL(response.location,url).href,depth+1);return;}
   if(response.status!==200){errors.push(`linked-http-${response.status}`);return;}body=response.text;
  }
  if(String(body).trimStart().startsWith('#EXTM3U')){
   const row=rowFromMaster(body,url,{provider,display,headers:requestHeaders});
   if(row&&ctx.type==='movie') {
    const minutes=await bounded(runtimeMinutes(ctx.tmdbId));
    if(minutes>0){const result=await require('../media/taggedHlsRow').runtimeCheck(body,url,minutes,u=>read(u,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(remaining(deadline,8000))]):AbortSignal.timeout(remaining(deadline,8000)),headers:requestHeaders}));
     if(result.verdict==='mismatch'){errors.push('runtime-mismatch');return;}}
   }
   if(signal?.aborted)throw signal.reason;
   if(row&&!urls.has(url)){urls.add(url);out.push({...row,serverLabel:display,providerGroup:'MultiMovies'});}return;
  }
  const decoded=parser.unpack(body),content=body+'\n'+decoded;
  for(const link of parser.mediaLinks(content,url)){
   if(urls.has(link))continue;await visit(link,depth+1);
  }
  const directory = /(?:^|\.)iqsmartgames\.com$/.test(new URL(url).hostname) && /\bFinalID\s*=/.test(content)
    ? await require('./gdDirectory').links(content,url,ctx,{signal,read:async(u,opts)=>read(u,{...opts,headers:{...requestHeaders,...opts.headers},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(remaining(deadline,8000))]):AbortSignal.timeout(remaining(deadline,8000))})}) : [];
  if(directory.upstreamError)errors.push('directory-partial');
  const candidates=[...directory,...parser.serverItems(content,url),...parser.embedLinks(content,url)];
  for(const link of candidates.slice(0,16)){
   if(signal?.aborted)throw signal.reason;
   const sameProxy=new URL(link.url).origin===new URL(url).origin && /proxy|embed|player|stream/i.test(new URL(link.url).pathname);
   const service=serviceFor(link.url,link.platform);
   if(sameProxy&&link.url!==url){await visit(link.url,depth+1);continue;}
   if(service){
    if(services.has(service))continue;services.add(service);
    let rows;try{rows=await bounded(resolveService(service,ctx));}catch(error){if(signal?.aborted)throw signal.reason;errors.push(service);continue;}
    if(signal?.aborted)throw signal.reason;
    if(rows?.upstreamError||rows?.timedOut)errors.push(`${service}-partial`);
    for(const row of rows||[])if(row.url&&!urls.has(row.url)){urls.add(row.url);out.push(taggedChild(row,provider,`${display} / ${names[service]}`));}
   }else if((link.kind==='embed'||new URL(link.url).origin===new URL(url).origin && /proxy|embed|player|stream/i.test(new URL(link.url).pathname)) && !/\.(?:js|css|png|jpe?g|gif|svg|webp|ico|woff2?)$/i.test(new URL(link.url).pathname)){
    try{await visit(link.url,depth+1);}catch(error){if(signal?.aborted||error.status===429)throw error;errors.push('linked-page');}
   }
  }
 }
 try { await visit(start,0,seedText); }
 catch(error) {
  // A deadline ends discovery, not the validity of rows already resolved.
  // Viewer cancellation must still propagate, even after a row was found.
  const cancelled=signal?.aborted&&signal.reason?.name!=='TimeoutError';
  if(!out.length||cancelled)throw error;
  errors.push('discovery-incomplete');
 }
 if(!out.length)throw new Error(`${display}: no supported playable sources in published embed`);
 if(errors.length)out.upstreamError='Some linked services failed';
 return out;
}
module.exports={resolveLinked,serviceFor,taggedChild,UA};
