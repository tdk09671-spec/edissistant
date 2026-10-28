import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose root is src/renderer.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
