/* Chitram OTT — watch/detail page.
 * Loads TMDB metadata via /api/search (there is no /api/details endpoint;
 * see report), then fetches streams via /api/streams/:type/:id and wires
 * playback through hls.js with per-stream custom headers, external subtitle
 * <track> elements and an audio-track/language menu — same behaviour the
 * old player.js had, now driving the shared custom control bar.
 */
(function () {
  const { esc, streams: fetchStreams, search: apiSearch, showToast } = window.ChitramAPI;
  const { createPlayer } = window.ChitramPlayer;

  const els = {
    backdrop: document.getElementById('backdropSection'),
    headerSection: document.getElementById('headerSection'),
    overview: document.getElementById('overview'),
    playerShell: document.getElementById('playerShell'),
    video: document.getElementById('video'),
    empty: document.getElementById('videoEmpty'),
    loading: document.getElementById('videoLoading'),
    error: document.getElementById('videoError'),
    now: document.getElementById('nowPlaying'),
    details: document.getElementById('nowDetails'),
    subtitle: document.getElementById('subtitleNote'),
    timingStrip: document.getElementById('timingStrip'),
    streamCount: document.getElementById('streamCount'),
    streamGroups: document.getElementById('streamGroups'),
  };

  const params = new URLSearchParams(location.search);
  const type = params.get('type') === 'series' ? 'series' : 'movie';
  const id = params.get('id');
  const titleParam = params.get('title') || '';

  let hls = null;
  let player = null;
  let currentStreams = [];
  let currentIndex = -1;

  function streamLabel(stream) { return stream.name || stream.title || stream.provider || 'Stream'; }
  function languageFromLabel(stream) { const m = streamLabel(stream).match(/\[([^\]]+)\]/); return m ? m[1] : ''; }
  // A proxied playlist is `/m3u8-proxy?url=<encoded>`, so the `.m3u8` lives
  // inside the query string percent-encoded and a plain extension test misses
  // it. hls.js then never starts and the <video> element is handed a playlist
  // it cannot decode, which shows up as a player stuck on "Loading stream...".
  // Decode the wrapper and check the proxy route as well as the extension.
  function isHlsUrl(url) {
    const raw = String(url || '');
    if (/\.m3u8(?:$|\?)/i.test(raw)) return true;
    if (/\/m3u8-proxy(?:$|\?)/i.test(raw)) return true;
    try { return /\.m3u8(?:$|\?|&)/i.test(decodeURIComponent(raw)); } catch (_) { return false; }
  }

  function renderBackdropSkeleton() {
    els.backdrop.innerHTML = `<div class="watch-backdrop skel skel-hero"></div>`;
    els.headerSection.innerHTML = `
      <div class="watch-header">
        <div class="watch-poster skel"></div>
        <div class="watch-title-block"><h1>${esc(titleParam || 'Loading…')}</h1></div>
      </div>`;
  }

  function renderMeta(item) {
    const backdrop = item && (item.backdrop || item.poster);
    els.backdrop.innerHTML = `
      <div class="watch-backdrop">${backdrop ? `<img src="${esc(backdrop)}" alt="">` : ''}<div class="hero-scrim"></div></div>`;
    els.headerSection.innerHTML = `
      <div class="watch-header">
        <div class="watch-poster">${item && item.poster ? `<img src="${esc(item.poster)}" alt="">` : ''}</div>
        <div class="watch-title-block">
          <h1>${esc((item && item.title) || titleParam || 'Untitled')}</h1>
          <div class="hero-meta">
            <span class="badge">${esc(type === 'series' ? 'Series' : 'Movie')}</span>
            ${item && item.year ? `<span class="badge">${esc(item.year)}</span>` : ''}
            ${item && item.rating && Number(item.rating) > 0 ? `<span class="badge rating">★ ${esc(Number(item.rating).toFixed(1))}</span>` : ''}
          </div>
        </div>
      </div>`;
    if (item && item.overview) { els.overview.hidden = false; els.overview.textContent = item.overview; }
  }

  async function loadMeta() {
    if (!titleParam) return null;
    try {
      const data = await apiSearch(titleParam, type);
      const results = data.results || [];
      return results.find(r => String(r.id) === String(id)) || results[0] || null;
    } catch (e) {
      console.warn('[watch] metadata lookup failed', e);
      return null;
    }
  }

  function renderTimings(timings) {
    if (!timings) { els.timingStrip.innerHTML = ''; return; }
    els.timingStrip.innerHTML = Object.entries(timings)
      .sort((a, b) => a[1] - b[1])
      .map(([name, ms]) => `<span>${esc(name)} · ${ms}ms</span>`).join('');
  }

  function groupStreams(list) {
    const groups = new Map();
    list.forEach((s, i) => {
      const key = s.provider || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...s, _index: i });
    });
    return groups;
  }

  function renderStreamGroups(list) {
    els.streamCount.textContent = list.length;
    if (!list.length) {
      els.streamGroups.innerHTML = `<div class="state-block">
        <div class="state-icon">&#128561;</div>
        <h3>No streams found</h3>
        <p>None of the enabled providers returned a playable link for this title. Try again later or check provider status.</p>
      </div>`;
      return;
    }
    const groups = groupStreams(list);
    els.streamGroups.innerHTML = Array.from(groups.entries()).map(([provider, items]) => `
      <div class="stream-group">
        <div class="stream-group-head"><h3>${esc(provider)}</h3><span class="badge">${items.length}</span></div>
        <div class="stream-list">
          ${items.map((s) => {
            const lang = languageFromLabel(s);
            const subs = Array.isArray(s.subtitles) ? s.subtitles.length : 0;
            return `<button class="stream-item" data-index="${s._index}" type="button">
              <div class="stream-title">${esc(streamLabel(s))}</div>
              <div class="stream-tags">
                <span class="badge">${esc(s.quality || 'Auto')}</span>
                ${lang ? `<span class="badge">${esc(lang)}</span>` : ''}
                ${subs ? `<span class="badge">${subs} subtitle${subs === 1 ? '' : 's'}</span>` : ''}
              </div>
            </button>`;
          }).join('')}
        </div>
      </div>`).join('');
  }

  function clearTracks() {
    els.video.querySelectorAll('track').forEach(t => t.remove());
    els.subtitle.textContent = '';
  }

  function addExternalSubtitles(stream) {
    const subtitles = Array.isArray(stream.subtitles) ? stream.subtitles : [];
    subtitles.forEach((sub, i) => {
      if (!sub || !sub.url) return;
      const track = document.createElement('track');
      track.kind = 'subtitles'; track.src = sub.url;
      track.srclang = (sub.lang || 'und').slice(0, 2);
      track.label = sub.label || sub.language || sub.lang || `Subtitle ${i + 1}`;
      track.default = i === 0;
      els.video.appendChild(track);
    });
    if (subtitles.length) els.subtitle.textContent = `${subtitles.length} subtitle track${subtitles.length === 1 ? '' : 's'} available — use the subtitle control in the player menu bar.`;
  }

  // When the manifest itself declares 2+ audio renditions (real
  // `#EXT-X-MEDIA:TYPE=AUDIO` entries hls.js parsed out), that is ground
  // truth for what this playing stream can actually do — switching audio
  // is a `hls.audioTrack = n` call, no reload. The per-stream/API-array
  // list becomes noise in that case (it doesn't describe alternate audio
  // for the manifest that's actually loaded), so it's dropped entirely.
  //
  // Threshold is 2, not 1: a manifest with exactly one declared audio
  // rendition offers no real choice, so it reads the same as "none".
  //
  // When the manifest declares no switchable audio the menu says so rather
  // than listing the API's stream array. Those rows are separate provider
  // URLs, not audio tracks of what is playing: presenting them as an audio
  // menu told the user they could change language when picking one actually
  // swapped the whole stream, and on a title whose entries differ only by
  // quality it listed the same "Default" five times over.
  function buildAudioMenu(manifestTracks) {
    const tracks = manifestTracks || [];
    if (tracks.length < 2) {
      player.setAudioMenu([{ label: 'No alternate audio in this stream', active: true, disabled: true, onSelect: () => {} }]);
      return;
    }
    const options = tracks.map((t, index) => ({
      label: t.name || t.lang || `Audio ${index + 1}`,
      active: hls && hls.audioTrack === index,
      onSelect: () => { if (hls) hls.audioTrack = index; },
    }));
    player.setAudioMenu(options);
  }

  function setLoading(isLoading) {
    els.loading.hidden = !isLoading;
    if (isLoading) { els.empty.style.display = 'none'; els.error.hidden = true; }
  }

  // The overlay used to be cleared only by MANIFEST_PARSED (hls path) or
  // loadedmetadata (native path). Both are startup-only signals, so any route
  // that reached playback without firing the expected one - or that hit a
  // recoverable error after parsing - left "Loading stream..." pasted over a
  // video that was visibly playing. Playback progress is the honest signal:
  // if the playhead is advancing, the stream is up, whatever the events said.
  // These are bound once against the <video> element rather than per stream,
  // so switching streams cannot leave a stale listener behind.
  ['playing', 'timeupdate', 'canplay'].forEach((evt) => {
    els.video.addEventListener(evt, () => {
      if (!els.loading.hidden && els.video.currentTime > 0) setLoading(false);
    });
  });
  // A 'waiting' event does NOT justify re-showing the overlay. hls.js fires
  // bufferNudgeOnStall repeatedly on this merged stream, each nudge emits
  // 'waiting', and re-showing on every one pasted "Loading stream..." back
  // over a video that was playing fine - the clear from timeupdate and the
  // re-show from waiting just raced each other forever.
  //
  // Only a stall the viewer can actually see counts: the playhead has to stop
  // advancing for a sustained period. Track that instead of trusting events.
  let lastSeenTime = -1, stalledTicks = 0;
  setInterval(() => {
    const t = els.video.currentTime;
    if (els.video.paused || els.video.ended) { stalledTicks = 0; lastSeenTime = t; return; }
    if (Math.abs(t - lastSeenTime) < 0.01) stalledTicks += 1; else stalledTicks = 0;
    lastSeenTime = t;
    // ~2s of a frozen playhead while trying to play.
    if (stalledTicks >= 4) setLoading(true);
    else if (t > 0) setLoading(false);
  }, 500);

  function setError(message) {
    els.error.hidden = !message;
    els.error.textContent = message || '';
    els.loading.hidden = true;
  }

  function playStream(index) {
    const stream = currentStreams[index];
    if (!stream || !stream.url) return;
    currentIndex = index;
    document.querySelectorAll('.stream-item').forEach((el) => el.classList.toggle('active', Number(el.dataset.index) === index));
    if (hls) { hls.destroy(); hls = null; }
    els.video.pause(); els.video.removeAttribute('src'); els.video.load();
    clearTracks(); addExternalSubtitles(stream);
    setLoading(true); setError(null);
    els.now.textContent = streamLabel(stream);
    els.details.textContent = `${stream.provider || 'Unknown provider'} · ${stream.quality || 'Auto'} · ${languageFromLabel(stream) || 'language from manifest'}`;
    const headers = stream.headers || {};

    if (window.Hls && Hls.isSupported() && isHlsUrl(stream.url)) {
      // Diagnostics: count every hls.js network call by kind so a runaway
      // loop is visible as a number instead of a wall of DevTools rows.
      // buffered.end(0) reports only the FIRST range. Once a seek or a track
      // switch fragments the buffer, that number freezes at the old range and
      // reads as a stall even while playback is perfectly buffered further
      // out - which is exactly how this bug was misdiagnosed. Report the range
      // holding the playhead, plus the range count.
      const bufferedAhead = () => {
        const b = els.video.buffered, t = els.video.currentTime;
        for (let i = 0; i < b.length; i++) {
          if (t >= b.start(i) - 0.5 && t <= b.end(i) + 0.5) {
            return `${b.end(i).toFixed(1)}s(+${(b.end(i) - t).toFixed(1)} ranges=${b.length})`;
          }
        }
        return `GAP!(ranges=${b.length}${b.length ? ' last=' + b.end(b.length - 1).toFixed(1) : ''})`;
      };
      // Reads the actual MSE SourceBuffers rather than trusting hls.js events,
      // so a missing video buffer shows up even if BUFFER_CODECS said otherwise.
      const sourceBufferState = () => {
        try {
          const ms = hls && hls.media && hls.media.__ms;
          const sbs = (hls && hls.bufferController && hls.bufferController.sourceBuffer) || null;
          if (!sbs) return 'n/a';
          return Object.keys(sbs).map((k) => {
            const sb = sbs[k];
            if (!sb) return k + ':none';
            let r = '';
            try { r = sb.buffered.length ? `${sb.buffered.start(0).toFixed(1)}-${sb.buffered.end(sb.buffered.length - 1).toFixed(1)}` : 'empty'; } catch (_) { r = 'err'; }
            return `${k}:${r}${sb.updating ? ':updating' : ''}`;
          }).join(' ') || 'none';
        } catch (e) { return 'err:' + e.message; }
      };
      const hlsStats = { manifest: 0, level: 0, audioTrack: 0, frag: 0, appended: {}, parsed: {}, started: Date.now() };
      window.__hlsStats = hlsStats;
      if (window.__hlsStatsTimer) clearInterval(window.__hlsStatsTimer);
      window.__hlsStatsTimer = setInterval(() => {
        const secs = ((Date.now() - hlsStats.started) / 1000).toFixed(0);
        console.log(`[hls-stats] t=${secs}s manifest=${hlsStats.manifest} level=${hlsStats.level}`
          + ` audioTrack=${hlsStats.audioTrack} frag=${hlsStats.frag}`
          + ` buffered=${bufferedAhead()}`
          + ` currentTime=${els.video.currentTime.toFixed(1)}s readyState=${els.video.readyState}`
          + ` appended=${JSON.stringify(hlsStats.appended)} parsed=${JSON.stringify(hlsStats.parsed)}`
          + ` sb=${sourceBufferState()}`);
      }, 5000);

      hls = new Hls({
        enableWorker: true,
        // With no caps the buffer grows unbounded and old ranges are never
        // trimmed, so a long session ends up holding several disjoint ranges
        // (measured: 4 ranges spanning 0s to 1835s). An audio-track switch
        // then resolves the playhead against the wrong range and jumps the
        // viewer ~26 minutes, after which hls.js must refill video around the
        // new position - a ~1000-fragment burst that reads as a request flood.
        // Bounding the buffer keeps it to a single contiguous range.
        maxBufferLength: 30,
        maxMaxBufferLength: 120,
        backBufferLength: 30,
        // Small holes between the Castle video (44.1kHz muxed) and NetMirror
        // audio (48kHz) timelines should be jumped, not treated as a stall.
        maxBufferHole: 0.5,
        nudgeMaxRetry: 5,
        // Without caps a manifest hls.js cannot buffer (for example a variant
        // whose declared codecs do not match the media) turns into an endless
        // re-fetch of the same segment: tens of thousands of requests, no
        // playback. Bound the retries so a bad stream surfaces as an error
        // instead of silently hammering the proxy.
        fragLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 20000,
            maxLoadTimeMs: 60000,
            timeoutRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 4000 },
            errorRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
          },
        },
        // fragLoadPolicy alone is NOT enough. A master whose child playlist
        // cannot be parsed never reaches fragment loading at all, so the
        // uncapped manifest/playlist policies retry forever - tens of
        // thousands of requests, served from disk cache, with the player
        // frozen and MANIFEST_PARSED never firing. Cap those too.
        manifestLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 20000,
            maxLoadTimeMs: 30000,
            timeoutRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 4000 },
            errorRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
          },
        },
        playlistLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 20000,
            maxLoadTimeMs: 30000,
            timeoutRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 4000 },
            errorRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
          },
        },
        appendErrorMaxRetry: 3,
        xhrSetup: function (xhr) {
          ['Referer', 'Origin', 'Accept', 'Accept-Language'].forEach((k) => {
            if (headers[k]) { try { xhr.setRequestHeader(k, headers[k]); } catch (_) {} }
          });
        },
      });
      const applyManifestAudio = (tracks) => {
        const list = Array.isArray(tracks) ? tracks : [];
        buildAudioMenu(list.map(t => ({ name: t.name || t.lang, lang: t.lang })));
        if (list.length && hls.audioTrack < 0) hls.audioTrack = 0;
      };
      hls.on(Hls.Events.MANIFEST_LOADING, () => { hlsStats.manifest += 1; console.log('[hls] MANIFEST_LOADING', hlsStats.manifest); });
      hls.on(Hls.Events.LEVEL_LOADING, () => { hlsStats.level += 1; });
      hls.on(Hls.Events.AUDIO_TRACK_LOADING, () => { hlsStats.audioTrack += 1; });
      hls.on(Hls.Events.FRAG_LOADING, () => { hlsStats.frag += 1; });
      hls.on(Hls.Events.LEVEL_LOADED, (_, d) => console.log('[hls] LEVEL_LOADED frags=' + ((d.details && d.details.fragments || []).length) + ' live=' + (d.details && d.details.live)));
      hls.on(Hls.Events.AUDIO_TRACK_LOADED, (_, d) => console.log('[hls] AUDIO_TRACK_LOADED id=' + d.id + ' frags=' + ((d.details && d.details.fragments || []).length)));
      hls.on(Hls.Events.BUFFER_CODECS, (_, d) => console.log('[hls] BUFFER_CODECS', JSON.stringify(Object.keys(d)),
        Object.keys(d).map(k => k + '=' + (d[k] && d[k].container) + '/' + (d[k] && d[k].codec)).join(' ')));
      // Which SourceBuffer each append lands in is the fact that decides this
      // bug: a buffered range frozen while fragments keep arriving means video
      // appends stopped. Counting them by type shows that directly.
      hls.on(Hls.Events.BUFFER_APPENDED, (_, d) => { hlsStats.appended[d.type] = (hlsStats.appended[d.type] || 0) + 1; });
      hls.on(Hls.Events.FRAG_PARSED, (_, d) => { const t = d.frag && d.frag.type; hlsStats.parsed[t] = (hlsStats.parsed[t] || 0) + 1; });
      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        console.log('[hls] MANIFEST_PARSED levels=' + (data.levels || []).length + ' audioTracks=' + ((data.audioTracks || []).length));
        applyManifestAudio(data && data.audioTracks ? data.audioTracks : hls.audioTracks);
        setLoading(false);
        els.video.play().catch((e) => {
          console.warn('[hls] autoplay blocked:', e && e.name, '- press play');
          showToast('Press play to start', 'info');
        });
      });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_, data) => applyManifestAudio(data && data.audioTracks ? data.audioTracks : hls.audioTracks));
      // Non-fatal errors were being dropped on the floor, which is how an
      // endless retry loop stayed invisible: the player looked idle while it
      // re-requested the same playlist thousands of times. Log every one.
      hls.on(Hls.Events.ERROR, (_, data) => {
        console.warn('[hls]', data.fatal ? 'FATAL' : 'non-fatal', data.type, data.details,
          data.response ? `http=${data.response.code}` : '', data.url || '');
        if (data.fatal) {
          setError('This stream could not be loaded in your browser. Try another provider below.');
          showToast('Playback failed for this stream — try another provider.', 'error');
        }
      });
      hls.loadSource(stream.url);
      hls.attachMedia(els.video);
    } else {
      els.video.src = stream.url;
      els.video.addEventListener('loadedmetadata', () => setLoading(false), { once: true });
      els.video.addEventListener('error', () => setError('This stream could not be played directly by the browser.'), { once: true });
      els.video.play().catch(() => {});
      buildAudioMenu(els.video.audioTracks ? Array.from(els.video.audioTracks).map(t => ({ name: t.label, lang: t.language })) : []);
    }
  }

  async function loadStreams() {
    els.streamGroups.innerHTML = `<div class="state-block"><div class="spinner" style="margin:0 auto"></div><h3>Finding streams…</h3><p>Providers are being queried in parallel — this can take up to 30-45 seconds.</p></div>`;
    try {
      const data = await fetchStreams(type, id);
      currentStreams = Array.isArray(data.streams) ? data.streams.filter(s => s && s.url) : [];
      renderTimings(data.providerTimings);
      renderStreamGroups(currentStreams);
      if (currentStreams.length) playStream(0);
      else setError(null);
    } catch (e) {
      els.streamGroups.innerHTML = `<div class="state-block">
        <div class="state-icon">&#9888;</div>
        <h3>Could not load streams</h3>
        <p>${esc(e.message || 'The stream API request failed.')}</p>
      </div>`;
      showToast(e.message || 'Failed to load streams.', 'error');
    }
  }

  els.streamGroups.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-index]');
    if (btn) playStream(Number(btn.dataset.index));
  });

  async function init() {
    if (!id) {
      els.headerSection.innerHTML = `<div class="state-block"><h3>Missing title</h3><p>No TMDB id was supplied. Go back to search and pick a title.</p></div>`;
      return;
    }
    renderBackdropSkeleton();
    player = createPlayer(els.playerShell);
    const meta = await loadMeta();
    renderMeta(meta);
    loadStreams();
  }

  init();
}());
