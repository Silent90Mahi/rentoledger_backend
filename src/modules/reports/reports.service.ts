import type { Document } from 'mongodb';
import { col, contains, escapeRegex } from '../../db/mongo.js';
import type { Ctx } from '../../lib/context.js';
import { diffDays, monthKeyOf, monthKeysBetween, monthLabel, shortMonthLabel } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import { round2 } from '../../lib/money.js';
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from '../expenses/expenses.service.js';
import { collectedByProperty, expectedByProperty, expensesByProperty, duesByProperty } from '../finance/finance.queries.js';
import { chargeRefStages, chargeStatusStages } from '../rents/charge-query.js';
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

async function sumOf(name: 'payments' | 'expenses', match: Document, field: string): Promise<number> {
  const [r] = await col(name).aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: `$${field}` } } }]).toArray();
  return round2(r?.total ?? 0);
}

async function unitIdsOfProperty(ctx: Ctx, propertyId: string): Promise<string[]> {
  return col('units').distinct('_id', { account_id: ctx.accountId, property_id: propertyId });
}

/** Cash received in the range, optionally restricted to one property (attribution via allocations/unit). */
async function cashCollected(ctx: Ctx, range: DateRange, propertyId?: string): Promise<number> {
  if (!propertyId) {
    return sumOf('payments', { account_id: ctx.accountId, status: 'confirmed', paid_on: { $gte: range.from, $lte: range.to } }, 'amount');
  }
  const byProperty = await collectedByProperty(ctx.accountId, range.from, range.to);
  return byProperty.get(propertyId) ?? 0;
}

export async function reportSummary(ctx: Ctx, range: DateRange & { propertyId?: string }) {
  assertRange(range);
  await ensureAccountCharges(ctx.accountId, ctx.today);

  const unitFilter = range.propertyId ? { unit_id: { $in: await unitIdsOfProperty(ctx, range.propertyId) } } : {};
  const status = (match: Document) => chargeStatusStages({ accountId: ctx.accountId }, ctx.today, { ...unitFilter, ...match });

  const [billed = {}] = await col('rent_charges')
    .aggregate([
      ...status({ due_date: { $gte: range.from, $lte: range.to } }),
      { $match: { status: { $ne: 'void' }, kind: { $ne: 'opening_balance' } } },
      {
        $group: {
          _id: null,
          expected: { $sum: '$total_amount' },
          collected_of_expected: { $sum: '$paid_amount' },
          gst_billed: { $sum: '$gst_amount' },
          entries: { $sum: 1 },
        },
      },
    ])
    .toArray();
  const [dues = {}] = await col('rent_charges')
    .aggregate([
      ...status({ due_date: { $lte: range.to } }),
      { $match: { status: { $ne: 'void' } } },
      { $group: { _id: null, outstanding: { $sum: '$balance' }, overdue: { $sum: { $cond: ['$is_overdue', '$balance', 0] } } } },
    ])
    .toArray();

  // GST share of the cash received in the range.
  const [gstRow] = await col('payments')
    .aggregate([
      { $match: { account_id: ctx.accountId, status: 'confirmed', paid_on: { $gte: range.from, $lte: range.to } } },
      { $lookup: { from: 'payment_allocations', localField: '_id', foreignField: 'payment_id', as: 'pa' } },
      { $unwind: '$pa' },
      { $lookup: { from: 'rent_charges', localField: 'pa.charge_id', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      ...(range.propertyId ? [{ $match: { 'c.unit_id': unitFilter.unit_id } }] : []),
      {
        $group: {
          _id: null,
          gst: { $sum: { $cond: [{ $gt: ['$c.total_amount', 0] }, { $divide: [{ $multiply: ['$pa.amount', '$c.gst_amount'] }, '$c.total_amount'] }, 0] } },
        },
      },
    ])
    .toArray();

  const collected = await cashCollected(ctx, range, range.propertyId);
  const expenses = range.propertyId
    ? ((await expensesByProperty(ctx.accountId, range.from, range.to)).get(range.propertyId) ?? 0)
    : await sumOf('expenses', { account_id: ctx.accountId, expense_date: { $gte: range.from, $lte: range.to } }, 'amount');

  const depositMatch: Document = { account_id: ctx.accountId };
  if (range.propertyId) {
    depositMatch.agreement_id = { $in: await col('agreements').distinct('_id', { account_id: ctx.accountId, ...unitFilter }) };
  }
  const [deposits = {}] = await col('deposit_transactions')
    .aggregate([
      { $match: depositMatch },
      {
        $group: {
          _id: null,
          held: { $sum: { $cond: [{ $eq: ['$type', 'received'] }, '$amount', { $multiply: ['$amount', -1] }] } },
          deducted: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$type', 'deducted'] }, { $gte: ['$txn_date', range.from] }, { $lte: ['$txn_date', range.to] }] },
                '$amount',
                0,
              ],
            },
          },
        },
      },
    ])
    .toArray();

  const expected = round2(billed.expected ?? 0);
  const collectedOfExpected = round2(billed.collected_of_expected ?? 0);
  const depositDeductions = round2(deposits.deducted ?? 0);
  return {
    from: range.from,
    to: range.to,
    propertyId: range.propertyId ?? null,
    expected,
    collected,
    collectedOfExpected,
    collectionRate: expected > 0 ? Math.round((collectedOfExpected / expected) * 1000) / 10 : 0,
    gstBilled: round2(billed.gst_billed ?? 0),
    gstCollected: round2(gstRow?.gst ?? 0),
    outstanding: round2(dues.outstanding ?? 0),
    overdue: round2(dues.overdue ?? 0),
    expenses,
    depositDeductions,
    netIncome: round2(collected + depositDeductions - expenses),
    depositsHeld: round2(deposits.held ?? 0),
    entries: billed.entries ?? 0,
  };
}

