import { col, round2, type Session } from '../../db/mongo.js';
import { chargeStatusStages } from '../rents/charge-query.js';

/**
 * Shared financial aggregations. Everything is derived from transactions:
 * charges (what is owed), payments + allocations (what was received and
 * what it settled) and expenses (money out).
 */

const sessionOpt = (session?: Session) => (session ? { session } : {});

/** Confirmed allocations per charge id. */
export async function paidByCharge(chargeIds: string[], session?: Session): Promise<Map<string, number>> {
  if (chargeIds.length === 0) return new Map();
  const rows = await col('payment_allocations')
    .aggregate([{ $match: { charge_id: { $in: chargeIds } } }, { $group: { _id: '$charge_id', paid: { $sum: '$amount' } } }], sessionOpt(session))
    .toArray();
  return new Map(rows.map((r) => [r._id as string, round2(r.paid)]));
}

/** Allocated amount per payment id. */
export async function allocatedByPayment(paymentIds: string[], session?: Session): Promise<Map<string, number>> {
  if (paymentIds.length === 0) return new Map();
  const rows = await col('payment_allocations')
    .aggregate([{ $match: { payment_id: { $in: paymentIds } } }, { $group: { _id: '$payment_id', allocated: { $sum: '$amount' } } }], sessionOpt(session))
    .toArray();
  return new Map(rows.map((r) => [r._id as string, round2(r.allocated)]));
}

/** unit id -> property id for the given units (or every unit of the account). */
async function unitPropertyMap(accountId: string, unitIds?: string[]): Promise<Map<string, string>> {
  const filter = unitIds ? { account_id: accountId, _id: { $in: unitIds } } : { account_id: accountId };
  const units = await col('units').find(filter, { projection: { property_id: 1 } }).toArray();
  return new Map(units.map((u) => [u._id, u.property_id as string]));
}

function addTo<K>(map: Map<K, number>, key: K, amount: number) {
  map.set(key, round2((map.get(key) ?? 0) + amount));
}

/**
 * Cash received in [from, to] (confirmed payments by payment date) broken
 * down by property. Money applied to a charge is attributed to the charge's
 * property; unapplied (advance) money is attributed via the payment's unit.
 */
export async function collectedByProperty(accountId: string, from: string, to: string): Promise<Map<string | null, number>> {
  const payments = await col('payments')
    .find({ account_id: accountId, status: 'confirmed', paid_on: { $gte: from, $lte: to } }, { projection: { amount: 1, unit_id: 1 } })
    .toArray();
  const result = new Map<string | null, number>();
  if (payments.length === 0) return result;

  const allocations = await col('payment_allocations')
    .find({ payment_id: { $in: payments.map((p) => p._id) } }, { projection: { payment_id: 1, charge_id: 1, amount: 1 } })
    .toArray();
  const charges = await col('rent_charges')
    .find({ _id: { $in: [...new Set(allocations.map((a) => a.charge_id))] } }, { projection: { unit_id: 1 } })
    .toArray();
  const chargeUnit = new Map(charges.map((c) => [c._id, c.unit_id as string]));
  const unitProperty = await unitPropertyMap(accountId);

  const allocatedPerPayment = new Map<string, number>();
  for (const a of allocations) {
    addTo(result, unitProperty.get(chargeUnit.get(a.charge_id) ?? '') ?? null, a.amount);
    addTo(allocatedPerPayment, a.payment_id, a.amount);
  }
  for (const p of payments) {
    const unapplied = round2(p.amount - (allocatedPerPayment.get(p._id) ?? 0));
    if (unapplied > 0) addTo(result, p.unit_id ? (unitProperty.get(p.unit_id) ?? null) : null, unapplied);
  }
  return result;
}

export async function expensesByProperty(accountId: string, from: string, to: string): Promise<Map<string | null, number>> {
  const rows = await col('expenses')
    .aggregate([
      { $match: { account_id: accountId, expense_date: { $gte: from, $lte: to } } },
      { $group: { _id: { property_id: '$property_id', unit_id: '$unit_id' }, amount: { $sum: '$amount' } } },
    ])
    .toArray();
  const unitProperty = await unitPropertyMap(accountId);
  const result = new Map<string | null, number>();
  for (const r of rows) {
    const propertyId = r._id.property_id ?? (r._id.unit_id ? (unitProperty.get(r._id.unit_id) ?? null) : null);
    addTo(result, propertyId, r.amount);
  }
  return result;
}

/** Rent due (charges by due date) in [from, to] per property. */
export async function expectedByProperty(accountId: string, from: string, to: string): Promise<Map<string, number>> {
  const rows = await col('rent_charges')
    .aggregate([
      { $match: { account_id: accountId, voided_at: null, kind: { $ne: 'opening_balance' }, due_date: { $gte: from, $lte: to } } },
      { $group: { _id: '$unit_id', amount: { $sum: '$total_amount' } } },
    ])
    .toArray();
  const unitProperty = await unitPropertyMap(accountId);
  const result = new Map<string, number>();
  for (const r of rows) {
    const propertyId = unitProperty.get(r._id);
    if (propertyId) addTo(result, propertyId, r.amount);
  }
  return result;
}

