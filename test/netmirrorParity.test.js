'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
process.env.NETMIRROR_PLATFORM_GAP_MS = '1';
process.env.NETMIRROR_BUDGET_CALLS = '1000';
process.env.NETMIRROR_OTP = '';
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('utils/tmdb.js', { getDetails: async () => ({ title: 'Parity Movie', release_date: '2024-01-01', first_air_date: '2024-01-01' }) });
stub('lib/media/mp4AudioProbe.js', { probeAudioTracks: async () => [] });
const { guard } = require('../utils/netmirrorGuard');
const { normaliseStream } = require('../utils/streamSchema');
const moduleId = require.resolve('../providers/netmirror');
let provider;
let now = 2_000_000_000_000;
guard._setNow(() => now);
beforeEach(() => { now += 24 * 60 * 60 * 1000; guard.reset(); delete require.cache[moduleId]; provider = require(moduleId); });
const json = (v) => new Response(JSON.stringify(v), { status: 200 });
function install({ dubs = 1, series = false, post = {}, pages = {}, audio = ['Telugu', 'Hindi'], playerFail = null, embed = [], catalogs = ['nf', 'pv', 'hs'], matchOtt = 'nf', registryFail = false } = {}) {
    const calls = [];
    global.fetch = async (url, init = {}) => {
        const u = new URL(url); const ott = init.headers?.Ott;
        calls.push({ path: u.pathname, query: u.search, ott, headers: init.headers || {} });
        if (init.headers?.Range) return new Response('', { status: 206 });
        if (u.pathname.includes('/api/embed-tmdb/')) return json({ ok: true, streams: embed });
        if (u.pathname === '/checknewtv.php') return json({ token_hash: Buffer.from('https://newtv.example').toString('base64') });
        if (u.pathname === '/newtv/ott.php') {
            if (registryFail) throw Error('registry unavailable');
            return json({ ott: catalogs.map(value => typeof value === 'string' ? ({ value }) : value) });
        }
        if (u.pathname === '/newtv/search.php') return json({ searchResult: ott === matchOtt ? Array.from({ length: dubs }, (_, i) => ({ id: String(100 + i), t: 'Parity Movie' })) : [] });
        if (u.pathname === '/newtv/post.php') return json({ type: series ? 't' : 'm', main_id: u.searchParams.get('id'), year: '2024', lang: ['Telugu', 'Hindi', 'Tamil'].map(l => ({ l })), ...post });
        if (u.pathname === '/newtv/episodes.php') {
            const key = `${u.searchParams.get('id')}|${u.searchParams.get('page') || ''}`;
            if (!(key in pages)) throw Error(`unexpected episodes cursor ${key}`);
            const p = pages[key];
            if (p instanceof Error) throw p;
            return json(p);
        }
        if (u.pathname === '/newtv/player.php') {
            if (playerFail && u.searchParams.get('id') === playerFail) throw Error('temporary player failure');
            return json({ status: 'ok', video_link: `https://cdn.example/${u.searchParams.get('id')}.m3u8`, referer: 'https://newtv.example/' });
        }
        if (u.hostname === 'cdn.example') {
            const id = u.pathname.match(/\/(\d+)\.m3u8$/)?.[1];
            return new Response(['#EXTM3U', ...audio.map(l=>`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="${l === 'Telugu' ? 'tel' : 'hin'}",NAME="${l}",URI="${l}.m3u8"`),
                '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"', `https://cdn.example/files/${id}/1080.m3u8`,
                '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"', `https://cdn.example/files/${id}/720.m3u8`, ''].join('\n'));
        }
        throw Error(`unexpected ${url}`);
    };
    return calls;
}

