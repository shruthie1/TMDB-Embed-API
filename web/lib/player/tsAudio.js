/**
 * Muxed MPEG-TS audio: read the language tracks, and choose which one plays.
 *
 * CastleTV serves a MEDIA playlist whose segments each carry H.264 plus FIVE
 * AAC tracks, every one tagged in the PMT (measured 2026-10-03 on 1508168,
 * Bethlehem Kudumba Unit: PIDs 0x101-0x105 = hin/mal/tam/tel/kan). The
 * playlist declares no #EXT-X-MEDIA, so hls.js reports no audio tracks, and
 * its TS demuxer plays the FIRST AAC PID in the PMT - Hindi - with no API to
 * pick another. Telugu was in every byte we downloaded and unreachable.
 *
 * The server can split the tracks (castle-demux), but that needs ffmpeg and a
 * persistent job store, so it is off on Vercel - which is production. This
 * does the same job in the browser with no re-encode: read the PMT, and swap
 * the chosen track's PID with the first AAC PID in every packet header. hls.js
 * then demuxes the chosen language as if it were the only one. The PMT is not
 * touched, so there is no CRC to recompute.
 */

const PACKET = 188;
const SYNC = 0x47;
// ADTS AAC. hls.js picks the first PMT entry of this type, so only tracks of
// this type are offered: swapping an AC-3 PID into an AAC slot would feed the
// AAC parser data it cannot decode.
const STREAM_TYPE_AAC = 0x0f;
const DESCRIPTOR_LANGUAGE = 0x0a;

const pidOf = (u8, i) => ((u8[i + 1] & 0x1f) << 8) | u8[i + 2];

/** True when every whole packet in the buffer starts on a sync byte. */
function isTs(u8) {
  if (!u8 || u8.length < PACKET * 2) return false;
  const whole = u8.length - (u8.length % PACKET);
  for (let i = 0; i < whole; i += PACKET) if (u8[i] !== SYNC) return false;
  return true;
}

/** Offset of the PSI section in a packet that starts one, or -1. */
function sectionStart(u8, i) {
  if (!(u8[i + 1] & 0x40)) return -1;                 // payload_unit_start
  const afc = (u8[i + 3] >> 4) & 0x03;
  if (afc !== 1 && afc !== 3) return -1;              // no payload
  let p = i + 4;
  if (afc === 3) p += 1 + u8[p];                      // skip adaptation field
  p += 1 + u8[p];                                     // skip pointer_field
  return p < i + PACKET ? p : -1;
}

function findSection(u8, pid, tableId) {
  for (let i = 0; i + PACKET <= u8.length; i += PACKET) {
    if (pidOf(u8, i) !== pid) continue;
    const s = sectionStart(u8, i);
    if (s < 0 || u8[s] !== tableId) continue;
    const len = ((u8[s + 1] & 0x0f) << 8) | u8[s + 2];
    // A section spanning packets is legal but has not been seen from these
    // providers. Declining is safe: playback falls back to the default track.
    if (s + 3 + len > i + PACKET) return null;
    return { start: s, end: s + 3 + len - 4 };        // excludes CRC
  }
  return null;
}

function languageOf(u8, from, to) {
  for (let d = from; d + 2 <= to;) {
    const tag = u8[d];
    const len = u8[d + 1];
    if (tag === DESCRIPTOR_LANGUAGE && len >= 3) {
      const code = String.fromCharCode(u8[d + 2], u8[d + 3], u8[d + 4])
        .replace(/[^a-z]/gi, '').toLowerCase();
      return code && code !== 'und' ? code : null;
    }
    d += 2 + len;
  }
  return null;
}

/**
 * The AAC tracks in one TS segment, in PMT order.
 *
 * @param {Uint8Array} u8
 * @returns {{pid:number, lang:string|null}[]|null} null when the buffer is not
 *   a parseable TS (fMP4, encrypted, truncated) - "unknown", not "no audio".
 */
export function probeTsAudio(u8) {
  if (!isTs(u8)) return null;
  const pat = findSection(u8, 0x0000, 0x00);
  if (!pat) return null;
  let pmtPid = -1;
  for (let p = pat.start + 8; p + 4 <= pat.end; p += 4) {
    const program = (u8[p] << 8) | u8[p + 1];
    if (program !== 0) { pmtPid = ((u8[p + 2] & 0x1f) << 8) | u8[p + 3]; break; }
  }
  if (pmtPid < 0) return null;
  const pmt = findSection(u8, pmtPid, 0x02);
  if (!pmt) return null;

  const infoLen = ((u8[pmt.start + 10] & 0x0f) << 8) | u8[pmt.start + 11];
  const tracks = [];
  for (let p = pmt.start + 12 + infoLen; p + 5 <= pmt.end;) {
    const type = u8[p];
    const pid = ((u8[p + 1] & 0x1f) << 8) | u8[p + 2];
    const esLen = ((u8[p + 3] & 0x0f) << 8) | u8[p + 4];
    if (type === STREAM_TYPE_AAC) tracks.push({ pid, lang: languageOf(u8, p + 5, p + 5 + esLen) });
    p += 5 + esLen;
  }
  return tracks;
}

/**
 * Swap two PIDs in every packet header, in place, so the track on `pidB`
 * plays from the slot hls.js reads (`pidA`). Each stream keeps its own
 * continuity counters, so both remain internally consistent.
 *
 * Refuses (returns false, buffer untouched) when the buffer is not clean TS:
 * a half-swapped segment would be worse than playing the default track.
 */
export function swapPids(u8, pidA, pidB) {
  if (pidA === pidB || !isTs(u8)) return false;
  const whole = u8.length - (u8.length % PACKET);
  for (let i = 0; i < whole; i += PACKET) {
    const pid = pidOf(u8, i);
    const to = pid === pidA ? pidB : pid === pidB ? pidA : -1;
    if (to < 0) continue;
    u8[i + 1] = (u8[i + 1] & 0xe0) | ((to >> 8) & 0x1f);
    u8[i + 2] = to & 0xff;
  }
  return true;
}
