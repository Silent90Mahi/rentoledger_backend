import { logger } from '../../config/logger.js';
import { db, type Trx } from '../../db/knex.js';
import { todayIn } from '../../lib/clock.js';
import { addDays } from '../../lib/dates.js';
import { allocateTenant } from '../payments/allocation.service.js';
import { periodsThrough, termsFromRow, type AgreementRow } from './billing.js';

/**
 * Creates the missing rent entries of an agreement for every billing period
 * that has started on or before `uptoDate`. Idempotent: a period that
 * already has an entry (even a voided one) is never generated again.
 * Newly created entries are immediately settled from any advance credit.
 */
export async function generateChargesForAgreement(
  trx: Trx,
  agreement: AgreementRow,
  uptoDate: string,
  actorUserId: string | null = null,
): Promise<number> {
  const periods = periodsThrough(termsFromRow(agreement), uptoDate);
  if (periods.length === 0) return 0;

  const existing = new Set<string>(
    await trx('rent_charges').where({ agreement_id: agreement.id, kind: 'rent' }).pluck('period_start'),
  );
  const missing = periods.filter((p) => !existing.has(p.periodStart));
  if (missing.length === 0) return 0;

  const inserted = await trx('rent_charges')
    .insert(
      missing.map((p) => ({
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
        description: p.isPartial ? `Pro-rated rent for ${p.daysBilled} of ${p.daysInPeriod} days` : null,
        created_by: actorUserId,
      })),
    )
    .onConflict()
    .ignore()
    .returning('id');

  if (inserted.length > 0) {
    await allocateTenant(trx, agreement.account_id, agreement.tenant_id);
  }
  return inserted.length;
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

  const agreements: AgreementRow[] = await db('agreements')
    .where('account_id', accountId)
    .where((q) => q.where('status', 'active').orWhere('ended_on', '>=', addDays(today, -400)))
    .select('*');

  let created = 0;
  for (const agreement of agreements) {
    created += await db.transaction((trx) => generateChargesForAgreement(trx, agreement, today));
  }
  lastRun.set(accountId, { day: today, at: Date.now() });
  if (created > 0) logger.debug({ accountId, created }, 'Generated rent entries');
  return created;
}

/** Runs generation for every account in its own time zone (scheduler). */
export async function generateForAllAccounts(): Promise<{ accounts: number; created: number }> {
  const accounts = await db('accounts').select('id', 'timezone');
  let created = 0;
  for (const account of accounts) {
    try {
      created += await ensureAccountCharges(account.id, todayIn(account.timezone), { force: true });
    } catch (error) {
      logger.error({ err: error, accountId: account.id }, 'Rent generation failed for account');
    }
  }
  return { accounts: accounts.length, created };
}
