import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },   // React 17+ runtime; no React import needed
  test: {
    // jsdom only for hook/component tests; the pure-logic suites (fuzzy,
    // progress, subtitles) do not need it and stay fast on the node pool.
    environment: 'node',
    environmentMatchGlobs: [['test/hooks/**', 'jsdom'], ['test/components/**', 'jsdom']],
  },
});
