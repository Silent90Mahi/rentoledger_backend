import type { Server } from 'node:http';
import { createApp } from './app.js';
import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { ensureIndexes } from './db/indexes.js';
import { closeDb, connectDb, getDb } from './db/mongo.js';
import { startScheduler } from './jobs/scheduler.js';

async function waitForDatabase(attempts = 10): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await connectDb();
      await getDb().command({ ping: 1 });
      return;
    } catch (error) {
      if (i === attempts) throw error;
      logger.warn(`Database not reachable yet (attempt ${i}/${attempts}); retrying...`);
      await new Promise((r) => setTimeout(r, Math.min(1000 * i, 5000)));
    }
  }
}

async function main(): Promise<void> {
  if (config.auth.usingDevSecrets && !config.isTest) {
    logger.warn('Using built-in development secrets. Set JWT_ACCESS_SECRET and OTP_SECRET before deploying.');
  }
  if (config.otp.demoMode) {
    logger.warn('OTP_DEMO_MODE is on: sign-in codes are returned by the API. Anyone can sign in with any phone number. Turn it off before real users.');
  }
  await waitForDatabase();
  // Idempotent: creates any missing collection index (the MongoDB equivalent of migrations).
  await ensureIndexes();

  const app = createApp();
  const server: Server = app.listen(config.server.port, config.server.host, () => {
    logger.info(`RentOLedger API listening on http://${config.server.host}:${config.server.port}${config.server.apiPrefix}`);
  });
  server.keepAliveTimeout = 65_000;
  const stopScheduler = startScheduler();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down gracefully`);
    stopScheduler();
    const force = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 15_000);
    force.unref();
    server.close(async () => {
      await closeDb();
      logger.info('Shutdown complete');
      process.exit(0);
    });
    server.closeIdleConnections?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  process.exit(1);
});

main().catch((error) => {
  logger.fatal({ err: error }, 'Failed to start server');
  process.exit(1);
});
