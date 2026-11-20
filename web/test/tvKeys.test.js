import { describe, it, expect, vi } from 'vitest';
import { isVidaa, mediaKeyAction, backAction, exitApp, isTyping } from '../lib/tvKeys';

/**
 * Hisense VIDAA remote keys. The browser (Odin, a Chromium build) sends Back
 * as Backspace and the media keys as bare keyCodes, often with key
 * "Unidentified", so the keyCode has to be read as well as the key name.
 */

const VIDAA_UA = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/111.0.5563.146 Odin/111.5563.5.1 Safari/537.36 VIDAA/9.0(Hisense;SmartTV;65A60LXVT;;)';

describe('isVidaa', () => {
  it('matches the Odin browser and the VIDAA / Hisense tokens', () => {
    expect(isVidaa(VIDAA_UA)).toBe(true);
    expect(isVidaa('Mozilla/5.0 Chrome/88.0 Odin/88.4324.3.0 Safari/537.36')).toBe(true);
    expect(isVidaa('Mozilla/5.0 Chrome/74 Safari/537.36 vidaa/6.0')).toBe(true);
  });
  it('does not match other TVs, where Back on home must not close the browser', () => {
    for (const ua of [
      'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36',
      'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36',
      'Mozilla/5.0 (Linux; Android 10; Android TV) AppleWebKit/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      '',
    ]) expect(isVidaa(ua), ua).toBe(false);
  });
});

describe('mediaKeyAction', () => {
  it('maps the VIDAA keyCodes', () => {
    const k = (keyCode) => mediaKeyAction({ key: 'Unidentified', keyCode });
    expect(k(415)).toBe('play');
    expect(k(19)).toBe('pause');
    expect(k(413)).toBe('stop');
    expect(k(417)).toBe('forward');
    expect(k(412)).toBe('rewind');
    expect(k(179)).toBe('toggle');
  });
  it('maps the standard key names', () => {
    const k = (key) => mediaKeyAction({ key, keyCode: 0 });
    expect(k('MediaPlayPause')).toBe('toggle');
    expect(k('MediaPlay')).toBe('play');
    expect(k('MediaPause')).toBe('pause');
    expect(k('MediaStop')).toBe('stop');
    expect(k('MediaFastForward')).toBe('forward');
    expect(k('MediaRewind')).toBe('rewind');
  });
  it('ignores ordinary keys', () => {
    for (const [key, keyCode] of [['ArrowLeft', 37], ['Enter', 13], [' ', 32], ['Backspace', 8], ['k', 75]]) {
      expect(mediaKeyAction({ key, keyCode }), key).toBe(null);
    }
    expect(mediaKeyAction(null)).toBe(null);
  });
});

describe('backAction', () => {
  const base = { key: 'Backspace', keyCode: 8, tv: true, typing: false,
                 playerOpen: false, dialogOpen: false, pathname: '/title/movie/1', vidaa: false };
  it('goes back a page on a TV', () => {
    expect(backAction(base)).toBe('back');
    expect(backAction({ ...base, key: 'Unidentified' })).toBe('back');
  });
  it('closes an open overlay first, like Escape', () => {
    expect(backAction({ ...base, dialogOpen: true })).toBe('escape');
    expect(backAction({ ...base, dialogOpen: true, pathname: '/', vidaa: true })).toBe('escape');
  });
  it('exits on the home page only on VIDAA', () => {
    expect(backAction({ ...base, pathname: '/', vidaa: true })).toBe('exit');
    expect(backAction({ ...base, pathname: '/', vidaa: false })).toBe(null);
  });
  it('leaves Backspace alone off-TV, while typing, and in the player', () => {
    expect(backAction({ ...base, tv: false })).toBe(null);
    expect(backAction({ ...base, typing: true })).toBe(null);
    expect(backAction({ ...base, playerOpen: true })).toBe(null);
  });
  it('ignores other keys', () => {
    expect(backAction({ ...base, key: 'Escape', keyCode: 27 })).toBe(null);
    expect(backAction({ ...base, key: 'ArrowLeft', keyCode: 37 })).toBe(null);
  });
});

describe('exitApp', () => {
  it('prefers Hisense_Exit when the TV provides it', () => {
    const w = { Hisense_Exit: vi.fn(), close: vi.fn() };
    exitApp(w);
    expect(w.Hisense_Exit).toHaveBeenCalledOnce();
    expect(w.close).not.toHaveBeenCalled();
  });
  it('falls back to window.close', () => {
    const w = { close: vi.fn() };
    exitApp(w);
    expect(w.close).toHaveBeenCalledOnce();
  });
});

describe('isTyping', () => {
  it('is true only for text fields', () => {
    expect(isTyping({ tagName: 'INPUT' })).toBe(true);
    expect(isTyping({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTyping({ tagName: 'BUTTON' })).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});
