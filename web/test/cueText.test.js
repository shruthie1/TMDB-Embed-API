import { describe, it, expect } from 'vitest';
import { parseCueText } from '../lib/player/useCueOverlay';

const flat = (t) => parseCueText(t).map(l => l.map(s => s.text).join(''));

describe('parseCueText', () => {
  it('renders italics as emphasis instead of printing the tags', () => {
    // The bug a screenshot caught: painting cue text as a plain string put
    // "<i>What if they get hungry</i>" on screen, literally.
    const lines = parseCueText('<i>What if they get hungry</i>\nand you\'re not there?');
    expect(lines[0]).toEqual([{ text: 'What if they get hungry', i: true, b: false }]);
    expect(lines[1]).toEqual([{ text: "and you're not there?", i: false, b: false }]);
  });

  it('handles emphasis that starts mid-line', () => {
    const [line] = parseCueText('He said <i>quietly</i> then left');
    expect(line.map(s => [s.text, s.i])).toEqual([
      ['He said ', false], ['quietly', true], [' then left', false],
    ]);
  });

  it('keeps bold separate from italic', () => {
    const [line] = parseCueText('<b>LOUD</b> and <i>soft</i>');
    expect(line.filter(s => s.b).map(s => s.text)).toEqual(['LOUD']);
    expect(line.filter(s => s.i).map(s => s.text)).toEqual(['soft']);
  });

  it('drops markup that has nothing to show', () => {
    // Speaker names are audible; karaoke timestamps and class tags are noise.
    expect(flat('<v Alice>Hello there</v>')).toEqual(['Hello there']);
    expect(flat('<00:01:02.500><c.yellow>styled</c>')).toEqual(['styled']);
    expect(flat('<ruby>x<rt>y</rt></ruby>')).toEqual(['xy']);
  });

  it('decodes the entities a subtitle actually contains', () => {
    expect(flat('A &amp; B')).toEqual(['A & B']);
    expect(flat('&lt;not a tag&gt;')).toEqual(['<not a tag>']);
  });

  it('survives unbalanced tags rather than losing the line', () => {
    // Real files are not always well formed.
    expect(flat('<i>unclosed italic')).toEqual(['unclosed italic']);
    expect(flat('stray </i> close')).toEqual(['stray  close']);
  });

  it('returns an empty structure for empty text', () => {
    expect(parseCueText('')).toEqual([[]]);
  });
});
