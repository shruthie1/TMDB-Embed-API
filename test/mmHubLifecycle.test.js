'use strict';
const {test,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const page=require('../lib/mmhub/page');
const state=require('../lib/mmhub/state');
const TITLE={tmdbId:'579974',type:'movie'};
const SITE='https://catalog.example';
const html=(name='Vidbolt',host='vidbolt.xyz')=>'const watchConfig = '+JSON.stringify({initialServers:[{name,url:`https://${host}/movie/579974`}]})+';';
function fixture(extra={}) {
 const calls=[];
 return {calls,deps:{site:SITE,details:async()=>({title:'R.R.R'}),fetch:async url=>{
  calls.push(url);
  if(url.includes('/api/search'))return {status:200,text:async()=>JSON.stringify({results:[{type:'movie',title:'RRR',url:'/movie/rrr-10105'}]})};
  return {status:200,text:async()=>html()};
 },...extra}};
}
beforeEach(()=>{page._reset();state._reset();});
test('uses published JSON search, normalized punctuation, and one shared lookup',async()=>{
 const f=fixture();
 const [a,b]=await Promise.all([page.read(TITLE,f.deps),page.read(TITLE,f.deps)]);
 assert.deepEqual(a,b);assert.equal(f.calls.length,2);
 assert.ok(f.calls[0].includes('/api/search?q=RRR&limit=20'));
 assert.equal(state.snapshot().hostState,'ok');
 await page.read(TITLE,f.deps);assert.equal(f.calls.length,2);
});
test('cancelling one subscriber preserves the other and its subsequent cache hit',async()=>{
 let release,started;
 const entered=new Promise(resolve=>started=resolve);
 const gate=new Promise(resolve=>release=resolve);
 const f=fixture({details:async()=>{started();await gate;return {title:'RRR'};}});
 const controller=new AbortController();
 const a=page.read(TITLE,{...f.deps,signal:controller.signal});
 const b=page.read(TITLE,f.deps);
 await entered;controller.abort();
 await assert.rejects(a,{name:'AbortError'});release();
 assert.equal((await b).servers.length,1);
 await page.read(TITLE,f.deps);assert.equal(f.calls.length,2);
});
test('all subscribers cancelling prevents next requests and does not cache a miss',async()=>{
 let release,started;
 const entered=new Promise(resolve=>started=resolve);
 const gate=new Promise(resolve=>release=resolve);
 const f=fixture({details:async()=>{started();await gate;return {title:'RRR'};}});
 const controller=new AbortController();
 const a=page.read(TITLE,{...f.deps,signal:controller.signal});
 await entered;controller.abort();await assert.rejects(a,{name:'AbortError'});release();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.calls.length,0);
 const retry=fixture();assert.equal((await page.read(TITLE,retry.deps)).servers.length,1);
 assert.equal(retry.calls.length,2);
});
test('host and parser configuration changes cannot reuse the old catalog cache',async()=>{
 const a=fixture();await page.read(TITLE,a.deps);
 const b=fixture({site:'https://new-catalog.example'});await page.read(TITLE,b.deps);
 assert.equal(b.calls.length,2);assert.ok(b.calls.every(u=>u.startsWith('https://new-catalog.example/')));
 const c=fixture({cfg:{...page.DEFAULTS,serverListPaths:['servers']},fetch:async()=>({status:200,text:async()=>'{"results":[]}'})});
 assert.equal(await page.read(TITLE,c.deps),null);
});
test('unknown hosts stay visible even if their display name resembles a known service',()=>{
 const s=page.classifyServer({name:'Vidbolt',url:'https://new-host.example/movie/579974'});
 assert.equal(s.known,false);assert.equal(s.extractor,'multimovies');
});
