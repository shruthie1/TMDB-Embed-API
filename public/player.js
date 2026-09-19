/* Basic Chitram OTT stream browser/player. */
(function () {
  const $ = (s) => document.querySelector(s);
  const els = { form: $('#searchForm'), type: $('#mediaType'), id: $('#tmdbId'), search: $('#searchBtn'), status: $('#status'), streams: $('#streams'), count: $('#streamCount'), video: $('#video'), empty: $('#videoEmpty'), now: $('#nowPlaying'), details: $('#nowDetails'), audio: $('#audioTracks'), subtitle: $('#subtitleNote') };
  let hls = null;
  let currentStreams = [];
  let currentIndex = -1;

  function setStatus(text, kind) { els.status.textContent = text; els.status.className = 'status' + (kind ? ' ' + kind : ''); }
  function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }
  function streamLabel(stream) { return stream.name || stream.title || stream.provider || 'Stream'; }
  function languageFromLabel(stream) { const m = streamLabel(stream).match(/\[([^\]]+)\]/); return m ? m[1] : ''; }
  function isHls(url) { return /\.m3u8(?:$|\?)/i.test(url || ''); }

  function renderStreams(streams) {
    els.count.textContent = streams.length;
    if (!streams.length) { els.streams.innerHTML = '<div class="empty">No streams were returned for this title.</div>'; return; }
    els.streams.innerHTML = streams.map((s, i) => {
      const lang = languageFromLabel(s);
      const subs = Array.isArray(s.subtitles) ? s.subtitles.length : 0;
      return `<button class="stream" data-index="${i}" type="button"><div class="stream-title">${esc(streamLabel(s))}</div><div class="stream-sub"><span class="tag">${esc(s.provider || 'Provider')}</span><span class="tag">${esc(s.quality || 'Auto')}</span>${lang ? `<span class="tag audio">${esc(lang)}</span>` : ''}${subs ? `<span class="tag">${subs} subtitle${subs === 1 ? '' : 's'}</span>` : ''}</div></button>`;
    }).join('');
  }

  function clearTracks() {
    els.video.querySelectorAll('track').forEach(t => t.remove());
    els.audio.innerHTML = '<option>Detecting audio…</option>'; els.audio.disabled = true;
    els.subtitle.textContent = '';
  }

  function addExternalSubtitles(stream) {
    const subtitles = Array.isArray(stream.subtitles) ? stream.subtitles : [];
    subtitles.forEach((sub, i) => {
      if (!sub || !sub.url) return;
      const track = document.createElement('track'); track.kind = 'subtitles'; track.src = sub.url;
      track.srclang = (sub.lang || 'und').slice(0, 2); track.label = sub.label || sub.language || sub.lang || `Subtitle ${i + 1}`; track.default = i === 0;
      els.video.appendChild(track);
    });
    if (subtitles.length) els.subtitle.textContent = `${subtitles.length} subtitle track${subtitles.length === 1 ? '' : 's'} available in the player menu.`;
  }

  function renderAudioTracks(tracks) {
    const languageStreams = currentStreams.map((stream, index) => ({
      index,
      name: `${languageFromLabel(stream) || 'Default'} · ${stream.quality || 'Auto'} · ${stream.provider || 'Provider'}`
    }));
    const embedded = tracks.map((track, index) => ({ index, name: track.name || track.lang || `Audio ${index + 1}`, embedded: true }));
    const options = [...languageStreams.map(item => ({ ...item, value: `stream:${item.index}` })), ...embedded.map(item => ({ ...item, value: `hls:${item.index}` }))];
    if (!options.length) { els.audio.innerHTML = '<option>No alternate audio detected</option>'; els.audio.disabled = true; return; }
    els.audio.innerHTML = options.map(option => `<option value="${option.value}"${option.index === currentIndex && !option.embedded ? ' selected' : ''}>${esc(option.name)}</option>`).join('');
    els.audio.disabled = false;
  }

  function playStream(index) {
    const stream = currentStreams[index]; if (!stream || !stream.url) return;
    currentIndex = index; document.querySelectorAll('.stream').forEach((el, i) => el.classList.toggle('active', i === index));
    if (hls) { hls.destroy(); hls = null; }
    clearTracks(); addExternalSubtitles(stream); els.empty.style.display = 'none';
    els.now.textContent = streamLabel(stream); els.details.textContent = `${stream.provider || 'Unknown provider'} · ${stream.quality || 'Auto'} · ${languageFromLabel(stream) || 'language from manifest'}`;
    const headers = stream.headers || {};
    if (window.Hls && Hls.isSupported() && isHls(stream.url)) {
      hls = new Hls({ enableWorker: true, xhrSetup: function (xhr) { ['Referer', 'Origin', 'Accept', 'Accept-Language'].forEach(k => { if (headers[k]) { try { xhr.setRequestHeader(k, headers[k]); } catch (_) {} } }); } });
      hls.on(Hls.Events.MANIFEST_PARSED, function () { renderAudioTracks((hls.audioTracks || []).map(t => ({ name: t.name || t.lang, lang: t.lang }))); els.video.play().catch(() => {}); });
      hls.on(Hls.Events.ERROR, function (_, data) { if (data.fatal) setStatus('The stream could not be loaded in this browser. Try another provider.', 'error'); });
      hls.loadSource(stream.url); hls.attachMedia(els.video);
    } else {
      els.video.src = stream.url; els.video.play().catch(() => {});
      renderAudioTracks(els.video.audioTracks ? Array.from(els.video.audioTracks).map(t => ({ name: t.label, lang: t.language })) : []);
    }
    setStatus(`Playing ${languageFromLabel(stream) || 'selected'} stream ${index + 1} of ${currentStreams.length}.`, 'good');
  }

  async function search() {
    const id = els.id.value.trim(); if (!/^\d+$/.test(id)) { setStatus('Enter a numeric TMDB ID.', 'error'); return; }
    els.search.disabled = true; setStatus('Finding streams…'); els.streams.innerHTML = ''; currentStreams = [];
    try {
      const response = await fetch(`/api/streams/${encodeURIComponent(els.type.value)}/${encodeURIComponent(id)}`);
      const data = await response.json(); if (!response.ok || !data.success) throw new Error(data.error || 'API request failed');
      currentStreams = Array.isArray(data.streams) ? data.streams.filter(s => s && s.url) : []; renderStreams(currentStreams);
      setStatus(`${data.count || currentStreams.length} stream${(data.count || currentStreams.length) === 1 ? '' : 's'} found for TMDB ${id}.`, 'good');
      if (currentStreams.length) playStream(0);
    } catch (e) { setStatus(e.message || 'Could not load streams.', 'error'); els.streams.innerHTML = '<div class="empty">The stream request failed. Check the API deployment logs.</div>'; }
    finally { els.search.disabled = false; }
  }

  els.form.addEventListener('submit', e => { e.preventDefault(); search(); });
  els.streams.addEventListener('click', e => { const card = e.target.closest('[data-index]'); if (card) playStream(Number(card.dataset.index)); });
  els.audio.addEventListener('change', () => {
    const value = els.audio.value || '';
    if (value.startsWith('stream:')) return playStream(Number(value.slice(7)));
    if (value.startsWith('hls:') && hls) hls.audioTrack = Number(value.slice(4));
    else if (els.video.audioTracks) Array.from(els.video.audioTracks).forEach((t, i) => { t.enabled = i === Number(value); });
  });
  const queryId = new URLSearchParams(location.search).get('id'); if (queryId) els.id.value = queryId; search();
}());