test('keeps every matching dub beyond the old four-row truncation, with measured qualities/codecs', async () => {
    const calls = install({ dubs: 5 });
    const rows = await provider.getNetmirrorStreams(1, 'movie');
    assert.equal(rows.length, 5);
    assert.deepEqual(rows[0].levels.map(l=>l.height), [1080, 720]);
    assert.equal(rows[0].codecs, 'avc1.640028,mp4a.40.2');
    assert.equal(rows[0].headers['X-Requested-With'], 'NetmirrorNewTV v1.0');
    assert.match(rows[0].headers['User-Agent'], /OS\.GatuNewTV v1\.0$/);
    assert.equal(calls.filter(c=>c.path.endsWith('/player.php')).length, 5);
});

test('catalog languages do not invent playable audio tracks, and metadata survives normalization', async () => {
    install({ audio: ['Hindi'] });
    const [raw] = await provider.getNetmirrorStreams(2, 'movie');
    const row = normaliseStream(raw);
    assert.deepEqual(row.languages, ['Hindi']);
    assert.deepEqual(row.catalogLanguages, ['Telugu', 'Hindi', 'Tamil']);
    assert.deepEqual(row.audio.map(a=>a.language), ['Hindi']);
});

test('movie year mismatch is rejected before player lookup, later matching dubs remain eligible', async () => {
    const calls = install({ post: { year: '1990' } });
    const rows = await provider.getNetmirrorStreams(3, 'movie');
    assert.equal(rows.length, 0);
    assert.equal(calls.filter(c=>c.path.endsWith('/player.php')).length, 0);
});

test('requested season uses its s field and id, then follows response cursor beyond page two', async () => {
    const calls = install({ series: true,
        post: { season: [{ id:'s3', s:'Season 3', selected:true }, { id:'s7', s:'Season 7' }], episodes:[{ id:'301', sNum:'3', ep:'1' }], nextPageShow:1, nextPage:2, nextPageSeason:'s3' },
        pages: { 's7|':{ episodes:[{id:'701',ep:'1'}], nextPageShow:1,nextPage:2,nextPageSeason:'s7' },
            's7|2':{ episodes:[{id:'702',ep:'2'}], nextPageShow:1,nextPage:3,nextPageSeason:'s7-page3' },
            's7-page3|3':{ episodes:[{id:'703',ep:'3'}],nextPageShow:0 } } });
    const rows = await provider.getNetmirrorStreams(4, 'tv', 7, 3);
    assert.equal(rows.length, 1);
    assert.match(rows[0].url, /703\.m3u8$/);
    assert.deepEqual(calls.filter(c=>c.path.endsWith('/episodes.php')).map(c=>c.query), ['?id=s7','?id=s7&page=2','?id=s7-page3&page=3']);
    assert.equal(calls.filter(c=>c.path.endsWith('/player.php')).length, 1);
});

test('episode on the initial selected-season page stops paging, without fetching a sibling season', async () => {
    const calls = install({ series:true,post:{season:[{id:'s3',s:'3',selected:true}],episodes:[{id:'303',ep:'3'}],nextPageShow:1,nextPage:2,nextPageSeason:'s3'} });
    const rows = await provider.getNetmirrorStreams(5, 'tv', 3, 3);
    assert.equal(rows.length, 1);
    assert.equal(calls.filter(c=>c.path.endsWith('/episodes.php')).length, 0);
});

test('a later page failure is unknown, not an empty cached title; next lookup continues from cached earlier pages', async () => {
    let calls = install({series:true,post:{season:[{id:'s1',s:'1',selected:true}],episodes:[],nextPageShow:1,nextPage:2,nextPageSeason:'s1'},pages:{'s1|2':Error('offline')} });
    await assert.rejects(provider.getNetmirrorStreams(6,'tv',1,3), /offline/);
    assert.equal(calls.filter(c=>c.path.endsWith('/player.php')).length,0);
    now += 91_000;
    calls = install({series:true,post:{season:[{id:'s1',s:'1',selected:true}],episodes:[],nextPageShow:1,nextPage:2,nextPageSeason:'s1'},pages:{'s1|2':{episodes:[{id:'103',ep:'3'}],nextPageShow:0}} });
    const rows=await provider.getNetmirrorStreams(6,'tv',1,3);
    assert.equal(rows.length,1);
    assert.equal(calls.filter(c=>c.path.endsWith('/post.php')).length,0);
    assert.equal(calls.filter(c=>c.path.endsWith('/player.php')).length,1);
});

