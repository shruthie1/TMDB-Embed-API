'use strict';

// MPD -> HLS, text only (P21 dash-direct, 2026-11-22).
//
// MultiMovies' /dash/ sources are sacdn fMP4 folders described by a signed
// index.mpd. The third-party dash-hls-bridge that turned them into HLS is out
// of quota (Cloudflare 1027), so the VM builds the same playlists itself.
// Segment lines stay absolute on sacdn with the signed query, so the player
// fetches media straight from sacdn (CORS *) and no media bytes pass the VM.
//
// Pure functions: no network, no cache. lib/media/mmDash.js does the I/O.
// Port of scratchpad bridge/conv.py (KGF 2: 1,660 video and 1,987 audio
// segments). Handles SegmentTemplate with SegmentTimeline (KGF 2) and with a
// fixed @duration (Salaar).

// ISO 639-2 (MPD `lang`) -> the 2-letter code HLS LANGUAGE uses. A code not
// listed passes through as given (BCP 47 allows 3 letters). und/unk/mul/zxx
// say nothing, so they give no LANGUAGE at all.
const ISO2 = {
    tel: 'te', tam: 'ta', kan: 'kn', hin: 'hi', mal: 'ml', eng: 'en', ben: 'bn', mar: 'mr',
    guj: 'gu', pan: 'pa', urd: 'ur', ori: 'or', ory: 'or', asm: 'as', jpn: 'ja', kor: 'ko',
    spa: 'es', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', ita: 'it', por: 'pt', rus: 'ru',
    zho: 'zh', chi: 'zh', ara: 'ar', tha: 'th', ind: 'id', msa: 'ms', may: 'ms', vie: 'vi', tur: 'tr',
};
const NAMES = {
    te: 'Telugu', ta: 'Tamil', kn: 'Kannada', hi: 'Hindi', ml: 'Malayalam', en: 'English', bn: 'Bengali',
    mr: 'Marathi', gu: 'Gujarati', pa: 'Punjabi', ur: 'Urdu', or: 'Odia', as: 'Assamese', ja: 'Japanese',
    ko: 'Korean', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian',
    zh: 'Chinese', ar: 'Arabic', th: 'Thai', id: 'Indonesian', ms: 'Malay', vi: 'Vietnamese', tr: 'Turkish',
};
const CODE_OF_NAME = Object.fromEntries(Object.entries(NAMES).map(([c, n]) => [n.toLowerCase(), c]));

// MPD lang -> HLS LANGUAGE code, or null (no information).
function hlsLanguage(lang) {
    const l = String(lang || '').trim().toLowerCase();
    if (!l || /^(und|unk|mul|zxx|mis)$/.test(l)) return null;
    const primary = l.split(/[-_]/)[0];
    return ISO2[primary] || primary;
}
// A language name ("Telugu") -> its 2-letter code, or null.
function codeOfName(name) {
    return CODE_OF_NAME[String(name || '').trim().toLowerCase()] || null;
}
function nameOfCode(code) {
    return NAMES[String(code || '').toLowerCase()] || null;
}

function attrsOf(tag) {
    const out = {};
    for (const m of String(tag || '').matchAll(/([\w:.-]+)="([^"]*)"/g)) out[m[1]] = m[2];
    return out;
}

// ISO 8601 duration (PT2H45M57.2S) -> seconds, or null.
function isoSeconds(v) {
    const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(v || '').trim());
    if (!m) return null;
    const [d, h, mi, s] = m.slice(1).map((x) => Number(x || 0));
    return d * 86400 + h * 3600 + mi * 60 + s;
}

// The first element `name` inside `body`: { attrs, inner } or null.
function element(body, name) {
    const re = new RegExp(`<${name}\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/${name}>)`);
    const m = re.exec(body);
    return m ? { attrs: attrsOf(m[1]), inner: m[3] || '' } : null;
}
function elements(body, name) {
    const re = new RegExp(`<${name}\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/${name}>)`, 'g');
    return [...String(body || '').matchAll(re)].map((m) => ({ attrs: attrsOf(m[1]), inner: m[3] || '' }));
}

// $RepresentationID$, $Number%05d$, $Time$, $Bandwidth$ in a template.
function fillTemplate(tpl, vars) {
    return String(tpl || '').replace(/\$(RepresentationID|Number|Time|Bandwidth)(%0(\d+)d)?\$|\$\$/g, (all, key, _f, width) => {
        if (all === '$$') return '$';
        const v = String(vars[key] ?? '');
        return width ? v.padStart(Number(width), '0') : v;
    });
}

