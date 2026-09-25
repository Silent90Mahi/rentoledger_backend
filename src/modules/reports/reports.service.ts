import { db } from '../../db/knex.js';
import type { Ctx } from '../../lib/context.js';
import { diffDays, monthKeyOf, monthKeysBetween, monthLabel, shortMonthLabel } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import { round2 } from '../../lib/money.js';
import { likePattern } from '../../lib/validation.js';
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from '../expenses/expenses.service.js';
import { allocationTotals, collectedByProperty, expectedByProperty, expensesByProperty, duesByProperty } from '../finance/finance.queries.js';
import { chargeQuery } from '../rents/charge-query.js';
import { ensureAccountCharges } from '../rents/generation.service.js';
import { unitsWithOccupancy } from '../units/occupancy.js';

export interface DateRange {
  from: string;
  to: string;
}

function assertRange(range: DateRange) {
  if (range.from > range.to) {
    throw Errors.validation('"from" must be on or before "to".', [{ field: 'from', message: 'Invalid date range' }]);
  }
  if (diffDays(range.from, range.to) > 366 * 10) {
    throw Errors.validation('Date range is too large (max 10 years).', [{ field: 'from', message: 'Range too large' }]);
  }
}

/** Cash received in the range, optionally restricted to one property (attribution via allocations/unit). */
async function cashCollected(ctx: Ctx, range: DateRange, propertyId?: string): Promise<number> {
  if (!propertyId) {
    const [row] = await db('payments')
      .where({ account_id: ctx.accountId, status: 'confirmed' })
      .whereBetween('paid_on', [range.from, range.to])
      .sum({ total: 'amount' });
    return Number(row?.total ?? 0);
  }
  const byProperty = await collectedByProperty(db, ctx.accountId, range.from, range.to);
  return byProperty.get(propertyId) ?? 0;
}

export async function reportSummary(ctx: Ctx, range: DateRange & { propertyId?: string }) {
  assertRange(range);
  await ensureAccountCharges(ctx.accountId, ctx.today);

  const scoped = chargeQuery(db, { accountId: ctx.accountId }, ctx.today).modify((q) => {
    if (range.propertyId) q.where('p.id', range.propertyId);
  });

  const [billed] = await db
    .from(scoped.clone().whereBetween('c.due_date', [range.from, range.to]).as('x'))
    .whereNot('x.status', 'void')
    .whereNot('x.kind', 'opening_balance')
    .select(
      db.raw('COALESCE(SUM(x.total_amount), 0) AS expected'),
      db.raw('COALESCE(SUM(x.paid_amount), 0) AS collected_of_expected'),
      db.raw('COALESCE(SUM(x.gst_amount), 0) AS gst_billed'),
      db.raw('COUNT(*) AS entries'),
    );
  const [dues] = await db
    .from(scoped.clone().where('c.due_date', '<=', range.to).as('x'))
    .whereNot('x.status', 'void')
    .select(
      db.raw('COALESCE(SUM(x.balance), 0) AS outstanding'),
      db.raw('COALESCE(SUM(x.balance) FILTER (WHERE x.is_overdue), 0) AS overdue'),
    );

  // GST share of the cash received in the range.
  const { rows: gstRows } = await db.raw<{ rows: Array<{ gst: number }> }>(
    `SELECT COALESCE(SUM(CASE WHEN c.total_amount > 0 THEN pa.amount * c.gst_amount / c.total_amount ELSE 0 END), 0) AS gst
       FROM payment_allocations pa
       JOIN payments p ON p.id = pa.payment_id
       JOIN rent_charges c ON c.id = pa.charge_id
       JOIN units u ON u.id = c.unit_id
      WHERE p.account_id = ? AND p.status = 'confirmed' AND p.paid_on BETWEEN ?::date AND ?::date
        ${range.propertyId ? 'AND u.property_id = ?' : ''}`,
    range.propertyId ? [ctx.accountId, range.from, range.to, range.propertyId] : [ctx.accountId, range.from, range.to],
  );

  const collected = await cashCollected(ctx, range, range.propertyId);
  const expenses = range.propertyId
    ? ((await expensesByProperty(db, ctx.accountId, range.from, range.to)).get(range.propertyId) ?? 0)
    : Number(
        (
          await db('expenses').where({ account_id: ctx.accountId }).whereBetween('expense_date', [range.from, range.to]).sum({ total: 'amount' })
        )[0]?.total ?? 0,
      );

  const [deposits] = await db('deposit_transactions as d')
    .join('agreements as a', 'a.id', 'd.agreement_id')
    .join('units as u', 'u.id', 'a.unit_id')
    .where('d.account_id', ctx.accountId)
    .modify((q) => {
      if (range.propertyId) q.where('u.property_id', range.propertyId);
    })
    .select(
      db.raw(`COALESCE(SUM(CASE WHEN d.type = 'received' THEN d.amount ELSE -d.amount END), 0) AS held`),
      db.raw(`COALESCE(SUM(d.amount) FILTER (WHERE d.type = 'deducted' AND d.txn_date BETWEEN ?::date AND ?::date), 0) AS deducted`, [
        range.from,
        range.to,
      ]),
    );

  const expected = Number(billed.expected);
  const collectedOfExpected = Number(billed.collected_of_expected);
  const depositDeductions = Number(deposits?.deducted ?? 0);
  return {
    from: range.from,
    to: range.to,
    propertyId: range.propertyId ?? null,
    expected,
    collected,
    collectedOfExpected,
    collectionRate: expected > 0 ? Math.round((collectedOfExpected / expected) * 1000) / 10 : 0,
    gstBilled: Number(billed.gst_billed),
    gstCollected: round2(Number(gstRows[0]?.gst ?? 0)),
    outstanding: Number(dues.outstanding),
    overdue: Number(dues.overdue),
    expenses,
    depositDeductions,
    netIncome: round2(collected + depositDeductions - expenses),
    depositsHeld: Number(deposits?.held ?? 0),
    entries: Number(billed.entries),
  };
}

