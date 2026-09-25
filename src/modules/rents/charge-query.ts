import type { Knex } from 'knex';
import { diffDays, endOfMonth, humanDate, monthKeyOf, monthLabel, shortMonthLabel, startOfMonth } from '../../lib/dates.js';

export type ChargeStatus = 'collected' | 'to_confirm' | 'overdue' | 'pending' | 'void';
export type ChargeKind = 'rent' | 'opening_balance' | 'maintenance' | 'utility' | 'late_fee' | 'other';

export type ChargeScope = { accountId: string } | { tenantIds: string[] };

/**
 * Base query for rent entries with their live financial state, derived purely
 * from transactions:
 *   paid_amount = sum of allocations, balance = total - paid,
 *   status      = void | collected | to_confirm | overdue | pending.
 * Wrap it as a subquery (`.as('lc')`) to filter or sort on computed columns.
 */
export function chargeQuery(q: Knex | Knex.Transaction, scope: ChargeScope, today: string): Knex.QueryBuilder {
  const byAccount = 'accountId' in scope;

  const allocations = q('payment_allocations as pa')
    .select('pa.charge_id')
    .sum({ paid: 'pa.amount' })
    .groupBy('pa.charge_id')
    .modify((sq) => {
      if (byAccount) sq.where('pa.account_id', scope.accountId);
      else sq.whereIn('pa.charge_id', q('rent_charges').select('id').whereIn('tenant_id', scope.tenantIds));
    });

  const pendingPayments = q('payments as pp')
    .select('pp.target_charge_id')
    .sum({ pending_amount: 'pp.amount' })
    .count({ pending_count: '*' })
    .where('pp.status', 'pending')
    .whereNotNull('pp.target_charge_id')
    .groupBy('pp.target_charge_id')
    .modify((sq) => {
      if (byAccount) sq.where('pp.account_id', scope.accountId);
      else sq.whereIn('pp.tenant_id', scope.tenantIds);
    });

  return q('rent_charges as c')
    .join('tenants as t', 't.id', 'c.tenant_id')
    .join('units as u', 'u.id', 'c.unit_id')
    .join('properties as p', 'p.id', 'u.property_id')
    .leftJoin(allocations.as('al'), 'al.charge_id', 'c.id')
    .leftJoin(pendingPayments.as('pnd'), 'pnd.target_charge_id', 'c.id')
    .modify((qb) => {
      if (byAccount) qb.where('c.account_id', scope.accountId);
      else qb.whereIn('c.tenant_id', scope.tenantIds);
    })
    .select(
      'c.id',
      'c.account_id',
      'c.agreement_id',
      'c.tenant_id',
      'c.unit_id',
      'c.kind',
      'c.description',
      'c.period_start',
      'c.period_end',
      'c.due_date',
      'c.base_amount',
      'c.gst_rate',
      'c.gst_amount',
      'c.total_amount',
      'c.voided_at',
      'c.void_reason',
      'c.created_at',
      't.name as tenant_name',
      't.phone as tenant_phone',
      't.business_name as tenant_business_name',
      'u.name as unit_name',
      'u.type as unit_type',
      'p.id as property_id',
      'p.name as property_name',
      'p.type as property_type',
      q.raw('COALESCE(al.paid, 0) AS paid_amount'),
      q.raw('c.total_amount - COALESCE(al.paid, 0) AS balance'),
      q.raw('COALESCE(pnd.pending_amount, 0) AS pending_amount'),
      q.raw('COALESCE(pnd.pending_count, 0) AS pending_count'),
      q.raw(
        `CASE
           WHEN c.voided_at IS NOT NULL THEN 'void'
           WHEN c.total_amount - COALESCE(al.paid, 0) <= 0 THEN 'collected'
           WHEN COALESCE(pnd.pending_count, 0) > 0 THEN 'to_confirm'
           WHEN c.due_date < ?::date THEN 'overdue'
           ELSE 'pending'
         END AS status`,
        [today],
      ),
      q.raw(
        '(c.voided_at IS NULL AND c.total_amount - COALESCE(al.paid, 0) > 0 AND c.due_date < ?::date) AS is_overdue',
        [today],
      ),
      q.raw('(c.voided_at IS NULL AND COALESCE(al.paid, 0) > 0 AND c.total_amount - COALESCE(al.paid, 0) > 0) AS is_partial'),
    );
}

export interface RentEntryDto {
  id: string;
  agreementId: string;
  kind: ChargeKind;
  description: string | null;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  month: string;
  dueDate: string;
  baseAmount: number;
  gstRate: number;
  gstAmount: number;
  totalAmount: number;
  paidAmount: number;
  balance: number;
  pendingAmount: number;
  status: ChargeStatus;
  isOverdue: boolean;
  isPartial: boolean;
  daysOverdue: number;
  voidedAt: string | null;
  voidReason: string | null;
  tenant: { id: string; name: string; phone: string; businessName: string | null };
  unit: { id: string; name: string; type: string };
  property: { id: string; name: string; type: string };
  createdAt: string;
}

const KIND_LABELS: Record<string, string> = {
  opening_balance: 'Previous outstanding',
  maintenance: 'Maintenance charge',
  utility: 'Utility charge',
  late_fee: 'Late fee',
  other: 'Other charge',
};

export function periodLabelFor(kind: string, periodStart: string, periodEnd: string): string {
  if (kind !== 'rent') return KIND_LABELS[kind] ?? 'Charge';
  const startsOnFirst = periodStart === startOfMonth(periodStart);
  const endsOnLast = periodEnd === endOfMonth(periodEnd);
  if (startsOnFirst && endsOnLast) {
    const from = monthKeyOf(periodStart);
    const to = monthKeyOf(periodEnd);
    return from === to ? monthLabel(from) : `${shortMonthLabel(from)} – ${shortMonthLabel(to)}`;
  }
  return `${humanDate(periodStart)} – ${humanDate(periodEnd)}`;
}

export function mapCharge(row: Record<string, any>, today: string): RentEntryDto {
  const isOverdue = Boolean(row.is_overdue);
  return {
    id: row.id,
    agreementId: row.agreement_id,
    kind: row.kind,
    description: row.description ?? null,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    periodLabel: periodLabelFor(row.kind, row.period_start, row.period_end),
    month: monthKeyOf(row.period_start),
    dueDate: row.due_date,
    baseAmount: Number(row.base_amount),
    gstRate: Number(row.gst_rate),
    gstAmount: Number(row.gst_amount),
    totalAmount: Number(row.total_amount),
    paidAmount: Number(row.paid_amount),
    balance: Math.max(0, Number(row.balance)),
    pendingAmount: Number(row.pending_amount),
    status: row.status,
    isOverdue,
    isPartial: Boolean(row.is_partial),
    daysOverdue: isOverdue ? Math.max(0, diffDays(row.due_date, today)) : 0,
    voidedAt: row.voided_at ?? null,
    voidReason: row.void_reason ?? null,
    tenant: {
      id: row.tenant_id,
      name: row.tenant_name,
      phone: row.tenant_phone,
      businessName: row.tenant_business_name ?? null,
    },
    unit: { id: row.unit_id, name: row.unit_name, type: row.unit_type },
    property: { id: row.property_id, name: row.property_name, type: row.property_type },
    createdAt: row.created_at,
  };
}
