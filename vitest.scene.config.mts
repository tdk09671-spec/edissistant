import { defineConfig } from 'vitest/config';

// The scene renderer's integration suite (Phase 0): starts the real render host (Electron) and FFmpeg.
// Needs `npm run build:main` first, a display (xvfb on Linux) and a normal (non-root) user, because the
// Chromium sandbox stays on. Run with `npm run test:scene`.
export default defineConfig({
  test: {
    include: ['tests/scene/**/*.test.ts'],
    environment: 'node',
    testTimeout: 240_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
