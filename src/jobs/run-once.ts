/**
 * Runs the periodic jobs once and exits. Use this from an external scheduler
 * (cron, Kubernetes CronJob, Cloud Scheduler) when JOBS_ENABLED=false.
 */
import { logger } from '../config/logger.js';
import { closeDb } from '../db/knex.js';
import { runScheduledJobs } from './scheduler.js';

try {
  const report = await runScheduledJobs();
  logger.info({ report }, report ? 'Jobs finished' : 'Jobs skipped (lock held by another instance)');
  await closeDb();
  process.exit(0);
} catch (error) {
  logger.error({ err: error }, 'Jobs failed');
  await closeDb();
  process.exit(1);
}
