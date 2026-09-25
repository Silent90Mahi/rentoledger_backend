import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { col } from '../db/mongo.js';
import { generateForAllAccounts } from '../modules/rents/generation.service.js';
import { cleanupExpired, runReminderTasks } from './tasks.js';

const JOB_LOCK_ID = 'scheduled-jobs';
/** A crashed holder's lease expires after this long, so jobs never stay blocked. */
const LEASE_MS = 15 * 60_000;
const instanceId = randomUUID();

export interface JobRunReport {
  generation: { accounts: number; created: number };
  reminders: { accounts: number; overdue: number; dueSoon: number; expiring: number };
  cleanup: { otps: number; tokens: number };
  durationMs: number;
}

/** Takes the jobs lease unless another live instance holds it. */
async function acquireLease(): Promise<boolean> {
  const now = new Date();
  try {
    const result = await col('locks').updateOne(
      { _id: JOB_LOCK_ID, $or: [{ expires_at: { $lt: now } }, { holder: instanceId }] },
      { $set: { holder: instanceId, expires_at: new Date(now.getTime() + LEASE_MS), acquired_at: now } },
      { upsert: true },
    );
    return result.modifiedCount + result.upsertedCount > 0;
  } catch (error) {
    // Duplicate key: the lock document exists and is held by someone else.
    if ((error as { code?: number }).code === 11000) return false;
    throw error;
  }
}

async function releaseLease(): Promise<void> {
  await col('locks').updateOne({ _id: JOB_LOCK_ID, holder: instanceId }, { $set: { expires_at: new Date(0) } });
}

/**
 * Runs all periodic jobs once. A lease document guarantees that only one API
 * instance runs them at a time when the service is scaled out.
 * Returns null when another instance holds the lease.
 */
export async function runScheduledJobs(): Promise<JobRunReport | null> {
  const started = Date.now();
  if (!(await acquireLease())) {
    logger.debug('Scheduled jobs skipped: another instance is running them');
    return null;
  }
  try {
    const generation = await generateForAllAccounts();
    const reminders = await runReminderTasks();
    const cleanup = await cleanupExpired();
    const report = { generation, reminders, cleanup, durationMs: Date.now() - started };
    logger.info(report, 'Scheduled jobs completed');
    return report;
  } finally {
    await releaseLease();
  }
}

/** Starts the in-process scheduler; returns a function that stops it. */
export function startScheduler(): () => void {
  if (!config.jobs.enabled) {
    logger.info('Background jobs disabled (JOBS_ENABLED=false)');
    return () => undefined;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runScheduledJobs();
    } catch (error) {
      logger.error({ err: error }, 'Scheduled jobs failed');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 3_000);
  const interval = setInterval(tick, config.jobs.intervalMinutes * 60_000);
  first.unref();
  interval.unref();
  logger.info(`Background jobs scheduled every ${config.jobs.intervalMinutes} minutes`);
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
}
