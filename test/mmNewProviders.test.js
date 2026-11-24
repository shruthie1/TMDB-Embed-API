'use strict';
const {test,afterEach}=require('node:test'),assert=require('node:assert/strict');
const nexus=require('../providers/nexus');
const original={...nexus._deps};
afterEach(()=>{Object.assign(nexus._deps,original);nexus._reset();});
const master='#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="te",NAME="Original",URI="te.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,AUDIO="a"\nv.m3u8\n';
test('Nexus resolves exact episode, preserves media headers and reads actual tags rather than labels',async()=>{
 const calls=[];nexus._deps.catalog=async()=>({servers:[{name:'Nexus',url:'https://nexus.example/tv/200946/2/3'}]});
 nexus._deps.read=async(url,options)=>{calls.push({url,options});
  if(options.method==='POST')return {status:200,text:'1:{"token":"public-token","nonce":"n","timestamp":1}'};
  if(url.includes('/api/extract?'))return {status:200,text:JSON.stringify({servers:[{type:'m3u8',headers:{Referer:'https://nexus.example/'},audioTracks:[{url:'https://cdn.example/master.m3u8',label:'Hindi'}]}]})};
  return {status:200,text:master};};
 const rows=await nexus.getNexusStreams('200946','tv',2,3);
 assert.equal(rows.length,1);assert.deepEqual(rows[0].languages,['Telugu']);
 assert.equal(calls[0].url,'https://nexus.example/tv/200946/2/3');
 assert.deepEqual(JSON.parse(calls[0].options.body),['200946-s2e3','tv']);
 assert.ok(calls[1].url.includes('season=2')&&calls[1].url.includes('episode=3'));
 assert.equal(rows[0].headers.Referer,'https://nexus.example/');
});
test('Nexus quota response stops requests and subsequent calls respect cooldown',async()=>{
 let calls=0;nexus._deps.catalog=async()=>({servers:[{name:'Nexus',url:'https://nexus.example/movie/579974'}]});
 nexus._deps.read=async()=>{calls++;return {status:429,text:'quota',retryAfter:'600'};};
 await assert.rejects(()=>nexus.getNexusStreams('579974'),/quota/);
 await assert.rejects(()=>nexus.getNexusStreams('579974'),/cooldown/);assert.equal(calls,1);
});
test('public challenge solver is bounded, abortable and never sends an unproven answer',async()=>{
 assert.equal(await nexus.solve('seed','ffffff',{maxIterations:0}),null);
 const controller=new AbortController();controller.abort(new Error('cancelled'));
 await assert.rejects(()=>nexus.solve('seed','000',{signal:controller.signal}),/cancelled/);
 const answer=await nexus.solve('seed','0',{maxIterations:1000});assert.notEqual(answer,null);
 const crypto=require('node:crypto');assert.ok(crypto.createHash('sha256').update(`seed:${answer}`).digest('hex').startsWith('0'));
});
test('Nexus decoder accepts plain/hex data but no executable or private URL expressions',()=>{
 const raw='https://cdn.example/master.m3u8',key='fixture';
 const hex=Buffer.from(raw).map((b,i)=>b^key.charCodeAt(i%key.length)).toString('hex');
 assert.equal(nexus.decodeUrl(hex,key),raw);assert.equal(nexus.decodeUrl('javascript:fetch("x")'),null);
});
test('Cineverse follows the supplied proxy unchanged and reuses a supported child service',async()=>{
 const {resolveLinked}=require('../lib/mmhub/linkedResolver');const calls=[];
 const row={url:'https://cdn.example/master.m3u8',audio:[{languageCode:'te',language:'Telugu',name:'Original'}],headers:{'User-Agent':'signing-UA'}};
 const result=await resolveLinked('https://cine.example/embed/movie/579974',{tmdbId:'579974',type:'movie'},
  {provider:'cineverse',display:'Cineverse',seedText:'<div class="srv-item" data-platform="vidrift" data-url="/proxy.php?p=vidrift&custom=1">Vidrift</div>',
   read:async url=>{calls.push(url);return {status:200,text:'<iframe src="https://embed.vidrift.net/embed/movie/579974"></iframe>'};},
   resolveService:async(name,ctx)=>{assert.equal(name,'vidrift');assert.equal(ctx.tmdbId,'579974');return [row];}});
 assert.deepEqual(calls,['https://cine.example/proxy.php?p=vidrift&custom=1']);
 assert.equal(result[0].provider,'cineverse');assert.deepEqual(result[0].languages,['Telugu']);
 assert.equal(result[0].headers['User-Agent'],'signing-UA');
});
test('shared mirror resolver detects cycles and keeps request-level reuse intact',async()=>{
 const c=require('../lib/mmhub/resolveContext');let n=0;
 const cache=new Map();const ctx={tmdbId:'579974',resolveService:name=>{if(!cache.has(name))cache.set(name,Promise.resolve().then(()=>{n++;return [{url:'https://cdn.example/m.m3u8'}];}));return cache.get(name);}};
 await c.run('cineverse',ctx,async()=>{await c.resolve('vidrift',ctx);await c.resolve('vidrift',ctx);await assert.rejects(()=>c.resolve('cineverse',ctx),/cycle/);});assert.equal(n,1);
});

