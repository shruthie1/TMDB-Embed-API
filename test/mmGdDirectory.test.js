'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const gd=require('../lib/mmhub/gdDirectory');
test('GD static fields and fallback templates are parsed as data',()=>{
 const html='let FinalID="tt8178634";let idType="imdbid";let myKey="public-page-key";link:`https://api.insertunit.ws/embed/imdb/${FinalID}`;';
 const vars=gd.variables(html);assert.equal(vars.FinalID,'tt8178634');
 assert.equal(gd.templates(html,vars)[0].url,'https://api.insertunit.ws/embed/imdb/tt8178634');
});
test('helper mirrors handle plain, JSON and base64 JSON codes without losing entries',()=>{
 for(const mresult of [{a:'one',b:'two'},JSON.stringify({a:'one',b:'two'}),Buffer.from(JSON.stringify({a:'one',b:'two'})).toString('base64')]){
  const out=gd.mirrors({sources:{a:{siteUrl:'https://mirror.example/e/'},b:{siteUrl:'https://other.example/v/'}},mresult});
  assert.equal(out.length,2);assert.equal(out[1].url,'https://other.example/v/two');
 }
});
test('directory lookup proves title identity before issuing any request and respects quota',async()=>{
 let calls=0;const html='let FinalID="tt8178634";let idType="imdbid";let myKey="key";';
 const read=async()=>{calls++;return {status:429,text:'quota'};};
 await assert.rejects(()=>gd.links(html,'https://streams.iqsmartgames.com/embed', {tmdbId:'579974',type:'movie',imdbId:'tt0000000'},{read}),/identity/);assert.equal(calls,0);
 await assert.rejects(()=>gd.links(html,'https://streams.iqsmartgames.com/embed', {tmdbId:'579974',type:'movie',imdbId:'tt8178634'},{read}),/quota/);assert.equal(calls,1);
});
test('directory quota preserves its published fallback and marks it partial',async()=>{
 const html='let FinalID="579974";let idType="tmdbid";link:`https://api.insertunit.ws/embed/${FinalID}`;';let calls=0;
 const out=await gd.links(html,'https://streams.iqsmartgames.com/embed',{tmdbId:'579974',type:'movie'},
  {read:async()=>{calls++;return {status:503,text:'Error 1027: The owner has reached their plan limits.'};}});
 assert.equal(out.length,1);assert.equal(out[0].url,'https://api.insertunit.ws/embed/579974');assert.ok(out.upstreamError);assert.equal(calls,1);
});
test('later GD helper quota retains earlier mirrors and makes no next helper request',async()=>{
 const html='let FinalID="579974";let idType="tmdbid";';let helpers=0;
 const out=await gd.links(html,'https://streams.iqsmartgames.com/embed',{tmdbId:'579974',type:'movie'},
  {read:async(url)=>{
   if(url.includes('/mymovieapi'))return {status:200,text:JSON.stringify([{slug:'one'},{slug:'two'},{slug:'three'}])};
   helpers++;return helpers===1?{status:200,text:JSON.stringify({sources:{a:'https://mirror.example/e/'},mresult:{a:'movie'}})}:{status:429,text:'quota'};
  }});
 assert.equal(out.length,1);assert.equal(out[0].url,'https://mirror.example/e/movie');assert.ok(out.upstreamError);assert.equal(helpers,2);
});
test('GD caller cancellation propagates even with a published fallback',async()=>{
 const controller=new AbortController();let calls=0;
 const html='let FinalID="579974";let idType="tmdbid";link:`https://api.insertunit.ws/embed/${FinalID}`;';
 await assert.rejects(()=>gd.links(html,'https://streams.iqsmartgames.com/embed',{tmdbId:'579974',type:'movie'},
  {signal:controller.signal,read:async()=>{calls++;controller.abort(new Error('viewer left'));throw controller.signal.reason;}}),/viewer left/);
 assert.equal(calls,1);
});
test('GD cancellation before lookup sends no requests; cancellation with a response sends no helper requests',async()=>{
 const html='let FinalID="579974";let idType="tmdbid";link:`https://api.insertunit.ws/embed/${FinalID}`;';
 for(const preaborted of [true,false]){
  const controller=new AbortController();let calls=0;
  if(preaborted)controller.abort(new Error('viewer left'));
  await assert.rejects(()=>gd.links(html,'https://streams.iqsmartgames.com/embed',{tmdbId:'579974',type:'movie'},
   {signal:controller.signal,read:async()=>{calls++;controller.abort(new Error('viewer left'));return {status:200,text:'[{"slug":"must-not-start"}]'};}}),/viewer left/);
  assert.equal(calls,preaborted?0:1);
 }
});