export async function collectionsReport(ctx: Ctx, range: DateRange & { groupBy: 'month' | 'year'; propertyId?: string }) {
  assertRange(range);
  await ensureAccountCharges(ctx.accountId, ctx.today);
  const fmt = range.groupBy === 'year' ? 'YYYY' : 'YYYY-MM';

  const expectedRows = await db('rent_charges as c')
    .join('units as u', 'u.id', 'c.unit_id')
    .leftJoin(allocationTotals(db, ctx.accountId).as('al'), 'al.charge_id', 'c.id')
    .where('c.account_id', ctx.accountId)
    .whereNull('c.voided_at')
    .whereNot('c.kind', 'opening_balance')
    .whereBetween('c.due_date', [range.from, range.to])
    .modify((q) => {
      if (range.propertyId) q.where('u.property_id', range.propertyId);
    })
    .select(db.raw(`to_char(c.due_date, '${fmt}') AS bucket`))
    .select(db.raw('SUM(c.total_amount) AS expected'))
    .select(db.raw('SUM(COALESCE(al.paid, 0)) AS collected_of_expected'))
    .groupByRaw(`to_char(c.due_date, '${fmt}')`);

  let cashRows: Array<{ bucket: string; collected: number }>;
  if (range.propertyId) {
    const { rows } = await db.raw<{ rows: Array<{ bucket: string; collected: number }> }>(
      `WITH pay AS (
         SELECT p.id, p.amount, p.paid_on, p.unit_id FROM payments p
          WHERE p.account_id = ? AND p.status = 'confirmed' AND p.paid_on BETWEEN ?::date AND ?::date
       )
       SELECT bucket, SUM(amount) AS collected FROM (
         SELECT to_char(pay.paid_on, '${fmt}') AS bucket, pa.amount
           FROM pay JOIN payment_allocations pa ON pa.payment_id = pay.id
           JOIN rent_charges c ON c.id = pa.charge_id JOIN units u ON u.id = c.unit_id
          WHERE u.property_id = ?
         UNION ALL
         SELECT to_char(pay.paid_on, '${fmt}') AS bucket, pay.amount - COALESCE(x.allocated, 0)
           FROM pay
           LEFT JOIN (SELECT payment_id, SUM(amount) AS allocated FROM payment_allocations GROUP BY payment_id) x ON x.payment_id = pay.id
           JOIN units u ON u.id = pay.unit_id
          WHERE u.property_id = ? AND pay.amount - COALESCE(x.allocated, 0) > 0
       ) t GROUP BY bucket`,
      [ctx.accountId, range.from, range.to, range.propertyId, range.propertyId],
    );
    cashRows = rows;
  } else {
    cashRows = (await db('payments')
      .where({ account_id: ctx.accountId, status: 'confirmed' })
      .whereBetween('paid_on', [range.from, range.to])
      .select(db.raw(`to_char(paid_on, '${fmt}') AS bucket`))
      .sum({ collected: 'amount' })
      .groupByRaw(`to_char(paid_on, '${fmt}')`)) as any;
  }

  const expenseRows = await db('expenses as e')
    .leftJoin('units as u', 'u.id', 'e.unit_id')
    .where('e.account_id', ctx.accountId)
    .whereBetween('e.expense_date', [range.from, range.to])
    .modify((q) => {
      if (range.propertyId) q.whereRaw('COALESCE(e.property_id, u.property_id) = ?', [range.propertyId]);
    })
    .select(db.raw(`to_char(e.expense_date, '${fmt}') AS bucket`))
    .sum({ expenses: 'e.amount' })
    .groupByRaw(`to_char(e.expense_date, '${fmt}')`);

  const buckets =
    range.groupBy === 'year'
      ? Array.from(
          { length: Number(range.to.slice(0, 4)) - Number(range.from.slice(0, 4)) + 1 },
          (_, i) => String(Number(range.from.slice(0, 4)) + i),
        )
      : monthKeysBetween(monthKeyOf(range.from), monthKeyOf(range.to));

  const exp = new Map<string, any>(expectedRows.map((r: any) => [r.bucket as string, r]));
  const cash = new Map<string, number>(cashRows.map((r: any) => [r.bucket as string, Number(r.collected)]));
  const out = new Map<string, number>(expenseRows.map((r: any) => [r.bucket as string, Number(r.expenses)]));

  const series = buckets.map((bucket) => {
    const e = exp.get(bucket) as any;
    const expected = Number(e?.expected ?? 0);
    const collectedOfExpected = Number(e?.collected_of_expected ?? 0);
    const collected = cash.get(bucket) ?? 0;
    const expenses = out.get(bucket) ?? 0;
    return {
      period: bucket,
      label: range.groupBy === 'year' ? bucket : shortMonthLabel(bucket),
      fullLabel: range.groupBy === 'year' ? bucket : monthLabel(bucket),
      expected,
      collected,
      collectedOfExpected,
      pending: round2(Math.max(0, expected - collectedOfExpected)),
      expenses,
      net: round2(collected - expenses),
    };
  });

  const totals = series.reduce(
    (t, s) => ({
      expected: round2(t.expected + s.expected),
      collected: round2(t.collected + s.collected),
      collectedOfExpected: round2(t.collectedOfExpected + s.collectedOfExpected),
      pending: round2(t.pending + s.pending),
      expenses: round2(t.expenses + s.expenses),
      net: round2(t.net + s.net),
    }),
    { expected: 0, collected: 0, collectedOfExpected: 0, pending: 0, expenses: 0, net: 0 },
  );

  return { from: range.from, to: range.to, groupBy: range.groupBy, series, totals };
}

