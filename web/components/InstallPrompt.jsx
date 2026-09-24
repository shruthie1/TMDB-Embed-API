'use client';

import { useEffect } from 'react';

/**
 * Install affordance + service worker registration.
 *
 * The browser owns the install banner. We intentionally do not intercept
 * `beforeinstallprompt`: calling preventDefault() without immediately calling
 * prompt() suppresses Chrome's banner and produces a console warning. Chrome
 * also decides when an install offer is appropriate, so there is no reason to
 * duplicate that decision with a second in-app chip.
 */
export default function InstallPrompt() {
  useEffect(() => {
    const localDev = process.env.NODE_ENV !== 'production'
      || window.location.hostname === 'localhost'
      || window.location.hostname === '127.0.0.1';

    // A service worker must never pin stale Next chunks during local UI work.
    // Remove registrations left by an earlier dev session as well as their
    // caches, so localhost always exercises the current source tree.
    if (localDev && 'serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(regs => {
        regs.forEach(reg => reg.unregister());
      }).catch(() => {});
      if ('caches' in window) {
        caches.keys().then(names => names.forEach(name => caches.delete(name))).catch(() => {});
      }
    }

    // Registering from the client, after load, so the SW never competes with
    // the first paint's chunk fetches.
    if (!localDev && 'serviceWorker' in navigator) {
      const register = () => {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
          /* SW is an enhancement; a failure here must never break the app */
        });
      };
      if (document.readyState === 'complete') register();
      else window.addEventListener('load', register, { once: true });
    }

    return () => {
      // The load listener is removed only when registration has not started.
      // The `{ once: true }` option handles the normal path for us.
    };
  }, []);

  return null;
}
