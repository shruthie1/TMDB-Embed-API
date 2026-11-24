'use strict';
// Failure -> heal kind. Pure; first matching rule wins.
//
//   blocked  Cloudflare challenge, cf-mitigated, vaplayer rateLimited:true.
//            Never a move: no rediscover for it.
//   host     DNS / refused / certificate errors, 404/410 on the base path.
//   key      decrypt failed (GCM tag, CBC padding, garbage after decrypt).
//   token    page answered, its token was missing (vaplayer apiToken).
//   drift    404 on a path while the host root answers (path change), or a
//            2xx without the expected object; also the catch-all.
//   down     timeouts, resets, 5xx, 429/throttle, hosting quota (e.g. 1027).
//            A 403 without a quota response is blocked.
//
// Spec: docs/superpowers/specs/2026-11-21-provider-selfheal-design.md section 4.

const BLOCKED_RE = /Just a moment|cf-mitigated|"?rateLimited"?\s*:\s*true/i;
const HOST_RE = /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|certificate|CERT_|ERR_TLS/i;
const KEY_RE = /bad decrypt|unable to authenticate data|decrypted value is not a URL|decrypt[\s\S]*JSON|JSON[\s\S]*decrypt/i;
const TOKEN_RE = /no apiToken/i;
const DOWN_RE = /timeout|timed out|aborted|ETIMEDOUT/i;
const RESET_RE = /ECONNRESET|socket hang up|other side closed|EPIPE/i;
const QUOTA_RE = /\bquota\b|\b(?:error|code)\s*[:#]?\s*1027\b|owner has reached (?:their|the) plan limits|daily.{0,20}limit|limit.{0,10}exceed/i;

function header(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    const k = Object.keys(headers).find((h) => h.toLowerCase() === name);
    return k ? headers[k] : null;
}

/**
 * input: { message, status, body, headers, base, hostAlive }
 *   base       true when the failed request was on the provider's base path
 *   hostAlive  true when `<host>/` answered 2xx/3xx while the path failed
 * A status inside the message (`HTTP 403`, `api HTTP 521 for ...`) counts as
 * the status when none is given. Returns { kind, rule }.
 *
 * Rulings (coordinator, 2026-11-21 review I1): 403 -> blocked; 429 -> down
 * rule throttle; 5xx -> down rule 5xx; transport timeouts and resets -> down
 * rule timeout|reset, which still may start a heal (a sinkholed host times
 * out). shouldHeal() is that gate.
 */
function explain(input = {}) {
    const message = String(input.message || '');
    const body = String(input.body || '').slice(0, 4096);
    const inMsg = /\bHTTP (\d{3})\b/.exec(message);
    const status = Number(input.status) || (inMsg ? Number(inMsg[1]) : 0);
    const text = `${message}\n${body}`;
    // A 2xx body is page content (scripts often say "throttle"/"quota"); only
    // a failed response's body may signal quota or throttling.
    const ok = status >= 200 && status < 300;
    const failText = ok ? message : text;
    if (input.rule === 'quota' || QUOTA_RE.test(failText)) return { kind: 'down', rule: 'quota' };
    if (BLOCKED_RE.test(text) || header(input.headers, 'cf-mitigated')) return { kind: 'blocked', rule: 'cloudflare' };
    if (status === 403) return { kind: 'blocked', rule: 'http-403' };
    if (status === 429 || /rate.?limit|throttl/i.test(failText)) return { kind: 'down', rule: 'throttle' };
    if (status >= 500 && status < 600) return { kind: 'down', rule: '5xx' };
    if (HOST_RE.test(message)) return { kind: 'host', rule: 'dns' };
    if ((status === 404 || status === 410) && input.base && input.hostAlive !== true) return { kind: 'host', rule: 'base-404' };
    if (KEY_RE.test(message)) return { kind: 'key', rule: 'decrypt' };
    if (TOKEN_RE.test(message)) return { kind: 'token', rule: 'token-miss' };
    if (status === 404 && input.hostAlive === true) return { kind: 'drift', rule: 'path-404' };
    if (RESET_RE.test(message)) return { kind: 'down', rule: 'reset' };
    if (DOWN_RE.test(message)) return { kind: 'down', rule: 'timeout' };
    return { kind: 'drift', rule: 'unexpected' };
}

/** False for a failure a new host cannot fix: blocked, quota, throttle, 5xx. */
function shouldHeal(r) {
    if (r.kind === 'blocked') return false;
    if (r.kind === 'down' && (r.rule === 'quota' || r.rule === 'throttle' || r.rule === '5xx')) return false;
    return true;
}

function classify(input) { return explain(input).kind; }

/** classify, plus one `[selfheal] classify <provider> <kind> rule=<rule>` line. */
function classifyAndLog(provider, input, { full = false } = {}) {
    const r = explain(input);
    console.warn(`[selfheal] classify ${provider} ${r.kind} rule=${r.rule} msg=${String((input && input.message) || '').slice(0, 120)}`);
    return full ? r : r.kind;
}

module.exports = { classify, explain, classifyAndLog, shouldHeal };
