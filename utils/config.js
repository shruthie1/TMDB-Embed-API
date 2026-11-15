require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { fromRoot, paths: appPaths } = require('../lib/runtime/paths');
const { features } = require('../lib/runtime/environment');
// Relocated user-config.json into utils directory; maintain backward-compatible fallback
const NEW_OVERRIDE_PATH = fromRoot('utils', 'user-config.json');
const LEGACY_OVERRIDE_PATH = fromRoot('user-config.json');
const OVERRIDE_PATH = (fs.existsSync(NEW_OVERRIDE_PATH) || !fs.existsSync(LEGACY_OVERRIDE_PATH)) ? NEW_OVERRIDE_PATH : LEGACY_OVERRIDE_PATH;
// The real override file is gitignored (it can hold keys). A clean checkout or
// a `git archive` deploy has only this tracked template, and without it every
// provider flag defaults to enabled. Reads fall back to it; writes always go
// to OVERRIDE_PATH, so the first save from the admin UI seeds the real file.
const EXAMPLE_OVERRIDE_PATH = fromRoot('utils', 'user-config.example.json');
function overrideReadPath(p = { real: OVERRIDE_PATH, example: EXAMPLE_OVERRIDE_PATH }) {
  if (fs.existsSync(p.real)) return p.real;
  if (fs.existsSync(p.example)) return p.example;
  return null;
}
const CONFIG_SCHEMA_VERSION = 1; // Increment when structure / semantics change

function parseJsonMaybe(val) {
  if (!val) return null;
  const trimmed = val.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  return null;
}

function parseCookies(raw) {
  if (!raw) return [];
  const text = raw.trim();
  if (!text) return [];
  let arr = [];
  const json = parseJsonMaybe(text);
  if (Array.isArray(json)) arr = json; else {
    arr = text.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
  }
  return Array.from(new Set(arr.map(c => c.replace(/^ui=/,'').trim()).filter(Boolean)));
}

