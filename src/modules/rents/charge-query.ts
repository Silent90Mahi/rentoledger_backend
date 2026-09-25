import type { Document } from 'mongodb';
import { $round2, col, type Session } from '../../db/mongo.js';
import { diffDays, endOfMonth, humanDate, monthKeyOf, monthLabel, shortMonthLabel, startOfMonth } from '../../lib/dates.js';

export type ChargeStatus = 'collected' | 'to_confirm' | 'overdue' | 'pending' | 'void';
export type ChargeKind = 'rent' | 'opening_balance' | 'maintenance' | 'utility' | 'late_fee' | 'other';

export type ChargeScope = { accountId: string } | { tenantIds: string[] };

/**
 * Aggregation stages for rent entries with their live financial state,
 * derived purely from transactions:
 *   paid_amount = sum of allocations, balance = total - paid,
 *   status      = void | collected | to_confirm | overdue | pending.
 * Output documents use the same field names as `rent_charges` plus `id`
 * and the computed fields; add `$match`/`$sort`/`$group` stages after them.
 */
export function chargeStatusStages(scope: ChargeScope, today: string, match: Document = {}): Document[] {
  const scopeMatch = 'accountId' in scope ? { account_id: scope.accountId } : { tenant_id: { $in: scope.tenantIds } };
  return [
    { $match: { ...scopeMatch, ...match } },
    {
      $lookup: {
        from: 'payment_allocations',
        localField: '_id',
        foreignField: 'charge_id',
        pipeline: [{ $project: { amount: 1 } }],
        as: '_al',
      },
    },
    {
      $lookup: {
        from: 'payments',
        localField: '_id',
        foreignField: 'target_charge_id',
        pipeline: [{ $match: { status: 'pending' } }, { $project: { amount: 1 } }],
        as: '_pnd',
      },
    },
    {
      $addFields: {
        id: '$_id',
        paid_amount: $round2({ $sum: '$_al.amount' }),
        pending_amount: $round2({ $sum: '$_pnd.amount' }),
        pending_count: { $size: '$_pnd' },
      },
    },
    { $addFields: { balance: $round2({ $subtract: ['$total_amount', '$paid_amount'] }) } },
    {
      $addFields: {
        status: {
          $switch: {
            branches: [
              { case: { $ne: [{ $ifNull: ['$voided_at', null] }, null] }, then: 'void' },
              { case: { $lte: ['$balance', 0] }, then: 'collected' },
              { case: { $gt: ['$pending_count', 0] }, then: 'to_confirm' },
              { case: { $lt: ['$due_date', today] }, then: 'overdue' },
            ],
            default: 'pending',
          },
        },
        is_overdue: {
          $and: [{ $eq: [{ $ifNull: ['$voided_at', null] }, null] }, { $gt: ['$balance', 0] }, { $lt: ['$due_date', today] }],
        },
        is_partial: {
          $and: [{ $eq: [{ $ifNull: ['$voided_at', null] }, null] }, { $gt: ['$paid_amount', 0] }, { $gt: ['$balance', 0] }],
        },
      },
    },
    { $project: { _al: 0, _pnd: 0, lock_version: 0 } },
  ];
}

/** Adds tenant/unit/property names to each entry. */
export function chargeRefStages(): Document[] {
  return [
    { $lookup: { from: 'tenants', localField: 'tenant_id', foreignField: '_id', pipeline: [{ $project: { name: 1, phone: 1, business_name: 1 } }], as: '_t' } },
    { $lookup: { from: 'units', localField: 'unit_id', foreignField: '_id', pipeline: [{ $project: { name: 1, type: 1, property_id: 1 } }], as: '_u' } },
    { $addFields: { _t: { $first: '$_t' }, _u: { $first: '$_u' } } },
    { $lookup: { from: 'properties', localField: '_u.property_id', foreignField: '_id', pipeline: [{ $project: { name: 1, type: 1 } }], as: '_p' } },
    { $addFields: { _p: { $first: '$_p' } } },
    {
      $addFields: {
        tenant_name: '$_t.name',
        tenant_phone: '$_t.phone',
        tenant_business_name: '$_t.business_name',
        unit_name: '$_u.name',
        unit_type: '$_u.type',
        property_id: '$_p._id',
        property_name: '$_p.name',
        property_type: '$_p.type',
      },
    },
    { $project: { _t: 0, _u: 0, _p: 0 } },
  ];
}

/** Full rows (status + names) matching `match`, e.g. `{ _id: id }` or `{ agreement_id }`. */
export async function findCharges(
  scope: ChargeScope,
  today: string,
  match: Document = {},
  options: { sort?: Document; limit?: number; session?: Session } = {},
): Promise<Array<Record<string, any>>> {
  const pipeline: Document[] = [...chargeStatusStages(scope, today, match)];
  if (options.sort) pipeline.push({ $sort: options.sort });
  if (options.limit) pipeline.push({ $limit: options.limit });
  pipeline.push(...chargeRefStages());
  return col('rent_charges').aggregate(pipeline, options.session ? { session: options.session } : {}).toArray();
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
