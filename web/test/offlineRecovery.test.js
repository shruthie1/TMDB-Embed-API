import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { offlineAction, canFailOver, retryResumeAt } from '../lib/player/offlineRecovery';

describe('offlineAction', () => {
  it('retries everything when the error came from the outage', () => {
    expect(offlineAction({ online: true, error: 'x', errorWhileOffline: true })).toBe('retryAll');
  });
  it('only nudges playback when there is no error', () => {
    expect(offlineAction({ online: true, error: null })).toBe('nudge');
  });
  it('leaves an error that happened online alone', () => {
    expect(offlineAction({ online: true, error: 'x', errorWhileOffline: false })).toBe(null);
  });
  it('does nothing while still offline', () => {
    expect(offlineAction({ online: false })).toBe(null);
  });
});

describe('canFailOver', () => {
  it('never fails over while the browser is offline', () => {
    expect(canFailOver(false)).toBe(false);
  });
  it('fails over when online', () => {
    expect(canFailOver(true)).toBe(true);
  });
});

describe('retryResumeAt', () => {
  it('resumes where the viewer is, not the original start', () => {
    expect(retryResumeAt(1834.2, 1200)).toBe(1834.2);
  });
  it('uses the last played position when the element was reset', () => {
    expect(retryResumeAt(0, 1834.2)).toBe(1834.2);
  });
  it('nothing played: 0, so the player falls back to startAt', () => {
    expect(retryResumeAt(0, 0)).toBe(0);
    expect(retryResumeAt(undefined, undefined)).toBe(0);
  });
  it('retryAll in Player.jsx sets resumeAt from it', () => {
    const src = readFileSync(fileURLToPath(new URL('../components/Player.jsx', import.meta.url)), 'utf8');
    const body = src.slice(src.indexOf('const retryAll = useCallback'), src.indexOf('retryAllRef.current = retryAll'));
    expect(body).toMatch(/resumeAt\.current = retryResumeAt\(videoRef\.current\?\.currentTime, lastPlayedAtRef\.current\)/);
  });
});
