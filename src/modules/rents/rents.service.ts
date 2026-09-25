import type { Document } from 'mongodb';
import { $round2, col, contains, lockDoc, newId, withTransaction } from '../../db/mongo.js';
import type { Ctx } from '../../lib/context.js';
import { humanDate, monthEnd, monthStart } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import { formatInr, gstFor, round2, subtractMoney } from '../../lib/money.js';
import { resolveSort } from '../../lib/validation.js';
import { logActivity } from '../activity/activity.service.js';
import { notifyTenant } from '../notifications/notifications.service.js';
import { allocateTenant, clearChargeAllocations, tenantAdvanceCredit, trimChargeAllocations } from '../payments/allocation.service.js';
import { METHOD_LABELS, type PaymentMethod, type RecordableMethod } from '../payments/payment.types.js';
import { createPayment, type PaymentDetailDto } from '../payments/payments.service.js';
import { chargeRefStages, chargeStatusStages, findCharges, mapCharge, periodLabelFor, type ChargeKind, type RentEntryDto } from './charge-query.js';
import { ensureAccountCharges } from './generation.service.js';

export type LedgerFilter = 'all' | 'overdue' | 'to_confirm' | 'pending' | 'partial' | 'collected' | 'unpaid' | 'void';

export interface LedgerCounts {
  all: number;
  overdue: number;
  to_confirm: number;
  pending: number;
  partial: number;
  collected: number;
  void: number;
}

export interface LedgerTotals {
  expected: number;
  collected: number;
  outstanding: number;
  overdue: number;
  gstCollected: number;
}

