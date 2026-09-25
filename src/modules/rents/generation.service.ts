import type { ClientSession } from 'mongodb';
import { logger } from '../../config/logger.js';
import { keys } from '../../db/indexes.js';
import { col, newId, toRow, withTransaction } from '../../db/mongo.js';
import { todayIn } from '../../lib/clock.js';
import { addDays } from '../../lib/dates.js';
import { round2 } from '../../lib/money.js';
import { allocateTenant } from '../payments/allocation.service.js';
import { periodsThrough, termsFromRow, type AgreementRow } from './billing.js';

/** Loads an agreement document as the row shape the billing engine uses. */
export function agreementRow(doc: Record<string, any>): AgreementRow {
  return toRow(doc) as unknown as AgreementRow;
}

/**
 * Creates the missing rent entries of an agreement for every billing period
 * that has started on or before `uptoDate`. Idempotent: a period that
 * already has an entry (even a voided one) is never generated again — the
 * unique `rent_period_key` index guarantees it, and upserts keep concurrent
 * runs from failing. New entries are immediately settled from advance credit.
 */
export async function generateChargesForAgreement(
  session: ClientSession,
  agreement: AgreementRow,
  uptoDate: string,
  actorUserId: string | null = null,
): Promise<number> {
  const periods = periodsThrough(termsFromRow(agreement), uptoDate);
  if (periods.length === 0) return 0;

  const existing = new Set<string>(
    (await col('rent_charges').find({ agreement_id: agreement.id, kind: 'rent' }, { session, projection: { period_start: 1 } }).toArray()).map(
      (c) => c.period_start as string,
    ),
  );
  const missing = periods.filter((p) => !existing.has(p.periodStart));
  if (missing.length === 0) return 0;

  const now = new Date();
  const result = await col('rent_charges').bulkWrite(
    missing.map((p) => ({
      updateOne: {
        filter: { rent_period_key: keys.rentPeriod(agreement.id, p.periodStart) },
        update: {
          $setOnInsert: {
            _id: newId(),
            account_id: agreement.account_id,
            agreement_id: agreement.id,
            tenant_id: agreement.tenant_id,
            unit_id: agreement.unit_id,
            kind: 'rent',
            period_start: p.periodStart,
            period_end: p.periodEnd,
            due_date: p.dueDate,
            base_amount: p.baseAmount,
            gst_rate: p.gstRate,
            gst_amount: p.gstAmount,
            total_amount: round2(p.baseAmount + p.gstAmount),
            description: p.isPartial ? `Pro-rated rent for ${p.daysBilled} of ${p.daysInPeriod} days` : null,
            voided_at: null,
            void_reason: null,
            created_by: actorUserId,
            created_at: now,
            updated_at: now,
          },
        },
        upsert: true,
      },
    })),
    { session },
  );

  const created = result.upsertedCount;
  if (created > 0) await allocateTenant(session, agreement.account_id, agreement.tenant_id);
  return created;
}

const lastRun = new Map<string, { day: string; at: number }>();
const THROTTLE_MS = 2 * 60_000;

/** Forget throttling state (used after agreement changes and in tests). */
export function resetGenerationThrottle(accountId?: string): void {
  if (accountId) lastRun.delete(accountId);
  else lastRun.clear();
}

/**
 * Makes sure every agreement of the account has its entries up to `today`.
 * Cheap enough to call before reads (ledger, dashboard); throttled per account.
 */
export async function ensureAccountCharges(accountId: string, today: string, opts: { force?: boolean } = {}): Promise<number> {
  const previous = lastRun.get(accountId);
  if (!opts.force && previous && previous.day === today && Date.now() - previous.at < THROTTLE_MS) return 0;

  const agreements = await col('agreements')
    .find({ account_id: accountId, $or: [{ status: 'active' }, { ended_on: { $gte: addDays(today, -400) } }] })
    .toArray();

  let created = 0;
  for (const doc of agreements) {
    const agreement = agreementRow(doc);
    // Cheap pre-check outside a transaction: skip agreements that are already up to date.
    const periods = periodsThrough(termsFromRow(agreement), today);
    if (periods.length === 0) continue;
    const count = await col('rent_charges').countDocuments({ agreement_id: agreement.id, kind: 'rent' });
    if (count >= periods.length) {
      const last = periods[periods.length - 1];
      const hasLast = await col('rent_charges').countDocuments({ rent_period_key: keys.rentPeriod(agreement.id, last.periodStart) }, { limit: 1 });
      if (hasLast) continue;
    }
    created += await withTransaction((session) => generateChargesForAgreement(session, agreement, today));
  }
  lastRun.set(accountId, { day: today, at: Date.now() });
  if (created > 0) logger.debug({ accountId, created }, 'Generated rent entries');
  return created;
}

/** Runs generation for every account in its own time zone (scheduler). */
export async function generateForAllAccounts(): Promise<{ accounts: number; created: number }> {
  const accounts = await col('accounts').find({}, { projection: { timezone: 1 } }).toArray();
  let created = 0;
  for (const account of accounts) {
    try {
      created += await ensureAccountCharges(account._id, todayIn(account.timezone), { force: true });
    } catch (error) {
      logger.error({ err: error, accountId: account._id }, 'Rent generation failed for account');
    }
  }
  return { accounts: accounts.length, created };
}
