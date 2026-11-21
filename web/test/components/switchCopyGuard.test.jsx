import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Task 6 (2026-11-21): honest switch copy and the loading-screen pick guard.
// No test mounts Player.jsx (hls.js, resolve, recovery, a video element), so
// the wiring is guarded in the source text, like languagePickNoPair.
const text = readFileSync(resolve(__dirname, '../../components/Player.jsx'), 'utf8');
const bodyOf = (decl) => {
  const start = text.indexOf(decl);
  return { start, body: text.slice(start, text.indexOf('}, [', start)),
    deps: text.slice(text.indexOf('}, [', start), text.indexOf(']);', start)) };
};

describe('Player wiring: loading-screen pick and switch copy', () => {
  it('pickFromLoading goes through pickSource (switchGuard), never switchSource directly', () => {
    const { start, body, deps } = bodyOf('const pickFromLoading = useCallback(');
    expect(start).toBeGreaterThan(-1);
    expect(body).toMatch(/pickSource\(src\)/);
    expect(body).not.toMatch(/switchSource\(/);
    // A switch still being judged is ended first, or pickSource would refuse
    // the viewer's pick with "Still switching to …".
    expect(body).toMatch(/if \(srcSwitch\.current\) endSourceSwitch\(\)/);
    expect(deps).toMatch(/\bpickSource\b/);
    expect(start).toBeGreaterThan(bodyOf('const pickSource = useCallback(').start);
  });

  it('a manual pick marks the switch as asked; an automatic advance does not', () => {
    const ps = bodyOf('const pickSource = useCallback(').body;
    expect(ps).toMatch(/asked: true/);
    const ss = bodyOf('const switchSource = useCallback(').body;
    expect(ss).toMatch(/Boolean\(opts\.asked\)/);
    const start = bodyOf('const startSourceSwitch = useCallback(').body;
    expect(start).toMatch(/setSwitchAsked\(Boolean\(asked\)\)/);
    expect(bodyOf('const endSourceSwitch = useCallback(').body).toMatch(/setSwitchAsked\(false\)/);
    // failSwitch's advance passes no `asked`.
    expect(text).toMatch(/switchSourceRef\.current\?\.\(alt, m\.ctx\.strictLanguage \? m\.ctx\.lang : null, \{ at: m\.at, ctx: m\.ctx \}\)/);
  });

  it('the loading card is told when a viewer-asked switch is in flight', () => {
    const start = text.indexOf('const loadView = useMemo(');
    const lv = text.slice(start, text.indexOf(']);', start));
    expect(start).toBeGreaterThan(-1);
    expect(lv).toMatch(/switching: switchAsked/);
    expect(lv.slice(lv.indexOf('}), ['))).toMatch(/\bswitchAsked\b/);
  });

  it('a mid-film failure of the playing source says "stopped", not "didn\'t start"', () => {
    expect(text).toMatch(/action\.kind === 'novideo' \|\| action\.kind === 'codecs', true\)\)/);
  });

  it('no viewer-facing line in Player.jsx calls a server slow', () => {
    // Comments may discuss slowness; a notice must not claim it.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/is slow\. Trying|source slow|server slow/i);
  });

  // Fix round 1.
  it('a viewer pick closes the row being left as LEFT, not as a failure', () => {
    const b = bodyOf('const beginAttempt = useCallback(').body;
    expect(b).toMatch(/if \(asked\) closeAttempt\(null, RowState\.LEFT\)/);
    expect(bodyOf('const startSourceSwitch = useCallback(').body).toMatch(/beginAttempt\(src\?\.id, asked\)/);
    expect(bodyOf('const closeAttempt = useCallback(').body).toMatch(/state === RowState\.LEFT \? null/);
  });

  it('before the first frame the guard has nothing to restore', () => {
    const snap = bodyOf('const snapshot = useCallback(').body;
    expect(snap).toMatch(/stream && framedOnceRef\.current \?/);
    expect(bodyOf('const pickSource = useCallback(').body).toMatch(/switchGuard\.begin\(snapshot\(\)/);
  });

  it('an Audio-menu substitute pick is a viewer-asked switch', () => {
    const pp = bodyOf('const pickPair = useCallback(').body;
    expect(pp).toMatch(/switchSource\(plan\.audio\?\.source, null, \{ asked: true \}\)/);
  });

  it('a title or episode change ends a switch still in flight', () => {
    expect(text).toMatch(/useEffect\(\(\) => \{ endSourceSwitch\(\); \}, \[titleKey, endSourceSwitch\]\)/);
  });
});