export async function pendingReport(ctx: Ctx, opts: { propertyId?: string; search?: string }) {
  await ensureAccountCharges(ctx.accountId, ctx.today);
  const rows = await db
    .from(
      chargeQuery(db, { accountId: ctx.accountId }, ctx.today)
        .modify((q) => {
          if (opts.propertyId) q.where('p.id', opts.propertyId);
          if (opts.search) {
            const pattern = likePattern(opts.search);
            q.where((w) => w.whereILike('t.name', pattern).orWhereILike('u.name', pattern));
          }
        })
        .as('x'),
    )
    .whereIn('x.status', ['overdue', 'pending', 'to_confirm'])
    .orderBy('x.due_date');

  type Buckets = { current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number };
  const emptyBuckets = (): Buckets => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 });
  const totals = { outstanding: 0, overdue: 0, buckets: emptyBuckets(), entries: 0 };
  const byTenant = new Map<
    string,
    {
      tenant: { id: string; name: string; phone: string };
      units: Set<string>;
      outstanding: number;
      overdue: number;
      oldestDueDate: string;
      maxDaysOverdue: number;
      entries: number;
      buckets: Buckets;
    }
  >();

  for (const r of rows as any[]) {
    const balance = Number(r.balance);
    const days = r.due_date < ctx.today ? diffDays(r.due_date, ctx.today) : 0;
    const key: keyof Buckets = days === 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus';
    const t =
      byTenant.get(r.tenant_id) ??
      {
        tenant: { id: r.tenant_id, name: r.tenant_name, phone: r.tenant_phone },
        units: new Set<string>(),
        outstanding: 0,
        overdue: 0,
        oldestDueDate: r.due_date,
        maxDaysOverdue: 0,
        entries: 0,
        buckets: emptyBuckets(),
      };
    t.units.add(r.unit_name);
    t.outstanding = round2(t.outstanding + balance);
    if (days > 0) t.overdue = round2(t.overdue + balance);
    if (r.due_date < t.oldestDueDate) t.oldestDueDate = r.due_date;
    t.maxDaysOverdue = Math.max(t.maxDaysOverdue, days);
    t.entries += 1;
    t.buckets[key] = round2(t.buckets[key] + balance);
    byTenant.set(r.tenant_id, t);

    totals.outstanding = round2(totals.outstanding + balance);
    if (days > 0) totals.overdue = round2(totals.overdue + balance);
    totals.buckets[key] = round2(totals.buckets[key] + balance);
    totals.entries += 1;
  }

  return {
    asOf: ctx.today,
    totals,
    tenants: [...byTenant.values()]
      .map((t) => ({ ...t, units: [...t.units].sort() }))
      .sort((a, b) => b.overdue - a.overdue || b.outstanding - a.outstanding),
  };
}

