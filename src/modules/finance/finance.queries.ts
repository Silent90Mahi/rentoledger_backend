import type { Knex } from 'knex';

/**
 * Shared financial aggregations. Everything is derived from transactions:
 * charges (what is owed), payments + allocations (what was received and
 * what it settled) and expenses (money out).
 */

type Q = Knex | Knex.Transaction;

/** Allocation totals per charge for an account (sub-select). */
export function allocationTotals(q: Q, accountId: string): Knex.QueryBuilder {
  return q('payment_allocations').select('charge_id').sum({ paid: 'amount' }).where('account_id', accountId).groupBy('charge_id');
}

/**
 * Cash received in [from, to] (confirmed payments by payment date) broken
 * down by property. Money applied to a charge is attributed to the charge's
 * property; unapplied (advance) money is attributed via the payment's unit.
 */
export async function collectedByProperty(
  q: Q,
  accountId: string,
  from: string,
  to: string,
): Promise<Map<string | null, number>> {
  const { rows } = await q.raw<{ rows: Array<{ property_id: string | null; amount: number }> }>(
    `WITH pay AS (
       SELECT p.id, p.amount, p.unit_id
         FROM payments p
        WHERE p.account_id = ? AND p.status = 'confirmed' AND p.paid_on BETWEEN ?::date AND ?::date
     ),
     applied AS (
       SELECT u.property_id, SUM(pa.amount) AS amount
         FROM pay
         JOIN payment_allocations pa ON pa.payment_id = pay.id
         JOIN rent_charges c ON c.id = pa.charge_id
         JOIN units u ON u.id = c.unit_id
        GROUP BY u.property_id
     ),
     unapplied AS (
       SELECT u.property_id, SUM(pay.amount - COALESCE(x.allocated, 0)) AS amount
         FROM pay
         LEFT JOIN (SELECT payment_id, SUM(amount) AS allocated FROM payment_allocations GROUP BY payment_id) x
                ON x.payment_id = pay.id
         LEFT JOIN units u ON u.id = pay.unit_id
        WHERE pay.amount - COALESCE(x.allocated, 0) > 0
        GROUP BY u.property_id
     )
     SELECT property_id, SUM(amount) AS amount
       FROM (SELECT * FROM applied UNION ALL SELECT * FROM unapplied) t
      GROUP BY property_id`,
    [accountId, from, to],
  );
  return new Map(rows.map((r) => [r.property_id, Number(r.amount)]));
}

export async function expensesByProperty(q: Q, accountId: string, from: string, to: string): Promise<Map<string | null, number>> {
  const rows = await q('expenses as e')
    .leftJoin('units as u', 'u.id', 'e.unit_id')
    .where('e.account_id', accountId)
    .whereBetween('e.expense_date', [from, to])
    .select(q.raw('COALESCE(e.property_id, u.property_id) AS property_id'))
    .sum({ amount: 'e.amount' })
    .groupByRaw('COALESCE(e.property_id, u.property_id)');
  return new Map(rows.map((r: any) => [r.property_id, Number(r.amount)]));
}

/** Rent due (charges by due date) in [from, to] per property. */
export async function expectedByProperty(q: Q, accountId: string, from: string, to: string): Promise<Map<string, number>> {
  const rows = await q('rent_charges as c')
    .join('units as u', 'u.id', 'c.unit_id')
    .where('c.account_id', accountId)
    .whereNull('c.voided_at')
    .whereNot('c.kind', 'opening_balance')
    .whereBetween('c.due_date', [from, to])
    .select('u.property_id')
    .sum({ amount: 'c.total_amount' })
    .groupBy('u.property_id');
  return new Map(rows.map((r: any) => [r.property_id, Number(r.amount)]));
}

