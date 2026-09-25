import { db } from '../../db/knex.js';
import type { Ctx } from '../../lib/context.js';
import { humanDate, monthEnd, monthStart } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import { formatInr, gstFor, round2, subtractMoney } from '../../lib/money.js';
import { likePattern, resolveSort } from '../../lib/validation.js';
import { logActivity } from '../activity/activity.service.js';
import { notifyTenant } from '../notifications/notifications.service.js';
import { allocateTenant, clearChargeAllocations, tenantAdvanceCredit, trimChargeAllocations } from '../payments/allocation.service.js';
import { METHOD_LABELS, type PaymentMethod, type RecordableMethod } from '../payments/payment.types.js';
import { createPayment, type PaymentDetailDto } from '../payments/payments.service.js';
import { chargeQuery, mapCharge, periodLabelFor, type ChargeKind, type RentEntryDto } from './charge-query.js';
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
      dueDate: 'x.due_date',
      amount: 'x.total_amount',
      balance: 'x.balance',
      unit: 'lower(x.unit_name)',
      tenant: 'lower(x.tenant_name)',
      period: 'x.period_start',
      createdAt: 'x.created_at',
    },
    { column: 'x.due_date', direction: 'asc' },
  );

  const inner = chargeQuery(db, { accountId: ctx.accountId }, ctx.today).modify((q) => {
    if (opts.month) q.whereBetween('c.period_start', [monthStart(opts.month), monthEnd(opts.month)]);
    if (opts.propertyId) q.where('p.id', opts.propertyId);
    if (opts.unitId) q.where('c.unit_id', opts.unitId);
    if (opts.tenantId) q.where('c.tenant_id', opts.tenantId);
    if (opts.agreementId) q.where('c.agreement_id', opts.agreementId);
    if (opts.kind) q.where('c.kind', opts.kind);
    if (opts.search) {
      const pattern = likePattern(opts.search);
      q.where((w) =>
        w
          .whereILike('u.name', pattern)
          .orWhereILike('t.name', pattern)
          .orWhereILike('t.business_name', pattern)
          .orWhereILike('p.name', pattern)
          .orWhereILike('c.description', pattern),
      );
    }
  });

  const [agg] = await db
    .from(inner.clone().as('x'))
    .select(
      db.raw(`COUNT(*) FILTER (WHERE x.status <> 'void') AS all_count`),
      db.raw(`COUNT(*) FILTER (WHERE x.status = 'overdue') AS overdue_count`),
      db.raw(`COUNT(*) FILTER (WHERE x.status = 'to_confirm') AS to_confirm_count`),
      db.raw(`COUNT(*) FILTER (WHERE x.status = 'pending') AS pending_count`),
      db.raw(`COUNT(*) FILTER (WHERE x.is_partial) AS partial_count`),
      db.raw(`COUNT(*) FILTER (WHERE x.status = 'collected') AS collected_count`),
      db.raw(`COUNT(*) FILTER (WHERE x.status = 'void') AS void_count`),
      db.raw(`COALESCE(SUM(x.total_amount) FILTER (WHERE x.status <> 'void'), 0) AS expected`),
      db.raw(`COALESCE(SUM(x.paid_amount) FILTER (WHERE x.status <> 'void'), 0) AS collected`),
      db.raw(`COALESCE(SUM(x.balance) FILTER (WHERE x.status <> 'void'), 0) AS outstanding`),
      db.raw(`COALESCE(SUM(x.balance) FILTER (WHERE x.is_overdue), 0) AS overdue`),
      db.raw(
        `COALESCE(SUM(CASE WHEN x.total_amount > 0 THEN x.paid_amount * x.gst_amount / x.total_amount ELSE 0 END) FILTER (WHERE x.status <> 'void'), 0) AS gst_collected`,
      ),
    );

  const counts: LedgerCounts = {
    all: Number(agg.all_count),
    overdue: Number(agg.overdue_count),
    to_confirm: Number(agg.to_confirm_count),
    pending: Number(agg.pending_count),
    partial: Number(agg.partial_count),
    collected: Number(agg.collected_count),
    void: Number(agg.void_count),
  };

  const filtered = db.from(inner.as('x')).modify((q) => {
    switch (opts.status ?? 'all') {
      case 'all':
        q.whereNot('x.status', 'void');
        break;
      case 'partial':
        q.where('x.is_partial', true);
        break;
      case 'unpaid':
        q.whereIn('x.status', ['overdue', 'pending', 'to_confirm']);
        break;
      default:
        q.where('x.status', opts.status!);
    }
  });
  const [{ count }] = await filtered.clone().count<{ count: number }[]>({ count: '*' });
  const rows = await filtered
    .select('x.*')
    .orderByRaw(`${sort.column} ${sort.direction}, lower(x.unit_name) ASC, x.id`)
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);

  let earlierDues: { amount: number; count: number } | null = null;
  if (opts.month) {
    const [earlier] = await db
      .from(chargeQuery(db, { accountId: ctx.accountId }, ctx.today).where('c.period_start', '<', monthStart(opts.month)).as('e'))
      .whereIn('e.status', ['overdue', 'pending', 'to_confirm'])
      .select(db.raw('COALESCE(SUM(e.balance), 0) AS amount'), db.raw('COUNT(*) AS count'));
    earlierDues = { amount: Number(earlier.amount), count: Number(earlier.count) };
  }

  return {
    items: rows.map((r: Record<string, any>) => mapCharge(r, ctx.today)),
    total: Number(count),
    counts,
    totals: {
      expected: Number(agg.expected),
      collected: Number(agg.collected),
      outstanding: Number(agg.outstanding),
      overdue: Number(agg.overdue),
      gstCollected: round2(Number(agg.gst_collected)),
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
  const row = await db.from(chargeQuery(db, { accountId: ctx.accountId }, ctx.today).where('c.id', id).as('x')).first();
  if (!row) throw Errors.notFound('Rent entry');
  const entry = mapCharge(row, ctx.today);

  const agreement = await db('agreements').where({ id: entry.agreementId }).first();

  // Statement-style view of the agreement as at this period (see README "Balance calculation"):
  //   previousDue = earlier charges - payments made before this period applied to them
  //   paid        = payments applied to this entry + payments made since this period applied to earlier entries
  //   remaining   = previousDue + this period's total - paid  (= live outstanding up to this entry)
  const { rows: calcRows } = await db.raw<{ rows: Array<{ earlier_total: number; earlier_paid_before: number; earlier_paid_since: number }> }>(
    `SELECT
        COALESCE((SELECT SUM(c.total_amount) FROM rent_charges c
                   WHERE c.agreement_id = :agreementId AND c.voided_at IS NULL AND c.id <> :chargeId
                     AND (c.period_start < :periodStart OR (c.period_start = :periodStart AND c.kind = 'opening_balance' AND :kind <> 'opening_balance'))), 0) AS earlier_total,
        COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                    JOIN rent_charges c ON c.id = pa.charge_id
                    JOIN payments p ON p.id = pa.payment_id
                   WHERE c.agreement_id = :agreementId AND c.voided_at IS NULL AND c.id <> :chargeId
                     AND (c.period_start < :periodStart OR (c.period_start = :periodStart AND c.kind = 'opening_balance' AND :kind <> 'opening_balance'))
                     AND p.paid_on < :periodStart), 0) AS earlier_paid_before,
        COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                    JOIN rent_charges c ON c.id = pa.charge_id
                    JOIN payments p ON p.id = pa.payment_id
                   WHERE c.agreement_id = :agreementId AND c.voided_at IS NULL AND c.id <> :chargeId
                     AND (c.period_start < :periodStart OR (c.period_start = :periodStart AND c.kind = 'opening_balance' AND :kind <> 'opening_balance'))
                     AND p.paid_on >= :periodStart), 0) AS earlier_paid_since`,
    { agreementId: entry.agreementId, chargeId: entry.id, periodStart: entry.periodStart, kind: entry.kind },
  );
  const calc = calcRows[0];
  const isVoid = entry.status === 'void';
  const previousDue = isVoid ? 0 : subtractMoney(Number(calc.earlier_total), Number(calc.earlier_paid_before));
  const periodTotal = isVoid ? 0 : entry.totalAmount;
  const paid = isVoid ? 0 : round2(entry.paidAmount + Number(calc.earlier_paid_since));
  const totalPayable = round2(previousDue + periodTotal);

  const payments = await db('payment_allocations as pa')
    .join('payments as p', 'p.id', 'pa.payment_id')
    .where('pa.charge_id', id)
    .orderBy([
      { column: 'p.paid_on', order: 'asc' },
      { column: 'p.created_at', order: 'asc' },
    ])
    .select('pa.amount as allocated', 'p.id', 'p.amount', 'p.paid_on', 'p.method', 'p.reference', 'p.source');

  const pending = await db('payments')
    .where({ target_charge_id: id, status: 'pending', account_id: ctx.accountId })
    .orderBy('created_at', 'asc');

  const advanceCredit = await tenantAdvanceCredit(db, entry.tenant.id);

  return {
    ...entry,
    agreement: {
      id: agreement.id,
      status: agreement.status,
      rentAmount: Number(agreement.rent_amount),
      billingCycle: agreement.billing_cycle,
      dueDay: agreement.due_day,
      gstApplicable: agreement.gst_applicable,
      gstRate: Number(agreement.gst_rate),
      startDate: agreement.start_date,
      endDate: agreement.end_date,
      endedOn: agreement.ended_on,
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
      reference: p.reference,
      source: p.source,
    })),
    pendingPayments: pending.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      paidOn: p.paid_on,
      method: p.method,
      methodLabel: METHOD_LABELS[p.method as PaymentMethod] ?? p.method,
      reference: p.reference,
      notes: p.notes,
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
  const id = await db.transaction(async (trx) => {
    const agreement = await trx('agreements').where({ id: input.agreementId, account_id: ctx.accountId }).first();
    if (!agreement) throw Errors.validation('Agreement not found.', [{ field: 'agreementId', message: 'Agreement not found' }]);
    const periodStart = input.periodStart ?? input.dueDate;
    const periodEnd = input.periodEnd ?? periodStart;
    if (periodEnd < periodStart) {
      throw Errors.validation('Period end must be on or after period start.', [{ field: 'periodEnd', message: 'Invalid period' }]);
    }
    const rate = input.gstApplicable ? Number(agreement.gst_rate) || ctx.gstRate : 0;
    const [row] = await trx('rent_charges')
      .insert({
        account_id: ctx.accountId,
        agreement_id: agreement.id,
        tenant_id: agreement.tenant_id,
        unit_id: agreement.unit_id,
        kind: input.kind,
        description: input.description ?? null,
        period_start: periodStart,
        period_end: periodEnd,
        due_date: input.dueDate,
        base_amount: input.amount,
        gst_rate: rate,
        gst_amount: gstFor(input.amount, rate),
        created_by: ctx.userId,
      })
      .returning('id');
    await allocateTenant(trx, ctx.accountId, agreement.tenant_id);
    const tenant = await trx('tenants').where({ id: agreement.tenant_id }).first('name');
    await logActivity(trx, ctx, {
      action: 'charge.created',
      entityType: 'charge',
      entityId: row.id,
      summary: `Added ${periodLabelFor(input.kind, periodStart, periodEnd).toLowerCase()} of ${formatInr(input.amount)} for ${tenant?.name}`,
    });
    return row.id as string;
  });
  return getRent(ctx, id);
}

