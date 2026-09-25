import type pg from 'pg';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { db } from '../db/knex.js';
import { generateForAllAccounts } from '../modules/rents/generation.service.js';
import { cleanupExpired, runReminderTasks } from './tasks.js';

/** Arbitrary constant identifying the scheduler's Postgres advisory lock. */
const JOB_LOCK_KEY = 72_615_004;

export interface JobRunReport {
  generation: { accounts: number; created: number };
  reminders: { accounts: number; overdue: number; dueSoon: number; expiring: number };
  cleanup: { otps: number; tokens: number };
  durationMs: number;
}

/**
 * Runs all periodic jobs once. A session-level advisory lock guarantees that
 * only one API instance runs them at a time when the service is scaled out.
 * Returns null when another instance holds the lock.
 */
export async function runScheduledJobs(): Promise<JobRunReport | null> {
  const started = Date.now();
  const client = (await db.client.acquireConnection()) as pg.Client;
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [JOB_LOCK_KEY]);
    if (!rows[0]?.locked) {
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
      await client.query('SELECT pg_advisory_unlock($1)', [JOB_LOCK_KEY]);
    }
  } finally {
    await db.client.releaseConnection(client);
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
