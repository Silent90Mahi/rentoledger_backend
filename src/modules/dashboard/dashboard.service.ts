import { col, round2 as r2 } from '../../db/mongo.js';
import type { Ctx } from '../../lib/context.js';
import { addDays, addMonthsToKey, monthEnd, monthKeyOf, monthKeysBetween, monthLabel, monthStart, shortMonthLabel } from '../../lib/dates.js';
import { round2 } from '../../lib/money.js';
import { listActivity, type ActivityItem } from '../activity/activity.service.js';
import { METHOD_LABELS, type PaymentMethod } from '../payments/payment.types.js';
import { nextPeriodAfter, termsFromRow, type AgreementRow } from '../rents/billing.js';
import { chargeRefStages, chargeStatusStages, mapCharge, periodLabelFor, type RentEntryDto } from '../rents/charge-query.js';
import { agreementRow, ensureAccountCharges } from '../rents/generation.service.js';
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
  const status = (match: Record<string, unknown>) => chargeStatusStages({ accountId: ctx.accountId }, ctx.today, match);
  const notOpening = { $ne: ['$kind', 'opening_balance'] };
  const countIf = (cond: unknown) => ({ $sum: { $cond: [cond, 1, 0] } });

  const [monthAgg = {}] = await col('rent_charges')
    .aggregate([
      ...status({ period_start: { $gte: from, $lte: to } }),
      { $match: { status: { $ne: 'void' } } },
      {
        $group: {
          _id: null,
          expected: { $sum: { $cond: [notOpening, '$total_amount', 0] } },
          collected: { $sum: { $cond: [notOpening, '$paid_amount', 0] } },
          gst_collected: {
            $sum: { $cond: [{ $gt: ['$total_amount', 0] }, { $divide: [{ $multiply: ['$paid_amount', '$gst_amount'] }, '$total_amount'] }, 0] },
          },
          total: { $sum: 1 },
          collected_count: countIf({ $eq: ['$status', 'collected'] }),
          pending_count: countIf({ $eq: ['$status', 'pending'] }),
          to_confirm_count: countIf({ $eq: ['$status', 'to_confirm'] }),
          overdue_count: countIf({ $eq: ['$status', 'overdue'] }),
          partial_count: countIf('$is_partial'),
        },
      },
    ])
    .toArray();

  const [dues = {}] = await col('rent_charges')
    .aggregate([
      ...status({ period_start: { $lte: to } }),
      { $match: { status: { $ne: 'void' } } },
      {
        $group: {
          _id: null,
          outstanding: { $sum: '$balance' },
          previous: { $sum: { $cond: [{ $lt: ['$period_start', from] }, '$balance', 0] } },
          overdue: { $sum: { $cond: ['$is_overdue', '$balance', 0] } },
        },
      },
    ])
    .toArray();

  const overdueRows = await col('rent_charges')
    .aggregate([
      ...status({ period_start: { $lte: to } }),
      { $match: { is_overdue: true } },
      ...chargeRefStages(),
      { $sort: { due_date: 1, unit_name: 1 } },
      { $limit: 20 },
    ])
    .toArray();

  const paymentsWithNames = async (filter: Record<string, unknown>, sort: Record<string, 1 | -1>, limit: number) => {
    const docs = await col('payments').find(filter).sort(sort).limit(limit).toArray();
    const tenants = new Map((await col('tenants').find({ _id: { $in: docs.map((p) => p.tenant_id) } }).toArray()).map((t) => [t._id, t.name]));
    const units = new Map((await col('units').find({ _id: { $in: docs.map((p) => p.unit_id).filter(Boolean) } }).toArray()).map((u) => [u._id, u.name]));
    return docs.map((p): Record<string, any> => ({ ...p, id: p._id, tenant_name: tenants.get(p.tenant_id), unit_name: p.unit_id ? units.get(p.unit_id) : null }));
  };

  const toConfirmRows = await paymentsWithNames({ account_id: ctx.accountId, status: 'pending' }, { created_at: -1 }, 10);

  // Upcoming: open entries due in the next 30 days + next periods not generated yet.
  const horizon = addDays(ctx.today, 30);
  const upcomingEntries = await col('rent_charges')
    .aggregate([
      ...status({ due_date: { $gte: ctx.today, $lte: horizon } }),
      { $match: { status: { $in: ['pending', 'to_confirm'] } } },
      { $sort: { due_date: 1 } },
      { $limit: 20 },
      ...chargeRefStages(),
    ])
    .toArray();
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

  const agreementDocs = await col('agreements')
    .find({ account_id: ctx.accountId, $or: [{ status: 'active' }, { ended_on: { $gt: ctx.today } }] })
    .toArray();
  const agreementUnits = new Map((await col('units').find({ _id: { $in: agreementDocs.map((a) => a.unit_id) } }).toArray()).map((u) => [u._id, u]));
  const agreementProperties = new Map(
    (await col('properties').find({ _id: { $in: [...agreementUnits.values()].map((u) => u.property_id) } }).toArray()).map((p) => [p._id, p]),
  );
  const agreementTenants = new Map((await col('tenants').find({ _id: { $in: agreementDocs.map((a) => a.tenant_id) } }).toArray()).map((t) => [t._id, t]));
  for (const doc of agreementDocs) {
    const a: AgreementRow = agreementRow(doc);
    const next = nextPeriodAfter(termsFromRow(a), ctx.today);
    if (!next || next.dueDate > horizon) continue;
    const unit = agreementUnits.get(a.unit_id);
    const property = unit ? agreementProperties.get(unit.property_id) : undefined;
    upcoming.push({
      source: 'projected',
      chargeId: null,
      agreementId: a.id,
      tenant: { id: a.tenant_id, name: agreementTenants.get(a.tenant_id)?.name },
      unit: { id: a.unit_id, name: unit?.name },
      property: { id: property?._id, name: property?.name },
      periodLabel: periodLabelFor('rent', next.periodStart, next.periodEnd),
      dueDate: next.dueDate,
      amount: next.totalAmount,
      daysUntilDue: Math.round((Date.parse(next.dueDate) - Date.parse(ctx.today)) / 86_400_000),
    });
  }
  upcoming.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || String(a.unit.name).localeCompare(String(b.unit.name)));

  // Portfolio (rent roll uses the rent in force today, i.e. after escalations)
  const unitRecords = (await unitsWithOccupancy(ctx.accountId, ctx.today, { archived_at: null })).filter((r) => !r.property_archived_at);
  const unitRows: UnitDto[] = unitRecords.map((r) => mapUnit(r, ctx.today));
  const units = {
    units: unitRows.length,
    occupied: unitRows.filter((u) => u.occupancy === 'occupied').length,
    reserved: unitRows.filter((u) => u.occupancy === 'reserved').length,
    vacant: unitRows.filter((u) => u.occupancy === 'vacant').length,
    rent_roll: unitRows.reduce((sum, u) => sum + (u.occupancy === 'occupied' ? (u.currentAgreement?.monthlyRent ?? 0) : 0), 0),
  };
  const propertyCount = await col('properties').countDocuments({ account_id: ctx.accountId, archived_at: null });
  const occupyingTenantIds = await col('agreements').distinct('tenant_id', {
    account_id: ctx.accountId,
    start_date: { $lte: ctx.today },
    $or: [{ status: 'active' }, { ended_on: { $gte: ctx.today } }],
  });
  const activeTenants = await col('tenants').countDocuments({ account_id: ctx.accountId, archived_at: null, _id: { $in: occupyingTenantIds } });
  const expiring = await col('agreements').countDocuments({
    account_id: ctx.accountId,
    status: 'active',
    end_date: { $ne: null, $lte: addDays(ctx.today, 60) },
  });

  // Finance (cash basis for the month)
  const sum = async (name: 'payments' | 'expenses' | 'deposit_transactions', match: Record<string, unknown>, expr: unknown) => {
    const [r] = await col(name).aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: expr } } }]).toArray();
    return r2(r?.total ?? 0);
  };
  const cashTotal = await sum('payments', { account_id: ctx.accountId, status: 'confirmed', paid_on: { $gte: from, $lte: to } }, '$amount');
  const spentTotal = await sum('expenses', { account_id: ctx.accountId, expense_date: { $gte: from, $lte: to } }, '$amount');
  const depositsHeld = await sum('deposit_transactions', { account_id: ctx.accountId }, {
    $cond: [{ $eq: ['$type', 'received'] }, '$amount', { $multiply: ['$amount', -1] }],
  });

  const recentPayments = await paymentsWithNames(
    { account_id: ctx.accountId, status: { $in: ['confirmed', 'pending'] } },
    { paid_on: -1, created_at: -1 },
    6,
  );

  const activity = await listActivity(ctx.accountId, { page: 1, pageSize: 8 });

  // Six-month trend ending at the selected month.
  const trendMonths = monthKeysBetween(addMonthsToKey(month, -5), month);
  const trendRows = await col('rent_charges')
    .aggregate([
      ...status({ period_start: { $gte: monthStart(trendMonths[0]), $lte: to } }),
      { $match: { status: { $ne: 'void' }, kind: { $ne: 'opening_balance' } } },
      { $group: { _id: { $substrBytes: ['$period_start', 0, 7] }, expected: { $sum: '$total_amount' }, collected: { $sum: '$paid_amount' } } },
    ])
    .toArray();
  const trendMap = new Map(trendRows.map((r) => [r._id as string, r]));
  const cash = { total: cashTotal };
  const spent = { total: spentTotal };
  const deposits = { held: depositsHeld };

  const expected = round2(Number(monthAgg.expected ?? 0));
  const collected = round2(Number(monthAgg.collected ?? 0));
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
      gstCollected: round2(Number(monthAgg.gst_collected ?? 0)),
      gstRate: ctx.gstRate,
      collectionRate: expected > 0 ? Math.round((collected / expected) * 1000) / 10 : 0,
      counts: {
        total: Number(monthAgg.total ?? 0),
        collected: Number(monthAgg.collected_count ?? 0),
        pending: Number(monthAgg.pending_count ?? 0),
        toConfirm: Number(monthAgg.to_confirm_count ?? 0),
        overdue: Number(monthAgg.overdue_count ?? 0),
        partial: Number(monthAgg.partial_count ?? 0),
      },
      outstanding: round2(Number(dues.outstanding ?? 0)),
      outstandingPrevious: round2(Number(dues.previous ?? 0)),
      overdueAmount: round2(Number(dues.overdue ?? 0)),
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
      reference: p.reference ?? null,
      tenant: { id: p.tenant_id, name: p.tenant_name },
      unitName: p.unit_name ?? null,
      targetChargeId: p.target_charge_id ?? null,
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
      return { month: m, label: shortMonthLabel(m), expected: round2(Number(r?.expected ?? 0)), collected: round2(Number(r?.collected ?? 0)) };
    }),
  };
}
