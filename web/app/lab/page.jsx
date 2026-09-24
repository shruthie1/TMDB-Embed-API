'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

const STATIC_TITLES = [
  {
    id: 'vishwanath-and-sons', title: 'Vishwanath and Sons', year: 2026,
    language: 'Telugu', playable: false,
    note: 'Metadata-only test record; no protected provider is connected.',
  },
  {
    id: 'demo-bunny', title: 'Big Buck Bunny', year: 2008,
    language: 'English', playable: true,
    note: 'Authorized public playback test asset.',
    playUrl: 'https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  },
];

/** Small local search/play smoke-test surface for the catalog. */
export default function LocalPlaybackLab() {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [attachedUrl, setAttachedUrl] = useState('');
  const [streamInput, setStreamInput] = useState('');
  const [playbackError, setPlaybackError] = useState('');
  const videoRef = useRef(null);
  const [pageUrl, setPageUrl] = useState('');
  const [pageState, setPageState] = useState({ loading: false, result: null, error: '' });
  const titles = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? STATIC_TITLES.filter(t => `${t.title} ${t.language} ${t.year}`.toLowerCase().includes(q)) : [];
  }, [query]);

  const activeUrl = selected?.playUrl || attachedUrl;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeUrl) return undefined;
    let hls;
    let cancelled = false;
    setPlaybackError('');
    const isHls = /\.m3u8(?:$|[?#])/i.test(activeUrl);
    if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
      import('hls.js').then(({ default: Hls }) => {
        if (cancelled || !Hls.isSupported()) return;
        hls = new Hls({ enableWorker: true });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data?.fatal) setPlaybackError('The attached HLS stream could not be loaded. Check its URL and access policy.');
        });
        hls.loadSource(activeUrl);
        hls.attachMedia(video);
      }).catch(() => setPlaybackError('HLS playback support could not be loaded.'));
    } else {
      video.src = activeUrl;
    }
    return () => {
      cancelled = true;
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [activeUrl]);

  function selectTitle(title) {
    setSelected(title);
    setAttachedUrl(title.playUrl || '');
    setStreamInput('');
    setPlaybackError('');
  }

  function attachStream(event) {
    event.preventDefault();
    try {
      const parsed = new URL(streamInput.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) URLs are supported.');
      setAttachedUrl(parsed.href);
      setPlaybackError('');
    } catch (error) {
      setPlaybackError(error.message || 'Enter a valid authorized stream URL.');
    }
  }

  async function analyzePage(event) {
    event.preventDefault();
    setPageState({ loading: true, result: null, error: '' });
    try {
      const response = await fetch(`/api/lab/page?url=${encodeURIComponent(pageUrl.trim())}`);
      const result = await response.json();
      setPageState(result.ok ? { loading: false, result, error: '' }
        : { loading: false, result: null, error: result.error || 'Page analysis failed' });
    } catch (error) {
      setPageState({ loading: false, result: null, error: error.message });
    }
  }

  return (
    <div className="search-page lab-shell">
      <div className="lab-hero">
        <div>
          <div className="eyebrow">Local playback lab</div>
          <h1 className="page-title">Search and play</h1>
          <p className="search-summary">
            A separate visual POC for catalog search, source inspection, and playback.
          </p>
        </div>
        <div className="lab-status"><span className="lab-status-dot" /> Local only</div>
      </div>

      <div className="lab-search-wrap">
        <div className="search-field">
          <span className="lab-search-mark" aria-hidden="true">⌕</span>
        <input
          className="search-input"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search a movie or series"
          aria-label="Search a movie or series"
          autoFocus
        />
          {query && <button type="button" className="lab-clear" onClick={() => setQuery('')} aria-label="Clear search">×</button>}
        </div>
        <p className="lab-search-hint">Try “vishwa”, “telugu”, or “bunny”</p>
      </div>

      {query.trim() && <p className="lab-result-count">{titles.length} {titles.length === 1 ? 'result' : 'results'}</p>}

      {query.trim() && titles.length > 0 && (
        <section className="lab-results" aria-label="Search results">
          {titles.map(title => (
            <button
              key={title.id}
              className={`lab-result-card${selected?.id === title.id ? ' is-selected' : ''}`}
              type="button"
              onClick={() => selectTitle(title)}
            >
              <div className={`lab-art lab-art-${title.id}`} aria-hidden="true">
                <span>{title.id === 'demo-bunny' ? 'BB' : 'VS'}</span>
              </div>
              <span className="lab-result-copy">
                <strong>{title.title}</strong>
                <span>{title.year} · {title.language}</span>
                <em>{title.playable ? 'Ready to play' : 'Metadata only'}</em>
              </span>
              <span className="lab-result-arrow" aria-hidden="true">›</span>
            </button>
          ))}
        </section>
      )}

      <form onSubmit={analyzePage} style={{ marginTop: 18 }}>
        <label className="lab-section-label" htmlFor="source-page">Source inspection</label>
        <div className="search-field">
          <input
            id="source-page"
            className="search-input"
            value={pageUrl}
            onChange={event => setPageUrl(event.target.value)}
            placeholder="https://…/movie-page.html"
          />
          <button className="button focusable" data-focus="" type="submit" disabled={!pageUrl.trim() || pageState.loading}>
            {pageState.loading ? 'Checking…' : 'Analyze'}
          </button>
        </div>
      </form>
      {pageState.error && <p className="error-copy">{pageState.error}</p>}
      {pageState.result?.metadata && (
        <section className="lab-inspector" aria-live="polite">
          <div className="lab-inspector-head"><h2>Source metadata</h2><span>{pageState.status}</span></div>
          <p className="lab-inspector-title">{pageState.result.metadata.title || 'Untitled'}</p>
          <p className="search-summary">
            Language: {pageState.result.metadata.language || 'not detected'} ·
            {' '}{pageState.result.metadata.audioMode}
          </p>
          <p className="search-summary">
            Evidence: {pageState.result.metadata.languageEvidence.join(', ') || 'none'}
          </p>
        </section>
      )}

      {query.trim() && !titles.length && (
        <div className="lab-empty"><strong>No local match</strong><span>Try a shorter title or inspect a source page below.</span></div>
      )}

      {selected && (
        <section className="lab-player" aria-live="polite">
          <div className="lab-player-head">
            <div><div className="eyebrow">Selected title</div><h2>{selected.title}</h2></div>
            <button type="button" className="lab-close" onClick={() => setSelected(null)}>Close</button>
          </div>
          <p className="search-summary">{selected.note}</p>
          {activeUrl ? (
            <>
              <div className="lab-video-frame"><video ref={videoRef} controls playsInline preload="metadata" /></div>
              {playbackError && <p className="error-copy">{playbackError}</p>}
            </>
          ) : (
            <div className="lab-unavailable"><span className="lab-unavailable-icon">◌</span><div><strong>Playback unavailable</strong><p>This record confirms Telugu page metadata, but no authorized playable stream is connected to the lab.</p></div></div>
          )}
          {!selected.playable && !activeUrl && (
            <form className="lab-attach" onSubmit={attachStream}>
              <label htmlFor="authorized-stream">Attach an authorized MP4 or HLS URL</label>
              <div className="search-field">
                <input id="authorized-stream" className="search-input" value={streamInput} onChange={event => setStreamInput(event.target.value)} placeholder="https://…/master.m3u8" />
                <button className="button focusable" data-focus="" type="submit" disabled={!streamInput.trim()}>Play</button>
              </div>
              <p>This stays in the browser and does not send cookies or proxy the stream.</p>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
