'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Paint captions ourselves, inside the picture.
 *
 * The browser positions cues against the <video> ELEMENT, but the element is
 * object-fit:contain, so the picture is letterboxed inside it. Measured on a
 * 1280x900 element showing a 16:9 film: the picture is 1280x720 and there is a
 * 90px black bar top and bottom, so the UA painted the cues 90px BELOW the
 * picture - in the bar, and on a taller window off the visible area entirely.
 *
 * Styling the UA's own container is not a fix. ::-webkit-media-text-track-*
 * is non-standard, Firefox has no equivalent, and measured here it did not
 * apply at all (transform came back "none", font-size 16px - our rules ignored).
 *
 * So the native track keeps PARSING (mode 'hidden' still fires cuechange and
 * populates activeCues) and we render the text into a normal element that is
 * sized to the picture. Ordinary CSS then works, identically on every browser.
 */
/**
 * WebVTT cue text -> renderable segments.
 *
 * Cue text carries inline markup: <i>, <b>, <u>, <v Speaker>, <c.class>, and
 * &-entities. ::cue rendered those for us; painting the raw string as text
 * printed them literally on screen ("<i>What if they get hungry</i>"). Italics
 * are common in subtitles - song lyrics, off-screen voices - so they are kept
 * as real emphasis rather than stripped.
 *
 * Timestamp tags (<00:01:02.500>) are karaoke markers with no place here, and
 * <v Speaker> names are dropped: the voice is audible.
 */
export function parseCueText(text) {
  return String(text).split('\n').map((line) => {
    const out = [];
    // Tag or run-of-text, one at a time.
    const re = /<\/?([a-zA-Z]?)[^>]*>|[^<]+/g;
    let italic = 0, bold = 0, m;
    while ((m = re.exec(line)) !== null) {
      const tok = m[0];
      if (tok[0] === '<') {
        const closing = tok[1] === '/';
        const tag = (m[1] || '').toLowerCase();
        if (tag === 'i') italic += closing ? -1 : 1;
        else if (tag === 'b') bold += closing ? -1 : 1;
        continue;   // every other tag contributes nothing visible
      }
      const value = tok
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, '\u00a0').replace(/&amp;/g, '&');
      if (value) out.push({ text: value, i: italic > 0, b: bold > 0 });
    }
    return out;
  });
}

/**
 * How much of the frame is a letterbox bar burned into the pixels.
 *
 * A 2.35:1 film delivered in a 16:9 raster carries its black bars as actual
 * black pixels: videoWidth/videoHeight report 1920x1080, the same as a film
 * that fills the frame. No amount of geometry can tell the two apart, so the
 * caption box was sized to the RASTER and a bottom-aligned caption landed
 * inside the bar - reading as if it were floating in the middle of the image.
 *
 * Draws the frame small and walks in from the top and bottom edges looking for
 * the first row that is not black. Returns the bar as a FRACTION of height, so
 * the caller does not care what size we sampled at.
 *
 * Returns 0 - meaning "assume no bars" - whenever the answer cannot be trusted:
 * a tainted canvas (cross-origin frames), a frame that is not ready, or an
 * all-black frame such as a fade. Never guesses; the caller keeps its previous
 * value, so a fade to black does not make captions jump.
 */
export function detectBakedBars(video) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h || video.readyState < 2) return null;
  // Small sample: we need row luminance, not detail. 64px tall is enough to
  // resolve a bar to ~1.5% of height and costs almost nothing to draw.
  const SH = 64, SW = 32;
  let data;
  try {
    const c = document.createElement('canvas');
    c.width = SW; c.height = SH;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, SW, SH);
    data = ctx.getImageData(0, 0, SW, SH).data;
  } catch {
    // Tainted canvas: the frames are cross-origin and cannot be read. This is
    // the normal case for a CDN that does not send CORS headers, so it must
    // fail quietly rather than break captions.
    return null;
  }

  // A bar is not pure #000 after compression; ringing and noise lift it a
  // little. 18/255 is above that floor and well below any real image content.
  const DARK = 18;
  const rowIsDark = (y) => {
    for (let x = 0; x < SW; x++) {
      const i = (y * SW + x) * 4;
      // Rec.601 luma is enough here and avoids a sqrt per pixel.
      const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      if (lum > DARK) return false;
    }
    return true;
  };

  let top = 0, bottom = 0;
  while (top < SH && rowIsDark(top)) top++;
  while (bottom < SH && rowIsDark(SH - 1 - bottom)) bottom++;

  // Whole frame dark (a fade, or a night scene): tells us nothing.
  if (top >= SH) return null;
  // Wildly asymmetric bars are not a letterbox - more likely a dark scene that
  // happens to start black at one edge. Letterboxing is symmetric.
  if (Math.abs(top - bottom) > SH * 0.06) return null;
  const bar = Math.min(top, bottom) / SH;
  // Ignore a sliver: a couple of rows is noise, not a bar. And refuse anything
  // implausible - a real letterbox on a 16:9 raster tops out around 2.76:1,
  // which is ~18% per bar.
  if (bar < 0.02 || bar > 0.25) return 0;
  return bar;
}

