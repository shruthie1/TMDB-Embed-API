// Short tokens for proxy request headers, so a rewritten playlist does not
// repeat the row's headers as URL-encoded JSON on every segment line.
//
// Measured 2026-11-21 (Animal 781732, local API): a CastleTV 720p media
// playlist went 327,127 -> 2,904,427 bytes through /m3u8-proxy, ~580 of each
// line's ~740 bytes being `&headers=<json>`. A playlist uses ONE header set,
// so the line carries `&h=<id>` and /ts-proxy looks the headers up here.
//
// The id is a content hash: the same headers always give the same id, so
// re-rewriting a playlist (or another server instance) agrees. The map is
// persisted to a small JSON file and reloaded at startup, so a VM restart in
// the middle of a film does not strand the segment lines a player already
// holds. Bounded: header sets are per provider/title, a few dozen a day.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fromRoot } = require('../runtime/paths');

const MAX_ENTRIES = Number(process.env.PROXY_HEADER_TOKENS_MAX) || 5000;
const ID_LEN = 12;
const ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

let store = null; // id -> headers, insertion ordered (oldest first)

function filePath() {
    if (process.env.PROXY_HEADER_TOKENS_FILE) return process.env.PROXY_HEADER_TOKENS_FILE;
    // Under `node --test`, keep test header sets out of the real data dir.
    if (process.env.NODE_TEST_CONTEXT) return path.join(require('os').tmpdir(), `chitram-header-tokens-${process.pid}.json`);
    return fromRoot('data', 'proxy-header-tokens.json');
}

function load() {
    if (store) return store;
    store = new Map();
    try {
        const saved = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
        if (saved && typeof saved === 'object') {
            for (const [id, h] of Object.entries(saved)) {
                if (ID_RE.test(id) && h && typeof h === 'object' && !Array.isArray(h)) store.set(id, h);
            }
        }
    } catch { /* first run or unreadable: start empty */ }
    return store;
}

function save() {
    try {
        const file = filePath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(store)));
        fs.renameSync(tmp, file);
    } catch (e) {
        console.warn(`[header-token] persist failed: ${e.message}`);
    }
}

// Canonical form: keys sorted, values as strings.
function canonical(headers) {
    const out = {};
    for (const k of Object.keys(headers).sort()) out[k] = String(headers[k]);
    return out;
}

function idFor(headers) {
    return crypto.createHash('sha256').update(JSON.stringify(canonical(headers)))
        .digest('base64url').slice(0, ID_LEN);
}

// Register a header set; returns its id, or '' for no headers.
function put(headers) {
    if (!headers || typeof headers !== 'object' || !Object.keys(headers).length) return '';
    const s = load();
    const id = idFor(headers);
    if (s.has(id)) return id;
    s.set(id, { ...headers });
    while (s.size > MAX_ENTRIES) s.delete(s.keys().next().value);
    save();
    console.log(`[header-token] new id=${id} keys=${Object.keys(headers).join(',')} total=${s.size}`);
    return id;
}

// Headers for an id, or null when unknown.
function get(id) {
    if (!id || !ID_RE.test(String(id))) return null;
    const h = load().get(String(id));
    return h ? { ...h } : null;
}

module.exports = { put, get, _resetForTest: () => { store = null; } };