/** Outstanding and overdue balances per property as of `today`. */
export async function duesByProperty(accountId: string, today: string): Promise<Map<string, { outstanding: number; overdue: number }>> {
  const rows = await col('rent_charges')
    .aggregate([
      ...chargeStatusStages({ accountId }, today, { voided_at: null }),
      {
        $group: {
          _id: '$unit_id',
          outstanding: { $sum: '$balance' },
          overdue: { $sum: { $cond: [{ $lt: ['$due_date', today] }, '$balance', 0] } },
        },
      },
    ])
    .toArray();
  const unitProperty = await unitPropertyMap(accountId);
  const result = new Map<string, { outstanding: number; overdue: number }>();
  for (const r of rows) {
    const propertyId = unitProperty.get(r._id);
    if (!propertyId) continue;
    const current = result.get(propertyId) ?? { outstanding: 0, overdue: 0 };
    result.set(propertyId, { outstanding: round2(current.outstanding + r.outstanding), overdue: round2(current.overdue + r.overdue) });
  }
  return result;
}

export interface TenantFinancials {
  totalCharged: number;
  totalPaid: number;
  outstanding: number;
  overdue: number;
  advanceCredit: number;
  netBalance: number;
  depositHeld: number;
  pendingConfirmation: number;
}

/**
 * Balance per tenant: charged, outstanding and overdue are summed from each
 * live entry's total minus what has been allocated to it; paid, advance and
 * pending come from the tenant's payments.
 */
export async function tenantFinancials(accountId: string, tenantIds: string[], today: string): Promise<Map<string, TenantFinancials>> {
  const result = new Map<string, TenantFinancials>();
  if (tenantIds.length === 0) return result;
  for (const id of tenantIds) {
    result.set(id, {
      totalCharged: 0,
      totalPaid: 0,
      outstanding: 0,
      overdue: 0,
      advanceCredit: 0,
      netBalance: 0,
      depositHeld: 0,
      pendingConfirmation: 0,
    });
  }

  const [charges, payments, deposits] = await Promise.all([
    col('rent_charges')
      .aggregate([
        ...chargeStatusStages({ accountId }, today, { tenant_id: { $in: tenantIds }, voided_at: null }),
        {
          $group: {
            _id: '$tenant_id',
            charged: { $sum: '$total_amount' },
            outstanding: { $sum: '$balance' },
            overdue: { $sum: { $cond: [{ $lt: ['$due_date', today] }, '$balance', 0] } },
          },
        },
      ])
      .toArray(),
    col('payments')
      .find({ account_id: accountId, tenant_id: { $in: tenantIds }, status: { $in: ['confirmed', 'pending'] } }, { projection: { tenant_id: 1, amount: 1, status: 1 } })
      .toArray(),
    col('deposit_transactions')
      .aggregate([
        { $match: { account_id: accountId, tenant_id: { $in: tenantIds } } },
        { $group: { _id: '$tenant_id', held: { $sum: { $cond: [{ $eq: ['$type', 'received'] }, '$amount', { $multiply: ['$amount', -1] }] } } } },
      ])
      .toArray(),
  ]);

  for (const r of charges) {
    const f = result.get(r._id)!;
    f.totalCharged = round2(r.charged);
    f.outstanding = round2(r.outstanding);
    f.overdue = round2(r.overdue);
  }

  const allocated = await allocatedByPayment(payments.filter((p) => p.status === 'confirmed').map((p) => p._id));
  for (const p of payments) {
    const f = result.get(p.tenant_id)!;
    if (p.status === 'confirmed') {
      f.totalPaid = round2(f.totalPaid + p.amount);
      f.advanceCredit = round2(f.advanceCredit + p.amount - (allocated.get(p._id) ?? 0));
    } else {
      f.pendingConfirmation = round2(f.pendingConfirmation + p.amount);
    }
  }

  for (const r of deposits) result.get(r._id)!.depositHeld = round2(r.held);

  for (const f of result.values()) {
    f.netBalance = round2(f.totalCharged - f.totalPaid);
  }
  return result;
}

/** Security deposit currently held for each agreement. */
export async function depositHeldByAgreement(agreementIds: string[], session?: Session): Promise<Map<string, number>> {
  if (agreementIds.length === 0) return new Map();
  const rows = await col('deposit_transactions')
    .aggregate(
      [
        { $match: { agreement_id: { $in: agreementIds } } },
        { $group: { _id: '$agreement_id', held: { $sum: { $cond: [{ $eq: ['$type', 'received'] }, '$amount', { $multiply: ['$amount', -1] }] } } } },
      ],
      sessionOpt(session),
    )
    .toArray();
  return new Map(rows.map((r) => [r._id as string, round2(r.held)]));
}
