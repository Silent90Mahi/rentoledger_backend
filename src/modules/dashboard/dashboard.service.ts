import { db } from '../../db/knex.js';
import type { Ctx } from '../../lib/context.js';
import { addDays, addMonthsToKey, monthEnd, monthKeyOf, monthKeysBetween, monthLabel, monthStart, shortMonthLabel } from '../../lib/dates.js';
import { round2 } from '../../lib/money.js';
import { listActivity, type ActivityItem } from '../activity/activity.service.js';
import { METHOD_LABELS, type PaymentMethod } from '../payments/payment.types.js';
import { nextPeriodAfter, termsFromRow, type AgreementRow } from '../rents/billing.js';
import { chargeQuery, mapCharge, periodLabelFor, type RentEntryDto } from '../rents/charge-query.js';
import { ensureAccountCharges } from '../rents/generation.service.js';
import { mapUnit, unitsWithOccupancy, type UnitDto } from '../units/occupancy.js';

export interface UpcomingDue {
  source: 'entry' | 'projected';
  chargeId: string | null;
  agreementId: string;
  tenant: { id: string; name: string };
  unit: { id: string; name: string };
  property: { id: string; name: string };
  periodLabel: string;
  dueDate: string;
  amount: number;
  daysUntilDue: number;
}

export interface DashboardDto {
  month: string;
  monthLabel: string;
  isCurrentMonth: boolean;
  today: string;
  rent: {
    expected: number;
    collected: number;
    gstCollected: number;
    gstRate: number;
    collectionRate: number;
    counts: { total: number; collected: number; pending: number; toConfirm: number; overdue: number; partial: number };
    outstanding: number;
    outstandingPrevious: number;
    overdueAmount: number;
  };
  portfolio: {
    properties: number;
    units: number;
    occupied: number;
    vacant: number;
    reserved: number;
    occupancyRate: number;
    activeTenants: number;
    expiringAgreements: number;
    monthlyRentRoll: number;
  };
  finance: { cashReceived: number; expenses: number; netIncome: number; depositsHeld: number };
  overdue: RentEntryDto[];
  toConfirm: Array<{
    id: string;
    amount: number;
    paidOn: string;
    method: string;
    methodLabel: string;
    reference: string | null;
    tenant: { id: string; name: string };
    unitName: string | null;
    targetChargeId: string | null;
    createdAt: string;
  }>;
  upcoming: UpcomingDue[];
  recentPayments: Array<{
    id: string;
    amount: number;
    paidOn: string;
    method: string;
    methodLabel: string;
    status: string;
    tenant: { id: string; name: string };
    unitName: string | null;
  }>;
  recentActivity: ActivityItem[];
  trend: Array<{ month: string; label: string; expected: number; collected: number }>;
}

