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
