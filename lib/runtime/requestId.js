'use strict';
// One id per request, carried through every log line the request causes.
//
// The aggregate route fans out to several providers concurrently, so their
// log lines interleave across requests and could not be told apart. An
// AsyncLocalStorage context follows each request through awaits, and console
// output gets a `[rid]` prefix while one is active. Lines outside a request
// (startup, timers) are unchanged. The id is echoed as X-Request-Id; an
// incoming X-Request-Id (from nginx or the web app) is reused when sane.
const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const store = new AsyncLocalStorage();
const SANE = /^[A-Za-z0-9._-]{1,64}$/;

function currentRequestId() {
  return store.getStore() || null;
}

function requestIdMiddleware(req, res, next) {
  const incoming = req.get && req.get('x-request-id');
  const id = incoming && SANE.test(incoming) ? incoming : crypto.randomBytes(4).toString('hex');
  req.id = id;
  res.set('X-Request-Id', id);
  store.run(id, next);
}

let patched = false;
function patchConsole(target = console) {
  if (patched) return;
  patched = true;
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = target[level].bind(target);
    target[level] = (...args) => {
      const id = store.getStore();
      if (!id) return orig(...args);
      if (typeof args[0] === 'string') return orig(`[${id}] ${args[0]}`, ...args.slice(1));
      return orig(`[${id}]`, ...args);
    };
  }
}

module.exports = { requestIdMiddleware, patchConsole, currentRequestId };