export function useCueOverlay({ videoRef, subUrl, fit = 'contain', enabled = true }) {
  const [text, setText] = useState('');
  // The picture's box inside the element, so the overlay can match it.
  const [box, setBox] = useState(null);
  // Fraction of the RASTER height taken by a letterbox bar encoded into the
  // pixels themselves (top and bottom each). 0 for a film that fills its
  // raster. See detectBakedBars below for why geometry cannot supply this.
  const bakedBarRef = useRef(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Recompute where the picture actually sits. object-fit:contain letterboxes
    // on whichever axis is over-long.
    const measure = () => {
      const w = video.videoWidth, h = video.videoHeight;
      const r = video.getBoundingClientRect();
      // No frames yet (videoWidth is 0 until metadata lands, and stays 0 while
      // a source switch is in flight). Falling back to `null` here left the
      // layer with NO inline size, so `position:absolute` resolved against
      // .player - which is `position:fixed; inset:0`, the whole viewport. The
      // caption then bottom-aligned to the WINDOW, and with a letterboxed
      // picture floating mid-screen it read as sitting in the middle of the
      // image. Reported on a tall narrow window; the picture there is a few
      // hundred px tall inside a 1600px-tall viewport, so the caption landed
      // roughly a third of the way down the frame.
      //
      // The element's own rect is the honest answer before the aspect ratio is
      // known: it is where the picture will be, minus a letterbox we cannot
      // compute yet. Captions sit at the element's lower edge instead of the
      // window's, which is correct as soon as the film fills the width and
      // close enough otherwise - and it self-corrects the moment metadata
      // arrives, because `loadedmetadata` re-runs this.
      if (!r.width || !r.height) { setBox(null); return; }
      if (!w || !h) {
        setBox({ left: 0, top: 0, width: r.width, height: r.height });
        return;
      }
      const ar = w / h, boxAr = r.width / r.height;
      // With 'cover' or 'fill' the picture occupies the whole element, so
      // there is no letterbox to correct for.
      // ONE decision, applied to both axes. These were two separate
      // conditions - `boxAr > ar` for the width and `boxAr <= ar` for the
      // height - which disagree for a window WIDER than the film: the width
      // came from the element while the height was derived from that same
      // width, so the box was taller than the picture and bottom-aligned
      // captions landed mid-frame instead of near the lower edge.
      const letterboxed = fit === 'contain';
      // Wider box than film -> bars on the SIDES, full height.
      // Taller box than film -> bars top and bottom, full width.
      const barsOnSides = boxAr > ar;
      const picW = !letterboxed || !barsOnSides ? r.width : r.height * ar;
      const picH = !letterboxed || barsOnSides ? r.height : r.width / ar;
      // A film wider than its raster carries the letterbox IN THE PIXELS.
      // videoWidth/videoHeight report 1920x1080 for a 2.35:1 film, so the box
      // above is the RASTER, not the image, and a bottom-aligned caption sits
      // inside the baked-in black bar - which reads as floating in the middle
      // of the frame. Geometry cannot see this; only the pixels can.
      const inset = bakedBarRef.current;
      const shownH = picH * (1 - inset * 2);
      setBox({
        left: (r.width - picW) / 2,
        top: (r.height - picH) / 2 + picH * inset,
        width: picW, height: shownH,
      });
    };

    // Sample the pixels for a burned-in letterbox, then re-measure if the
    // answer changed. Kept separate from measure() because measure() runs on
    // every resize tick and reading a canvas is far more expensive than
    // reading a rect.
    //
    // `null` means "could not tell" (fade to black, tainted canvas, frame not
    // ready) and is NOT an answer - the previous value stands, so captions do
    // not jump around during a dark scene.
    const sampleBars = () => {
      const found = detectBakedBars(video);
      if (found === null) return;
      // Only act on a real change. Small jitter between frames would otherwise
      // re-render the overlay constantly.
      if (Math.abs(found - bakedBarRef.current) < 0.015) return;
      bakedBarRef.current = found;
      measure();
    };

    measure();
    const ro = typeof ResizeObserver === 'function'
      ? new ResizeObserver(measure) : null;
    ro?.observe(video);
    // Every few seconds is plenty: the aspect ratio of a film does not change
    // mid-playback, but the FIRST readable frame may be several seconds in
    // (studio logos and fades are exactly the frames we refuse to read), and a
    // source switch can bring a differently-mastered copy.
    const barTimer = setInterval(sampleBars, 3000);
    // And once as soon as frames exist, so a correctly-placed caption does not
    // wait for the first interval tick.
    video.addEventListener('loadeddata', sampleBars);
    video.addEventListener('seeked', sampleBars);
    // Fullscreen and rotation change the box without resizing the element in
    // some browsers, and the picture size is only known once metadata lands.
    const evts = ['loadedmetadata', 'resize', 'enterpictureinpicture',
                  'leavepictureinpicture'];
    evts.forEach(e => video.addEventListener(e, measure));
    window.addEventListener('resize', measure);
    document.addEventListener('fullscreenchange', measure);
    return () => {
      ro?.disconnect();
      clearInterval(barTimer);
      video.removeEventListener('loadeddata', sampleBars);
      video.removeEventListener('seeked', sampleBars);
      evts.forEach(e => video.removeEventListener(e, measure));
      window.removeEventListener('resize', measure);
      document.removeEventListener('fullscreenchange', measure);
    };
  }, [videoRef, subUrl, fit]);

  // Mirror the active cues into our own state.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) { setText(''); return; }
    if (!subUrl) { setText(''); return; }
    // Native controls paint their own captions and offer their own track menu.
    // Setting the track to 'hidden' here would silence both, so leave the UA
    // to it and render nothing of our own.
    if (!enabled) { setText(''); return; }

    let track = null;
    let shown = '';
    /**
     * Read the active cues.
     *
     * Driven by `timeupdate` as well as `cuechange`, because a track in mode
     * 'hidden' does not fire cuechange reliably in Chrome - measured: the
     * right track was hidden, activeCues stayed empty, and no caption ever
     * appeared. timeupdate fires ~4x a second during playback, which is ample
     * for subtitles and costs nothing since we bail when the text is unchanged.
     */
    const onChange = () => {
      const cues = track?.activeCues;
      // Several cues can be active at once; keep their order.
      const next = cues && cues.length
        ? [...cues].map(c => c.text).join('\n') : '';
      if (next === shown) return;    // no re-render when nothing changed
      shown = next;
      setText(next);
    };

    /**
     * Find OUR track, not just the last one.
     *
     * hls.js adds its own CEA-608 caption track from the stream, so
     * textTracks holds two: our subtitles file (thousands of cues) and its
     * 4-cue embedded one. Taking the last entry grabbed hls.js's, so the wrong
     * track was hidden and the real one kept painting in the wrong place -
     * measured: [{mode:"showing",kind:"subtitles",cues:3559},
     *            {mode:"hidden",kind:"captions",cues:4}].
     *
     * The <track> element React renders is the authority: its .track property
     * IS the TextTrack, so there is no guessing.
     */
    const attach = () => {
      const el = video.querySelector('track');
      const t = el?.track
        || [...(video.textTracks || [])].find(x => x.kind === 'subtitles');
      if (!t) return false;
      track = t;
      // 'hidden' still parses and fires cuechange, but stops the UA painting -
      // which is the whole point: its position is the bug.
      track.mode = 'hidden';
      // hls.js's embedded CEA-608 track would paint through the UA at the
      // wrong position too, so silence every track we are not rendering.
      for (const other of video.textTracks || []) {
        if (other !== track) other.mode = 'disabled';
      }
      track.addEventListener('cuechange', onChange);
      video.addEventListener('timeupdate', onChange);
      video.addEventListener('seeked', onChange);
      onChange();
      return true;
    };

    if (!attach()) {
      const tl = video.textTracks;
      const onAdd = () => { if (attach()) tl.removeEventListener('addtrack', onAdd); };
      tl?.addEventListener('addtrack', onAdd);
      return () => {
        tl?.removeEventListener('addtrack', onAdd);
        track?.removeEventListener('cuechange', onChange);
        video.removeEventListener('timeupdate', onChange);
        video.removeEventListener('seeked', onChange);
      };
    }
    return () => {
      track?.removeEventListener('cuechange', onChange);
      video.removeEventListener('timeupdate', onChange);
      video.removeEventListener('seeked', onChange);
    };
  }, [videoRef, subUrl, enabled]);

  // `lines` is what the player renders; `text` stays for anything that only
  // needs to know whether a caption is showing.
  return { text, lines: text ? parseCueText(text) : [], box };
}