export async function listRents(
  ctx: Ctx,
  opts: {
    page: number;
    pageSize: number;
    month?: string;
    status?: LedgerFilter;
    search?: string;
    propertyId?: string;
    unitId?: string;
    tenantId?: string;
    agreementId?: string;
    kind?: ChargeKind;
    sort?: string;
  },
): Promise<{
  items: RentEntryDto[];
  total: number;
  counts: LedgerCounts;
  totals: LedgerTotals;
  earlierDues: { amount: number; count: number } | null;
}> {
  await ensureAccountCharges(ctx.accountId, ctx.today);

  const sort = resolveSort(
    opts.sort,
    {
      dueDate: 'due_date',
      amount: 'total_amount',
      balance: 'balance',
      unit: '_unit_lc',
      tenant: '_tenant_lc',
      period: 'period_start',
      createdAt: 'created_at',
    },
    { column: 'due_date', direction: 'asc' },
  );

  const match: Document = {};
  if (opts.month) match.period_start = { $gte: monthStart(opts.month), $lte: monthEnd(opts.month) };
  if (opts.unitId) match.unit_id = opts.unitId;
  if (opts.tenantId) match.tenant_id = opts.tenantId;
  if (opts.agreementId) match.agreement_id = opts.agreementId;
  if (opts.kind) match.kind = opts.kind;
  if (opts.propertyId) {
    const unitIds = await col('units').distinct('_id', { account_id: ctx.accountId, property_id: opts.propertyId });
    match.unit_id = opts.unitId ? (unitIds.includes(opts.unitId) ? opts.unitId : '__none__') : { $in: unitIds };
  }

  const pipeline: Document[] = [...chargeStatusStages({ accountId: ctx.accountId }, ctx.today, match), ...chargeRefStages()];
  if (opts.search) {
    const pattern = contains(opts.search);
    pipeline.push({
      $match: { $or: [{ unit_name: pattern }, { tenant_name: pattern }, { tenant_business_name: pattern }, { property_name: pattern }, { description: pattern }] },
    });
  }
  pipeline.push({ $addFields: { _unit_lc: { $toLower: { $ifNull: ['$unit_name', ''] } }, _tenant_lc: { $toLower: { $ifNull: ['$tenant_name', ''] } } } });

  const statusMatch: Document = (() => {
    switch (opts.status ?? 'all') {
      case 'all':
        return { status: { $ne: 'void' } };
      case 'partial':
        return { is_partial: true };
      case 'unpaid':
        return { status: { $in: ['overdue', 'pending', 'to_confirm'] } };
      default:
        return { status: opts.status };
    }
  })();

  const notVoid = { $ne: ['$status', 'void'] };
  const [result] = await col('rent_charges')
    .aggregate([
      ...pipeline,
      {
        $facet: {
          agg: [
            {
              $group: {
                _id: null,
                all_count: { $sum: { $cond: [notVoid, 1, 0] } },
                overdue_count: { $sum: { $cond: [{ $eq: ['$status', 'overdue'] }, 1, 0] } },
                to_confirm_count: { $sum: { $cond: [{ $eq: ['$status', 'to_confirm'] }, 1, 0] } },
                pending_count: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
                partial_count: { $sum: { $cond: ['$is_partial', 1, 0] } },
                collected_count: { $sum: { $cond: [{ $eq: ['$status', 'collected'] }, 1, 0] } },
                void_count: { $sum: { $cond: [{ $eq: ['$status', 'void'] }, 1, 0] } },
                expected: { $sum: { $cond: [notVoid, '$total_amount', 0] } },
                collected: { $sum: { $cond: [notVoid, '$paid_amount', 0] } },
                outstanding: { $sum: { $cond: [notVoid, '$balance', 0] } },
                overdue: { $sum: { $cond: ['$is_overdue', '$balance', 0] } },
                gst_collected: {
                  $sum: {
                    $cond: [
                      { $and: [notVoid, { $gt: ['$total_amount', 0] }] },
                      { $divide: [{ $multiply: ['$paid_amount', '$gst_amount'] }, '$total_amount'] },
                      0,
                    ],
                  },
                },
              },
            },
          ],
          total: [{ $match: statusMatch }, { $count: 'count' }],
          rows: [
            { $match: statusMatch },
            { $sort: { [sort.column]: sort.direction === 'asc' ? 1 : -1, _unit_lc: 1, _id: 1 } },
            { $skip: (opts.page - 1) * opts.pageSize },
            { $limit: opts.pageSize },
          ],
        },
      },
    ])
    .toArray();

  const agg = result.agg[0] ?? {};
  const counts: LedgerCounts = {
    all: agg.all_count ?? 0,
    overdue: agg.overdue_count ?? 0,
    to_confirm: agg.to_confirm_count ?? 0,
    pending: agg.pending_count ?? 0,
    partial: agg.partial_count ?? 0,
    collected: agg.collected_count ?? 0,
    void: agg.void_count ?? 0,
  };

  let earlierDues: { amount: number; count: number } | null = null;
  if (opts.month) {
    const [earlier] = await col('rent_charges')
      .aggregate([
        ...chargeStatusStages({ accountId: ctx.accountId }, ctx.today, { period_start: { $lt: monthStart(opts.month) } }),
        { $match: { status: { $in: ['overdue', 'pending', 'to_confirm'] } } },
        { $group: { _id: null, amount: { $sum: '$balance' }, count: { $sum: 1 } } },
      ])
      .toArray();
    earlierDues = { amount: round2(earlier?.amount ?? 0), count: earlier?.count ?? 0 };
  }

  return {
    items: result.rows.map((r: Record<string, any>) => mapCharge(r, ctx.today)),
    total: result.total[0]?.count ?? 0,
    counts,
    totals: {
      expected: round2(agg.expected ?? 0),
      collected: round2(agg.collected ?? 0),
      outstanding: round2(agg.outstanding ?? 0),
      overdue: round2(agg.overdue ?? 0),
      gstCollected: round2(agg.gst_collected ?? 0),
    },
    earlierDues,
  };
}

export interface RentEntryPayment {
  paymentId: string;
  allocatedAmount: number;
  paymentAmount: number;
  paidOn: string;
  method: string;
  methodLabel: string;
  reference: string | null;
  source: string;
}

export interface PendingPayment {
  id: string;
  amount: number;
  paidOn: string;
  method: string;
  methodLabel: string;
  reference: string | null;
  notes: string | null;
  source: string;
  createdAt: string;
}

export interface RentEntryDetailDto extends RentEntryDto {
  agreement: {
    id: string;
    status: string;
    rentAmount: number;
    billingCycle: string;
    dueDay: number;
    gstApplicable: boolean;
    gstRate: number;
    startDate: string;
    endDate: string | null;
    endedOn: string | null;
  };
  calculation: {
    baseAmount: number;
    gstRate: number;
    gstAmount: number;
    periodTotal: number;
    previousDue: number;
    totalPayable: number;
    paid: number;
    remaining: number;
    entryPaid: number;
    entryBalance: number;
    advanceCredit: number;
  };
  payments: RentEntryPayment[];
  pendingPayments: PendingPayment[];
  actions: { canCollect: boolean; canEdit: boolean; canVoid: boolean; canRemind: boolean };
}

