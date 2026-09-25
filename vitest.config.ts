import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup-env.ts'],
    include: ['tests/**/*.test.ts'],
    // All suites share one MongoDB database, so run files one at a time.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 180_000,
    env: {
      NODE_ENV: 'test',
      DEV_OTP_CODE: '123456',
      OTP_RESEND_COOLDOWN_SECONDS: '0',
      OTP_MAX_PER_HOUR: '50',
      LOG_LEVEL: 'silent',
      JOBS_ENABLED: 'false',
    },
  },
});
