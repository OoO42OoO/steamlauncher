import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // electron-log's main transport touches fs; we don't want tests to
    // actually write anywhere, so silence the transport at module-load
    // time in the test environment.
    setupFiles: ['./vitest.setup.ts'],
  },
});
