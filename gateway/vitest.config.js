import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Inject required env vars for all tests so auth.js doesn't call process.exit
    env: {
      JWT_SECRET: 'vitest-test-secret-do-not-use-in-production',
      JWT_EXPIRES_IN: '1h',
    },
    // Run in Node environment (no browser DOM)
    environment: 'node',
  },
});
