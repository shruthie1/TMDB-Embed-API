'use strict';
// Endpoint/parser data is configuration, never downloaded executable code.
function current(provider, defaults, limits = {}) {
  const selfheal = require('../selfheal/config');
  const value = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const candidate = selfheal.cfg(provider, key, fallback);
    value[key] = Array.isArray(candidate) ? [...candidate] : candidate;
  }
  for (const key of ['base', 'catalogue']) if (key in value) {
    try {
      const url = new URL(value[key]);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('endpoint');
      value[key] = url.href.replace(/\/$/, '');
    } catch { value[key] = defaults[key]; }
  }
  if (!value.userAgent || value.userAgent.length > 600 || /[\r\n]/.test(value.userAgent)) value.userAgent = defaults.userAgent;
  for (const [key, floor, ceiling] of [['budgetMs', 1000, 60_000], ['stepTimeoutMs', 500, 20_000]]) {
    value[key] = Math.min(Number(limits[key]) || ceiling, Math.max(floor, Math.min(ceiling, Number(value[key]) || defaults[key])));
  }
  return Object.freeze(value);
}
function remaining(deadline, stepMs, now = Date.now()) {
  if (deadline <= now) throw Object.assign(new Error('extractor budget spent'), { code: 'EXTRACTOR_BUDGET' });
  return Math.max(1, Math.min(stepMs, deadline - now));
}
module.exports = { current, remaining };