export async function collectionsReport(ctx: Ctx, range: DateRange & { groupBy: 'month' | 'year'; propertyId?: string }) {
  assertRange(range);
  await ensureAccountCharges(ctx.accountId, ctx.today);
  const width = range.groupBy === 'year' ? 4 : 7;
  const bucketOf = (field: string) => ({ $substrBytes: [field, 0, width] });
  const unitIds = range.propertyId ? await unitIdsOfProperty(ctx, range.propertyId) : null;

  const expectedRows = await col('rent_charges')
    .aggregate([
      ...chargeStatusStages({ accountId: ctx.accountId }, ctx.today, {
        voided_at: null,
        kind: { $ne: 'opening_balance' },
        due_date: { $gte: range.from, $lte: range.to },
        ...(unitIds ? { unit_id: { $in: unitIds } } : {}),
      }),
      { $group: { _id: bucketOf('$due_date'), expected: { $sum: '$total_amount' }, collected_of_expected: { $sum: '$paid_amount' } } },
    ])
    .toArray();

  let cashRows: Array<{ bucket: string; collected: number }>;
  if (unitIds) {
    // Money applied to the property's charges plus unapplied money paid for its units.
    const payments = await col('payments')
      .find({ account_id: ctx.accountId, status: 'confirmed', paid_on: { $gte: range.from, $lte: range.to } }, { projection: { amount: 1, paid_on: 1, unit_id: 1 } })
      .toArray();
    const allocations = await col('payment_allocations').find({ payment_id: { $in: payments.map((p) => p._id) } }).toArray();
    const chargeUnits = new Map(
      (await col('rent_charges').find({ _id: { $in: allocations.map((a) => a.charge_id) } }, { projection: { unit_id: 1 } }).toArray()).map((c) => [c._id, c.unit_id]),
    );
    const inProperty = new Set(unitIds);
    const paidOn = new Map(payments.map((p) => [p._id, p.paid_on as string]));
    const allocated = new Map<string, number>();
    const buckets = new Map<string, number>();
    const add = (bucket: string, amount: number) => buckets.set(bucket, round2((buckets.get(bucket) ?? 0) + amount));
    for (const a of allocations) {
      allocated.set(a.payment_id, round2((allocated.get(a.payment_id) ?? 0) + a.amount));
      if (inProperty.has(chargeUnits.get(a.charge_id))) add(paidOn.get(a.payment_id)!.slice(0, width), a.amount);
    }
    for (const p of payments) {
      const unapplied = round2(p.amount - (allocated.get(p._id) ?? 0));
      if (unapplied > 0 && p.unit_id && inProperty.has(p.unit_id)) add(String(p.paid_on).slice(0, width), unapplied);
    }
    cashRows = [...buckets.entries()].map(([bucket, collected]) => ({ bucket, collected }));
  } else {
    cashRows = (
      await col('payments')
        .aggregate([
          { $match: { account_id: ctx.accountId, status: 'confirmed', paid_on: { $gte: range.from, $lte: range.to } } },
          { $group: { _id: bucketOf('$paid_on'), collected: { $sum: '$amount' } } },
        ])
        .toArray()
    ).map((r) => ({ bucket: r._id as string, collected: r.collected as number }));
  }

  const expenseRows = await col('expenses')
    .aggregate([
      { $match: { account_id: ctx.accountId, expense_date: { $gte: range.from, $lte: range.to } } },
      ...(range.propertyId
        ? [
            { $lookup: { from: 'units', localField: 'unit_id', foreignField: '_id', pipeline: [{ $project: { property_id: 1 } }], as: '_u' } },
            { $match: { $expr: { $eq: [{ $ifNull: ['$property_id', { $first: '$_u.property_id' }] }, range.propertyId] } } },
          ]
        : []),
      { $group: { _id: bucketOf('$expense_date'), expenses: { $sum: '$amount' } } },
    ])
    .toArray();

  const buckets =
    range.groupBy === 'year'
      ? Array.from(
          { length: Number(range.to.slice(0, 4)) - Number(range.from.slice(0, 4)) + 1 },
          (_, i) => String(Number(range.from.slice(0, 4)) + i),
        )
      : monthKeysBetween(monthKeyOf(range.from), monthKeyOf(range.to));

  const exp = new Map<string, any>(expectedRows.map((r) => [r._id as string, r]));
  const cash = new Map<string, number>(cashRows.map((r) => [r.bucket, round2(r.collected)]));
  const out = new Map<string, number>(expenseRows.map((r) => [r._id as string, round2(r.expenses)]));

  const series = buckets.map((bucket) => {
    const e = exp.get(bucket) as any;
    const expected = round2(e?.expected ?? 0);
    const collectedOfExpected = round2(e?.collected_of_expected ?? 0);
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
  const pipeline: Document[] = [
    ...chargeStatusStages({ accountId: ctx.accountId }, ctx.today, {
      voided_at: null,
      ...(opts.propertyId ? { unit_id: { $in: await unitIdsOfProperty(ctx, opts.propertyId) } } : {}),
    }),
    { $match: { status: { $in: ['overdue', 'pending', 'to_confirm'] } } },
    ...chargeRefStages(),
  ];
  if (opts.search) {
    const pattern = contains(opts.search);
    pipeline.push({ $match: { $or: [{ tenant_name: pattern }, { unit_name: pattern }] } });
  }
  pipeline.push({ $sort: { due_date: 1 } });
  const rows = await col('rent_charges').aggregate(pipeline).toArray();

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
  const [properties, expected, collected, expenses, dues, unitRows] = await Promise.all([
    col('properties').find({ account_id: ctx.accountId }).toArray(),
    expectedByProperty(ctx.accountId, range.from, range.to),
    collectedByProperty(ctx.accountId, range.from, range.to),
    expensesByProperty(ctx.accountId, range.from, range.to),
    duesByProperty(ctx.accountId, ctx.today),
    unitsWithOccupancy(ctx.accountId, ctx.today, { archived_at: null }),
  ]);
  properties.sort(
    (a, b) =>
      Number(Boolean(a.archived_at)) - Number(Boolean(b.archived_at)) ||
      String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base', numeric: true }),
  );
  const unitMap = new Map<string, { units: number; occupied: number }>();
  for (const u of unitRows) {
    const current = unitMap.get(u.property_id) ?? { units: 0, occupied: 0 };
    current.units += 1;
    if (u.occupancy === 'occupied') current.occupied += 1;
    unitMap.set(u.property_id, current);
  }

  const items = properties
    .map((p) => {
      const c = collected.get(p._id) ?? 0;
      const e = expenses.get(p._id) ?? 0;
      const u = unitMap.get(p._id);
      return {
        property: { id: p._id, name: p.name, type: p.type, archived: p.archived_at !== null && p.archived_at !== undefined },
        units: Number(u?.units ?? 0),
        occupied: Number(u?.occupied ?? 0),
        expected: expected.get(p._id) ?? 0,
        collected: c,
        expenses: e,
        net: round2(c - e),
        outstanding: dues.get(p._id)?.outstanding ?? 0,
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
  const base: Document[] = [
    { $match: { account_id: ctx.accountId, expense_date: { $gte: range.from, $lte: range.to } } },
    { $lookup: { from: 'units', localField: 'unit_id', foreignField: '_id', pipeline: [{ $project: { property_id: 1 } }], as: '_u' } },
    { $addFields: { _pid: { $ifNull: ['$property_id', { $first: '$_u.property_id' }] } } },
    { $lookup: { from: 'properties', localField: '_pid', foreignField: '_id', pipeline: [{ $project: { name: 1 } }], as: '_p' } },
    { $addFields: { _p: { $first: '$_p' } } },
    ...(range.propertyId ? [{ $match: { '_p._id': range.propertyId } }] : []),
  ];

  const [result] = await col('expenses')
    .aggregate([
      ...base,
      {
        $facet: {
          byCategory: [{ $group: { _id: '$category', amount: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { amount: -1 } }],
          byProperty: [{ $group: { _id: { id: '$_p._id', name: '$_p.name' }, amount: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { amount: -1 } }],
          byMonth: [{ $group: { _id: { $substrBytes: ['$expense_date', 0, 7] }, amount: { $sum: '$amount' } } }],
        },
      },
    ])
    .toArray();
  const byCategory = result.byCategory as Array<{ _id: ExpenseCategory; amount: number; count: number }>;
  const monthMap = new Map((result.byMonth as Array<{ _id: string; amount: number }>).map((r) => [r._id, round2(r.amount)]));
  const total = round2(byCategory.reduce((s, r) => s + r.amount, 0));

  return {
    from: range.from,
    to: range.to,
    total,
    byCategory: byCategory.map((r) => ({
      category: r._id,
      label: EXPENSE_CATEGORY_LABELS[r._id] ?? r._id,
      amount: round2(r.amount),
      count: r.count,
      share: total ? Math.round((r.amount / total) * 1000) / 10 : 0,
    })),
    byProperty: (result.byProperty as Array<{ _id: { id?: string; name?: string }; amount: number; count: number }>).map((r) => ({
      property: r._id.id ? { id: r._id.id, name: r._id.name } : null,
      amount: round2(r.amount),
      count: r.count,
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
  const withAgreements = await col('agreements').distinct('tenant_id', { account_id: ctx.accountId });
  const filter: Document = { account_id: ctx.accountId, _id: { $in: withAgreements } };
  if (range.search) {
    const pattern = contains(range.search);
    const digits = range.search.replace(/\D/g, '');
    filter.$or = [{ name: pattern }, { business_name: pattern }, ...(digits ? [{ phone: { $regex: escapeRegex(digits) } }] : [])];
  }

  const total = await col('tenants').countDocuments(filter);
  const tenants = await col('tenants')
    .find(filter)
    .collation({ locale: 'en', strength: 2 })
    .sort({ name: 1, _id: 1 })
    .skip((range.page - 1) * range.pageSize)
    .limit(range.pageSize)
    .toArray();
  const ids = tenants.map((t) => t._id);
  if (ids.length === 0) return { from: range.from, to: range.to, items: [], total };

  const [billed, paid, balances, agreements] = await Promise.all([
    col('rent_charges')
      .aggregate([
        { $match: { tenant_id: { $in: ids }, voided_at: null, due_date: { $gte: range.from, $lte: range.to } } },
        { $group: { _id: '$tenant_id', amount: { $sum: '$total_amount' } } },
      ])
      .toArray(),
    col('payments')
      .aggregate([
        { $match: { tenant_id: { $in: ids }, status: 'confirmed', paid_on: { $gte: range.from, $lte: range.to } } },
        { $group: { _id: '$tenant_id', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      ])
      .toArray(),
    col('rent_charges')
      .aggregate([
        ...chargeStatusStages({ accountId: ctx.accountId }, ctx.today, { tenant_id: { $in: ids }, voided_at: null }),
        { $group: { _id: '$tenant_id', outstanding: { $sum: '$balance' } } },
      ])
      .toArray(),
    col('agreements').find({ tenant_id: { $in: ids } }).sort({ start_date: -1 }).toArray(),
  ]);
  const unitNames = new Map(
    (await col('units').find({ _id: { $in: agreements.map((a) => a.unit_id) } }, { projection: { name: 1 } }).toArray()).map((u) => [u._id, u.name]),
  );

  const billedMap = new Map(billed.map((r) => [r._id, round2(r.amount)]));
  const paidMap = new Map(paid.map((r) => [r._id, { amount: round2(r.amount), count: r.count as number }]));
  const balanceMap = new Map(balances.map((r) => [r._id, round2(r.outstanding)]));

  return {
    from: range.from,
    to: range.to,
    total,
    items: tenants.map((t) => ({
      tenant: { id: t._id, name: t.name, phone: t.phone, businessName: t.business_name ?? null, archived: Boolean(t.archived_at) },
      units: agreements
        .filter((a) => a.tenant_id === t._id)
        .map((a) => ({ name: unitNames.get(a.unit_id), status: a.status, startDate: a.start_date, endedOn: a.ended_on ?? null })),
      billed: billedMap.get(t._id) ?? 0,
      paid: paidMap.get(t._id)?.amount ?? 0,
      payments: paidMap.get(t._id)?.count ?? 0,
      outstanding: Math.max(0, balanceMap.get(t._id) ?? 0),
    })),
  };
}