/** Outstanding and overdue balances per property as of `today`. */
export async function duesByProperty(
  q: Q,
  accountId: string,
  today: string,
): Promise<Map<string, { outstanding: number; overdue: number }>> {
  const rows = await q('rent_charges as c')
    .join('units as u', 'u.id', 'c.unit_id')
    .leftJoin(allocationTotals(q, accountId).as('al'), 'al.charge_id', 'c.id')
    .where('c.account_id', accountId)
    .whereNull('c.voided_at')
    .select('u.property_id')
    .select(q.raw('SUM(c.total_amount - COALESCE(al.paid, 0)) AS outstanding'))
    .select(
      q.raw('SUM(CASE WHEN c.due_date < ?::date THEN c.total_amount - COALESCE(al.paid, 0) ELSE 0 END) AS overdue', [today]),
    )
    .groupBy('u.property_id');
  return new Map(
    rows.map((r: any) => [r.property_id, { outstanding: Number(r.outstanding), overdue: Number(r.overdue) }]),
  );
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

/** Per-tenant financial summary as of `today`. */
export async function tenantFinancials(q: Q, accountId: string, tenantIds: string[], today: string): Promise<Map<string, TenantFinancials>> {
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

  const charges = await q('rent_charges as c')
    .leftJoin(allocationTotals(q, accountId).as('al'), 'al.charge_id', 'c.id')
    .where('c.account_id', accountId)
    .whereIn('c.tenant_id', tenantIds)
    .whereNull('c.voided_at')
    .select('c.tenant_id')
    .select(q.raw('SUM(c.total_amount) AS charged'))
    .select(q.raw('SUM(c.total_amount - COALESCE(al.paid, 0)) AS outstanding'))
    .select(q.raw('SUM(CASE WHEN c.due_date < ?::date THEN c.total_amount - COALESCE(al.paid, 0) ELSE 0 END) AS overdue', [today]))
    .groupBy('c.tenant_id');
  for (const r of charges as any[]) {
    const f = result.get(r.tenant_id)!;
    f.totalCharged = Number(r.charged);
    f.outstanding = Number(r.outstanding);
    f.overdue = Number(r.overdue);
  }

  const payments = await q('payments as p')
    .leftJoin(
      q('payment_allocations').select('payment_id').sum({ allocated: 'amount' }).where('account_id', accountId).groupBy('payment_id').as('x'),
      'x.payment_id',
      'p.id',
    )
    .where('p.account_id', accountId)
    .whereIn('p.tenant_id', tenantIds)
    .whereIn('p.status', ['confirmed', 'pending'])
    .select('p.tenant_id')
    .select(q.raw(`SUM(CASE WHEN p.status = 'confirmed' THEN p.amount ELSE 0 END) AS paid`))
    .select(q.raw(`SUM(CASE WHEN p.status = 'confirmed' THEN p.amount - COALESCE(x.allocated, 0) ELSE 0 END) AS advance`))
    .select(q.raw(`SUM(CASE WHEN p.status = 'pending' THEN p.amount ELSE 0 END) AS pending`))
    .groupBy('p.tenant_id');
  for (const r of payments as any[]) {
    const f = result.get(r.tenant_id)!;
    f.totalPaid = Number(r.paid);
    f.advanceCredit = Number(r.advance);
    f.pendingConfirmation = Number(r.pending);
  }

  const deposits = await q('deposit_transactions')
    .where('account_id', accountId)
    .whereIn('tenant_id', tenantIds)
    .select('tenant_id')
    .select(q.raw(`SUM(CASE WHEN type = 'received' THEN amount ELSE -amount END) AS held`))
    .groupBy('tenant_id');
  for (const r of deposits as any[]) {
    result.get(r.tenant_id)!.depositHeld = Number(r.held);
  }

  for (const f of result.values()) {
    f.netBalance = Math.round((f.totalCharged - f.totalPaid) * 100) / 100;
  }
  return result;
}

/** Security deposit currently held for each agreement. */
export async function depositHeldByAgreement(q: Q, agreementIds: string[]): Promise<Map<string, number>> {
  if (agreementIds.length === 0) return new Map();
  const rows = await q('deposit_transactions')
    .whereIn('agreement_id', agreementIds)
    .select('agreement_id')
    .select(q.raw(`SUM(CASE WHEN type = 'received' THEN amount ELSE -amount END) AS held`))
    .groupBy('agreement_id');
  return new Map(rows.map((r: any) => [r.agreement_id, Number(r.held)]));
}
