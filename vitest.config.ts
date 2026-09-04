import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/live/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environment: 'node',
    reporters: 'default',
  },
});
