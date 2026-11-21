import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Loading } from '../../components/player/overlays';
import { loadingView, labelRows, RowState, Reason, CHECK_SERVER } from '../../lib/player/loadingModel';

// Loading-ux spec section 8, web case 2: the overlay drawn from the model.
const list = [
  { id: 'c1', provider: 'CastleTV', quality: '1080p', languages: ['Telugu'], masterUrl: 'u1' },
  { id: 'c2', provider: 'CastleTV', quality: '1080p', languages: ['Telugu'], masterUrl: 'u2' },
  { id: 'o1', provider: 'OneTouchTV', quality: '720p', languages: ['Telugu'], masterUrl: 'u3' },
];
const searching = (now) => loadingView({
  now, playAt: 0, title: 'Devara Part 1', sources: null, labels: {}, attempts: [],
  checks: [{ id: CHECK_SERVER, label: 'Chitram server', startedAt: 0 }],
});
const starting = (now) => loadingView({
  now, playAt: 0, title: 'Devara Part 1', sources: list, labels: labelRows({}, list),
  firstListSize: 3, framed: false,
  attempts: [{ id: 'c1', startedAt: 1000, endedAt: 21000, state: RowState.FAILED, reason: Reason.NO_PICTURE },
             { id: 'c2', startedAt: 21000, endedAt: null, state: RowState.STARTING }],
});

const mount = (view, props = {}) => render(
  <Loading view={view} title="Devara Part 1" onClose={() => {}} onRetry={() => {}} {...props} />);

afterEach(cleanup);

describe('Loading overlay', () => {
  it('only the headline sits in the polite live region', () => {
    const { container } = mount(starting(34000));
    const live = container.querySelectorAll('[aria-live="polite"]');
    expect(live.length).toBe(1);
    expect(live[0].getAttribute('aria-atomic')).toBe('true');
    expect(live[0].textContent).toBe("CastleTV 1 didn't start. Trying CastleTV 2.");
    expect(container.querySelector('.ov-load-detail').textContent).toBe('Telugu · 1080p · 2 of 3 tried');
  });

  it('no Try again at 8s and 29s; present at 30s with no list', () => {
    for (const t of [8000, 29000]) {
      const { container, unmount } = mount(searching(t));
      expect(container.textContent).not.toMatch(/Try again/);
      unmount();
    }
    const { getByText } = mount(searching(30000));
    expect(getByText('Try again')).toBeTruthy();
  });

  it('Try again calls onRetry', () => {
    const onRetry = vi.fn();
    const { getByText } = mount(searching(31000), { onRetry });
    fireEvent.click(getByText('Try again'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('the 15s hint replaces the plain line, no Try again yet', () => {
    const { container } = mount(searching(16000));
    expect(container.textContent).toMatch('Still finding sources…');
    expect(container.textContent).toMatch('First play of a title can take up to a minute.');
    expect(container.textContent).not.toMatch(/Try again/);
  });

  it('Details is a button with aria-expanded; rows are buttons with full text', () => {
    const { container, getByRole } = mount(starting(34000));
    const btn = getByRole('button', { name: /Details/ });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-controls')).toBe('load-rows');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const rows = container.querySelectorAll('#load-rows li button');
    expect(rows.length).toBe(3);
    expect(rows[0].getAttribute('aria-label'))
      .toBe('CastleTV 1, Telugu, 1080p, failed: no picture in 20 seconds · 20 seconds');
    expect(rows[0].textContent).toMatch('Failed: no picture in 20s');
    expect(rows[1].textContent).toMatch('Starting… 13s');
    expect(container.querySelector('.ov-load-footer').textContent).toBe('Started 34s ago · 2 of 3 tried');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('clicking a waiting row calls onPick(id); the starting row is not clickable', () => {
    const onPick = vi.fn();
    const { container, getByRole } = mount(starting(34000), { onPick });
    fireEvent.click(getByRole('button', { name: /Details/ }));
    const rows = container.querySelectorAll('#load-rows li button');
    fireEvent.click(rows[1]);
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(rows[2]);
    expect(onPick).toHaveBeenCalledWith('o1');
  });

  it('Choose a server at 30s opens Details and focuses the first waiting row', () => {
    const { container, getByText, getByRole } = mount(starting(34000));
    expect(container.textContent).not.toMatch(/Try again/);
    fireEvent.click(getByText('Choose a server'));
    expect(getByRole('button', { name: /Details/ }).getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement.getAttribute('data-row')).toBe('o1');
  });

  it('no Choose a server before 30s', () => {
    const { container } = mount(starting(29000));
    expect(container.textContent).not.toMatch(/Choose a server/);
  });

  it('the spinner is hidden from screen readers', () => {
    const { container } = mount(searching(1000));
    expect(container.querySelector('.ov-spinner').getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('TV: focus starts on Details and does not move when the chooser appears', () => {
    document.documentElement.dataset.tv = 'true';
    try {
      const { getByRole, rerender } = mount(starting(4000));
      const details = getByRole('button', { name: /Details/ });
      expect(document.activeElement).toBe(details);
      rerender(<Loading view={starting(31000)} title="Devara Part 1" onClose={() => {}} />);
      expect(document.activeElement).toBe(details);
    } finally { delete document.documentElement.dataset.tv; }
  });
});
