'use strict';
// Graceful stop for PM2 (SIGINT) and Docker/systemd (SIGTERM).
//
// Without this a restart killed in-flight requests mid-response: a viewer's
// /api/streams fan-out or a segment being proxied was cut off. Now the server
// stops accepting, lets open requests finish for up to SHUTDOWN_GRACE_MS, then
// exits 0. `exit` is injected because apiServer.js intercepts process.exit.
function installGracefulShutdown(server, { exit, graceMs = Number(process.env.SHUTDOWN_GRACE_MS) || 8000,
  signals = ['SIGTERM', 'SIGINT'], log = console } = {}) {
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    log.log(`[shutdown] ${signal}: closing server, waiting up to ${graceMs}ms for open requests`);
    const timer = setTimeout(() => {
      log.warn('[shutdown] grace expired; closing remaining connections');
      if (server.closeAllConnections) server.closeAllConnections();
      exit(0);
    }, graceMs);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      log.log('[shutdown] closed cleanly');
      exit(0);
    });
    // Keep-alive sockets with no request in flight would hold close() open.
    if (server.closeIdleConnections) server.closeIdleConnections();
  };
  for (const s of signals) process.on(s, () => stop(s));
  return stop;
}

module.exports = { installGracefulShutdown };