export async function getRent(ctx: Ctx, id: string): Promise<RentEntryDetailDto> {
  const [row] = await findCharges({ accountId: ctx.accountId }, ctx.today, { _id: id });
  if (!row) throw Errors.notFound('Rent entry');
  const entry = mapCharge(row, ctx.today);

  const agreement = await col('agreements').findOne({ _id: entry.agreementId });
  if (!agreement) throw Errors.notFound('Agreement');

  // Statement-style view of the agreement as at this period (see README "Balance calculation"):
  //   previousDue = earlier charges - payments made before this period applied to them
  //   paid        = payments applied to this entry + payments made since this period applied to earlier entries
  //   remaining   = previousDue + this period's total - paid  (= live outstanding up to this entry)
  const earlierCharges = await col('rent_charges')
    .find({
      agreement_id: entry.agreementId,
      voided_at: null,
      _id: { $ne: entry.id },
      $or: [
        { period_start: { $lt: entry.periodStart } },
        ...(entry.kind !== 'opening_balance' ? [{ period_start: entry.periodStart, kind: 'opening_balance' }] : []),
      ],
    })
    .project({ total_amount: 1 })
    .toArray();
  const earlierTotal = round2(earlierCharges.reduce((sum, c) => sum + Number(c.total_amount), 0));
  const earlierAllocations = earlierCharges.length
    ? await col('payment_allocations').find({ charge_id: { $in: earlierCharges.map((c) => c._id) } }).toArray()
    : [];
  const allocationPayments = new Map(
    (await col('payments').find({ _id: { $in: [...new Set(earlierAllocations.map((a) => a.payment_id))] } }, { projection: { paid_on: 1 } }).toArray()).map((p) => [
      p._id,
      p.paid_on as string,
    ]),
  );
  let earlierPaidBefore = 0;
  let earlierPaidSince = 0;
  for (const a of earlierAllocations) {
    const paidOn = allocationPayments.get(a.payment_id);
    if (!paidOn) continue;
    if (paidOn < entry.periodStart) earlierPaidBefore = round2(earlierPaidBefore + a.amount);
    else earlierPaidSince = round2(earlierPaidSince + a.amount);
  }

  const isVoid = entry.status === 'void';
  const previousDue = isVoid ? 0 : subtractMoney(earlierTotal, earlierPaidBefore);
  const periodTotal = isVoid ? 0 : entry.totalAmount;
  const paid = isVoid ? 0 : round2(entry.paidAmount + earlierPaidSince);
  const totalPayable = round2(previousDue + periodTotal);

  const payments = await col('payment_allocations')
    .aggregate([
      { $match: { charge_id: id } },
      { $lookup: { from: 'payments', localField: 'payment_id', foreignField: '_id', as: 'p' } },
      { $unwind: '$p' },
      { $sort: { 'p.paid_on': 1, 'p.created_at': 1 } },
      {
        $project: {
          allocated: '$amount',
          id: '$p._id',
          amount: '$p.amount',
          paid_on: '$p.paid_on',
          method: '$p.method',
          reference: '$p.reference',
          source: '$p.source',
        },
      },
    ])
    .toArray();

  const pending = (
    await col('payments').find({ target_charge_id: id, status: 'pending', account_id: ctx.accountId }).sort({ created_at: 1 }).toArray()
  ).map((p): Record<string, any> => ({ ...p, id: p._id }));

  const advanceCredit = await tenantAdvanceCredit(entry.tenant.id);

  return {
    ...entry,
    agreement: {
      id: agreement._id,
      status: agreement.status,
      rentAmount: Number(agreement.rent_amount),
      billingCycle: agreement.billing_cycle,
      dueDay: agreement.due_day,
      gstApplicable: agreement.gst_applicable,
      gstRate: Number(agreement.gst_rate),
      startDate: agreement.start_date,
      endDate: agreement.end_date ?? null,
      endedOn: agreement.ended_on ?? null,
    },
    calculation: {
      baseAmount: entry.baseAmount,
      gstRate: entry.gstRate,
      gstAmount: entry.gstAmount,
      periodTotal,
      previousDue,
      totalPayable,
      paid,
      remaining: Math.max(0, round2(totalPayable - paid)),
      entryPaid: entry.paidAmount,
      entryBalance: entry.balance,
      advanceCredit,
    },
    payments: payments.map((p) => ({
      paymentId: p.id,
      allocatedAmount: Number(p.allocated),
      paymentAmount: Number(p.amount),
      paidOn: p.paid_on,
      method: p.method,
      methodLabel: METHOD_LABELS[p.method as PaymentMethod] ?? p.method,
      reference: p.reference ?? null,
      source: p.source,
    })),
    pendingPayments: pending.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      paidOn: p.paid_on,
      method: p.method,
      methodLabel: METHOD_LABELS[p.method as PaymentMethod] ?? p.method,
      reference: p.reference ?? null,
      notes: p.notes ?? null,
      source: p.source,
      createdAt: p.created_at,
    })),
    actions: {
      canCollect: !isVoid && entry.balance > 0,
      canEdit: !isVoid,
      canVoid: !isVoid,
      canRemind: !isVoid && entry.balance > 0,
    },
  };
}

