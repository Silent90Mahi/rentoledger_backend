import { db, type Trx } from '../../db/knex.js';
import type { Ctx } from '../../lib/context.js';
import { humanDate } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import { formatInr, round2 } from '../../lib/money.js';
import { likePattern, resolveSort } from '../../lib/validation.js';
import { logActivity } from '../activity/activity.service.js';
import { notifyAccountMembers, notifyTenant } from '../notifications/notifications.service.js';
import { periodLabelFor } from '../rents/charge-query.js';
import { allocateTenant, clearPaymentAllocations } from './allocation.service.js';
import { METHOD_LABELS, type PaymentMethod, type PaymentStatus, type RecordableMethod } from './payment.types.js';

export interface PaymentCreateInput {
  tenantId: string;
  agreementId?: string | null;
  targetChargeId?: string | null;
  amount: number;
  paidOn: string;
  method: RecordableMethod;
  reference?: string | null;
  notes?: string | null;
  status?: 'confirmed' | 'pending';
}

export interface PaymentDto {
  id: string;
  tenant: { id: string; name: string; phone: string };
  agreementId: string | null;
  unit: { id: string; name: string } | null;
  property: { id: string; name: string } | null;
  amount: number;
  allocatedAmount: number;
  unallocatedAmount: number;
  paidOn: string;
  method: PaymentMethod;
  methodLabel: string;
  reference: string | null;
  notes: string | null;
  status: PaymentStatus;
  source: 'owner' | 'tenant' | 'system';
  targetChargeId: string | null;
  recordedBy: { id: string; name: string | null } | null;
  confirmedAt: string | null;
  rejectedReason: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentAllocationDto {
  chargeId: string;
  amount: number;
  kind: string;
  periodLabel: string;
  dueDate: string;
  unitName: string;
}

export interface PaymentDetailDto extends PaymentDto {
  allocations: PaymentAllocationDto[];
  targetCharge: { id: string; periodLabel: string; unitName: string; dueDate: string; totalAmount: number } | null;
}

function paymentQuery(q: typeof db | Trx, accountId: string) {
  const allocated = q('payment_allocations').select('payment_id').sum({ allocated: 'amount' }).where('account_id', accountId).groupBy('payment_id');
  return q('payments as pm')
    .join('tenants as t', 't.id', 'pm.tenant_id')
    .leftJoin('units as u', 'u.id', 'pm.unit_id')
    .leftJoin('properties as p', 'p.id', 'u.property_id')
    .leftJoin('users as rb', 'rb.id', 'pm.recorded_by')
    .leftJoin(allocated.as('al'), 'al.payment_id', 'pm.id')
    .where('pm.account_id', accountId)
    .select(
      'pm.*',
      't.name as tenant_name',
      't.phone as tenant_phone',
      'u.name as unit_name',
      'p.id as property_id',
      'p.name as property_name',
      'rb.name as recorded_by_name',
      q.raw('COALESCE(al.allocated, 0) AS allocated_amount'),
    );
}

function mapPayment(r: Record<string, any>): PaymentDto {
  const allocated = r.status === 'confirmed' ? Number(r.allocated_amount ?? 0) : 0;
  return {
    id: r.id,
    tenant: { id: r.tenant_id, name: r.tenant_name, phone: r.tenant_phone },
    agreementId: r.agreement_id ?? null,
    unit: r.unit_id ? { id: r.unit_id, name: r.unit_name } : null,
    property: r.property_id ? { id: r.property_id, name: r.property_name } : null,
    amount: Number(r.amount),
    allocatedAmount: allocated,
    unallocatedAmount: r.status === 'confirmed' ? round2(Number(r.amount) - allocated) : 0,
    paidOn: r.paid_on,
    method: r.method,
    methodLabel: METHOD_LABELS[r.method as PaymentMethod] ?? r.method,
    reference: r.reference ?? null,
    notes: r.notes ?? null,
    status: r.status,
    source: r.source,
    targetChargeId: r.target_charge_id ?? null,
    recordedBy: r.recorded_by ? { id: r.recorded_by, name: r.recorded_by_name ?? null } : null,
    confirmedAt: r.confirmed_at ?? null,
    rejectedReason: r.rejected_reason ?? null,
    voidedAt: r.voided_at ?? null,
    voidReason: r.void_reason ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listPayments(
  ctx: Ctx,
  opts: {
    page: number;
    pageSize: number;
    search?: string;
    tenantId?: string;
    propertyId?: string;
    unitId?: string;
    agreementId?: string;
    method?: PaymentMethod;
    status?: PaymentStatus;
    source?: 'owner' | 'tenant' | 'system';
    from?: string;
    to?: string;
    sort?: string;
  },
): Promise<{ items: PaymentDto[]; total: number; summary: { count: number; amount: number } }> {
  const sort = resolveSort(
    opts.sort,
    { paidOn: 'pm.paid_on', amount: 'pm.amount', createdAt: 'pm.created_at', tenant: 'lower(t.name)' },
    { column: 'pm.paid_on', direction: 'desc' },
  );
  const base = paymentQuery(db, ctx.accountId).modify((q) => {
    if (opts.tenantId) q.where('pm.tenant_id', opts.tenantId);
    if (opts.agreementId) q.where('pm.agreement_id', opts.agreementId);
    if (opts.unitId) q.where('pm.unit_id', opts.unitId);
    if (opts.propertyId) q.where('p.id', opts.propertyId);
    if (opts.method) q.where('pm.method', opts.method);
    if (opts.status) q.where('pm.status', opts.status);
    if (opts.source) q.where('pm.source', opts.source);
    if (opts.from) q.where('pm.paid_on', '>=', opts.from);
    if (opts.to) q.where('pm.paid_on', '<=', opts.to);
    if (opts.search) {
      const pattern = likePattern(opts.search);
      q.where((w) =>
        w.whereILike('t.name', pattern).orWhereILike('pm.reference', pattern).orWhereILike('u.name', pattern).orWhereILike('pm.notes', pattern),
      );
    }
  });

  const [agg] = await db.from(base.clone().as('x')).select(db.raw('COUNT(*) AS count'), db.raw('COALESCE(SUM(x.amount), 0) AS amount'));
  const rows = await base
    .orderByRaw(`${sort.column} ${sort.direction}, pm.created_at DESC, pm.id`)
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);
  return {
    items: rows.map(mapPayment),
    total: Number(agg.count),
    summary: { count: Number(agg.count), amount: Number(agg.amount) },
  };
}

export async function getPayment(ctx: Ctx, id: string): Promise<PaymentDetailDto> {
  const row = await paymentQuery(db, ctx.accountId).where('pm.id', id).first();
  if (!row) throw Errors.notFound('Payment');
  const allocations = await db('payment_allocations as pa')
    .join('rent_charges as c', 'c.id', 'pa.charge_id')
    .join('units as u', 'u.id', 'c.unit_id')
    .where('pa.payment_id', id)
    .orderBy('c.due_date')
    .select('pa.charge_id', 'pa.amount', 'c.kind', 'c.period_start', 'c.period_end', 'c.due_date', 'u.name as unit_name');
  let targetCharge: PaymentDetailDto['targetCharge'] = null;
  if (row.target_charge_id) {
    const c = await db('rent_charges as c')
      .join('units as u', 'u.id', 'c.unit_id')
      .where('c.id', row.target_charge_id)
      .first('c.id', 'c.kind', 'c.period_start', 'c.period_end', 'c.due_date', 'c.total_amount', 'u.name as unit_name');
    if (c) {
      targetCharge = {
        id: c.id,
        periodLabel: periodLabelFor(c.kind, c.period_start, c.period_end),
        unitName: c.unit_name,
        dueDate: c.due_date,
        totalAmount: Number(c.total_amount),
      };
    }
  }
  return {
    ...mapPayment(row),
    allocations: allocations.map((a) => ({
      chargeId: a.charge_id,
      amount: Number(a.amount),
      kind: a.kind,
      periodLabel: periodLabelFor(a.kind, a.period_start, a.period_end),
      dueDate: a.due_date,
      unitName: a.unit_name,
    })),
    targetCharge,
  };
}

async function resolveLinks(
  trx: Trx,
  ctx: Ctx,
  input: { tenantId: string; agreementId?: string | null; targetChargeId?: string | null },
): Promise<{ tenant: { id: string; name: string }; agreementId: string | null; unitId: string | null; unitName: string | null }> {
  const tenant = await trx('tenants').where({ id: input.tenantId, account_id: ctx.accountId }).first('id', 'name');
  if (!tenant) throw Errors.validation('Tenant not found.', [{ field: 'tenantId', message: 'Tenant not found' }]);

  if (input.targetChargeId) {
    const charge = await trx('rent_charges as c')
      .join('units as u', 'u.id', 'c.unit_id')
      .where({ 'c.id': input.targetChargeId, 'c.account_id': ctx.accountId })
      .first('c.tenant_id', 'c.agreement_id', 'c.unit_id', 'c.voided_at', 'u.name as unit_name');
    if (!charge || charge.tenant_id !== tenant.id) {
      throw Errors.validation('Rent entry not found for this tenant.', [{ field: 'targetChargeId', message: 'Invalid rent entry' }]);
    }
    if (charge.voided_at) throw Errors.conflict('This rent entry has been cancelled.');
    return { tenant, agreementId: charge.agreement_id, unitId: charge.unit_id, unitName: charge.unit_name };
  }

  if (input.agreementId) {
    const agreement = await trx('agreements as a')
      .join('units as u', 'u.id', 'a.unit_id')
      .where({ 'a.id': input.agreementId, 'a.account_id': ctx.accountId })
      .first('a.tenant_id', 'a.unit_id', 'u.name as unit_name');
    if (!agreement || agreement.tenant_id !== tenant.id) {
      throw Errors.validation('Agreement not found for this tenant.', [{ field: 'agreementId', message: 'Invalid agreement' }]);
    }
    return { tenant, agreementId: input.agreementId, unitId: agreement.unit_id, unitName: agreement.unit_name };
  }

  const agreements = await trx('agreements as a')
    .join('units as u', 'u.id', 'a.unit_id')
    .where({ 'a.tenant_id': tenant.id })
    .where((q) => q.where('a.status', 'active').orWhere('a.ended_on', '>=', ctx.today))
    .select('a.id', 'a.unit_id', 'u.name as unit_name');
  if (agreements.length === 1) {
    return { tenant, agreementId: agreements[0].id, unitId: agreements[0].unit_id, unitName: agreements[0].unit_name };
  }
  return { tenant, agreementId: null, unitId: null, unitName: null };
}

/** Records money received from a tenant (owner side). */
export async function createPayment(ctx: Ctx, input: PaymentCreateInput): Promise<PaymentDetailDto> {
  if (input.paidOn > ctx.today) {
    throw Errors.validation('Payment date cannot be in the future.', [{ field: 'paidOn', message: 'Cannot be in the future' }]);
  }
  const status = input.status ?? 'confirmed';
  const id = await db.transaction(async (trx) => {
    const links = await resolveLinks(trx, ctx, input);
    const [row] = await trx('payments')
      .insert({
        account_id: ctx.accountId,
        tenant_id: input.tenantId,
        agreement_id: links.agreementId,
        unit_id: links.unitId,
        target_charge_id: input.targetChargeId ?? null,
        amount: input.amount,
        paid_on: input.paidOn,
        method: input.method,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        status,
        source: 'owner',
        recorded_by: ctx.userId,
        confirmed_by: status === 'confirmed' ? ctx.userId : null,
        confirmed_at: status === 'confirmed' ? new Date() : null,
      })
      .returning('id');

    if (status === 'confirmed') await allocateTenant(trx, ctx.accountId, input.tenantId);

    const where = links.unitName ? ` for ${links.unitName}` : '';
    const summary =
      status === 'confirmed'
        ? `Recorded ${formatInr(input.amount)} from ${links.tenant.name}${where} (${METHOD_LABELS[input.method]})`
        : `Recorded ${formatInr(input.amount)} ${METHOD_LABELS[input.method].toLowerCase()} from ${links.tenant.name}${where} — awaiting clearance`;
    await logActivity(trx, ctx, { action: 'payment.recorded', entityType: 'payment', entityId: row.id, summary });

    if (status === 'confirmed') {
      await notifyTenant(trx, input.tenantId, {
        type: 'payment_confirmed',
        title: `Payment of ${formatInr(input.amount)} received`,
        body: `Your landlord recorded your payment of ${formatInr(input.amount)} on ${humanDate(input.paidOn)}${where}.`,
        entityType: 'payment',
        entityId: row.id,
      });
    }
    await notifyAccountMembers(
      trx,
      ctx.accountId,
      {
        type: 'payment_recorded',
        title: `${formatInr(input.amount)} received from ${links.tenant.name}`,
        body: `${ctx.userName ?? 'A partner'} recorded a ${METHOD_LABELS[input.method]} payment${where}.`,
        entityType: 'payment',
        entityId: row.id,
      },
      { excludeUserId: ctx.userId },
    );
    return row.id as string;
  });
  return getPayment(ctx, id);
}

async function lockPayment(trx: Trx, ctx: Ctx, id: string) {
  const row = await trx('payments').where({ id, account_id: ctx.accountId }).forUpdate().first();
  if (!row) throw Errors.notFound('Payment');
  return row;
}

export async function updatePayment(
  ctx: Ctx,
  id: string,
  input: { amount?: number; paidOn?: string; method?: RecordableMethod; reference?: string | null; notes?: string | null },
): Promise<PaymentDetailDto> {
  if (input.paidOn && input.paidOn > ctx.today) {
    throw Errors.validation('Payment date cannot be in the future.', [{ field: 'paidOn', message: 'Cannot be in the future' }]);
  }
  await db.transaction(async (trx) => {
    const payment = await lockPayment(trx, ctx, id);
    if (payment.status === 'void' || payment.status === 'rejected') throw Errors.conflict('Voided or rejected payments cannot be edited.');
    if (payment.method === 'deposit') throw Errors.conflict('Deposit adjustments are managed from the agreement’s deposit section.');

    const changes: Record<string, unknown> = {};
    if (input.amount !== undefined) changes.amount = input.amount;
    if (input.paidOn !== undefined) changes.paid_on = input.paidOn;
    if (input.method !== undefined) changes.method = input.method;
    if (input.reference !== undefined) changes.reference = input.reference;
    if (input.notes !== undefined) changes.notes = input.notes;
    if (!Object.keys(changes).length) return;

    const amountChanged = input.amount !== undefined && input.amount !== Number(payment.amount);
    if (amountChanged && payment.status === 'confirmed') await clearPaymentAllocations(trx, id);
    await trx('payments').where({ id }).update(changes);
    if (amountChanged && payment.status === 'confirmed') await allocateTenant(trx, ctx.accountId, payment.tenant_id);

    await logActivity(trx, ctx, {
      action: 'payment.updated',
      entityType: 'payment',
      entityId: id,
      summary: amountChanged
        ? `Changed a payment from ${formatInr(Number(payment.amount))} to ${formatInr(input.amount!)}`
        : `Updated payment details of ${formatInr(Number(payment.amount))}`,
    });
  });
  return getPayment(ctx, id);
}

export async function confirmPayment(ctx: Ctx, id: string): Promise<PaymentDetailDto> {
  await db.transaction(async (trx) => {
    const payment = await lockPayment(trx, ctx, id);
    if (payment.status !== 'pending') throw Errors.conflict('Only payments awaiting confirmation can be confirmed.');
    await trx('payments').where({ id }).update({ status: 'confirmed', confirmed_by: ctx.userId, confirmed_at: new Date() });
    await allocateTenant(trx, ctx.accountId, payment.tenant_id);
    const tenant = await trx('tenants').where({ id: payment.tenant_id }).first('name');
    await logActivity(trx, ctx, {
      action: 'payment.confirmed',
      entityType: 'payment',
      entityId: id,
      summary: `Confirmed ${formatInr(Number(payment.amount))} from ${tenant?.name} (${METHOD_LABELS[payment.method as PaymentMethod]})`,
    });
    await notifyTenant(trx, payment.tenant_id, {
      type: 'payment_confirmed',
      title: 'Payment confirmed',
      body: `Your payment of ${formatInr(Number(payment.amount))} made on ${humanDate(payment.paid_on)} has been confirmed.`,
      entityType: 'payment',
      entityId: id,
    });
  });
  return getPayment(ctx, id);
}

export async function rejectPayment(ctx: Ctx, id: string, reason: string): Promise<PaymentDetailDto> {
  await db.transaction(async (trx) => {
    const payment = await lockPayment(trx, ctx, id);
    if (payment.status !== 'pending') throw Errors.conflict('Only payments awaiting confirmation can be rejected.');
    await trx('payments').where({ id }).update({ status: 'rejected', rejected_reason: reason });
    const tenant = await trx('tenants').where({ id: payment.tenant_id }).first('name');
    await logActivity(trx, ctx, {
      action: 'payment.rejected',
      entityType: 'payment',
      entityId: id,
      summary: `Rejected ${formatInr(Number(payment.amount))} submitted by ${tenant?.name}: ${reason}`,
    });
    await notifyTenant(trx, payment.tenant_id, {
      type: 'payment_rejected',
      title: 'Payment not confirmed',
      body: `Your landlord could not confirm your payment of ${formatInr(Number(payment.amount))}: ${reason}`,
      entityType: 'payment',
      entityId: id,
    });
  });
  return getPayment(ctx, id);
}

export async function voidPayment(ctx: Ctx, id: string, reason: string): Promise<PaymentDetailDto> {
  await db.transaction(async (trx) => {
    const payment = await lockPayment(trx, ctx, id);
    if (payment.status === 'void') throw Errors.conflict('This payment is already void.');
    if (payment.status === 'rejected') throw Errors.conflict('Rejected payments cannot be voided.');
    await clearPaymentAllocations(trx, id);
    await trx('payments').where({ id }).update({ status: 'void', voided_at: new Date(), void_reason: reason });
    if (payment.method === 'deposit') {
      // Undo the deposit adjustment so the money counts as deposit held again.
      await trx('deposit_transactions').where({ payment_id: id }).delete();
    }
    await allocateTenant(trx, ctx.accountId, payment.tenant_id);
    const tenant = await trx('tenants').where({ id: payment.tenant_id }).first('name');
    await logActivity(trx, ctx, {
      action: 'payment.voided',
      entityType: 'payment',
      entityId: id,
      summary: `Voided ${formatInr(Number(payment.amount))} from ${tenant?.name}: ${reason}`,
    });
  });
  return getPayment(ctx, id);
}
