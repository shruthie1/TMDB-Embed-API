'use strict';

// NewTV credentials are separate from mobile WebView cookies. Tokens stay in
// this process, scoped to the API origin and OTP; never persisted with streams
// or forwarded to a CDN. Expiry is unknown upstream, so TTL only bounds reuse;
// an explicit `otp` response renews the token sooner.
function createNewTvSession({ exchange, credential = () => process.env.NETMIRROR_OTP || '',
    now = () => Date.now(), ttlMs = 6 * 60 * 60 * 1000, failureMs = 30 * 1000 } = {}) {
    const sessions = new Map();

    function authError() {
        const error = new Error('NetMirror OTP verification required');
        error.code = 'NETMIRROR_AUTH_REQUIRED';
        return error;
    }

    function stateFor(api, otp) {
        const url = new URL(api);
        if (url.protocol !== 'https:' || url.username || url.password) throw authError();
        const origin = url.origin;
        const key = `${origin}\0${otp}`;
        if (!sessions.has(key)) {
            // Rotating discovery hosts must not grow a process-lifetime cache.
            // Do not evict an active exchange: its waiters share this record.
            for (const [oldKey, old] of sessions) {
                if (sessions.size < 8) break;
                if (!old.pending) sessions.delete(oldKey);
            }
            sessions.set(key, { token: '', until: 0, pending: null, failedUntil: 0 });
        }
        return sessions.get(key);
    }

    function tokenOf(state) {
        return state.until > now() ? state.token : '';
    }

    function invalidate(state, token) {
        // A delayed rejection of token A must not erase token B issued while
        // that request was in flight.
        if (state.token === token) { state.token = ''; state.until = 0; }
    }

    async function renew(api, otp, state, rejected) {
        const current = tokenOf(state);
        if (current && current !== rejected) return current;
        if (state.pending) return state.pending;
        if (state.failedUntil > now()) throw authError();
        invalidate(state, rejected);
        const pending = (async () => {
            try {
                const result = await exchange(api, otp);
                if (result?.status !== 'ok' || typeof result.usertoken !== 'string' || !result.usertoken.trim()) {
                    throw authError();
                }
                state.token = result.usertoken;
                state.until = now() + ttlMs;
                state.failedUntil = 0;
                return state.token;
            } catch (error) {
                // Budget/refusal gates already own their cool-down and must
                // remain distinguishable from an invalid OTP.
                if (error?.gate) throw error;
                state.failedUntil = now() + failureMs;
                throw authError();
            }
        })();
        state.pending = pending;
        try { return await pending; } finally {
            if (state.pending === pending) state.pending = null;
        }
    }

    async function request(api, send) {
        const otp = String(credential() || '').trim();
        // Backend exchange is opt-in; the device maintains its own session.
        if (!otp) return send('');
        const state = stateFor(api, otp);
        let token = tokenOf(state);
        const data = await send(token);
        if (data?.status !== 'otp') return data;
        token = await renew(api, otp, state, token);
        const retried = await send(token);
        if (retried?.status === 'otp') {
            invalidate(state, token);
            state.failedUntil = now() + failureMs;
            throw authError();
        }
        return retried;
    }

    return { request };
}

module.exports = { createNewTvSession };
