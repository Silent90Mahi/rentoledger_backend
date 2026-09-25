import { config } from '../../config/env.js';
import { db } from '../../db/knex.js';
import { now, todayIn } from '../../lib/clock.js';
import type { TenantCtx } from '../../lib/context.js';
import { humanDate, monthEnd, monthKeyOf, monthLabel, monthStart } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import { formatInr, round2 } from '../../lib/money.js';
import { logActivity } from '../activity/activity.service.js';
import { notifyAccountMembers } from '../notifications/notifications.service.js';
import { METHOD_LABELS, type PaymentMethod, type RecordableMethod } from '../payments/payment.types.js';
import { chargeQuery, mapCharge, type RentEntryDto } from '../rents/charge-query.js';
import { ensureAccountCharges } from '../rents/generation.service.js';

interface Tenancy {
  tenantId: string;
  tenantName: string;
  accountId: string;
  accountName: string;
  timezone: string;
  payeeName: string | null;
  upiId: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  ownerName: string | null;
  ownerPhone: string | null;
}

async function tenancies(ctx: TenantCtx): Promise<Tenancy[]> {
  const rows = await db('tenants as t')
    .join('accounts as a', 'a.id', 't.account_id')
    .leftJoin('account_members as m', function () {
      this.on('m.account_id', '=', 'a.id').andOn('m.role', '=', db.raw('?', ['owner']));
    })
    .leftJoin('users as o', 'o.id', 'm.user_id')
    .whereIn('t.id', ctx.tenantIds)
    .select('t.id as tenant_id', 't.name as tenant_name', 'a.*', 'o.name as owner_name', 'o.phone as owner_phone');
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    accountId: r.id,
    accountName: r.name,
    timezone: r.timezone,
    payeeName: r.payee_name,
    upiId: r.upi_id,
    bankAccountName: r.bank_account_name,
    bankAccountNumber: r.bank_account_number,
    bankIfsc: r.bank_ifsc,
    bankName: r.bank_name,
    ownerName: r.owner_name,
    ownerPhone: r.owner_phone,
  }));
}

function tenantToday(list: Tenancy[]): string {
  return todayIn(list[0]?.timezone ?? config.defaults.timezone);
}

async function refreshCharges(list: Tenancy[], today: string) {
  const accounts = [...new Set(list.map((t) => t.accountId))];
  for (const accountId of accounts) await ensureAccountCharges(accountId, today);
}

function landlordInfo(t: Tenancy) {
  return {
    accountId: t.accountId,
    accountName: t.accountName,
    tenantId: t.tenantId,
    payeeName: t.payeeName ?? t.ownerName,
    ownerName: t.ownerName,
    ownerPhone: t.ownerPhone,
    upiId: t.upiId,
    bankAccountName: t.bankAccountName,
    bankAccountNumber: t.bankAccountNumber,
    bankIfsc: t.bankIfsc,
    bankName: t.bankName,
  };
}

export async function portalSummary(ctx: TenantCtx, monthInput?: string) {
  const list = await tenancies(ctx);
  const today = tenantToday(list);
  await refreshCharges(list, today);
  const month = monthInput ?? monthKeyOf(today);
  const from = monthStart(month);
  const to = monthEnd(month);

  const rows = await db
    .from(chargeQuery(db, { tenantIds: ctx.tenantIds }, today).where('c.period_start', '<=', to).as('x'))
    .whereNot('x.status', 'void')
    .where((q) => q.where('x.period_start', '>=', from).orWhereIn('x.status', ['overdue', 'pending', 'to_confirm']))
    .orderBy([
      { column: 'x.due_date', order: 'asc' },
      { column: 'x.unit_name', order: 'asc' },
    ]);
  const entries = rows.map((r) => mapCharge(r, today));
  const thisMonth = entries.filter((e) => e.periodStart >= from);
  const unpaid = entries.filter((e) => e.balance > 0);

  const pending = await db('payments as p')
    .leftJoin('units as u', 'u.id', 'p.unit_id')
    .whereIn('p.tenant_id', ctx.tenantIds)
    .where('p.status', 'pending')
    .orderBy('p.created_at', 'desc')
    .select('p.*', 'u.name as unit_name');

  const [credit] = await db('payments as p')
    .leftJoin(db('payment_allocations').select('payment_id').sum({ allocated: 'amount' }).groupBy('payment_id').as('a'), 'a.payment_id', 'p.id')
    .whereIn('p.tenant_id', ctx.tenantIds)
    .where('p.status', 'confirmed')
    .select(db.raw('COALESCE(SUM(p.amount - COALESCE(a.allocated, 0)), 0) AS credit'));

  return {
    name: list[0]?.tenantName ?? null,
    month,
    monthLabel: monthLabel(month),
    today,
    amountDue: round2(unpaid.reduce((s, e) => s + e.balance, 0)),
    dueThisMonth: round2(thisMonth.reduce((s, e) => s + e.balance, 0)),
    arrears: round2(unpaid.filter((e) => e.periodStart < from).reduce((s, e) => s + e.balance, 0)),
    overdueAmount: round2(unpaid.filter((e) => e.isOverdue).reduce((s, e) => s + e.balance, 0)),
    advanceCredit: Number(credit?.credit ?? 0),
    counts: {
      total: thisMonth.length,
      pending: thisMonth.filter((e) => e.status !== 'collected').length,
      paid: thisMonth.filter((e) => e.status === 'collected').length,
      overdue: entries.filter((e) => e.status === 'overdue').length,
      toConfirm: entries.filter((e) => e.status === 'to_confirm').length,
    },
    entries,
    pendingPayments: pending.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      paidOn: p.paid_on,
      method: p.method,
      methodLabel: METHOD_LABELS[p.method as PaymentMethod] ?? p.method,
      reference: p.reference,
      unitName: p.unit_name,
      targetChargeId: p.target_charge_id,
      createdAt: p.created_at,
    })),
    landlords: list.map(landlordInfo),
  };
}

