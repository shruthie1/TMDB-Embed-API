'use strict';
const {stringAt}=require('./embedded');
function variables(html){
 const result={};
 for(const name of ['FinalID','idType','myKey','player_base','api_url','season','episode']){
  const re=new RegExp('\\b(?:let|var|const)\\s+'+name+'\\s*=\\s*','g');const m=re.exec(html);if(!m)continue;
  const str=stringAt(html,m.index+m[0].length);
  if(str)result[name]=str.value;else {const number=/^\d+/.exec(html.slice(m.index+m[0].length));if(number)result[name]=number[0];}
 }
 return result;
}
function templates(html,vars){
 const out=[];
 for(const match of html.matchAll(/\blink\s*:\s*`([^`]+)`/g)){
  const url=match[1].replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(_m,key)=>vars[key]??'${'+key+'}');
  if(!url.includes('${')&&/^https?:\/\//.test(url))out.push({url,label:'Published fallback',kind:'embed'});
 }
 return out;
}
function fileList(value){
 if(Array.isArray(value))return value;
 if(!value||typeof value!=='object')return [];
 for(const key of ['data','files','results','sources'])if(Array.isArray(value[key]))return value[key];
 return [];
}
function decodeCodes(value){
 if(value&&typeof value==='object')return value;
 if(typeof value!=='string'||value.length>512000)return {};
 for(const s of [value,Buffer.from(value,'base64').toString('utf8')]){try{const p=JSON.parse(s);if(p&&typeof p==='object')return p;}catch{}}
 return {};
}
function mirrors(reply){
 const sources=reply?.sources||{},codes=decodeCodes(reply?.mresult),out=[];
 for(const [key,raw]of Object.entries(sources)){
  const site=typeof raw==='string'?raw:raw?.siteUrl||raw?.site_url||raw?.url;
  const code=codes[key];if(!site||typeof site!=='string')continue;
  let url=site;
  if(typeof code==='string'&&/^https?:\/\//.test(code))url=code;
  else if(typeof code==='string'){url=site.includes('{id}')?site.replace('{id}',encodeURIComponent(code)):site+code;}
  else if(code&&typeof code==='object'&&typeof code.url==='string')url=code.url;
  if(/^https?:\/\//.test(url))out.push({url,label:key,kind:'embed'});
 }
 return out;
}
async function links(html,page,ctx,{read,signal}){
 const vars=variables(html),fallbacks=templates(html,vars);
 if(!vars.FinalID||!['imdbid','tmdbid'].includes(vars.idType))return fallbacks;
 if(vars.idType==='tmdbid'&&String(ctx.tmdbId)!==vars.FinalID)throw new Error('GD mirror title identity mismatch');
 if(vars.idType==='imdbid'&&(!ctx.imdbId||ctx.imdbId!==vars.FinalID))throw new Error('GD mirror IMDb identity not verified');
 const base=new URL(vars.api_url||page).origin;
 const endpoint=new URL(ctx.type==='movie'?'/mymovieapi':'/myseriesapi',base);
 endpoint.searchParams.set(vars.idType,vars.FinalID);endpoint.searchParams.set('key',vars.myKey||'');
 if(ctx.type!=='movie'){endpoint.searchParams.set('season',String(ctx.season));endpoint.searchParams.set('epname',String(ctx.episode));}
 let response;
 try{response=await read(endpoint.href,{signal});}catch(e){if(signal?.aborted)throw e;return fallbacks;}
 if(response.status===429)throw Object.assign(new Error('GD mirror quota reached'),{status:429});
 if(response.status!==200)return fallbacks;
 let data;try{data=JSON.parse(response.text);}catch{return fallbacks;}
 const out=[...fallbacks];
 for(const item of fileList(data).slice(0,3)){
  const slug=item?.fileslug||item?.slug||item?.file_slug||item?.id;if(!slug)continue;
  const player=new URL(vars.player_base||'https://pro.iqsmartgames.com').origin;
  const body=new URLSearchParams({sid:String(slug),UserFavSite:'',currentDomain:JSON.stringify([new URL(base).hostname,new URL(player).hostname])});
  const r=await read(`${player}/embedhelper2.php`,{signal,method:'POST',body:body.toString(),headers:{'Content-Type':'application/x-www-form-urlencoded',Referer:page}});
  if(r.status===429)throw Object.assign(new Error('GD mirror helper quota reached'),{status:429});
  if(r.status!==200)continue;
  try{out.push(...mirrors(JSON.parse(r.text)));}catch{}
 }
 return [...new Map(out.map(x=>[x.url,x])).values()].slice(0,16);
}
module.exports={variables,templates,fileList,mirrors,links};