export async function propertyIncomeReport(ctx: Ctx, range: DateRange) {
  assertRange(range);
  await ensureAccountCharges(ctx.accountId, ctx.today);
  const [properties, expected, collected, expenses, dues, units] = await Promise.all([
    db('properties').where({ account_id: ctx.accountId }).orderByRaw('archived_at IS NOT NULL, lower(name)'),
    expectedByProperty(db, ctx.accountId, range.from, range.to),
    collectedByProperty(db, ctx.accountId, range.from, range.to),
    expensesByProperty(db, ctx.accountId, range.from, range.to),
    duesByProperty(db, ctx.accountId, ctx.today),
    db
      .from(unitsWithOccupancy(db, ctx.accountId, ctx.today).whereNull('u.archived_at').as('x'))
      .select('x.property_id')
      .select(db.raw('COUNT(*) AS units'), db.raw(`COUNT(*) FILTER (WHERE x.occupancy = 'occupied') AS occupied`))
      .groupBy('x.property_id'),
  ]);
  const unitMap = new Map(units.map((u: any) => [u.property_id, u]));

  const items = properties
    .map((p) => {
      const c = collected.get(p.id) ?? 0;
      const e = expenses.get(p.id) ?? 0;
      const u = unitMap.get(p.id) as any;
      return {
        property: { id: p.id, name: p.name, type: p.type, archived: p.archived_at !== null },
        units: Number(u?.units ?? 0),
        occupied: Number(u?.occupied ?? 0),
        expected: expected.get(p.id) ?? 0,
        collected: c,
        expenses: e,
        net: round2(c - e),
        outstanding: dues.get(p.id)?.outstanding ?? 0,
      };
    })
    .filter((i) => !i.property.archived || i.collected || i.expenses || i.expected);

  const unassigned = { collected: collected.get(null) ?? 0, expenses: expenses.get(null) ?? 0 };
  const totals = items.reduce(
    (t, i) => ({
      expected: round2(t.expected + i.expected),
      collected: round2(t.collected + i.collected),
      expenses: round2(t.expenses + i.expenses),
      net: round2(t.net + i.net),
      outstanding: round2(t.outstanding + i.outstanding),
    }),
    { expected: 0, collected: 0, expenses: 0, net: 0, outstanding: 0 },
  );
  totals.collected = round2(totals.collected + unassigned.collected);
  totals.expenses = round2(totals.expenses + unassigned.expenses);
  totals.net = round2(totals.collected - totals.expenses);

  return { from: range.from, to: range.to, items, unassigned, totals };
}

export async function expenseReport(ctx: Ctx, range: DateRange & { propertyId?: string }) {
  assertRange(range);
  const base = db('expenses as e')
    .leftJoin('units as u', 'u.id', 'e.unit_id')
    .leftJoin('properties as p', 'p.id', db.raw('COALESCE(e.property_id, u.property_id)'))
    .where('e.account_id', ctx.accountId)
    .whereBetween('e.expense_date', [range.from, range.to])
    .modify((q) => {
      if (range.propertyId) q.where('p.id', range.propertyId);
    });

  const [byCategory, byProperty, byMonth] = await Promise.all([
    base.clone().select('e.category').sum({ amount: 'e.amount' }).count({ count: '*' }).groupBy('e.category').orderBy('amount', 'desc'),
    base
      .clone()
      .select('p.id', 'p.name')
      .sum({ amount: 'e.amount' })
      .count({ count: '*' })
      .groupBy('p.id', 'p.name')
      .orderBy('amount', 'desc'),
    base
      .clone()
      .select(db.raw(`to_char(e.expense_date, 'YYYY-MM') AS month`))
      .sum({ amount: 'e.amount' })
      .groupByRaw(`to_char(e.expense_date, 'YYYY-MM')`),
  ]);
  const monthMap = new Map(byMonth.map((r: any) => [r.month, Number(r.amount)]));
  const total = round2(byCategory.reduce((s: number, r: any) => s + Number(r.amount), 0));

  return {
    from: range.from,
    to: range.to,
    total,
    byCategory: byCategory.map((r: any) => ({
      category: r.category,
      label: EXPENSE_CATEGORY_LABELS[r.category as ExpenseCategory] ?? r.category,
      amount: Number(r.amount),
      count: Number(r.count),
      share: total ? Math.round((Number(r.amount) / total) * 1000) / 10 : 0,
    })),
    byProperty: byProperty.map((r: any) => ({
      property: r.id ? { id: r.id, name: r.name } : null,
      amount: Number(r.amount),
      count: Number(r.count),
    })),
    byMonth: monthKeysBetween(monthKeyOf(range.from), monthKeyOf(range.to)).map((m) => ({
      month: m,
      label: shortMonthLabel(m),
      amount: monthMap.get(m) ?? 0,
    })),
  };
}

