import type { Trx } from '../../db/knex.js';
import { fromPaise, toPaise } from '../../lib/money.js';

/**
 * Settles open charges of a tenant with the unallocated part of their
 * confirmed payments.
 *
 * - A payment made "for" a specific entry (target_charge_id) settles that
 *   entry first; everything else is applied oldest-due-first (FIFO).
 * - Whatever cannot be applied stays unallocated and is the tenant's
 *   advance credit; it is consumed automatically when new charges appear.
 * - Existing allocations are never moved, so an owner's explicit choice
 *   ("this payment was for September") is preserved.
 *
 * Must run inside a transaction; the tenant row is locked to serialise
 * concurrent allocations for the same tenant.
 */
export async function allocateTenant(trx: Trx, accountId: string, tenantId: string): Promise<void> {
  await trx.raw('SELECT id FROM tenants WHERE id = ? AND account_id = ? FOR UPDATE', [tenantId, accountId]);

  const { rows: payments } = await trx.raw<{ rows: Array<{ id: string; target_charge_id: string | null; unallocated: number }> }>(
    `SELECT p.id, p.target_charge_id, p.amount - COALESCE(SUM(pa.amount), 0) AS unallocated
       FROM payments p
       LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
      WHERE p.account_id = ? AND p.tenant_id = ? AND p.status = 'confirmed'
      GROUP BY p.id
     HAVING p.amount - COALESCE(SUM(pa.amount), 0) > 0
      ORDER BY p.paid_on, p.created_at`,
    [accountId, tenantId],
  );
  if (payments.length === 0) return;

  const { rows: charges } = await trx.raw<{ rows: Array<{ id: string; remaining: number }> }>(
    `SELECT c.id, c.total_amount - COALESCE(SUM(pa.amount), 0) AS remaining
       FROM rent_charges c
       LEFT JOIN payment_allocations pa ON pa.charge_id = c.id
      WHERE c.account_id = ? AND c.tenant_id = ? AND c.voided_at IS NULL
      GROUP BY c.id
     HAVING c.total_amount - COALESCE(SUM(pa.amount), 0) > 0
      ORDER BY c.due_date, c.period_start, c.created_at`,
    [accountId, tenantId],
  );
  if (charges.length === 0) return;

  const remaining = new Map<string, number>(charges.map((c) => [c.id, toPaise(Number(c.remaining))]));
  const fifo = charges.map((c) => c.id);
  const planned = new Map<string, { paymentId: string; chargeId: string; paise: number }>();

  for (const payment of payments) {
    let credit = toPaise(Number(payment.unallocated));
    const target = payment.target_charge_id;
    const order = target && (remaining.get(target) ?? 0) > 0 ? [target, ...fifo.filter((id) => id !== target)] : fifo;
    for (const chargeId of order) {
      if (credit <= 0) break;
      const open = remaining.get(chargeId) ?? 0;
      if (open <= 0) continue;
      const applied = Math.min(open, credit);
      remaining.set(chargeId, open - applied);
      credit -= applied;
      const key = `${payment.id}:${chargeId}`;
      const existing = planned.get(key);
      planned.set(key, { paymentId: payment.id, chargeId, paise: (existing?.paise ?? 0) + applied });
    }
  }

  if (planned.size === 0) return;
  const values = [...planned.values()];
  const placeholders = values.map(() => '(?, ?, ?, ?)').join(', ');
  await trx.raw(
    `INSERT INTO payment_allocations (account_id, payment_id, charge_id, amount)
     VALUES ${placeholders}
     ON CONFLICT (payment_id, charge_id)
     DO UPDATE SET amount = payment_allocations.amount + EXCLUDED.amount`,
    values.flatMap((v) => [accountId, v.paymentId, v.chargeId, fromPaise(v.paise)]),
  );
}

/** Removes every allocation of a payment (used when a payment is voided/rejected/edited). */
export async function clearPaymentAllocations(trx: Trx, paymentId: string): Promise<void> {
  await trx('payment_allocations').where({ payment_id: paymentId }).delete();
}

/** Removes every allocation made to a charge (used when a charge is voided). */
export async function clearChargeAllocations(trx: Trx, chargeId: string): Promise<void> {
  await trx('payment_allocations').where({ charge_id: chargeId }).delete();
}

/**
 * Shrinks the allocations of a charge so they do not exceed its new total
 * (e.g. after the amount was reduced). The most recent payments are
 * released first; released money becomes credit for the FIFO pass.
 */
export async function trimChargeAllocations(trx: Trx, chargeId: string, newTotal: number): Promise<void> {
  const allocations = await trx('payment_allocations as pa')
    .join('payments as p', 'p.id', 'pa.payment_id')
    .where('pa.charge_id', chargeId)
    .orderBy([
      { column: 'p.paid_on', order: 'desc' },
      { column: 'p.created_at', order: 'desc' },
    ])
    .select('pa.id', 'pa.amount');
  let excess = allocations.reduce((sum, a) => sum + toPaise(Number(a.amount)), 0) - toPaise(newTotal);
  for (const allocation of allocations) {
    if (excess <= 0) break;
    const amount = toPaise(Number(allocation.amount));
    if (amount <= excess) {
      await trx('payment_allocations').where({ id: allocation.id }).delete();
      excess -= amount;
    } else {
      await trx('payment_allocations').where({ id: allocation.id }).update({ amount: fromPaise(amount - excess) });
      excess = 0;
    }
  }
}

/** Unallocated (advance) credit of a tenant from confirmed payments. */
export async function tenantAdvanceCredit(trx: Trx | import('knex').Knex, tenantId: string): Promise<number> {
  const { rows } = await trx.raw<{ rows: Array<{ credit: number }> }>(
    `SELECT COALESCE(SUM(p.amount - COALESCE(a.allocated, 0)), 0) AS credit
       FROM payments p
       LEFT JOIN (SELECT payment_id, SUM(amount) AS allocated FROM payment_allocations GROUP BY payment_id) a
              ON a.payment_id = p.id
      WHERE p.tenant_id = ? AND p.status = 'confirmed'`,
    [tenantId],
  );
  return Number(rows[0]?.credit ?? 0);
}