export async function updateCharge(
  ctx: Ctx,
  id: string,
  input: { baseAmount?: number; dueDate?: string; description?: string | null; reason?: string | null },
): Promise<RentEntryDetailDto> {
  await db.transaction(async (trx) => {
    const charge = await trx('rent_charges').where({ id, account_id: ctx.accountId }).forUpdate().first();
    if (!charge) throw Errors.notFound('Rent entry');
    if (charge.voided_at) throw Errors.conflict('Cancelled entries cannot be edited.');
    const changes: Record<string, unknown> = {};
    const notes: string[] = [];
    if (input.baseAmount !== undefined && input.baseAmount !== Number(charge.base_amount)) {
      changes.base_amount = input.baseAmount;
      changes.gst_amount = gstFor(input.baseAmount, Number(charge.gst_rate));
      notes.push(`amount ${formatInr(Number(charge.base_amount))} → ${formatInr(input.baseAmount)}`);
    }
    if (input.dueDate !== undefined && input.dueDate !== charge.due_date) {
      changes.due_date = input.dueDate;
      notes.push(`due date → ${humanDate(input.dueDate)}`);
    }
    if (input.description !== undefined) changes.description = input.description;
    if (!Object.keys(changes).length) return;

    await trx('rent_charges').where({ id }).update(changes);
    if (changes.base_amount !== undefined) {
      const newTotal = round2(Number(changes.base_amount) + Number(changes.gst_amount));
      await trimChargeAllocations(trx, id, newTotal);
    }
    await allocateTenant(trx, ctx.accountId, charge.tenant_id);
    const unit = await trx('units').where({ id: charge.unit_id }).first('name');
    await logActivity(trx, ctx, {
      action: 'charge.updated',
      entityType: 'charge',
      entityId: id,
      summary: `Adjusted ${periodLabelFor(charge.kind, charge.period_start, charge.period_end)} for ${unit?.name}${notes.length ? `: ${notes.join(', ')}` : ''}${input.reason ? ` (${input.reason})` : ''}`,
    });
  });
  return getRent(ctx, id);
}

