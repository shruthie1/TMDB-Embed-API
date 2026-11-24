'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const e=require('../lib/mmhub/embedded');
test('packed data supports base62 and standard trailing arguments without execution',()=>{
 const words=Array(62).fill('');words[61]='master.m3u8';
 const code="eval(function(p,a,c,k,e,d){return p}('https://cdn.example/Z',62,62,'"+words.join('|')+"'.split('|'),0,{}))";
 assert.equal(e.unpack(code),'https://cdn.example/master.m3u8');
 assert.deepEqual(e.mediaLinks(e.unpack(code),'https://page.example'),['https://cdn.example/master.m3u8']);
 const inert="eval(function(p,a,c,k,e,d){return p}('globalThis.compromised=true',10,0,''.split('|'),0,{}))";
 assert.match(e.unpack(inert),/compromised/);assert.equal(globalThis.compromised,undefined);
});
test('dictionary size/radix and expansion are bounded',()=>{
 assert.throws(()=>e.unpack("}('x',63,1,'x'.split('|'))"),/bounds/);
 assert.throws(()=>e.unpack("}('x',36,5001,'x'.split('|'))"),/bounds/);
 assert.throws(()=>e.unpack("}('"+'0 '.repeat(10000)+"',2,1,'"+'a'.repeat(200)+"'.split('|'))"),/expansion/);
});
test('escaped literal decoding is data only',()=>{assert.equal(e.stringAt("'https:\\/\\/cdn.example\\u0026a'",0).value,'https://cdn.example&a');});
test('modern supplied proxy URLs are retained rather than reconstructed',()=>{
 const rows=e.serverItems('<div class="srv-item" data-platform="Vidrift" data-url="/proxy.php?p=vidrift&amp;c=579974:movie:0:0&amp;custom=1">Vidrift</div>','https://cine.example/embed/movie/579974');
 assert.equal(rows[0].url,'https://cine.example/proxy.php?p=vidrift&c=579974:movie:0:0&custom=1');
});
test('every link attribute is considered even if href is only a placeholder',()=>{
 const rows=e.embedLinks('<a href="#" data-link="https://api.insertunit.ws/embed/imdb/tt8178634" data-url="https://vidout.pages.dev/movie/579974">Play</a>','https://gd.example');
 assert.equal(rows.length,2);assert.ok(rows.some(x=>x.url.includes('insertunit')));assert.ok(rows.some(x=>x.url.includes('vidout')));
});
test('all HLS candidates remain available in quality-family preference order',()=>{
 assert.deepEqual(e.mediaLinks('"https://cdn.example/hls2/master.m3u8?a=1&amp;b=2" "https://cdn.example/hls4/master.m3u8"','https://page.example'),['https://cdn.example/hls4/master.m3u8','https://cdn.example/hls2/master.m3u8?a=1&b=2']);
});