export async function createCharge(
  ctx: Ctx,
  input: {
    agreementId: string;
    kind: Exclude<ChargeKind, 'rent'>;
    description?: string | null;
    amount: number;
    gstApplicable?: boolean;
    dueDate: string;
    periodStart?: string | null;
    periodEnd?: string | null;
  },
): Promise<RentEntryDetailDto> {
  const id = await withTransaction(async (session) => {
    const agreement = await col('agreements').findOne({ _id: input.agreementId, account_id: ctx.accountId }, { session });
    if (!agreement) throw Errors.validation('Agreement not found.', [{ field: 'agreementId', message: 'Agreement not found' }]);
    const periodStart = input.periodStart ?? input.dueDate;
    const periodEnd = input.periodEnd ?? periodStart;
    if (periodEnd < periodStart) {
      throw Errors.validation('Period end must be on or after period start.', [{ field: 'periodEnd', message: 'Invalid period' }]);
    }
    const rate = input.gstApplicable ? Number(agreement.gst_rate) || ctx.gstRate : 0;
    const gstAmount = gstFor(input.amount, rate);
    const chargeId = newId();
    const now = new Date();
    await col('rent_charges').insertOne(
      {
        _id: chargeId,
        account_id: ctx.accountId,
        agreement_id: agreement._id,
        tenant_id: agreement.tenant_id,
        unit_id: agreement.unit_id,
        kind: input.kind,
        description: input.description ?? null,
        period_start: periodStart,
        period_end: periodEnd,
        due_date: input.dueDate,
        base_amount: input.amount,
        gst_rate: rate,
        gst_amount: gstAmount,
        total_amount: round2(input.amount + gstAmount),
        voided_at: null,
        void_reason: null,
        created_by: ctx.userId,
        created_at: now,
        updated_at: now,
      },
      { session },
    );
    await allocateTenant(session, ctx.accountId, agreement.tenant_id);
    const tenant = await col('tenants').findOne({ _id: agreement.tenant_id }, { session });
    await logActivity(session, ctx, {
      action: 'charge.created',
      entityType: 'charge',
      entityId: chargeId,
      summary: `Added ${periodLabelFor(input.kind, periodStart, periodEnd).toLowerCase()} of ${formatInr(input.amount)} for ${tenant?.name}`,
    });
    return chargeId;
  });
  return getRent(ctx, id);
}

export async function updateCharge(
  ctx: Ctx,
  id: string,
  input: { baseAmount?: number; dueDate?: string; description?: string | null; reason?: string | null },
): Promise<RentEntryDetailDto> {
  await withTransaction(async (session) => {
    const charge = await col('rent_charges').findOne({ _id: id, account_id: ctx.accountId }, { session });
    if (!charge) throw Errors.notFound('Rent entry');
    if (charge.voided_at) throw Errors.conflict('Cancelled entries cannot be edited.');
    const changes: Record<string, unknown> = {};
    const notes: string[] = [];
    if (input.baseAmount !== undefined && input.baseAmount !== Number(charge.base_amount)) {
      changes.base_amount = input.baseAmount;
      changes.gst_amount = gstFor(input.baseAmount, Number(charge.gst_rate));
      changes.total_amount = round2(input.baseAmount + Number(changes.gst_amount));
      notes.push(`amount ${formatInr(Number(charge.base_amount))} → ${formatInr(input.baseAmount)}`);
    }
    if (input.dueDate !== undefined && input.dueDate !== charge.due_date) {
      changes.due_date = input.dueDate;
      notes.push(`due date → ${humanDate(input.dueDate)}`);
    }
    if (input.description !== undefined) changes.description = input.description;
    if (!Object.keys(changes).length) return;

    await col('rent_charges').updateOne({ _id: id }, { $set: { ...changes, updated_at: new Date() }, $inc: { lock_version: 1 } }, { session });
    if (changes.total_amount !== undefined) {
      await trimChargeAllocations(session, id, Number(changes.total_amount));
    }
    await allocateTenant(session, ctx.accountId, charge.tenant_id);
    const unit = await col('units').findOne({ _id: charge.unit_id }, { session });
    await logActivity(session, ctx, {
      action: 'charge.updated',
      entityType: 'charge',
      entityId: id,
      summary: `Adjusted ${periodLabelFor(charge.kind, charge.period_start, charge.period_end)} for ${unit?.name}${notes.length ? `: ${notes.join(', ')}` : ''}${input.reason ? ` (${input.reason})` : ''}`,
    });
  });
  return getRent(ctx, id);
}

