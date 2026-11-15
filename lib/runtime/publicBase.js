'use strict';

// The origin viewers reach this API on, for every absolute url we hand out
// (proxied playlists, castle-demux masters, hybrid masters).
//
// PUBLIC_BASE_URL wins when set. Behind a reverse proxy on a VM the request
// can arrive as http://127.0.0.1:8787, and an http url handed to the https web
// app is blocked as mixed content - the stream silently never loads. Only
// serverUrlFor() honoured the variable before; eight other call sites built
// the base from the request, so the castle-demux row and every hybrid master
// ignored it.
//
// Unset, this is exactly the request-derived base those call sites used.
function publicBase(req, protocol = req.protocol) {
  const fixed = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (fixed) return fixed;
  return `${protocol}://${req.get('host')}`;
}

module.exports = { publicBase };
