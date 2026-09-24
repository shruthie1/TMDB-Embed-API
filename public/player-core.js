/* Chitram OTT — reusable custom video player with modern controls.
 * Wraps a <video> element with a play/pause, seek bar (with buffered range),
 * volume, time readout, playback-rate, audio-track & subtitle menus,
 * picture-in-picture and fullscreen — plus keyboard shortcuts.
 * HLS wiring (hls.js, xhrSetup headers, audio tracks) stays in watch.js;
 * this module only owns the chrome around the <video> tag.
 */
(function (global) {
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function createPlayer(root) {
    const video = root.querySelector('video');
    const wrap = root.querySelector('.video-wrap');

    const bar = document.createElement('div');
    bar.className = 'controls-bar';
    bar.innerHTML = `
      <div class="seek-row">
        <div class="seek-bar" id="pcSeek" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div class="track"><div class="buffered"></div><div class="played"></div><div class="knob"></div></div>
        </div>
      </div>
      <div class="controls-row">
        <button class="ctrl-btn" id="pcPlay" title="Play/Pause (k)" aria-label="Play">&#9658;</button>
        <button class="ctrl-btn" id="pcBack" title="Back 10s (Left arrow)" aria-label="Back 10 seconds">&#8634;</button>
        <button class="ctrl-btn" id="pcFwd" title="Forward 10s (Right arrow)" aria-label="Forward 10 seconds">&#8635;</button>
        <div class="vol-row">
          <button class="ctrl-btn" id="pcMute" title="Mute (m)" aria-label="Mute">&#128266;</button>
          <input type="range" id="pcVol" min="0" max="1" step="0.05" value="1" aria-label="Volume">
        </div>
        <span class="time-readout"><span id="pcCur">0:00</span> / <span id="pcDur">0:00</span></span>
        <span class="spacer"></span>
        <div class="menu-wrap">
          <button class="ctrl-btn" id="pcAudioBtn" title="Audio & subtitles" aria-label="Audio and subtitle settings">&#9881;</button>
          <div class="ctrl-menu" id="pcAudioMenu"></div>
        </div>
        <div class="menu-wrap">
          <button class="ctrl-btn" id="pcRateBtn" title="Playback speed" aria-label="Playback speed">1x</button>
          <div class="ctrl-menu" id="pcRateMenu"></div>
        </div>
        <button class="ctrl-btn" id="pcPip" title="Picture in picture" aria-label="Picture in picture">&#8862;</button>
        <button class="ctrl-btn" id="pcFullscreen" title="Fullscreen (f)" aria-label="Fullscreen">&#9974;</button>
      </div>`;
    wrap.appendChild(bar);

    const bigPlay = document.createElement('button');
    bigPlay.className = 'big-play';
    bigPlay.innerHTML = '<span class="circle">&#9658;</span>';
    bigPlay.setAttribute('aria-label', 'Play');
    wrap.appendChild(bigPlay);

    const el = {
      seek: bar.querySelector('#pcSeek'),
      played: bar.querySelector('.played'),
      buffered: bar.querySelector('.buffered'),
      knob: bar.querySelector('.knob'),
      play: bar.querySelector('#pcPlay'),
      back: bar.querySelector('#pcBack'),
      fwd: bar.querySelector('#pcFwd'),
      mute: bar.querySelector('#pcMute'),
      vol: bar.querySelector('#pcVol'),
      cur: bar.querySelector('#pcCur'),
      dur: bar.querySelector('#pcDur'),
      audioBtn: bar.querySelector('#pcAudioBtn'),
      audioMenu: bar.querySelector('#pcAudioMenu'),
      rateBtn: bar.querySelector('#pcRateBtn'),
      rateMenu: bar.querySelector('#pcRateMenu'),
      pip: bar.querySelector('#pcPip'),
      fullscreen: bar.querySelector('#pcFullscreen'),
    };

    function closeMenus() { el.audioMenu.classList.remove('open'); el.rateMenu.classList.remove('open'); }

    function setPlayIcon() {
      const playing = !video.paused && !video.ended;
      el.play.innerHTML = playing ? '&#10074;&#10074;' : '&#9658;';
      el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      bigPlay.classList.toggle('hidden', playing);
    }
    function togglePlay() { if (video.paused) video.play().catch(() => {}); else video.pause(); }
    el.play.addEventListener('click', togglePlay);
    bigPlay.addEventListener('click', togglePlay);
    video.addEventListener('play', setPlayIcon);
    video.addEventListener('pause', setPlayIcon);
    video.addEventListener('ended', setPlayIcon);

    el.back.addEventListener('click', () => { video.currentTime = Math.max(0, video.currentTime - 10); });
    el.fwd.addEventListener('click', () => { video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10); });

    function updateSeek() {
      const dur = video.duration || 0;
      const pct = dur ? (video.currentTime / dur) * 100 : 0;
      el.seek.style.setProperty('--pct', pct + '%');
      el.seek.setAttribute('aria-valuenow', Math.round(pct));
      el.cur.textContent = fmtTime(video.currentTime);
      el.dur.textContent = fmtTime(dur);
      let buf = 0;
      if (video.buffered && video.buffered.length && dur) {
        buf = (video.buffered.end(video.buffered.length - 1) / dur) * 100;
      }
      el.seek.style.setProperty('--buf', buf + '%');
    }
    video.addEventListener('timeupdate', updateSeek);
    video.addEventListener('progress', updateSeek);
    video.addEventListener('loadedmetadata', updateSeek);
    video.addEventListener('durationchange', updateSeek);

    let dragging = false;
    function seekFromEvent(clientX) {
      const rect = el.seek.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      if (video.duration) video.currentTime = ratio * video.duration;
      el.seek.style.setProperty('--pct', ratio * 100 + '%');
    }
    el.seek.addEventListener('pointerdown', (e) => { dragging = true; el.seek.classList.add('dragging'); seekFromEvent(e.clientX); el.seek.setPointerCapture(e.pointerId); });
    el.seek.addEventListener('pointermove', (e) => { if (dragging) seekFromEvent(e.clientX); });
    el.seek.addEventListener('pointerup', (e) => { dragging = false; el.seek.classList.remove('dragging'); try { el.seek.releasePointerCapture(e.pointerId); } catch (_) {} });
    el.seek.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { video.currentTime = Math.max(0, video.currentTime - 5); e.preventDefault(); }
    });

    function setVolIcon() {
      const v = video.muted || video.volume === 0 ? 0 : video.volume;
      el.mute.innerHTML = v === 0 ? '&#128263;' : v < 0.5 ? '&#128265;' : '&#128266;';
    }
    el.mute.addEventListener('click', () => { video.muted = !video.muted; setVolIcon(); });
    el.vol.addEventListener('input', () => { video.volume = Number(el.vol.value); video.muted = video.volume === 0; setVolIcon(); });
    video.addEventListener('volumechange', () => { el.vol.value = video.muted ? 0 : video.volume; setVolIcon(); });

    const rates = [0.5, 0.75, 1, 1.25, 1.5, 2];
    function renderRateMenu() {
      el.rateMenu.innerHTML = rates.map(r => `<button data-rate="${r}" class="${video.playbackRate === r ? 'active' : ''}">${r}x</button>`).join('');
    }
    renderRateMenu();
    el.rateBtn.addEventListener('click', () => { const wasOpen = el.rateMenu.classList.contains('open'); closeMenus(); if (!wasOpen) { renderRateMenu(); el.rateMenu.classList.add('open'); } });
    el.rateMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-rate]'); if (!btn) return;
      video.playbackRate = Number(btn.dataset.rate); el.rateBtn.textContent = `${video.playbackRate}x`; renderRateMenu(); el.rateMenu.classList.remove('open');
    });

    el.audioBtn.addEventListener('click', () => { const wasOpen = el.audioMenu.classList.contains('open'); closeMenus(); if (!wasOpen) el.audioMenu.classList.add('open'); });
    document.addEventListener('click', (e) => { if (!bar.contains(e.target)) closeMenus(); });

    el.pip.addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else if (video.requestPictureInPicture) await video.requestPictureInPicture();
      } catch (_) {}
    });
    if (!('pictureInPictureEnabled' in document)) el.pip.style.display = 'none';

    function toggleFullscreen() {
      if (!document.fullscreenElement) root.requestFullscreen?.().catch(() => {});
      else document.exitFullscreen?.();
    }
    el.fullscreen.addEventListener('click', toggleFullscreen);

    // Auto-hide chrome during playback
    let hideTimer = null;
    function showControls() {
      wrap.classList.remove('controls-hidden');
      clearTimeout(hideTimer);
      if (!video.paused) hideTimer = setTimeout(() => { if (!dragging) wrap.classList.add('controls-hidden'); }, 2800);
    }
    ['mousemove', 'pointermove', 'focusin', 'click'].forEach(ev => wrap.addEventListener(ev, showControls));
    video.addEventListener('play', showControls);
    video.addEventListener('pause', () => { wrap.classList.remove('controls-hidden'); clearTimeout(hideTimer); });

    // Keyboard shortcuts, scoped to when the player has focus/hover
    function onKey(e) {
      if (!wrap.matches(':hover') && document.activeElement !== el.seek && !root.contains(document.activeElement)) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
      switch (e.key.toLowerCase()) {
        case ' ': case 'k': togglePlay(); e.preventDefault(); break;
        case 'arrowright': video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10); break;
        case 'arrowleft': video.currentTime = Math.max(0, video.currentTime - 10); break;
        case 'arrowup': video.volume = Math.min(1, video.volume + 0.1); e.preventDefault(); break;
        case 'arrowdown': video.volume = Math.max(0, video.volume - 0.1); e.preventDefault(); break;
        case 'm': video.muted = !video.muted; setVolIcon(); break;
        case 'f': toggleFullscreen(); break;
        default: break;
      }
    }
    document.addEventListener('keydown', onKey);

    setPlayIcon(); setVolIcon(); updateSeek();

    return {
      video,
      /** Replace the audio-track menu contents. options: [{label, active, onSelect}] */
      setAudioMenu(options) {
        if (!options || !options.length) { el.audioMenu.innerHTML = '<div class="menu-title">No alternate audio</div>'; return; }
        el.audioMenu.innerHTML = '<div class="menu-title">Audio & language</div>' +
          options.map((o, i) => `<button data-i="${i}" class="${o.active ? 'active' : ''}">${o.label}${o.active ? ' &#10003;' : ''}</button>`).join('');
        el.audioMenu.querySelectorAll('button[data-i]').forEach((btn) => {
          btn.addEventListener('click', () => { options[Number(btn.dataset.i)].onSelect(); closeMenus(); });
        });
      },
      destroyKeyHandler() { document.removeEventListener('keydown', onKey); },
    };
  }

  global.ChitramPlayer = { createPlayer, fmtTime };
}(window));