test('a repeated pagination cursor fails explicitly instead of looping or marking the episode absent', async () => {
    const calls=install({series:true,post:{season:[{id:'s1',s:'1',selected:true}],episodes:[],nextPageShow:1,nextPage:2,nextPageSeason:'s1'},pages:{'s1|2':{episodes:[],nextPageShow:1,nextPage:2,nextPageSeason:'s1'}} });
    await assert.rejects(provider.getNetmirrorStreams(7,'tv',1,3), /pagination cursor/);
    assert.equal(calls.filter(c=>c.path.endsWith('/episodes.php')).length,1);
});

test('budget interruption keeps partial rows; a later lookup resumes beyond cached dubs without replaying their player requests', async () => {
    let calls = install({ dubs: 5 });
    while (guard.tokens() > 5) guard.take();
    const partial = await provider.getNetmirrorStreams(8, 'movie');
    assert.equal(partial.length, 1);
    assert.equal(partial.upstreamError, 'netmirror-budget');
    assert.equal(calls.filter(c=>c.path.startsWith('/newtv/') || c.path === '/checknewtv.php').length, 5);
    now += 5 * 60 * 1000;
    calls = install({ dubs: 5 });
    const completed = await provider.getNetmirrorStreams(8, 'movie');
    assert.equal(completed.length, 5);
    assert.equal(completed.upstreamError, undefined);
    assert.equal(calls.filter(c=>c.path.endsWith('/search.php') && c.ott === 'nf').length, 0, 'cached title search reused');
    assert.ok(!calls.some(c=>c.path.endsWith('/player.php') && c.query === '?id=100'), 'completed first dub not fetched twice');
});

test('pre-parity persisted metadata is not reused after pagination/catalog schema changes', async () => {
    guard.cacheSet('nt|nf|/newtv/search.php?s=Parity%20Movie', {searchResult:[]}, 86400_000);
    const calls = install();
    const rows = await provider.getNetmirrorStreams(9,'movie');
    assert.equal(rows.length,1);
    assert.ok(calls.some(c=>c.path.endsWith('/search.php') && c.ott === 'nf'));
});


test('SD and HD MP4 choices survive beside the HLS master on fresh and cached lookups', async () => {
    install({embed:[{url:'https://cdn.example/low.mp4',resolution:480,size:1},{url:'https://cdn.example/high.mp4',resolution:1080,size:2}]});
    const first = await provider.getNetmirrorStreams(10,'movie');
    assert.ok(first.some(s=>s.url.endsWith('/low.mp4')));
    assert.ok(first.some(s=>s.url.endsWith('/high.mp4')));
    const cached = await provider.getNetmirrorStreams(10,'movie');
    assert.ok(cached.some(s=>s.url.endsWith('/low.mp4')));
    assert.ok(cached.some(s=>s.url.endsWith('/high.mp4')));
});

test('partial recovery merges last-good and newly found distinct sources instead of discarding either set', async () => {
    const old = [1,2,3].map(i=>({provider:'NetMirror',name:'NetMirror | Netflix',url:`https://cdn.example/old-${i}.m3u8`,quality:'Auto',languages:['Hindi']}));
    guard.cacheSet('good3|11:movie:0:0', old, 60*60*1000);
    while (guard.take()) { /* provider's real bucket is empty */ }
    install({embed:[{url:'https://cdn.example/new.mp4',resolution:720,size:1}]});
    const rows=await provider.getNetmirrorStreams(11,'movie');
    assert.equal(rows.upstreamError,'netmirror-budget');
    assert.equal(rows.length,4);
    assert.ok(rows.some(r=>r.url.endsWith('/new.mp4')));
    assert.ok(old.every(o=>rows.some(r=>r.url===o.url)));
});