export async function voidCharge(ctx: Ctx, id: string, reason: string): Promise<RentEntryDetailDto> {
  await db.transaction(async (trx) => {
    const charge = await trx('rent_charges').where({ id, account_id: ctx.accountId }).forUpdate().first();
    if (!charge) throw Errors.notFound('Rent entry');
    if (charge.voided_at) throw Errors.conflict('This entry is already cancelled.');
    await clearChargeAllocations(trx, id);
    await trx('rent_charges').where({ id }).update({ voided_at: new Date(), void_reason: reason });
    await allocateTenant(trx, ctx.accountId, charge.tenant_id);
    const unit = await trx('units').where({ id: charge.unit_id }).first('name');
    await logActivity(trx, ctx, {
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
  const account = await db('accounts').where({ id: ctx.accountId }).first();
  const dueText = entry.isOverdue ? `was due on ${humanDate(entry.dueDate)}` : `is due on ${humanDate(entry.dueDate)}`;
  const payHint = account?.upi_id ? ` You can pay via UPI to ${account.upi_id}.` : '';
  const message =
    `Hi ${entry.tenant.name}, this is a gentle reminder that ${formatInr(entry.balance)} for ${entry.unit.name} ` +
    `(${entry.periodLabel}) ${dueText}.${payHint} Thank you! — ${account?.payee_name || ctx.accountName}`;
  const digits = entry.tenant.phone.replace(/\D/g, '');

  const notified = await db.transaction(async (trx) => {
    const count = await notifyTenant(trx, entry.tenant.id, {
      type: 'reminder',
      title: `Rent reminder: ${formatInr(entry.balance)} ${entry.isOverdue ? 'overdue' : 'due'}`,
      body: message,
      entityType: 'charge',
      entityId: entry.id,
      dedupeKey: `reminder:${entry.id}:${ctx.today}`,
    });
    await logActivity(trx, ctx, {
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