export async function portalCharges(
  ctx: TenantCtx,
  opts: { page: number; pageSize: number; status?: 'all' | 'unpaid' | 'collected' },
): Promise<{ items: RentEntryDto[]; total: number }> {
  const list = await tenancies(ctx);
  const today = tenantToday(list);
  await refreshCharges(list, today);
  const base = db.from(chargeQuery(db, { tenantIds: ctx.tenantIds }, today).as('x')).modify((q) => {
    q.whereNot('x.status', 'void');
    if (opts.status === 'unpaid') q.whereIn('x.status', ['overdue', 'pending', 'to_confirm']);
    if (opts.status === 'collected') q.where('x.status', 'collected');
  });
  const [{ count }] = await base.clone().count<{ count: number }[]>({ count: '*' });
  const rows = await base
    .select('x.*')
    .orderBy([
      { column: 'x.period_start', order: 'desc' },
      { column: 'x.due_date', order: 'desc' },
      { column: 'x.id', order: 'asc' },
    ])
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);
  return { items: rows.map((r: Record<string, any>) => mapCharge(r, today)), total: Number(count) };
}

export async function portalCharge(ctx: TenantCtx, id: string) {
  const list = await tenancies(ctx);
  const today = tenantToday(list);
  const row = await db.from(chargeQuery(db, { tenantIds: ctx.tenantIds }, today).where('c.id', id).as('x')).first();
  if (!row) throw Errors.notFound('Rent entry');
  const entry = mapCharge(row, today);
  const payments = await db('payment_allocations as pa')
    .join('payments as p', 'p.id', 'pa.payment_id')
    .where('pa.charge_id', id)
    .orderBy('p.paid_on')
    .select('pa.amount as allocated', 'p.id', 'p.amount', 'p.paid_on', 'p.method', 'p.reference');
  const pending = await db('payments').where({ target_charge_id: id, status: 'pending' }).whereIn('tenant_id', ctx.tenantIds);
  const tenancy = list.find((t) => t.tenantId === entry.tenant.id)!;
  return {
    ...entry,
    payments: payments.map((p) => ({
      paymentId: p.id,
      allocatedAmount: Number(p.allocated),
      paymentAmount: Number(p.amount),
      paidOn: p.paid_on,
      method: p.method,
      methodLabel: METHOD_LABELS[p.method as PaymentMethod] ?? p.method,
      reference: p.reference,
    })),
    pendingPayments: pending.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      paidOn: p.paid_on,
      method: p.method,
      methodLabel: METHOD_LABELS[p.method as PaymentMethod] ?? p.method,
      reference: p.reference,
      createdAt: p.created_at,
    })),
    landlord: landlordInfo(tenancy),
  };
}

export async function portalPayments(ctx: TenantCtx, opts: { page: number; pageSize: number }) {
  const base = db('payments as p').leftJoin('units as u', 'u.id', 'p.unit_id').whereIn('p.tenant_id', ctx.tenantIds);
  const [{ count }] = await base.clone().count<{ count: number }[]>({ count: '*' });
  const rows = await base
    .clone()
    .select('p.*', 'u.name as unit_name')
    .orderBy([
      { column: 'p.paid_on', order: 'desc' },
      { column: 'p.created_at', order: 'desc' },
    ])
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);
  return {
    total: Number(count),
    items: rows.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      paidOn: p.paid_on,
      method: p.method,
      methodLabel: METHOD_LABELS[p.method as PaymentMethod] ?? p.method,
      reference: p.reference,
      notes: p.notes,
      status: p.status,
      source: p.source,
      unitName: p.unit_name,
      rejectedReason: p.rejected_reason,
      createdAt: p.created_at,
    })),
  };
}