test('discovers a fourth catalog, validates header codes and preserves its label', async () => {
    const calls = install({ catalogs: ['nf', 'pv', 'hs', {value:'new',name:'Fourth Catalog'}, 'new', 'bad\r\nheader'], matchOtt:'new' });
    const rows = await provider.getNetmirrorStreams(12,'movie');
    assert.equal(rows.length,1);
    assert.match(rows[0].name, /Fourth Catalog/);
    assert.deepEqual(calls.filter(c=>c.path.endsWith('/search.php')).map(c=>c.ott), ['nf','pv','hs','new']);
    assert.equal(rows.upstreamError,undefined);
});

test('unavailable registry falls back to known catalogs with an explicit incomplete result', async () => {
    const calls = install({ registryFail:true });
    const rows = await provider.getNetmirrorStreams(13,'movie');
    assert.equal(rows.length,1);
    assert.equal(rows.upstreamError,'netmirror-catalogs-incomplete');
    assert.deepEqual(calls.filter(c=>c.path.endsWith('/search.php')).map(c=>c.ott), ['nf','pv','hs']);
});

test('registry is cached for ten minutes and refreshed without replaying completed title work', async () => {
    let calls = install();
    await provider.getNetmirrorStreams(14,'movie');
    assert.equal(calls.filter(c=>c.path.endsWith('/ott.php')).length,1);
    calls = install();
    await provider.getNetmirrorStreams(15,'movie');
    assert.equal(calls.filter(c=>c.path.endsWith('/ott.php')).length,0);
    now += 10 * 60 * 1000 + 1;
    calls = install();
    await provider.getNetmirrorStreams(16,'movie');
    assert.equal(calls.filter(c=>c.path.endsWith('/ott.php')).length,1);
    assert.equal(calls.filter(c=>c.path.endsWith('/player.php')).length,0);
});


test('partial fallback never resurrects a last-good source rejected by its CDN probe', async () => {
    guard.cacheSet('good3|17:movie:0:0', [{provider:'NetMirror',name:'NetMirror',url:'https://cdn.example/gone.m3u8',quality:'Auto'}], 60*60*1000);
    while (guard.take()) { /* budget interruption */ }
    install();
    const baseFetch = global.fetch;
    global.fetch = async (url, init) => String(url).includes('/gone.m3u8') ? new Response('',{status:403}) : baseFetch(url,init);
    await assert.rejects(provider.getNetmirrorStreams(17,'movie'), /netmirror-budget/);
});


test('a malformed registry returns known catalogs as explicitly incomplete rather than a clean empty', async () => {
    install({catalogs:['bad\r\nheader', '']});
    const rows = await provider.getNetmirrorStreams(18,'movie');
    assert.equal(rows.length,1);
    assert.equal(rows.upstreamError,'netmirror-catalogs-incomplete');
});


test('real decorated season labels use the first number rather than concatenating episode counts', async () => {
    guard.cacheSet('rows2|19:series:2:1',{streams:[],error:null},86400_000);
    const calls=install({series:true,post:{season:[{id:'80117715',s:'Season 2 (9 EP)'},{id:'s5',s:'Season 5 (8 EP)',selected:true}],episodes:[{id:'501',ep:'E1 (2026)'}]},
        pages:{'80117715|':{episodes:[{id:'80117716',sNum:'Season 2 (9 EP)',ep:'E1 (2026)'}],nextPageShow:0}}});
    const rows=await provider.getNetmirrorStreams(19,'tv',2,1);
    assert.equal(rows.length,1);assert.match(rows[0].url,/80117716/);
    assert.deepEqual(calls.filter(c=>c.path.endsWith('/episodes.php')).map(c=>c.query),['?id=80117715']);
});
