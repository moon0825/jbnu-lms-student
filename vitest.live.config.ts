import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    environment: 'node',
    reporters: 'default',
    sequence: { concurrent: false },
  },
});
