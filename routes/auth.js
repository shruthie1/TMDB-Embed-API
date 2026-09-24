'use strict';

// Authentication routes and their login rate limiter.
//
// Extracted from apiServer.js: the brute-force state and the routes that use
// it are one concern and nothing outside this file touched them.
//
// The limiter is deliberately in-process. That is correct for a single
// long-lived server and useless across serverless instances, where each cold
// instance starts with an empty Map - so on that platform this is defence in
// depth behind the password check, not a real throttle.

const { authenticate, issueSession, requireAuth, getSession, updatePassword } = require('../utils/auth');

// --- Simple In-Memory Rate Limiting for /auth/login ---
const loginAttempts = new Map(); // key: ip, value: { count, first, last, lockedUntil }
const MAX_ATTEMPTS_WINDOW = 5; // attempts allowed
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes window
const BASE_LOCK_MS = 5 * 60 * 1000; // 5 minutes base lock

function getClientIp(req){
  return (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();
}

function recordLoginFailure(ip){
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry) {
    entry = { count:1, first: now, last: now, lockedUntil:0 };
    loginAttempts.set(ip, entry);
    return entry;
  }
  // Reset window if outside timeframe and not locked
  if (now - entry.first > WINDOW_MS && now > entry.lockedUntil) {
    entry.count = 1;
    entry.first = now;
  } else {
    entry.count++;
  }
  entry.last = now;
  if (entry.count > MAX_ATTEMPTS_WINDOW) {
    // Exponential backoff lock: base * 2^(count - limit)
    const over = entry.count - MAX_ATTEMPTS_WINDOW;
    const lockMs = BASE_LOCK_MS * Math.min(8, Math.pow(2, over-1));
    entry.lockedUntil = now + lockMs;
  }
  return entry;
}

function canAttempt(ip){
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed:true };
  const now = Date.now();
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return { allowed:false, retryAfter: Math.ceil((entry.lockedUntil - now)/1000) };
  }
  if (now - entry.first > WINDOW_MS) {
    // Window passed; reset
    loginAttempts.delete(ip);
    return { allowed:true };
  }
  return { allowed:true };
}

function recordLoginSuccess(ip){
  // On success clear state to avoid lingering count
  loginAttempts.delete(ip);
}

function registerAuthRoutes(app) {

    // --- Auth Routes (login before static serving) ---
    app.post('/auth/login', (req,res) => {
      const { username, password } = req.body || {};
      const ip = getClientIp(req);
      const attemptState = canAttempt(ip);
      if (!attemptState.allowed) {
        res.setHeader('Retry-After', String(attemptState.retryAfter));
        return res.status(429).json({ success:false, error:'TOO_MANY_ATTEMPTS', retryAfter: attemptState.retryAfter });
      }
      if (!username || !password) return res.status(400).json({ success:false, error:'MISSING_CREDENTIALS' });
      if (!authenticate(username, password)) {
        const entry = recordLoginFailure(ip);
        if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
          const retryAfter = Math.ceil((entry.lockedUntil - Date.now())/1000);
          res.setHeader('Retry-After', String(retryAfter));
          return res.status(429).json({ success:false, error:'LOCKED', retryAfter });
        }
        return res.status(401).json({ success:false, error:'INVALID_CREDENTIALS', remaining: Math.max(0, MAX_ATTEMPTS_WINDOW - entry.count) });
      }
      recordLoginSuccess(ip);
      const token = issueSession(username);
      res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12*60*60}`);
      res.json({ success:true, username });
    });

    app.post('/auth/logout', (req,res) => {
      res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      res.json({ success:true });
    });

    app.get('/auth/session', (req,res) => {
      const sess = getSession(req);
      if (!sess) return res.json({ authenticated:false });
      res.json({ authenticated:true, username: sess.u });
    });

    app.post('/auth/change-password', requireAuth, (req,res) => {
      const { oldPassword, newPassword } = req.body || {};
      if (!oldPassword || !newPassword) return res.status(400).json({ success:false, error:'MISSING_FIELDS' });
      const sess = req.session;
      if (!authenticate(sess.u, oldPassword)) return res.status(401).json({ success:false, error:'INVALID_OLD_PASSWORD' });
      if (newPassword.length < 8) return res.status(400).json({ success:false, error:'PASSWORD_TOO_SHORT' });
      if (!updatePassword(sess.u, newPassword)) return res.status(500).json({ success:false, error:'UPDATE_FAILED' });
      res.json({ success:true, message:'PASSWORD_UPDATED' });
    });
}

module.exports = { registerAuthRoutes, getClientIp };
