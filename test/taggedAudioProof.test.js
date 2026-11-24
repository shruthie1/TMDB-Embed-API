'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const tagged=require('../lib/media/taggedHlsRow');
const {normaliseStream}=require('../utils/streamSchema');
const lkg=require('../lib/mmhub/lastKnownGood');
test('tag-only audio retains labels without inventing known languages or a canary baseline',()=>{
 for(const tag of ['', 'und','mul','zxx']) {
  const text='#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Telugu",'+(tag?`LANGUAGE="${tag}",`:'')+'URI="a.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,AUDIO="a"\nv.m3u8\n';
  const row=normaliseStream({...tagged.rowFromMaster(text,'https://fixture.test/m.m3u8',{provider:'insertunit',display:'Insertunit',headers:{}}),languages:['Telugu']});
  assert.deepEqual(row.languages,[]);
  assert.equal(row.audio[0].language,null);
  assert.equal(row.audio[0].name,'Telugu');
  assert.equal(row.audio[0].tagged,true);
  assert.equal(row.audioTagsOnly,true);
  assert.equal(lkg.isTelugu(row),false);
 }
});
