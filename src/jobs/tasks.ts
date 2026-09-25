import { logger } from '../config/logger.js';
import { db } from '../db/knex.js';
import { now, todayIn } from '../lib/clock.js';
import { addDays, humanDate } from '../lib/dates.js';
import { formatInr } from '../lib/money.js';
import { notifyAccountMembers, notifyTenant } from '../modules/notifications/notifications.service.js';
import { chargeQuery } from '../modules/rents/charge-query.js';
import { periodLabelFor } from '../modules/rents/charge-query.js';

export interface ReminderReport {
  accounts: number;
  overdue: number;
  dueSoon: number;
  expiring: number;
}

/**
 * Creates in-app notifications:
 *  - rent that turned overdue -> landlord members (who keep late-rent alerts on) and the tenant
 *  - rent due within `reminder_days_before` days -> the tenant
 *  - fixed-term agreements ending within 30 days -> landlord members
 * Each notification has a dedupe key, so running this repeatedly is safe.
 */
export async function runReminderTasks(): Promise<ReminderReport> {
  const report: ReminderReport = { accounts: 0, overdue: 0, dueSoon: 0, expiring: 0 };
  const accounts = await db('accounts').select('id', 'timezone', 'reminder_days_before');

  for (const account of accounts) {
    report.accounts += 1;
    const today = todayIn(account.timezone);
    try {
      const overdue = await db
        .from(chargeQuery(db, { accountId: account.id }, today).as('x'))
        .where('x.status', 'overdue')
        .select('x.id', 'x.tenant_id', 'x.tenant_name', 'x.unit_name', 'x.kind', 'x.period_start', 'x.period_end', 'x.due_date', 'x.balance');
      for (const c of overdue) {
        const period = periodLabelFor(c.kind, c.period_start, c.period_end);
        report.overdue += await notifyAccountMembers(
          db,
          account.id,
          {
            type: 'rent_overdue',
            title: `${c.unit_name}: rent overdue`,
            body: `${c.tenant_name} has not paid ${formatInr(Number(c.balance))} for ${period} (due ${humanDate(c.due_date)}).`,
            entityType: 'charge',
            entityId: c.id,
            dedupeKey: `overdue:${c.id}`,
          },
          { lateRentOnly: true },
        );
        await notifyTenant(db, c.tenant_id, {
          type: 'rent_overdue',
          title: 'Your rent is overdue',
          body: `${formatInr(Number(c.balance))} for ${c.unit_name} (${period}) was due on ${humanDate(c.due_date)}.`,
          entityType: 'charge',
          entityId: c.id,
          dedupeKey: `tenant-overdue:${c.id}`,
        }, { reminder: true });
      }

      const horizon = addDays(today, account.reminder_days_before);
      const dueSoon = await db
        .from(chargeQuery(db, { accountId: account.id }, today).whereBetween('c.due_date', [today, horizon]).as('x'))
        .where('x.status', 'pending')
        .select('x.id', 'x.tenant_id', 'x.unit_name', 'x.kind', 'x.period_start', 'x.period_end', 'x.due_date', 'x.balance');
      for (const c of dueSoon) {
        report.dueSoon += await notifyTenant(db, c.tenant_id, {
          type: 'rent_due_soon',
          title: c.due_date === today ? 'Rent due today' : `Rent due on ${humanDate(c.due_date)}`,
          body: `${formatInr(Number(c.balance))} for ${c.unit_name} (${periodLabelFor(c.kind, c.period_start, c.period_end)}).`,
          entityType: 'charge',
          entityId: c.id,
          dedupeKey: `due-soon:${c.id}`,
        }, { reminder: true });
      }

      const expiring = await db('agreements as a')
        .join('units as u', 'u.id', 'a.unit_id')
        .join('tenants as t', 't.id', 'a.tenant_id')
        .where({ 'a.account_id': account.id, 'a.status': 'active' })
        .whereNotNull('a.end_date')
        .whereBetween('a.end_date', [today, addDays(today, 30)])
        .select('a.id', 'a.end_date', 'u.name as unit_name', 't.name as tenant_name');
      for (const a of expiring) {
        report.expiring += await notifyAccountMembers(db, account.id, {
          type: 'agreement_expiring',
          title: `${a.unit_name}: agreement ends ${humanDate(a.end_date)}`,
          body: `The agreement with ${a.tenant_name} ends soon. Renew it or plan the move-out.`,
          entityType: 'agreement',
          entityId: a.id,
          dedupeKey: `expiring:${a.id}:${a.end_date}`,
        });
      }
    } catch (error) {
      logger.error({ err: error, accountId: account.id }, 'Reminder task failed for account');
    }
  }
  return report;
}

/** Removes stale authentication artefacts. */
export async function cleanupExpired(): Promise<{ otps: number; tokens: number }> {
  const dayAgo = new Date(now().getTime() - 86_400_000);
  const weekAgo = new Date(now().getTime() - 7 * 86_400_000);
  const otps = await db('otp_codes').where('created_at', '<', dayAgo).delete();
  const tokens = await db('refresh_tokens')
    .where((q) => q.where('expires_at', '<', now()).orWhere('revoked_at', '<', weekAgo))
    .delete();
  return { otps, tokens };
}
