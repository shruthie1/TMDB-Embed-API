import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

// C3: the Cast button in the player controls. Phone only; the player decides
// that and passes `cast` (null elsewhere), so the control just obeys the prop.

vi.mock('../../components/Icon', () => ({ default: () => null }));
window.matchMedia = (q) => ({
  matches: true, media: q,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});

const { default: PlayerControls } = await import('../../components/PlayerControls');

afterEach(cleanup);

function setup(props = {}) {
  const video = document.createElement('video');
  return render(<PlayerControls videoRef={{ current: video }} title="Devara" {...props} />);
}

describe('Cast button', () => {
  it('is absent without a cast prop (desktop, TV)', () => {
    const { queryByLabelText } = setup();
    expect(queryByLabelText('Cast to TV')).toBeNull();
  });

  it('is absent on the TV layout even with a cast prop', () => {
    const { queryByLabelText } = setup({ tv: true, cast: { prepare: vi.fn() } });
    expect(queryByLabelText('Cast to TV')).toBeNull();
  });

  it('prepares the cast, then offers the WVC link to open', async () => {
    const href = 'intent://h/cast/x.m3u8#Intent;scheme=https;package=com.instantbits.cast.webvideo;end';
    const prepare = vi.fn(async () => ({ href, audio: { language: 'tel', name: 'Telugu' } }));
    const { getByLabelText, findByText } = setup({ cast: { prepare } });
    fireEvent.click(getByLabelText('Cast to TV'));
    expect(prepare).toHaveBeenCalledTimes(1);
    const open = await findByText(/Open Web Video Caster/);
    expect(open.closest('a').getAttribute('href')).toBe(href);
  });

  it('shows the reason when the server refuses', async () => {
    const prepare = vi.fn(async () => { throw new Error('not pairable'); });
    const { getByLabelText, findByText } = setup({ cast: { prepare } });
    fireEvent.click(getByLabelText('Cast to TV'));
    await findByText(/not pairable/);
    await waitFor(() => expect(getByLabelText('Cast to TV').disabled).toBe(false));
  });
  it('says WVC is missing when Chrome comes back with #cast-no-wvc (no Play Store)', async () => {
    window.history.replaceState(null, '', '/title/movie/1#cast-no-wvc');
    const { findByText } = setup({ cast: { prepare: vi.fn() } });
    await findByText(/Web Video Caster is not installed/);
    expect(window.location.hash).toBe('');
  });

  it('shows the missing-WVC note on a hash change too', async () => {
    window.history.replaceState(null, '', '/title/movie/1');
    const { findByText } = setup({ cast: { prepare: vi.fn() } });
    window.history.replaceState(null, '', '/title/movie/1#cast-no-wvc');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await findByText(/Web Video Caster is not installed/);
  });

  it('shows no "Chrome asks" hint next to the intent link (owner 2026-11-22)', async () => {
    const prepare = vi.fn(async () => ({ href: 'intent://h#Intent;end' }));
    const { getByLabelText, findByText, queryByText } = setup({ cast: { prepare } });
    fireEvent.click(getByLabelText('Cast to TV'));
    await findByText(/Open Web Video Caster/);
    expect(queryByText(/Chrome asks/)).toBeNull();
  });
});