// Segment list for one SegmentTemplate: [{ number, time, dur }] in timescale units.
function segmentsOf(st, totalSec) {
    const ts = Number(st.attrs.timescale || 1);
    const start = Number(st.attrs.startNumber || 1);
    const out = [];
    const timeline = element(st.inner, 'SegmentTimeline');
    if (timeline) {
        let t = 0;
        let n = start;
        const ss = elements(timeline.inner, 'S');
        ss.forEach((s, i) => {
            if (s.attrs.t !== undefined) t = Number(s.attrs.t);
            const d = Number(s.attrs.d);
            if (!(d > 0)) return;
            let r = Number(s.attrs.r || 0);
            if (r < 0) {
                // Repeat until the next S's t, or the end of the period.
                const next = ss[i + 1] && ss[i + 1].attrs.t !== undefined ? Number(ss[i + 1].attrs.t)
                    : (totalSec ? Math.round(totalSec * ts) : t + d);
                r = Math.max(0, Math.ceil((next - t) / d) - 1);
            }
            for (let k = 0; k <= r; k++) { out.push({ number: n++, time: t, dur: d }); t += d; }
        });
        return { ts, segments: out };
    }
    const d = Number(st.attrs.duration);
    if (!(d > 0) || !(totalSec > 0)) return { ts, segments: out };
    const total = Math.round(totalSec * ts);
    let t = 0;
    for (let n = start; t < total; n++) {
        const dur = Math.min(d, total - t);
        out.push({ number: n, time: t, dur });
        t += d;
    }
    return { ts, segments: out };
}

// Parse a static MPD (first Period). Returns { duration, reps } or throws.
// reps: [{ id, kind: 'video'|'audio', codecs, bandwidth, width, height,
// frameRate, lang, channels, timescale, init, segments: [{ uri, dur }] }]
// with init/segment `uri` relative to the MPD folder.
function parseMpd(text) {
    const s = String(text || '');
    const mpd = /<MPD\b([^>]*)>/.exec(s);
    if (!mpd) throw new Error('not an MPD');
    const mattrs = attrsOf(mpd[1]);
    if (mattrs.type && mattrs.type !== 'static') throw new Error(`MPD type ${mattrs.type} unsupported`);
    if (/<BaseURL\b/.test(s)) throw new Error('MPD BaseURL unsupported');
    if (/<ContentProtection\b/.test(s)) throw new Error('MPD has DRM');
    const period = element(s, 'Period');
    if (!period) throw new Error('MPD has no Period');
    const totalSec = isoSeconds(mattrs.mediaPresentationDuration)
        || isoSeconds(period.attrs.duration) || null;
    const reps = [];
    for (const aset of elements(period.inner, 'AdaptationSet')) {
        const a = aset.attrs;
        const asetTpl = element(aset.inner.replace(/<Representation\b[\s\S]*$/, ''), 'SegmentTemplate');
        for (const rep of elements(aset.inner, 'Representation')) {
            const r = rep.attrs;
            const mime = r.mimeType || a.mimeType || '';
            const kind = /^video\//.test(mime) || a.contentType === 'video' ? 'video'
                : /^audio\//.test(mime) || a.contentType === 'audio' ? 'audio' : null;
            if (!kind) continue;
            const tpl = element(rep.inner, 'SegmentTemplate') || asetTpl;
            if (!tpl) continue;
            // Representation attributes override the AdaptationSet template's.
            const merged = { attrs: { ...(asetTpl ? asetTpl.attrs : {}), ...tpl.attrs }, inner: tpl.inner || (asetTpl ? asetTpl.inner : '') };
            const { ts, segments } = segmentsOf(merged, totalSec);
            if (!segments.length) continue;
            const vars = { RepresentationID: r.id, Bandwidth: r.bandwidth };
            const ch = element(rep.inner, 'AudioChannelConfiguration') || element(aset.inner, 'AudioChannelConfiguration');
            reps.push({
                id: r.id,
                kind,
                codecs: r.codecs || a.codecs || null,
                bandwidth: Number(r.bandwidth) || 0,
                width: Number(r.width || a.width) || null,
                height: Number(r.height || a.height) || null,
                frameRate: r.frameRate || a.frameRate || null,
                lang: a.lang || r.lang || null,
                channels: ch && /^\d+$/.test(ch.attrs.value || '') ? ch.attrs.value : null,
                timescale: ts,
                init: merged.attrs.initialization ? fillTemplate(merged.attrs.initialization, vars) : null,
                segments: segments.map((g) => ({
                    uri: fillTemplate(merged.attrs.media, { ...vars, Number: g.number, Time: g.time }),
                    dur: g.dur / ts,
                })),
            });
        }
    }
    if (!reps.some((r) => r.kind === 'video')) throw new Error('MPD has no video Representation');
    return { duration: totalSec, reps };
}

