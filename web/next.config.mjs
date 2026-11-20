/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // A verification build writes to its own dist dir so it can never invalidate
  // the chunks a running `next dev` session is serving.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  /**
   * Send the backend's own routes to the Express API in the repo root.
   *
   * This keeps every browser call same-origin, which matters for two reasons:
   * the stream urls the API returns are already rewritten to ITS origin
   * (/m3u8-proxy?url=...), and a cross-origin player fetch would need CORS on
   * every segment. In development API_ORIGIN points at localhost:8790; in
   * production both are served from the same deployment.
   *
   * Only the paths Express actually owns are listed. A catch-all would
   * swallow this app's own /api/* routes (search, rows, title), which are
   * separate and stay in Next.
   */
  async rewrites() {
    const origin = process.env.API_ORIGIN || 'http://localhost:8790';
    return [
      { source: '/api/streams/:path*',      destination: `${origin}/api/streams/:path*` },
      { source: '/api/capabilities',        destination: `${origin}/api/capabilities` },
      { source: '/api/providers/:path*',    destination: `${origin}/api/providers/:path*` },
      { source: '/api/status',              destination: `${origin}/api/status` },
      // Playback outcomes from the player feed the learned ranking.
      { source: '/api/playback-report',     destination: `${origin}/api/playback-report` },
      { source: '/castle-demux/:path*',     destination: `${origin}/castle-demux/:path*` },
      { source: '/m3u8-proxy',              destination: `${origin}/m3u8-proxy` },
      { source: '/ts-proxy',                destination: `${origin}/ts-proxy` },
      // Viewer-chosen pairing: POST /hybrid/pair fuses a video source with an
      // audio source, and the master it returns is served from /hybrid/:id/.
      // Without these the browser posted to NEXT and got a 404, so picking a
      // language from another provider silently fell back to the one already
      // playing. Measured 2026-09-22 on movie/1408162.
      { source: '/hybrid/:path*',           destination: `${origin}/hybrid/:path*` },
      // Segment timestamp shifting, used by a pairing whose two halves
      // disagree on where zero is. The master references it directly.
      { source: '/pts-rebase',              destination: `${origin}/pts-rebase` },
    ];
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'image.tmdb.org' },
      { protocol: 'https', hostname: 'images.metahub.space' },
      { protocol: 'https', hostname: 'm.media-amazon.com' },
    ],
  },
};
