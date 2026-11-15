'use client';
import { useState } from 'react';
import Icon from '../Icon';
import VideoMenu from './VideoMenu';
import { VA_EMBED_ID, VA_EMBED_LABEL } from '../../lib/player/vaEmbed';

/**
 * A provider's own player filling the stage, with our Close and Servers kept
 * on top so the viewer can always get back to one of our sources.
 *
 * Quality, audio and subtitles are NOT shown: inside the frame their player
 * owns all three, and our controls would act on a video that is not playing.
 *
 * NO sandbox. VaPlayer's page probes for one (it looks for "sandbox" and
 * writes document.domain, then bails), so a sandboxed frame shows nothing.
 * The original EmbedFallback keeps its sandbox; this frame is a separate,
 * explicitly requested trade. `referrerPolicy="origin"` because the page reads
 * document.referrer for its own checks and sends only our origin, no path.
 *
 * On a TV the frame takes no focus (tabIndex -1): the remote's D-pad moves
 * only between data-focus elements, so Close and Servers stay reachable.
 */
export default function EmbedStage({ url, choices, onPick, onClose, tv = false }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="embed-stage" data-focus-group="">
      <iframe className="embed-stage-frame" src={url} title={`${VA_EMBED_LABEL} player`}
              allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
              allowFullScreen referrerPolicy="origin"
              tabIndex={tv ? -1 : undefined} />
      <div className="embed-stage-bar" data-focus-group="">
        <button type="button" className="ov-back focusable" data-focus=""
                onClick={onClose} aria-label="Close">
          <Icon name="back" size={18} /><span>Close</span>
        </button>
        <VideoMenu choices={choices} currentId={VA_EMBED_ID} currentSource={VA_EMBED_LABEL}
                   open={open} onToggle={() => setOpen((o) => !o)}
                   onPick={(c) => { setOpen(false); if (c?.id !== VA_EMBED_ID) onPick?.(c); }} />
      </div>
    </div>
  );
}