export async function getDashboard(ctx: Ctx, monthInput?: string): Promise<DashboardDto> {
  await ensureAccountCharges(ctx.accountId, ctx.today);
  const month = monthInput ?? monthKeyOf(ctx.today);
  const from = monthStart(month);
  const to = monthEnd(month);
  const all = chargeQuery(db, { accountId: ctx.accountId }, ctx.today);

  const [monthAgg] = await db
    .from(all.clone().whereBetween('c.period_start', [from, to]).as('x'))
    .whereNot('x.status', 'void')
    .select(
      db.raw(`COALESCE(SUM(x.total_amount) FILTER (WHERE x.kind <> 'opening_balance'), 0) AS expected`),
      db.raw(`COALESCE(SUM(x.paid_amount) FILTER (WHERE x.kind <> 'opening_balance'), 0) AS collected`),
      db.raw(
        `COALESCE(SUM(CASE WHEN x.total_amount > 0 THEN x.paid_amount * x.gst_amount / x.total_amount ELSE 0 END), 0) AS gst_collected`,
      ),
      db.raw('COUNT(*) AS total'),
      db.raw(`COUNT(*) FILTER (WHERE x.status = 'collected') AS collected_count`),
      db.raw(`COUNT(*) FILTER (WHERE x.status = 'pending') AS pending_count`),
      db.raw(`COUNT(*) FILTER (WHERE x.status = 'to_confirm') AS to_confirm_count`),
      db.raw(`COUNT(*) FILTER (WHERE x.status = 'overdue') AS overdue_count`),
      db.raw(`COUNT(*) FILTER (WHERE x.is_partial) AS partial_count`),
    );

  const [dues] = await db
    .from(all.clone().where('c.period_start', '<=', to).as('x'))
    .whereNot('x.status', 'void')
    .select(
      db.raw('COALESCE(SUM(x.balance), 0) AS outstanding'),
      db.raw('COALESCE(SUM(x.balance) FILTER (WHERE x.period_start < ?::date), 0) AS previous', [from]),
      db.raw('COALESCE(SUM(x.balance) FILTER (WHERE x.is_overdue), 0) AS overdue'),
    );

  const overdueRows = await db
    .from(all.clone().where('c.period_start', '<=', to).as('x'))
    .where('x.is_overdue', true)
    .orderBy([
      { column: 'x.due_date', order: 'asc' },
      { column: 'x.unit_name', order: 'asc' },
    ])
    .limit(20);

  const toConfirmRows = await db('payments as p')
    .join('tenants as t', 't.id', 'p.tenant_id')
    .leftJoin('units as u', 'u.id', 'p.unit_id')
    .where({ 'p.account_id': ctx.accountId, 'p.status': 'pending' })
    .orderBy('p.created_at', 'desc')
    .limit(10)
    .select('p.*', 't.name as tenant_name', 'u.name as unit_name');

  // Upcoming: open entries due in the next 30 days + next periods not generated yet.
  const horizon = addDays(ctx.today, 30);
  const upcomingEntries = await db
    .from(all.clone().whereBetween('c.due_date', [ctx.today, horizon]).as('x'))
    .whereIn('x.status', ['pending', 'to_confirm'])
    .orderBy('x.due_date')
    .limit(20);
  const upcoming: UpcomingDue[] = upcomingEntries.map((r) => {
    const e = mapCharge(r, ctx.today);
    return {
      source: 'entry' as const,
      chargeId: e.id,
      agreementId: e.agreementId,
      tenant: { id: e.tenant.id, name: e.tenant.name },
      unit: { id: e.unit.id, name: e.unit.name },
      property: { id: e.property.id, name: e.property.name },
      periodLabel: e.periodLabel,
      dueDate: e.dueDate,
      amount: e.balance,
      daysUntilDue: Math.round((Date.parse(e.dueDate) - Date.parse(ctx.today)) / 86_400_000),
    };
  });
  const activeAgreements = (await db('agreements as a')
    .join('units as u', 'u.id', 'a.unit_id')
    .join('properties as p', 'p.id', 'u.property_id')
    .join('tenants as t', 't.id', 'a.tenant_id')
    .where('a.account_id', ctx.accountId)
    .where((q) => q.where('a.status', 'active').orWhere('a.ended_on', '>', ctx.today))
    .select('a.*', 'u.name as unit_name', 'p.id as property_id', 'p.name as property_name', 't.name as tenant_name')) as Array<
    AgreementRow & { unit_name: string; property_id: string; property_name: string; tenant_name: string }
  >;
  for (const a of activeAgreements) {
    const next = nextPeriodAfter(termsFromRow(a), ctx.today);
    if (!next || next.dueDate > horizon) continue;
    upcoming.push({
      source: 'projected',
      chargeId: null,
      agreementId: a.id,
      tenant: { id: a.tenant_id, name: a.tenant_name },
      unit: { id: a.unit_id, name: a.unit_name },
      property: { id: a.property_id, name: a.property_name },
      periodLabel: periodLabelFor('rent', next.periodStart, next.periodEnd),
      dueDate: next.dueDate,
      amount: next.totalAmount,
      daysUntilDue: Math.round((Date.parse(next.dueDate) - Date.parse(ctx.today)) / 86_400_000),
    });
  }
  upcoming.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.unit.name.localeCompare(b.unit.name));

  // Portfolio (rent roll uses the rent in force today, i.e. after escalations)
  const unitRecords: Array<Record<string, any>> = await unitsWithOccupancy(db, ctx.accountId, ctx.today)
    .whereNull('u.archived_at')
    .whereNull('p.archived_at');
  const unitRows: UnitDto[] = unitRecords.map((r) => mapUnit(r, ctx.today));
  const units = {
    units: unitRows.length,
    occupied: unitRows.filter((u) => u.occupancy === 'occupied').length,
    reserved: unitRows.filter((u) => u.occupancy === 'reserved').length,
    vacant: unitRows.filter((u) => u.occupancy === 'vacant').length,
    rent_roll: unitRows.reduce((sum, u) => sum + (u.occupancy === 'occupied' ? (u.currentAgreement?.monthlyRent ?? 0) : 0), 0),
  };
  const [{ count: propertyCount }] = await db('properties').where({ account_id: ctx.accountId }).whereNull('archived_at').count<{ count: number }[]>({ count: '*' });
  const [{ count: activeTenants }] = await db('tenants as t')
    .where('t.account_id', ctx.accountId)
    .whereNull('t.archived_at')
    .whereExists(
      db('agreements as a')
        .whereRaw('a.tenant_id = t.id')
        .where('a.start_date', '<=', ctx.today)
        .where((q) => q.where('a.status', 'active').orWhere('a.ended_on', '>=', ctx.today)),
    )
    .count<{ count: number }[]>({ count: '*' });
  const [{ count: expiring }] = await db('agreements')
    .where({ account_id: ctx.accountId, status: 'active' })
    .whereNotNull('end_date')
    .where('end_date', '<=', addDays(ctx.today, 60))
    .count<{ count: number }[]>({ count: '*' });

  // Finance (cash basis for the month)
  const [cash] = await db('payments')
    .where({ account_id: ctx.accountId, status: 'confirmed' })
    .whereBetween('paid_on', [from, to])
    .sum({ total: 'amount' });
  const [spent] = await db('expenses').where({ account_id: ctx.accountId }).whereBetween('expense_date', [from, to]).sum({ total: 'amount' });
  const [deposits] = await db('deposit_transactions')
    .where({ account_id: ctx.accountId })
    .select(db.raw(`COALESCE(SUM(CASE WHEN type = 'received' THEN amount ELSE -amount END), 0) AS held`));

  const recentPayments = await db('payments as p')
    .join('tenants as t', 't.id', 'p.tenant_id')
    .leftJoin('units as u', 'u.id', 'p.unit_id')
    .where('p.account_id', ctx.accountId)
    .whereIn('p.status', ['confirmed', 'pending'])
    .orderBy([
      { column: 'p.paid_on', order: 'desc' },
      { column: 'p.created_at', order: 'desc' },
    ])
    .limit(6)
    .select('p.*', 't.name as tenant_name', 'u.name as unit_name');

  const activity = await listActivity(ctx.accountId, { page: 1, pageSize: 8 });

  // Six-month trend ending at the selected month.
  const trendMonths = monthKeysBetween(addMonthsToKey(month, -5), month);
  const trendRows = await db
    .from(all.clone().whereBetween('c.period_start', [monthStart(trendMonths[0]), to]).as('x'))
    .whereNot('x.status', 'void')
    .whereNot('x.kind', 'opening_balance')
    .select(db.raw(`to_char(x.period_start, 'YYYY-MM') AS month`))
    .sum({ expected: 'x.total_amount', collected: 'x.paid_amount' })
    .groupByRaw(`to_char(x.period_start, 'YYYY-MM')`);
  const trendMap = new Map(trendRows.map((r: any) => [r.month, r]));

  const expected = Number(monthAgg.expected);
  const collected = Number(monthAgg.collected);
  const cashReceived = Number(cash?.total ?? 0);
  const expenses = Number(spent?.total ?? 0);
  const unitCount = Number(units?.units ?? 0);
  const occupied = Number(units?.occupied ?? 0);

  return {
    month,
    monthLabel: monthLabel(month),
    isCurrentMonth: month === monthKeyOf(ctx.today),
    today: ctx.today,
    rent: {
      expected,
      collected,
      gstCollected: round2(Number(monthAgg.gst_collected)),
      gstRate: ctx.gstRate,
      collectionRate: expected > 0 ? Math.round((collected / expected) * 1000) / 10 : 0,
      counts: {
        total: Number(monthAgg.total),
        collected: Number(monthAgg.collected_count),
        pending: Number(monthAgg.pending_count),
        toConfirm: Number(monthAgg.to_confirm_count),
        overdue: Number(monthAgg.overdue_count),
        partial: Number(monthAgg.partial_count),
      },
      outstanding: Number(dues.outstanding),
      outstandingPrevious: Number(dues.previous),
      overdueAmount: Number(dues.overdue),
    },
    portfolio: {
      properties: Number(propertyCount),
      units: unitCount,
      occupied,
      vacant: Number(units?.vacant ?? 0),
      reserved: Number(units?.reserved ?? 0),
      occupancyRate: unitCount ? Math.round((occupied / unitCount) * 1000) / 10 : 0,
      activeTenants: Number(activeTenants),
      expiringAgreements: Number(expiring),
      monthlyRentRoll: round2(Number(units?.rent_roll ?? 0)),
    },
    finance: {
      cashReceived,
      expenses,
      netIncome: round2(cashReceived - expenses),
      depositsHeld: Number(deposits?.held ?? 0),
    },
    overdue: overdueRows.map((r) => mapCharge(r, ctx.today)),
    toConfirm: toConfirmRows.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      paidOn: p.paid_on,
      method: p.method,
      methodLabel: METHOD_LABELS[p.method as PaymentMethod] ?? p.method,
      reference: p.reference,
      tenant: { id: p.tenant_id, name: p.tenant_name },
      unitName: p.unit_name ?? null,
      targetChargeId: p.target_charge_id,
      createdAt: p.created_at,
    })),
    upcoming: upcoming.slice(0, 10),
    recentPayments: recentPayments.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      paidOn: p.paid_on,
      method: p.method,
      methodLabel: METHOD_LABELS[p.method as PaymentMethod] ?? p.method,
      status: p.status,
      tenant: { id: p.tenant_id, name: p.tenant_name },
      unitName: p.unit_name ?? null,
    })),
    recentActivity: activity.items,
    trend: trendMonths.map((m) => {
      const r = trendMap.get(m) as any;
      return { month: m, label: shortMonthLabel(m), expected: Number(r?.expected ?? 0), collected: Number(r?.collected ?? 0) };
    }),
  };
}