function readOverrideFile() {
  try {
    const from = overrideReadPath();
    if (from) {
      const raw = fs.readFileSync(from, 'utf8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    }
  } catch (e) {
    console.warn('[config] Failed to read override file:', e.message);
  }
  return {};
}

function writeOverrideFile(obj) {
  // On serverless the bundle is read-only and /tmp is per-instance and
  // ephemeral, so a "successful" write would be invisible to the very next
  // request and lost entirely on the next cold start. Silently returning true
  // there would show the admin UI a saved setting that does not exist. Refuse
  // instead, so the caller can surface a real error.
  if (!features.configPersistence) {
    console.error('[config] Refusing to write override file: this runtime has no persistent filesystem. Set configuration via environment variables instead.');
    return false;
  }
  try {
    fs.writeFileSync(OVERRIDE_PATH, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    console.error('[config] Failed to write override file:', e.message);
    return false;
  }
}

function getProviderNames() {
  try {
    const providersDir = appPaths.providers;
    if (!fs.existsSync(providersDir)) return [];
    return fs.readdirSync(providersDir)
      .filter(file => file.endsWith('.js') && file !== 'registry.js')
      .map(file => path.parse(file).name.toLowerCase());
  } catch (e) {
    console.warn('[config] Failed to scan providers directory:', e.message);
    return [];
  }
}

function normalizeConfig(base) {
  const cfg = { ...base };
  // Marker: if user explicitly provided an empty array for tmdbApiKeys in override file we should not resurrect legacy key
  const explicitEmptyKeys = Array.isArray(cfg.tmdbApiKeys) && cfg.tmdbApiKeys.length === 0 && Object.prototype.hasOwnProperty.call(base,'tmdbApiKeys');
  if (!cfg.configVersion) cfg.configVersion = CONFIG_SCHEMA_VERSION;
  // Derive structured views
  cfg.minQualities = parseJsonMaybe(cfg.minQualitiesRaw) || (cfg.minQualitiesRaw ? { default: cfg.minQualitiesRaw } : null);
  cfg.excludeCodecs = parseJsonMaybe(cfg.excludeCodecsRaw) || null;
  cfg.febboxCookies = Array.isArray(cfg.febboxCookies) ? cfg.febboxCookies : parseCookies(cfg.febboxCookies);
  // TMDB multi-key support: allow tmdbApiKeys (array) or legacy single tmdbApiKey
  if (cfg.tmdbApiKeys && !Array.isArray(cfg.tmdbApiKeys)) {
    if (typeof cfg.tmdbApiKeys === 'string') {
      // split by newline/comma/semicolon
      cfg.tmdbApiKeys = cfg.tmdbApiKeys.split(/[\n,;]+/).map(s=>s.trim()).filter(Boolean);
    } else cfg.tmdbApiKeys = [];
  }
  if (!cfg.tmdbApiKeys || !cfg.tmdbApiKeys.length) {
    if (!explicitEmptyKeys && cfg.tmdbApiKey) cfg.tmdbApiKeys = [cfg.tmdbApiKey];
    else cfg.tmdbApiKeys = [];
  }
  // Serverless has no writable override file, so the key can only arrive as an
  // environment variable. Without this the committed config (which ships with
  // no key on purpose - it is a public repo) won overrode a TMDB_API_KEY set in
  // the host's dashboard: line ~138 below MIRRORS config into process.env and
  // deletes the var when the list is empty, so a correctly configured deploy
  // erased its own key at startup and every lookup returned nothing.
  //
  // The file still wins when it has keys; this only fills a gap. Read AFTER the
  // legacy single-key branch so an explicit local key keeps priority, and
  // deliberately NOT gated on explicitEmptyKeys: clearing the list in the
  // config UI is a statement about the override file, not an instruction to
  // ignore the deployment's environment.
  if (!cfg.tmdbApiKeys.length && process.env.TMDB_API_KEY) {
    cfg.tmdbApiKeys = String(process.env.TMDB_API_KEY)
      .split(/[\n,;]+/).map((k) => k.trim()).filter(Boolean);
  }
  // If user explicitly cleared tmdbApiKeys via override, also clear legacy single key so it is not shown
  if (explicitEmptyKeys) {
    cfg.tmdbApiKey = null;
  }
  // Ensure dedupe + trim
  cfg.tmdbApiKeys = Array.from(new Set(cfg.tmdbApiKeys.map(k=>String(k).trim()).filter(Boolean)));
  // Do not expose legacy single-key field in merged config output
  delete cfg.tmdbApiKey;
  
  // Dynamic provider enable flags
  const providerNames = getProviderNames();
  const boolKeys = providerNames.map(name => `enable${name.charAt(0).toUpperCase() + name.slice(1)}Provider`);
  boolKeys.push('disableCache', 'enablePStreamApi', 'disableUrlValidation', 'disable4khdhubUrlValidation', 'enableProxy');
  
  boolKeys.forEach(k=>{ if (cfg[k] === 'true') cfg[k] = true; else if (cfg[k] === 'false') cfg[k] = false; });
  
  // Set defaults for provider enable flags
  providerNames.forEach(name => {
    const flag = `enable${name.charAt(0).toUpperCase() + name.slice(1)}Provider`;
    if (cfg[flag] === undefined) cfg[flag] = true; // Default to enabled
  });
  
  // Default values for other flags
  if (cfg.disableCache === undefined) cfg.disableCache = false;
  if (cfg.enablePStreamApi === undefined) cfg.enablePStreamApi = true;
  if (cfg.enableProxy === undefined) cfg.enableProxy = false; // default off
  // Proxy features removed; always use direct connections
  if (cfg.disableUrlValidation === undefined) cfg.disableUrlValidation = false;
  if (cfg.disable4khdhubUrlValidation === undefined) cfg.disable4khdhubUrlValidation = false;
  // TMDB ID used by the dashboard's "Run Provider Functional Checks" feature
  if (!cfg.providerCheckTmdbId) cfg.providerCheckTmdbId = '278';
  return cfg;
}

function applyConfigToEnv(cfg){
  // Mirror config values into process.env so legacy provider code continues to work without .env file
  if (cfg.port) process.env.API_PORT = String(cfg.port);
  // Backward compat: set single TMDB_API_KEY env to first key if available
  if (cfg.tmdbApiKeys && cfg.tmdbApiKeys.length) process.env.TMDB_API_KEY = cfg.tmdbApiKeys[0];
  else if (cfg.tmdbApiKey) process.env.TMDB_API_KEY = cfg.tmdbApiKey; else delete process.env.TMDB_API_KEY;
  if (cfg.defaultProviders) process.env.DEFAULT_PROVIDERS = cfg.defaultProviders.join(',');
  if (cfg.minQualitiesRaw) process.env.MIN_QUALITIES = cfg.minQualitiesRaw; else delete process.env.MIN_QUALITIES;
  if (cfg.excludeCodecsRaw) process.env.EXCLUDE_CODECS = cfg.excludeCodecsRaw; else delete process.env.EXCLUDE_CODECS;
  if (cfg.febboxCookies && cfg.febboxCookies.length) process.env.FEBBOX_COOKIES = cfg.febboxCookies.join(',');
  else delete process.env.FEBBOX_COOKIES;
  if (cfg.cfClearance && Object.keys(cfg.cfClearance).length) process.env.CF_CLEARANCE = JSON.stringify(cfg.cfClearance);
  else delete process.env.CF_CLEARANCE;
  if (cfg.defaultRegion) process.env.DEFAULT_REGION = cfg.defaultRegion; else delete process.env.DEFAULT_REGION;
  
  // Dynamic provider enable flags
  const providerNames = getProviderNames();
  providerNames.forEach(name => {
    const flag = `enable${name.charAt(0).toUpperCase() + name.slice(1)}Provider`;
    const envName = `ENABLE_${name.toUpperCase()}_PROVIDER`;
    process.env[envName] = cfg[flag] ? 'true' : 'false';
  });
  
  // Caching / validation / PStream
  process.env.DISABLE_CACHE = cfg.disableCache ? 'true':'false';
  process.env.ENABLE_PSTREAM_API = cfg.enablePStreamApi ? 'true':'false';
  process.env.DISABLE_URL_VALIDATION = cfg.disableUrlValidation ? 'true':'false';
  process.env.DISABLE_4KHDHUB_URL_VALIDATION = cfg.disable4khdhubUrlValidation ? 'true':'false';
  process.env.ENABLE_PROXY = cfg.enableProxy ? 'true':'false';
  if (cfg.providerCheckTmdbId) process.env.PROVIDER_CHECK_TMDB_ID = String(cfg.providerCheckTmdbId);
  else delete process.env.PROVIDER_CHECK_TMDB_ID;
  // Showbox specific
  if (cfg.showboxCacheDir) process.env.SHOWBOX_CACHE_DIR = cfg.showboxCacheDir; else delete process.env.SHOWBOX_CACHE_DIR;
  // Proxy settings removed; ensure legacy envs are cleared
  delete process.env.SHOWBOX_USE_ROTATING_PROXY;
  delete process.env.SHOWBOX_PROXY_URL_VALUE;
  delete process.env.SHOWBOX_PROXY_URL_ALTERNATE;
  delete process.env.VIDZEE_PROXY_URL;
  delete process.env.VIDSRC_PROXY_URL;
  delete process.env.MOVIESMOD_PROXY_URL;
  if (cfg.defaultRegion) process.env.FEBBOX_REGION = cfg.defaultRegion; // alias
}

function loadConfig() {
  // Start with env for backward compat, then override with user-config.json
  const envCfg = {
    // Render and similar platforms provide PORT dynamically; keep API_PORT
    // as the local/Docker fallback.
    port: Number(process.env.PORT || process.env.API_PORT) || 8787,
    defaultRegion: process.env.DEFAULT_REGION || process.env.FEBBOX_REGION || null,
  defaultProviders: (process.env.DEFAULT_PROVIDERS || '').split(/[\s,]+/).map(p=>p.trim().toLowerCase()).filter(Boolean),
    minQualitiesRaw: process.env.MIN_QUALITIES || null,
    excludeCodecsRaw: process.env.EXCLUDE_CODECS || null,
    tmdbApiKey: process.env.TMDB_API_KEY || null,
  tmdbApiKeys: parseJsonMaybe(process.env.TMDB_API_KEYS) || null,
    febboxCookies: parseCookies(process.env.FEBBOX_COOKIES),
    // Febbox OAuth app credentials. Kept in .env (gitignored) and surfaced on
    // the config object so they are visible in one place, but nothing consumes
    // them yet: Showbox authenticates with the `ui=` session cookie above, not
    // with a client id/secret. Wire these up only if Febbox ships an OAuth API.
    febboxClientId: process.env.FEBBOX_CLIENT_ID || null,
    febboxClientSecret: process.env.FEBBOX_CLIENT_SECRET || null,
    // Cloudflare clearance cookies for hosts that sit behind a JS challenge
    // (DahmerMovies' p.111477.xyz). Shape: { "host": "cf_clearance=..." }.
    // A browser mints these by visiting the URL once; node cannot solve the
    // challenge itself, so the cookie has to be supplied from outside.
    cfClearance: parseJsonMaybe(process.env.CF_CLEARANCE) || null,
    // Extended advanced config (may not exist in env)
    disableCache: process.env.DISABLE_CACHE,
    enablePStreamApi: process.env.ENABLE_PSTREAM_API,
    showboxCacheDir: process.env.SHOWBOX_CACHE_DIR || null,
    // Proxy/env paths removed; always direct connections
    disableUrlValidation: process.env.DISABLE_URL_VALIDATION,
    disable4khdhubUrlValidation: process.env.DISABLE_4KHDHUB_URL_VALIDATION,
    enableProxy: process.env.ENABLE_PROXY,
    providerCheckTmdbId: process.env.PROVIDER_CHECK_TMDB_ID || null
  };
  
  // Dynamic provider enable flags from env
  const providerNames = getProviderNames();
  providerNames.forEach(name => {
    const envName = `ENABLE_${name.toUpperCase()}_PROVIDER`;
    envCfg[`enable${name.charAt(0).toUpperCase() + name.slice(1)}Provider`] = process.env[envName];
  });
  
  const override = readOverrideFile();
  const merged = { ...envCfg, ...override };

  // The hosting platform assigns the port and the process MUST bind the one it
  // is given. user-config.json carries a saved port (8790 locally), and since
  // the override spreads last it would otherwise beat $PORT and make the
  // container bind the wrong port - the platform's health check then never
  // connects and the deploy is marked failed. A platform-provided PORT
  // therefore wins over the stored value. API_PORT stays a local-only fallback.
  if (process.env.PORT) merged.port = Number(process.env.PORT) || merged.port;
  const normalized = normalizeConfig(merged);
  applyConfigToEnv(normalized); // ensure providers see updated process.env values
  return normalized;
}

const config = loadConfig();

function saveConfigPatch(patch) {
  const currentOverride = readOverrideFile();
  const updated = { ...currentOverride, ...patch };
  if (!updated.configVersion) updated.configVersion = CONFIG_SCHEMA_VERSION;
  // Remove keys set to null to fall back to env
  Object.keys(updated).forEach(k => { if (updated[k] === null) delete updated[k]; });
  if (writeOverrideFile(updated)) {
    Object.assign(config, loadConfig());
    return true;
  }
  return false;
}

module.exports = { config, reloadConfig: () => Object.assign(config, loadConfig()), saveConfigPatch, OVERRIDE_PATH, CONFIG_SCHEMA_VERSION, overrideReadPath };