// One HLS media playlist for one Representation. `folder`: absolute sacdn
// folder URL ending in '/'; `query`: the signed query, appended to every line.
function mediaPlaylist(rep, folder, query) {
    const q = query ? `?${query}` : '';
    const target = Math.max(1, Math.ceil(Math.max(...rep.segments.map((g) => g.dur))));
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`,
        '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
    if (rep.init) lines.push(`#EXT-X-MAP:URI="${folder}${rep.init}${q}"`);
    for (const g of rep.segments) {
        lines.push(`#EXTINF:${g.dur.toFixed(3)},`);
        lines.push(`${folder}${g.uri}${q}`);
    }
    lines.push('#EXT-X-ENDLIST', '');
    return lines.join('\n');
}

const quoted = (v) => String(v).replace(/"/g, "'");

// The HLS master. `playlistUrl(rep)`: the URL of that rep's media playlist.
// opts.videoCodecs: rep id -> full codec string ("hev1.1.6.L150.90"); when a
// video rep has none, CODECS is left out for every variant (a bare "hev1"
// fails MediaSource.isTypeSupported in Chrome and hls.js reads the init
// segment instead). opts.language: { code, name } that overrides every audio
// set's MPD lang (the provider's language plan); code null = no LANGUAGE.
// Telugu audio goes first and is the DEFAULT.
function masterPlaylist(parsed, playlistUrl, opts = {}) {
    const audio = parsed.reps.filter((r) => r.kind === 'audio');
    const video = parsed.reps.filter((r) => r.kind === 'video').sort((a, b) => b.bandwidth - a.bandwidth);
    const vc = opts.videoCodecs || {};
    const allVideoCodecs = video.every((r) => vc[r.id]);
    const tracks = audio.map((r) => {
        let code;
        let name;
        if (opts.language) {
            code = opts.language.code || null;
            name = opts.language.name || nameOfCode(code) || 'Audio';
        } else {
            code = hlsLanguage(r.lang);
            name = nameOfCode(code) || (code ? code : 'Audio');
        }
        return { rep: r, code, name };
    });
    tracks.sort((x, y) => (y.code === 'te') - (x.code === 'te'));
    // Distinct NAMEs inside the group (HLS requires it).
    const seen = new Map();
    for (const t of tracks) {
        const k = t.name;
        seen.set(k, (seen.get(k) || 0) + 1);
        if (seen.get(k) > 1) t.name = `${k} ${seen.get(k)}`;
    }
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
    tracks.forEach((t, i) => {
        const parts = ['TYPE=AUDIO', 'GROUP-ID="audio"'];
        if (t.code) parts.push(`LANGUAGE="${quoted(t.code)}"`);
        parts.push(`NAME="${quoted(t.name)}"`, `DEFAULT=${i === 0 ? 'YES' : 'NO'}`, 'AUTOSELECT=YES');
        if (t.rep.channels) parts.push(`CHANNELS="${t.rep.channels}"`);
        parts.push(`URI="${playlistUrl(t.rep)}"`);
        lines.push(`#EXT-X-MEDIA:${parts.join(',')}`);
    });
    const audioBw = audio.length ? Math.max(...audio.map((r) => r.bandwidth)) : 0;
    const audioCodec = audio.length && audio[0].codecs ? audio[0].codecs : null;
    for (const v of video) {
        const parts = [`BANDWIDTH=${v.bandwidth + audioBw}`];
        if (v.width && v.height) parts.push(`RESOLUTION=${v.width}x${v.height}`);
        if (allVideoCodecs) parts.push(`CODECS="${[vc[v.id], audioCodec].filter(Boolean).join(',')}"`);
        const fr = /^(\d+)(?:\/(\d+))?$/.exec(String(v.frameRate || ''));
        if (fr) parts.push(`FRAME-RATE=${(Number(fr[1]) / Number(fr[2] || 1)).toFixed(3)}`);
        if (tracks.length) parts.push('AUDIO="audio"');
        lines.push(`#EXT-X-STREAM-INF:${parts.join(',')}`);
        lines.push(playlistUrl(v));
    }
    lines.push('');
    return lines.join('\n');
}

// Epoch seconds a CloudFront custom Policy (the URL param) expires at, or null.
function policyExpiry(policy) {
    if (!policy) return null;
    try {
        const b64 = String(policy).replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/');
        const j = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        const st = (j.Statement || [])[0] || {};
        const e = st.Condition && st.Condition.DateLessThan && st.Condition.DateLessThan['AWS:EpochTime'];
        return Number.isFinite(Number(e)) ? Number(e) : null;
    } catch { return null; }
}

module.exports = {
    parseMpd, mediaPlaylist, masterPlaylist, hlsLanguage, codeOfName, nameOfCode,
    policyExpiry, isoSeconds, fillTemplate,
};
