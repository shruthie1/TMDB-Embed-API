import { beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
vi.mock('../../lib/backend', () => ({ listSources: vi.fn() }));
import { listSources } from '../../lib/backend';
import useNetmirrorSources from '../../lib/player/useNetmirrorSources';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return {promise,resolve}; };
beforeEach(()=>vi.resetAllMocks());
it('checks once initially and per explicit continuation, preserving rows during failure', async () => {
  const partial=[{id:'mp4',incomplete:true}], complete=[{id:'mp4',incomplete:false},{id:'hls'}];
  listSources.mockResolvedValueOnce(partial).mockResolvedValueOnce(null).mockResolvedValueOnce(complete);
  const mergeSources=vi.fn();
  const {result}=renderHook(()=>useNetmirrorSources({hasStream:true,mediaType:'tv',tmdbId:1,season:2,episode:1,mergeSources}));
  await act(async()=>{});expect(mergeSources).toHaveBeenLastCalledWith(partial);
  await act(async()=>result.current.check());expect(mergeSources).toHaveBeenCalledTimes(1);
  await act(async()=>result.current.check());expect(mergeSources).toHaveBeenLastCalledWith(complete);
  expect(listSources).toHaveBeenCalledTimes(3);
  expect(listSources.mock.calls[2][2]).toMatchObject({provider:'netmirror',season:2,episode:1});
});
it('deduplicates clicks and aborts stale episode results before merging', async () => {
  const first=deferred(),next=deferred();listSources.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
  const mergeSources=vi.fn();
  const {result,rerender}=renderHook(({episode})=>useNetmirrorSources({hasStream:true,mediaType:'tv',tmdbId:1,season:2,episode,mergeSources}),{initialProps:{episode:1}});
  const oldSignal=listSources.mock.calls[0][2].signal;
  await act(async()=>result.current.check());expect(listSources).toHaveBeenCalledTimes(1);
  rerender({episode:2});expect(oldSignal.aborted).toBe(true);
  await act(async()=>first.resolve([{id:'wrong'}]));expect(mergeSources).not.toHaveBeenCalled();expect(result.current.loading).toBe(true);
  await act(async()=>next.resolve([{id:'correct'}]));expect(mergeSources).toHaveBeenCalledWith([{id:'correct'}]);expect(result.current.loading).toBe(false);
});
it('waits for playback and aborts explicit continuation on unmount', async () => {
  listSources.mockResolvedValueOnce([]);const pending=deferred();listSources.mockReturnValueOnce(pending.promise);
  const mergeSources=vi.fn();
  const {result,rerender,unmount}=renderHook(({hasStream})=>useNetmirrorSources({hasStream,mediaType:'movie',tmdbId:1,mergeSources}),{initialProps:{hasStream:false}});
  expect(listSources).not.toHaveBeenCalled();rerender({hasStream:true});await act(async()=>{});
  act(()=>{result.current.check();});const signal=listSources.mock.calls[1][2].signal;
  unmount();expect(signal.aborted).toBe(true);await act(async()=>pending.resolve([{id:'late'}]));expect(mergeSources).not.toHaveBeenCalled();
});
