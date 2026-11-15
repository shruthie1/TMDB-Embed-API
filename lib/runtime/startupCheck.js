'use strict';
// Configuration problems found at boot, before the first viewer meets them.
// Errors would make the service unusable; warnings degrade one feature.
// Pure, so it can be tested without loading the server.
function checkStartupConfig(config, env = process.env, knownProviders = []) {
  const errors = [];
  const warnings = [];
  const port = Number(config.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) errors.push(`port ${config.port} is not a valid TCP port`);
  if (!Array.isArray(config.tmdbApiKeys) || config.tmdbApiKeys.length === 0) {
    warnings.push('no TMDB key (set TMDB_API_KEY in .env): search and imdb lookups will fail');
  }
  const base = String(env.PUBLIC_BASE_URL || '').trim();
  if (base && !/^https?:\/\/[^/\s]+/i.test(base)) {
    errors.push(`PUBLIC_BASE_URL "${base}" is not an http(s) origin; every proxied url would be broken`);
  } else if (/^http:\/\//i.test(base)) {
    warnings.push('PUBLIC_BASE_URL is http: an https web app blocks it as mixed content');
  }
  const known = new Set(knownProviders.map((n) => String(n).toLowerCase()));
  if (known.size) {
    for (const name of String(env.PRIMARY_PROVIDERS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
      if (!known.has(name)) warnings.push(`PRIMARY_PROVIDERS names unknown provider "${name}"`);
    }
    for (const name of config.defaultProviders || []) {
      if (!known.has(String(name).toLowerCase())) warnings.push(`defaultProviders names unknown provider "${name}"`);
    }
  }
  for (const k of ['SECONDARY_GRACE_MS', 'FIRST_ANSWER_GRACE_MS', 'PROXY_RATE_LIMIT_PER_MIN', 'SHUTDOWN_GRACE_MS']) {
    if (env[k] !== undefined && env[k] !== '' && !Number.isFinite(Number(env[k]))) warnings.push(`${k}="${env[k]}" is not a number; default used`);
  }
  return { errors, warnings };
}

module.exports = { checkStartupConfig };
