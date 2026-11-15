'use strict';
// Fixed-window per-IP limit for the media proxy routes.
//
// Every /m3u8-proxy, /ts-proxy and /sub-proxy hit costs an upstream fetch from
// the VM, and the routes are open to anyone. One viewer pulls a segment every
// few seconds plus playlist refreshes (well under 2/s), so the default of 600
// per minute only stops a runaway client or a scraper. PROXY_RATE_LIMIT_PER_MIN
// tunes it; 0 turns it off. req.ip honours `trust proxy` (nginx in front).
function createRateLimit({ windowMs = 60000, max = 600, maxKeys = 10000, now = Date.now } = {}) {
  const hits = new Map(); // ip -> { start, count }
  function limiter(req, res, next) {
    if (!max) return next();
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const t = now();
    let h = hits.get(ip);
    if (!h || t - h.start >= windowMs) {
      if (!h && hits.size >= maxKeys) {
        // Bounded memory: drop expired windows, then the oldest key.
        for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
        if (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
      }
      h = { start: t, count: 0 };
      hits.set(ip, h);
    }
    h.count += 1;
    if (h.count > max) {
      const retry = Math.max(1, Math.ceil((h.start + windowMs - t) / 1000));
      res.set('Retry-After', String(retry));
      return res.status(429).json({ success: false, error: 'RATE_LIMITED', retryAfterSeconds: retry });
    }
    return next();
  }
  limiter.size = () => hits.size;
  return limiter;
}

module.exports = { createRateLimit };
