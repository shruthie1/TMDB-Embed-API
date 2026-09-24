import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { useNetworkStatus } from '../../lib/player/useNetworkStatus';

describe('useNetworkStatus', () => {
  afterEach(() => {
    window.dispatchEvent(new Event('online'));
  });

  it('tracks browser offline and online events', () => {
    const { result } = renderHook(() => useNetworkStatus());
    act(() => window.dispatchEvent(new Event('offline')));
    expect(result.current).toBe(false);
    act(() => window.dispatchEvent(new Event('online')));
    expect(result.current).toBe(true);
  });
});
