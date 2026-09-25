import type { ClientSession } from 'mongodb';
import { col, lockDoc, newId, round2, type Session } from '../../db/mongo.js';
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
 * Must run inside a transaction; the tenant document is locked so concurrent
 * allocations for the same tenant are serialised (the loser retries).
 */
export async function allocateTenant(session: ClientSession, accountId: string, tenantId: string): Promise<void> {
  await lockDoc('tenants', tenantId, session);

  const payments = await col('payments')
    .find({ account_id: accountId, tenant_id: tenantId, status: 'confirmed' }, { session })
    .sort({ paid_on: 1, created_at: 1 })
    .toArray();
  if (payments.length === 0) return;

  const charges = await col('rent_charges')
    .find({ account_id: accountId, tenant_id: tenantId, voided_at: null }, { session })
    .sort({ due_date: 1, period_start: 1, created_at: 1 })
    .toArray();
  if (charges.length === 0) return;

  const allocations = await col('payment_allocations')
    .find({ account_id: accountId, $or: [{ payment_id: { $in: payments.map((p) => p._id) } }, { charge_id: { $in: charges.map((c) => c._id) } }] }, { session })
    .toArray();

  const allocatedByPayment = new Map<string, number>();
  const allocatedByCharge = new Map<string, number>();
  const existing = new Map<string, { id: string; paise: number }>();
  for (const a of allocations) {
    const paise = toPaise(a.amount);
    allocatedByPayment.set(a.payment_id, (allocatedByPayment.get(a.payment_id) ?? 0) + paise);
    allocatedByCharge.set(a.charge_id, (allocatedByCharge.get(a.charge_id) ?? 0) + paise);
    existing.set(`${a.payment_id}:${a.charge_id}`, { id: a._id, paise });
  }

  const remaining = new Map<string, number>();
  for (const c of charges) {
    const open = toPaise(c.total_amount) - (allocatedByCharge.get(c._id) ?? 0);
    if (open > 0) remaining.set(c._id, open);
  }
  if (remaining.size === 0) return;
  const fifo = charges.map((c) => c._id).filter((id) => remaining.has(id));

  const planned = new Map<string, { paymentId: string; chargeId: string; paise: number }>();
  for (const payment of payments) {
    let credit = toPaise(payment.amount) - (allocatedByPayment.get(payment._id) ?? 0);
    if (credit <= 0) continue;
    const target = payment.target_charge_id as string | null;
    const order = target && (remaining.get(target) ?? 0) > 0 ? [target, ...fifo.filter((id) => id !== target)] : fifo;
    for (const chargeId of order) {
      if (credit <= 0) break;
      const open = remaining.get(chargeId) ?? 0;
      if (open <= 0) continue;
      const applied = Math.min(open, credit);
      remaining.set(chargeId, open - applied);
      credit -= applied;
      const key = `${payment._id}:${chargeId}`;
      const prior = planned.get(key);
      planned.set(key, { paymentId: payment._id, chargeId, paise: (prior?.paise ?? 0) + applied });
    }
  }
  if (planned.size === 0) return;

  const now = new Date();
  await col('payment_allocations').bulkWrite(
    [...planned.entries()].map(([key, plan]) => {
      const current = existing.get(key);
      return current
        ? { updateOne: { filter: { _id: current.id }, update: { $set: { amount: fromPaise(current.paise + plan.paise) } } } }
        : {
            insertOne: {
              document: { _id: newId(), account_id: accountId, payment_id: plan.paymentId, charge_id: plan.chargeId, amount: fromPaise(plan.paise), created_at: now },
            },
          };
    }),
    { session },
  );
}

/** Removes every allocation of a payment (used when a payment is voided/rejected/edited). */
export async function clearPaymentAllocations(session: ClientSession, paymentId: string): Promise<void> {
  await col('payment_allocations').deleteMany({ payment_id: paymentId }, { session });
}

/** Removes every allocation made to a charge (used when a charge is voided). */
export async function clearChargeAllocations(session: ClientSession, chargeId: string): Promise<void> {
  await col('payment_allocations').deleteMany({ charge_id: chargeId }, { session });
}

/**
 * Shrinks the allocations of a charge so they do not exceed its new total
 * (e.g. after the amount was reduced). The most recent payments are
 * released first; released money becomes credit for the FIFO pass.
 */
export async function trimChargeAllocations(session: ClientSession, chargeId: string, newTotal: number): Promise<void> {
  const allocations = await col('payment_allocations').find({ charge_id: chargeId }, { session }).toArray();
  if (allocations.length === 0) return;
  const payments = new Map(
    (await col('payments').find({ _id: { $in: allocations.map((a) => a.payment_id) } }, { session, projection: { paid_on: 1, created_at: 1 } }).toArray()).map(
      (p) => [p._id, p],
    ),
  );
  // Latest payment first.
  allocations.sort((a, b) => {
    const pa = payments.get(a.payment_id);
    const pb = payments.get(b.payment_id);
    const byDate = String(pb?.paid_on ?? '').localeCompare(String(pa?.paid_on ?? ''));
    if (byDate !== 0) return byDate;
    return new Date(pb?.created_at ?? 0).getTime() - new Date(pa?.created_at ?? 0).getTime();
  });

  let excess = allocations.reduce((sum, a) => sum + toPaise(a.amount), 0) - toPaise(newTotal);
  for (const allocation of allocations) {
    if (excess <= 0) break;
    const amount = toPaise(allocation.amount);
    if (amount <= excess) {
      await col('payment_allocations').deleteOne({ _id: allocation._id }, { session });
      excess -= amount;
    } else {
      await col('payment_allocations').updateOne({ _id: allocation._id }, { $set: { amount: fromPaise(amount - excess) } }, { session });
      excess = 0;
    }
  }
}

/** Unallocated (advance) credit of a tenant from confirmed payments. */
export async function tenantAdvanceCredit(tenantId: string, session?: Session): Promise<number> {
  const payments = await col('payments')
    .find({ tenant_id: tenantId, status: 'confirmed' }, { ...(session ? { session } : {}), projection: { amount: 1 } })
    .toArray();
  if (payments.length === 0) return 0;
  const allocated = await col('payment_allocations')
    .aggregate([{ $match: { payment_id: { $in: payments.map((p) => p._id) } } }, { $group: { _id: null, total: { $sum: '$amount' } } }], session ? { session } : {})
    .toArray();
  const paid = payments.reduce((sum, p) => sum + toPaise(p.amount), 0);
  return round2(fromPaise(paid - toPaise(allocated[0]?.total ?? 0)));
}
