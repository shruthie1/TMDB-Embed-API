'use client';
import { useEffect, useState } from 'react';

/**
 * Owns browser connectivity state for the player. `navigator.onLine` is only
 * a coarse signal, but it is still useful feedback when a phone backgrounds
 * the tab or loses Wi-Fi; hls.js remains responsible for CDN-level recovery.
 */
export function useNetworkStatus() {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  return online;
}