test('mirror deadline preserves resolved tagged rows and the next lookup starts fresh',async()=>{
 const {resolveLinked}=require('../lib/mmhub/linkedResolver');
 const controller=new AbortController();const calls=[];
 const options={provider:'gdmirror',display:'GD mirror',signal:controller.signal,
  seedText:'<iframe src="https://api.insertunit.ws/embed/579974"></iframe><iframe src="https://slow.example/embed"></iframe>',
  resolveService:async()=>[{url:'https://cdn.example/master.m3u8',audio:[{languageCode:'te'}]}],
  read:async url=>{calls.push(url);controller.abort(new DOMException('budget spent','TimeoutError'));throw controller.signal.reason;}};
 const rows=await resolveLinked('https://gd.example/embed',{tmdbId:'579974',type:'movie'},options);
 assert.deepEqual(rows[0].languages,['Telugu']);assert.ok(rows.upstreamError);
 assert.deepEqual(calls,['https://slow.example/embed']);
 await assert.rejects(()=>resolveLinked('https://gd.example/embed',{tmdbId:'27205',type:'movie'},
  {...options,signal:undefined,seedText:'<p>No sources</p>'}),/no supported playable sources/);
});
test('viewer cancellation after a mirror result propagates and starts no following request',async()=>{
 const {resolveLinked}=require('../lib/mmhub/linkedResolver');const controller=new AbortController();let reads=0;
 await assert.rejects(()=>resolveLinked('https://gd.example/embed',{tmdbId:'579974',type:'movie'},
  {provider:'gdmirror',display:'GD mirror',signal:controller.signal,
   seedText:'<iframe src="https://api.insertunit.ws/embed/579974"></iframe><iframe src="https://slow.example/embed"></iframe>',
   resolveService:async()=>{controller.abort(new Error('viewer left'));return [{url:'https://cdn.example/master.m3u8',audio:[{languageCode:'te'}]}];},
   read:async()=>{reads++;return {status:200,text:''};}}),/viewer left/);
 assert.equal(reads,0);
});
test('catalog says title not listed -> GD mirror, Cineverse and Nexus answer notListed, never an error; unknown catalog stays an error',async()=>{
 const gd=require('../providers/gdmirror'),cv=require('../providers/cineverse');
 const keep=[{...gd._deps},{...cv._deps}];
 const notListed={site:'https://mm.example',path:null,pattern:null,servers:[],notListed:true};
 try{
  gd._deps.read=async()=>notListed;cv._deps.read=async()=>notListed;nexus._deps.catalog=async()=>notListed;
  let fetched=0;nexus._deps.read=async()=>{fetched++;return {status:500,text:''};};
  for(const r of [await gd.getGdMirrorStreams('857598'),await cv.getCineverseStreams('857598'),await nexus.getNexusStreams('857598')]){
   assert.equal(r.notListed,true);assert.equal(r.length,0);
  }
  assert.equal(fetched,0);
  gd._deps.read=async()=>null;cv._deps.read=async()=>null;nexus._deps.catalog=async()=>null;
  await assert.rejects(()=>gd.getGdMirrorStreams('857598'),/catalog lookup unavailable/);
  await assert.rejects(()=>cv.getCineverseStreams('857598'),/catalog lookup unavailable/);
  await assert.rejects(()=>nexus.getNexusStreams('857598'),/catalog unavailable/);
 }finally{Object.assign(gd._deps,keep[0]);Object.assign(cv._deps,keep[1]);}
});
