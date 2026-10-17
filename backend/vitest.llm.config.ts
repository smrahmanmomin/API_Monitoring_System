import { defineConfig } from 'vitest/config';

/** Opt-in live test against a real LLM provider: requires LLM_API_KEY (never part of the default suite). */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