/** Tenant says "I paid": creates a payment awaiting the landlord's confirmation. */
export async function submitPayment(
  ctx: TenantCtx,
  input: {
    chargeId?: string | null;
    tenantId?: string | null;
    amount: number;
    paidOn: string;
    method: RecordableMethod;
    reference?: string | null;
    notes?: string | null;
  },
) {
  const list = await tenancies(ctx);
  let tenantId = input.tenantId ?? null;
  let charge: { id: string; tenant_id: string; agreement_id: string; unit_id: string; unit_name: string; voided_at: string | null } | undefined;

  if (input.chargeId) {
    charge = await db('rent_charges as c')
      .join('units as u', 'u.id', 'c.unit_id')
      .where('c.id', input.chargeId)
      .whereIn('c.tenant_id', ctx.tenantIds)
      .first('c.id', 'c.tenant_id', 'c.agreement_id', 'c.unit_id', 'c.voided_at', 'u.name as unit_name');
    if (!charge) throw Errors.validation('Rent entry not found.', [{ field: 'chargeId', message: 'Invalid rent entry' }]);
    if (charge.voided_at) throw Errors.conflict('This rent entry has been cancelled by your landlord.');
    tenantId = charge.tenant_id;
  }
  if (!tenantId) {
    if (list.length !== 1) throw Errors.validation('Choose which rent this payment is for.', [{ field: 'chargeId', message: 'This field is required' }]);
    tenantId = list[0].tenantId;
  }
  const tenancy = list.find((t) => t.tenantId === tenantId);
  if (!tenancy) throw Errors.forbidden();
  const today = todayIn(tenancy.timezone);
  if (input.paidOn > today) {
    throw Errors.validation('Payment date cannot be in the future.', [{ field: 'paidOn', message: 'Cannot be in the future' }]);
  }

  const duplicate = await db('payments')
    .where({ tenant_id: tenantId, status: 'pending', amount: input.amount, paid_on: input.paidOn })
    .modify((q) => {
      if (input.chargeId) q.where('target_charge_id', input.chargeId);
    })
    .where('created_at', '>', new Date(now().getTime() - 10 * 60_000))
    .first('id');
  if (duplicate) throw Errors.conflict('You already submitted this payment. Your landlord will confirm it shortly.');

  let unitId = charge?.unit_id ?? null;
  let agreementId = charge?.agreement_id ?? null;
  let unitName = charge?.unit_name ?? null;
  if (!charge) {
    const agreement = await db('agreements as a')
      .join('units as u', 'u.id', 'a.unit_id')
      .where('a.tenant_id', tenantId)
      .where((q) => q.where('a.status', 'active').orWhere('a.ended_on', '>=', today))
      .orderBy('a.start_date', 'desc')
      .first('a.id', 'a.unit_id', 'u.name as unit_name');
    unitId = agreement?.unit_id ?? null;
    agreementId = agreement?.id ?? null;
    unitName = agreement?.unit_name ?? null;
  }

  const paymentId = await db.transaction(async (trx) => {
    const [row] = await trx('payments')
      .insert({
        account_id: tenancy.accountId,
        tenant_id: tenantId,
        agreement_id: agreementId,
        unit_id: unitId,
        target_charge_id: charge?.id ?? null,
        amount: input.amount,
        paid_on: input.paidOn,
        method: input.method,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        status: 'pending',
        source: 'tenant',
        recorded_by: ctx.userId,
      })
      .returning('id');
    const where = unitName ? ` for ${unitName}` : '';
    await logActivity(trx, { accountId: tenancy.accountId, userId: ctx.userId }, {
      action: 'payment.submitted',
      entityType: 'payment',
      entityId: row.id,
      summary: `${tenancy.tenantName} reported paying ${formatInr(input.amount)}${where} via ${METHOD_LABELS[input.method]} — to confirm`,
    });
    await notifyAccountMembers(trx, tenancy.accountId, {
      type: 'payment_submitted',
      title: `${tenancy.tenantName} paid ${formatInr(input.amount)} — please confirm`,
      body: `${METHOD_LABELS[input.method]} payment on ${humanDate(input.paidOn)}${where}${input.reference ? ` (ref ${input.reference})` : ''}.`,
      entityType: 'payment',
      entityId: row.id,
      data: { chargeId: charge?.id ?? null },
    });
    return row.id as string;
  });

  const [created] = (await portalPayments(ctx, { page: 1, pageSize: 50 })).items.filter((p) => p.id === paymentId);
  return created;
}

/** A tenant may withdraw a submission the landlord has not acted on yet. */
export async function withdrawPayment(ctx: TenantCtx, id: string) {
  await db.transaction(async (trx) => {
    const payment = await trx('payments').where({ id }).whereIn('tenant_id', ctx.tenantIds).forUpdate().first();
    if (!payment) throw Errors.notFound('Payment');
    if (payment.status !== 'pending' || payment.source !== 'tenant') {
      throw Errors.conflict('Only payments awaiting confirmation can be withdrawn.');
    }
    await trx('payments').where({ id }).update({ status: 'void', voided_at: now(), void_reason: 'Withdrawn by tenant' });
    const tenant = await trx('tenants').where({ id: payment.tenant_id }).first('name');
    await logActivity(trx, { accountId: payment.account_id, userId: ctx.userId }, {
      action: 'payment.withdrawn',
      entityType: 'payment',
      entityId: id,
      summary: `${tenant?.name} withdrew a payment submission of ${formatInr(Number(payment.amount))}`,
    });
  });
}