export async function voidCharge(ctx: Ctx, id: string, reason: string): Promise<RentEntryDetailDto> {
  await withTransaction(async (session) => {
    const charge = await col('rent_charges').findOne({ _id: id, account_id: ctx.accountId }, { session });
    if (!charge) throw Errors.notFound('Rent entry');
    if (charge.voided_at) throw Errors.conflict('This entry is already cancelled.');
    await lockDoc('rent_charges', id, session);
    await clearChargeAllocations(session, id);
    await col('rent_charges').updateOne({ _id: id }, { $set: { voided_at: new Date(), void_reason: reason, updated_at: new Date() } }, { session });
    await allocateTenant(session, ctx.accountId, charge.tenant_id);
    const unit = await col('units').findOne({ _id: charge.unit_id }, { session });
    await logActivity(session, ctx, {
      action: 'charge.voided',
      entityType: 'charge',
      entityId: id,
      summary: `Cancelled ${periodLabelFor(charge.kind, charge.period_start, charge.period_end)} for ${unit?.name}: ${reason}`,
    });
  });
  return getRent(ctx, id);
}

/** "Mark as collected": records a payment against this entry (defaults to the full balance). */
export async function collectCharge(
  ctx: Ctx,
  id: string,
  input: { amount?: number; paidOn?: string; method: RecordableMethod; reference?: string | null; notes?: string | null },
): Promise<{ entry: RentEntryDetailDto; payment: PaymentDetailDto }> {
  const entry = await getRent(ctx, id);
  if (entry.status === 'void') throw Errors.conflict('This entry has been cancelled.');
  if (entry.balance <= 0) throw Errors.conflict('This entry is already fully collected.');
  const payment = await createPayment(ctx, {
    tenantId: entry.tenant.id,
    agreementId: entry.agreementId,
    targetChargeId: entry.id,
    amount: input.amount ?? entry.balance,
    paidOn: input.paidOn ?? ctx.today,
    method: input.method,
    reference: input.reference ?? null,
    notes: input.notes ?? null,
  });
  return { entry: await getRent(ctx, id), payment };
}

export async function remindCharge(
  ctx: Ctx,
  id: string,
): Promise<{ message: string; phone: string; whatsappUrl: string; smsUrl: string; notifiedInApp: boolean }> {
  const entry = await getRent(ctx, id);
  if (entry.status === 'void' || entry.balance <= 0) throw Errors.conflict('There is nothing due on this entry.');
  const account = await col('accounts').findOne({ _id: ctx.accountId });
  const dueText = entry.isOverdue ? `was due on ${humanDate(entry.dueDate)}` : `is due on ${humanDate(entry.dueDate)}`;
  const payHint = account?.upi_id ? ` You can pay via UPI to ${account.upi_id}.` : '';
  const message =
    `Hi ${entry.tenant.name}, this is a gentle reminder that ${formatInr(entry.balance)} for ${entry.unit.name} ` +
    `(${entry.periodLabel}) ${dueText}.${payHint} Thank you! — ${account?.payee_name || ctx.accountName}`;
  const digits = entry.tenant.phone.replace(/\D/g, '');

  const notified = await withTransaction(async (session) => {
    const count = await notifyTenant(session, entry.tenant.id, {
      type: 'reminder',
      title: `Rent reminder: ${formatInr(entry.balance)} ${entry.isOverdue ? 'overdue' : 'due'}`,
      body: message,
      entityType: 'charge',
      entityId: entry.id,
      dedupeKey: `reminder:${entry.id}:${ctx.today}`,
    });
    await logActivity(session, ctx, {
      action: 'charge.reminded',
      entityType: 'charge',
      entityId: entry.id,
      summary: `Sent a rent reminder to ${entry.tenant.name} for ${entry.unit.name} (${formatInr(entry.balance)})`,
    });
    return count > 0;
  });

  return {
    message,
    phone: entry.tenant.phone,
    whatsappUrl: `https://wa.me/${digits}?text=${encodeURIComponent(message)}`,
    smsUrl: `sms:${entry.tenant.phone}?body=${encodeURIComponent(message)}`,
    notifiedInApp: notified,
  };
}

export async function generateNow(ctx: Ctx): Promise<{ created: number }> {
  return { created: await ensureAccountCharges(ctx.accountId, ctx.today, { force: true }) };
}
