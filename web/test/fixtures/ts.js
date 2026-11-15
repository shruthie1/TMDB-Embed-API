// A minimal MPEG-TS shaped like CastleTV's (measured on 1508168): PAT, a PMT
// on 0x1000 listing H.264 on 0x100 and one ADTS AAC PID per language, then
// payload packets for each PID. Payload bytes carry the PID so a swap is
// visible in the data, not just the header.
function packet(pid, payloadStart, body) {
  const p = new Uint8Array(188).fill(0xff);
  p[0] = 0x47;
  p[1] = (payloadStart ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  p[2] = pid & 0xff;
  p[3] = 0x10;                       // payload only, cc 0
  p.set(body, 4);
  return p;
}
function section(tableId, bodyAfterLength) {
  const len = bodyAfterLength.length + 4;      // + CRC (not checked)
  return [0x00, tableId, 0xb0 | ((len >> 8) & 0x0f), len & 0xff, ...bodyAfterLength, 0, 0, 0, 0];
}
export function buildTs(audio, { extra = [] } = {}) {
  const pat = section(0x00, [0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xf0, 0x00]);
  const es = [0x1b, 0xe1, 0x00, 0xf0, 0x00];   // H.264 on 0x100, no descriptors
  for (const a of [...audio, ...extra]) {
    const desc = a.lang ? [0x0a, 0x04, ...[...a.lang].map((c) => c.charCodeAt(0)), 0x00] : [];
    es.push(a.type ?? 0x0f, 0xe0 | (a.pid >> 8), a.pid & 0xff, 0xf0, desc.length, ...desc);
  }
  const pmt = section(0x02, [0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x00, 0xf0, 0x00, ...es]);
  const parts = [packet(0, true, pat), packet(0x1000, true, pmt), packet(0x100, false, [1, 0, 0])];
  for (const a of [...audio, ...extra]) parts.push(packet(a.pid, false, [2, a.pid >> 8, a.pid & 0xff]));
  const out = new Uint8Array(parts.length * 188);
  parts.forEach((p, i) => out.set(p, i * 188));
  return out;
}
export const CASTLE = [
  { pid: 0x101, lang: 'hin' }, { pid: 0x102, lang: 'mal' }, { pid: 0x103, lang: 'tam' },
  { pid: 0x104, lang: 'tel' }, { pid: 0x105, lang: 'kan' },
];
