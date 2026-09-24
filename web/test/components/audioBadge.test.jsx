import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import AudioMenu from '../../components/player/AudioMenu';
import { initialAudioTrack } from '../../lib/player/useHls';

// Regression: switching server appeared to "move to Hindi".
//
// Two separate causes, both measured on movie/1408162 (2026-09-22):
//   1. the badge fell back to audioTracks[0] when nothing was selected, and
//      element 0 is a language from ANOTHER provider, not what is playing;
//   2. the viewer's chosen language was dropped on a source switch, because
//      initialAudioTrack only ever saw the build-time default.
describe('audio language survives a server switch', () => {
  it('does not name a language when none is known to be selected', () => {
    // showsst ships languages:[] - the merged list is entirely other-provider
    // languages, so naming the first one claims audio this stream may not have.
    render(<AudioMenu audioTracks={[{ id: 'src:a:Hindi', name: 'Hindi' },
                                    { id: 'src:b:Telugu', name: 'Telugu' }]}
                      currentAudio={null} open={false} />);
    const btn = document.querySelector('.pctl-pick-btn');
    expect(btn.getAttribute('aria-label')).toContain('Default');
    expect(btn.getAttribute('aria-label')).not.toContain('Hindi');
  });

  it('names the language that is actually selected', () => {
    const { container } = render(
      <AudioMenu audioTracks={[{ id: 0, name: 'Hindi' }, { id: 1, name: 'Telugu' }]}
                 currentAudio={1} open={false} />);
    const btn = container.querySelector('.pctl-pick-btn');
    expect(btn.getAttribute('aria-label')).toContain('Telugu');
  });

  it('honours the viewer language over the manifest DEFAULT flag', () => {
    // CastleTV marks Hindi DEFAULT=YES. A viewer who picked Telugu must not
    // be handed Hindi again by the next source.
    const tracks = [{ lang: 'hin', name: 'Hindi', default: true },
                    { lang: 'tel', name: 'Telugu' }];
    expect(initialAudioTrack(tracks, 'Telugu')).toBe(1);
    expect(initialAudioTrack(tracks, 'tel')).toBe(1);
  });

  it('falls back to DEFAULT when the wanted language is absent', () => {
    const tracks = [{ lang: 'hin', name: 'Hindi' }, { lang: 'tam', name: 'Tamil', default: true }];
    expect(initialAudioTrack(tracks, 'Telugu')).toBe(1);
  });
});