export async function tenantHistoryReport(ctx: Ctx, range: DateRange & { search?: string; page: number; pageSize: number }) {
  assertRange(range);
  await ensureAccountCharges(ctx.accountId, ctx.today);
  const base = db('tenants as t')
    .where('t.account_id', ctx.accountId)
    .modify((q) => {
      if (range.search) {
        const pattern = likePattern(range.search);
        q.where((w) => w.whereILike('t.name', pattern).orWhereILike('t.business_name', pattern).orWhere('t.phone', 'like', `%${range.search!.replace(/\D/g, '') || '~'}%`));
      }
    })
    .whereExists(db('agreements as a').whereRaw('a.tenant_id = t.id'));

  const [{ count }] = await base.clone().count<{ count: number }[]>({ count: '*' });
  const tenants = await base
    .clone()
    .select('t.id', 't.name', 't.phone', 't.business_name', 't.archived_at')
    .orderByRaw('lower(t.name), t.id')
    .limit(range.pageSize)
    .offset((range.page - 1) * range.pageSize);
  const ids = tenants.map((t: Record<string, any>) => t.id as string);
  if (ids.length === 0) return { from: range.from, to: range.to, items: [], total: Number(count) };

  const billed = await db('rent_charges')
    .whereIn('tenant_id', ids)
    .whereNull('voided_at')
    .whereBetween('due_date', [range.from, range.to])
    .select('tenant_id')
    .sum({ amount: 'total_amount' })
    .groupBy('tenant_id');
  const paid = await db('payments')
    .whereIn('tenant_id', ids)
    .where('status', 'confirmed')
    .whereBetween('paid_on', [range.from, range.to])
    .select('tenant_id')
    .sum({ amount: 'amount' })
    .count({ count: '*' })
    .groupBy('tenant_id');
  const balances = await db('rent_charges as c')
    .leftJoin(allocationTotals(db, ctx.accountId).as('al'), 'al.charge_id', 'c.id')
    .whereIn('c.tenant_id', ids)
    .whereNull('c.voided_at')
    .select('c.tenant_id')
    .select(db.raw('SUM(c.total_amount - COALESCE(al.paid, 0)) AS outstanding'))
    .groupBy('c.tenant_id');
  const units = await db('agreements as a')
    .join('units as u', 'u.id', 'a.unit_id')
    .whereIn('a.tenant_id', ids)
    .select('a.tenant_id', 'u.name', 'a.status', 'a.start_date', 'a.ended_on')
    .orderBy('a.start_date', 'desc');

  const billedMap = new Map(billed.map((r: any) => [r.tenant_id, Number(r.amount)]));
  const paidMap = new Map(paid.map((r: any) => [r.tenant_id, { amount: Number(r.amount), count: Number(r.count) }]));
  const balanceMap = new Map(balances.map((r: any) => [r.tenant_id, Number(r.outstanding)]));

  return {
    from: range.from,
    to: range.to,
    total: Number(count),
    items: tenants.map((t: Record<string, any>) => ({
      tenant: { id: t.id, name: t.name, phone: t.phone, businessName: t.business_name, archived: t.archived_at !== null },
      units: units
        .filter((u) => u.tenant_id === t.id)
        .map((u) => ({ name: u.name, status: u.status, startDate: u.start_date, endedOn: u.ended_on })),
      billed: billedMap.get(t.id) ?? 0,
      paid: paidMap.get(t.id)?.amount ?? 0,
      payments: paidMap.get(t.id)?.count ?? 0,
      outstanding: Math.max(0, balanceMap.get(t.id) ?? 0),
    })),
  };
}
