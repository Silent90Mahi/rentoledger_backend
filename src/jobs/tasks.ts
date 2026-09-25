import { logger } from '../config/logger.js';
import { col } from '../db/mongo.js';
import { now, todayIn } from '../lib/clock.js';
import { addDays, humanDate } from '../lib/dates.js';
import { formatInr } from '../lib/money.js';
import { notifyAccountMembers, notifyTenant } from '../modules/notifications/notifications.service.js';
import { chargeRefStages, chargeStatusStages, periodLabelFor } from '../modules/rents/charge-query.js';

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
  const accounts = (await col('accounts').find({}, { projection: { timezone: 1, reminder_days_before: 1 } }).toArray()).map((a) => ({
    id: a._id,
    timezone: a.timezone as string,
    reminder_days_before: (a.reminder_days_before as number) ?? 3,
  }));

  for (const account of accounts) {
    report.accounts += 1;
    const today = todayIn(account.timezone);
    try {
      const overdue = await col('rent_charges')
        .aggregate([
          ...chargeStatusStages({ accountId: account.id }, today, { voided_at: null, due_date: { $lt: today } }),
          { $match: { status: 'overdue' } },
          ...chargeRefStages(),
        ])
        .toArray();
      for (const c of overdue) {
        const period = periodLabelFor(c.kind, c.period_start, c.period_end);
        report.overdue += await notifyAccountMembers(
          undefined,
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
        await notifyTenant(undefined, c.tenant_id, {
          type: 'rent_overdue',
          title: 'Your rent is overdue',
          body: `${formatInr(Number(c.balance))} for ${c.unit_name} (${period}) was due on ${humanDate(c.due_date)}.`,
          entityType: 'charge',
          entityId: c.id,
          dedupeKey: `tenant-overdue:${c.id}`,
        }, { reminder: true });
      }

      const horizon = addDays(today, account.reminder_days_before);
      const dueSoon = await col('rent_charges')
        .aggregate([
          ...chargeStatusStages({ accountId: account.id }, today, { voided_at: null, due_date: { $gte: today, $lte: horizon } }),
          { $match: { status: 'pending' } },
          ...chargeRefStages(),
        ])
        .toArray();
      for (const c of dueSoon) {
        report.dueSoon += await notifyTenant(undefined, c.tenant_id, {
          type: 'rent_due_soon',
          title: c.due_date === today ? 'Rent due today' : `Rent due on ${humanDate(c.due_date)}`,
          body: `${formatInr(Number(c.balance))} for ${c.unit_name} (${periodLabelFor(c.kind, c.period_start, c.period_end)}).`,
          entityType: 'charge',
          entityId: c.id,
          dedupeKey: `due-soon:${c.id}`,
        }, { reminder: true });
      }

      const expiringDocs = await col('agreements')
        .find({ account_id: account.id, status: 'active', end_date: { $ne: null, $gte: today, $lte: addDays(today, 30) } })
        .toArray();
      const units = new Map((await col('units').find({ _id: { $in: expiringDocs.map((a) => a.unit_id) } }).toArray()).map((u) => [u._id, u.name]));
      const tenants = new Map((await col('tenants').find({ _id: { $in: expiringDocs.map((a) => a.tenant_id) } }).toArray()).map((t) => [t._id, t.name]));
      const expiring = expiringDocs.map((a) => ({ id: a._id, end_date: a.end_date, unit_name: units.get(a.unit_id), tenant_name: tenants.get(a.tenant_id) }));
      for (const a of expiring) {
        report.expiring += await notifyAccountMembers(undefined, account.id, {
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
  const otps = (await col('otp_codes').deleteMany({ created_at: { $lt: dayAgo } })).deletedCount;
  const tokens = (await col('refresh_tokens').deleteMany({ $or: [{ expires_at: { $lt: now() } }, { revoked_at: { $lt: weekAgo } }] })).deletedCount;
  return { otps, tokens };
}
