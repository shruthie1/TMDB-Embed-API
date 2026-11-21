import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { advanceNotice, Copy } from '../lib/player/loadingModel';

// Final-review I2 (2026-11-21): a language pick landed on a server that plays,
// but without that language. Its picture was on screen, so "didn't start" and
// "stopped" are both untrue.
describe('no-language notice', () => {
  it('Copy.noLanguage names the server, the language and the next server', () => {
    expect(Copy.noLanguage('CastleTV 1', 'Telugu', 'NetMirror')).toBe('CastleTV 1 has no Telugu audio. Trying NetMirror.');
  });
  it('advanceNotice uses it when a language is missing, ahead of stopped/didn\'t start', () => {
    expect(advanceNotice('A', 'B', false, false, 'Telugu')).toBe('A has no Telugu audio. Trying B.');
    expect(advanceNotice('A', 'B', false, true, 'Telugu')).toBe('A has no Telugu audio. Trying B.');
    expect(advanceNotice(null, null, false, false, 'Telugu')).toBe('That server has no Telugu audio. Trying the next server.');
    expect(advanceNotice('A', 'B')).toBe("A didn't start. Trying B.");
  });
  it('has no dash, no "!" and no "slow"', () => {
    expect(Copy.noLanguage('A', 'Telugu', 'B')).not.toMatch(/[–—!]|slow/i);
  });
  it('Player.jsx passes the missing language from the audio-missing path to the notice', () => {
    const text = readFileSync(resolve(__dirname, '../components/Player.jsx'), 'utf8');
    expect(text).toMatch(/failSwitchRef\.current\?\.\(`\$\{pending\.ctx\.lang\} audio missing`, null, pending\.ctx\.lang\)/);
    expect(text).toMatch(/failSwitchRef\.current = \(reason, uiReason = null, missingLang = null\) =>/);
    expect(text).toMatch(/attemptsRef\.current\[attemptsRef\.current\.length - 1\]\?\.reason === Reason\.UNSUPPORTED, false, missingLang\)/);
  });
});
