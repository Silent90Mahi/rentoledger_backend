import type { ClientSession, Document } from 'mongodb';
import { $round2, col, contains, newId, withTransaction } from '../../db/mongo.js';
import type { Ctx } from '../../lib/context.js';
import { humanDate } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import { formatInr, round2 } from '../../lib/money.js';
import { resolveSort } from '../../lib/validation.js';
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

/** Stages adding tenant/unit/property/recorder names and the allocated total to payment documents. */
function paymentRefStages(): Document[] {
  return [
    { $lookup: { from: 'tenants', localField: 'tenant_id', foreignField: '_id', pipeline: [{ $project: { name: 1, phone: 1 } }], as: '_t' } },
    { $lookup: { from: 'units', localField: 'unit_id', foreignField: '_id', pipeline: [{ $project: { name: 1, property_id: 1 } }], as: '_u' } },
    { $addFields: { _t: { $first: '$_t' }, _u: { $first: '$_u' } } },
    { $lookup: { from: 'properties', localField: '_u.property_id', foreignField: '_id', pipeline: [{ $project: { name: 1 } }], as: '_p' } },
    { $lookup: { from: 'users', localField: 'recorded_by', foreignField: '_id', pipeline: [{ $project: { name: 1 } }], as: '_rb' } },
    { $lookup: { from: 'payment_allocations', localField: '_id', foreignField: 'payment_id', pipeline: [{ $project: { amount: 1 } }], as: '_al' } },
    {
      $addFields: {
        id: '$_id',
        tenant_name: '$_t.name',
        tenant_phone: '$_t.phone',
        unit_name: '$_u.name',
        property_id: { $first: '$_p._id' },
        property_name: { $first: '$_p.name' },
        recorded_by_name: { $first: '$_rb.name' },
        allocated_amount: $round2({ $sum: '$_al.amount' }),
      },
    },
    { $project: { _t: 0, _u: 0, _p: 0, _rb: 0, _al: 0, lock_version: 0 } },
  ];
}

async function findPaymentRow(accountId: string, id: string): Promise<Record<string, any> | undefined> {
  const [row] = await col('payments')
    .aggregate([{ $match: { _id: id, account_id: accountId } }, ...paymentRefStages()])
    .toArray();
  return row;
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
    { paidOn: 'paid_on', amount: 'amount', createdAt: 'created_at', tenant: '_tenant_lc' },
    { column: 'paid_on', direction: 'desc' },
  );
  const match: Document = { account_id: ctx.accountId };
  if (opts.tenantId) match.tenant_id = opts.tenantId;
  if (opts.agreementId) match.agreement_id = opts.agreementId;
  if (opts.unitId) match.unit_id = opts.unitId;
  if (opts.method) match.method = opts.method;
  if (opts.status) match.status = opts.status;
  if (opts.source) match.source = opts.source;
  if (opts.from || opts.to) match.paid_on = { ...(opts.from ? { $gte: opts.from } : {}), ...(opts.to ? { $lte: opts.to } : {}) };

  const pipeline: Document[] = [{ $match: match }, ...paymentRefStages()];
  if (opts.propertyId) pipeline.push({ $match: { property_id: opts.propertyId } });
  if (opts.search) {
    const pattern = contains(opts.search);
    pipeline.push({ $match: { $or: [{ tenant_name: pattern }, { reference: pattern }, { unit_name: pattern }, { notes: pattern }] } });
  }
  pipeline.push({ $addFields: { _tenant_lc: { $toLower: { $ifNull: ['$tenant_name', ''] } } } });

  const [result] = await col('payments')
    .aggregate([
      ...pipeline,
      {
        $facet: {
          agg: [{ $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } }],
          rows: [
            { $sort: { [sort.column]: sort.direction === 'asc' ? 1 : -1, created_at: -1, _id: 1 } },
            { $skip: (opts.page - 1) * opts.pageSize },
            { $limit: opts.pageSize },
          ],
        },
      },
    ])
    .toArray();
  const count = result.agg[0]?.count ?? 0;
  return {
    items: result.rows.map(mapPayment),
    total: count,
    summary: { count, amount: round2(result.agg[0]?.amount ?? 0) },
  };
}

export async function getPayment(ctx: Ctx, id: string): Promise<PaymentDetailDto> {
  const row = await findPaymentRow(ctx.accountId, id);
  if (!row) throw Errors.notFound('Payment');
  const allocations = await col('payment_allocations')
    .aggregate([
      { $match: { payment_id: id } },
      { $lookup: { from: 'rent_charges', localField: 'charge_id', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      { $lookup: { from: 'units', localField: 'c.unit_id', foreignField: '_id', pipeline: [{ $project: { name: 1 } }], as: 'u' } },
      { $sort: { 'c.due_date': 1 } },
      {
        $project: {
          charge_id: 1,
          amount: 1,
          kind: '$c.kind',
          period_start: '$c.period_start',
          period_end: '$c.period_end',
          due_date: '$c.due_date',
          unit_name: { $first: '$u.name' },
        },
      },
    ])
    .toArray();
  let targetCharge: PaymentDetailDto['targetCharge'] = null;
  if (row.target_charge_id) {
    const c = await col('rent_charges').findOne({ _id: row.target_charge_id });
    if (c) {
      const unit = await col('units').findOne({ _id: c.unit_id }, { projection: { name: 1 } });
      targetCharge = {
        id: c._id,
        periodLabel: periodLabelFor(c.kind, c.period_start, c.period_end),
        unitName: unit?.name,
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
  session: ClientSession,
  ctx: Ctx,
  input: { tenantId: string; agreementId?: string | null; targetChargeId?: string | null },
): Promise<{ tenant: { id: string; name: string }; agreementId: string | null; unitId: string | null; unitName: string | null }> {
  const tenantDoc = await col('tenants').findOne({ _id: input.tenantId, account_id: ctx.accountId }, { session });
  if (!tenantDoc) throw Errors.validation('Tenant not found.', [{ field: 'tenantId', message: 'Tenant not found' }]);
  const tenant = { id: tenantDoc._id, name: tenantDoc.name as string };
  const unitName = async (unitId: string) => ((await col('units').findOne({ _id: unitId }, { session }))?.name as string) ?? null;

  if (input.targetChargeId) {
    const charge = await col('rent_charges').findOne({ _id: input.targetChargeId, account_id: ctx.accountId }, { session });
    if (!charge || charge.tenant_id !== tenant.id) {
      throw Errors.validation('Rent entry not found for this tenant.', [{ field: 'targetChargeId', message: 'Invalid rent entry' }]);
    }
    if (charge.voided_at) throw Errors.conflict('This rent entry has been cancelled.');
    return { tenant, agreementId: charge.agreement_id, unitId: charge.unit_id, unitName: await unitName(charge.unit_id) };
  }

  if (input.agreementId) {
    const agreement = await col('agreements').findOne({ _id: input.agreementId, account_id: ctx.accountId }, { session });
    if (!agreement || agreement.tenant_id !== tenant.id) {
      throw Errors.validation('Agreement not found for this tenant.', [{ field: 'agreementId', message: 'Invalid agreement' }]);
    }
    return { tenant, agreementId: input.agreementId, unitId: agreement.unit_id, unitName: await unitName(agreement.unit_id) };
  }

  const agreements = await col('agreements')
    .find({ tenant_id: tenant.id, $or: [{ status: 'active' }, { ended_on: { $gte: ctx.today } }] }, { session })
    .toArray();
  if (agreements.length === 1) {
    return { tenant, agreementId: agreements[0]._id, unitId: agreements[0].unit_id, unitName: await unitName(agreements[0].unit_id) };
  }
  return { tenant, agreementId: null, unitId: null, unitName: null };
}

/** Records money received from a tenant (owner side). */
export async function createPayment(ctx: Ctx, input: PaymentCreateInput): Promise<PaymentDetailDto> {
  if (input.paidOn > ctx.today) {
    throw Errors.validation('Payment date cannot be in the future.', [{ field: 'paidOn', message: 'Cannot be in the future' }]);
  }
  const status = input.status ?? 'confirmed';
  const id = await withTransaction(async (session) => {
    const links = await resolveLinks(session, ctx, input);
    const paymentId = newId();
    const now = new Date();
    await col('payments').insertOne(
      {
        _id: paymentId,
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
        confirmed_at: status === 'confirmed' ? now : null,
        rejected_reason: null,
        voided_at: null,
        void_reason: null,
        created_at: now,
        updated_at: now,
      },
      { session },
    );

    if (status === 'confirmed') await allocateTenant(session, ctx.accountId, input.tenantId);

    const where = links.unitName ? ` for ${links.unitName}` : '';
    const summary =
      status === 'confirmed'
        ? `Recorded ${formatInr(input.amount)} from ${links.tenant.name}${where} (${METHOD_LABELS[input.method]})`
        : `Recorded ${formatInr(input.amount)} ${METHOD_LABELS[input.method].toLowerCase()} from ${links.tenant.name}${where} — awaiting clearance`;
    await logActivity(session, ctx, { action: 'payment.recorded', entityType: 'payment', entityId: paymentId, summary });

    if (status === 'confirmed') {
      await notifyTenant(session, input.tenantId, {
        type: 'payment_confirmed',
        title: `Payment of ${formatInr(input.amount)} received`,
        body: `Your landlord recorded your payment of ${formatInr(input.amount)} on ${humanDate(input.paidOn)}${where}.`,
        entityType: 'payment',
        entityId: paymentId,
      });
    }
    await notifyAccountMembers(
      session,
      ctx.accountId,
      {
        type: 'payment_recorded',
        title: `${formatInr(input.amount)} received from ${links.tenant.name}`,
        body: `${ctx.userName ?? 'A partner'} recorded a ${METHOD_LABELS[input.method]} payment${where}.`,
        entityType: 'payment',
        entityId: paymentId,
      },
      { excludeUserId: ctx.userId },
    );
    return paymentId;
  });
  return getPayment(ctx, id);
}

/** Loads a payment for a change and locks it for the rest of the transaction. */
async function lockPayment(session: ClientSession, ctx: Ctx, id: string) {
  const row = await col('payments').findOneAndUpdate(
    { _id: id, account_id: ctx.accountId },
    { $inc: { lock_version: 1 } },
    { session, returnDocument: 'before' },
  );
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
  await withTransaction(async (session) => {
    const payment = await lockPayment(session, ctx, id);
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
    if (amountChanged && payment.status === 'confirmed') await clearPaymentAllocations(session, id);
    await col('payments').updateOne({ _id: id }, { $set: { ...changes, updated_at: new Date() } }, { session });
    if (amountChanged && payment.status === 'confirmed') await allocateTenant(session, ctx.accountId, payment.tenant_id);

    await logActivity(session, ctx, {
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
  await withTransaction(async (session) => {
    const payment = await lockPayment(session, ctx, id);
    if (payment.status !== 'pending') throw Errors.conflict('Only payments awaiting confirmation can be confirmed.');
    await col('payments').updateOne(
      { _id: id },
      { $set: { status: 'confirmed', confirmed_by: ctx.userId, confirmed_at: new Date(), updated_at: new Date() } },
      { session },
    );
    await allocateTenant(session, ctx.accountId, payment.tenant_id);
    const tenant = await col('tenants').findOne({ _id: payment.tenant_id }, { session });
    await logActivity(session, ctx, {
      action: 'payment.confirmed',
      entityType: 'payment',
      entityId: id,
      summary: `Confirmed ${formatInr(Number(payment.amount))} from ${tenant?.name} (${METHOD_LABELS[payment.method as PaymentMethod]})`,
    });
    await notifyTenant(session, payment.tenant_id, {
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
  await withTransaction(async (session) => {
    const payment = await lockPayment(session, ctx, id);
    if (payment.status !== 'pending') throw Errors.conflict('Only payments awaiting confirmation can be rejected.');
    await col('payments').updateOne({ _id: id }, { $set: { status: 'rejected', rejected_reason: reason, updated_at: new Date() } }, { session });
    const tenant = await col('tenants').findOne({ _id: payment.tenant_id }, { session });
    await logActivity(session, ctx, {
      action: 'payment.rejected',
      entityType: 'payment',
      entityId: id,
      summary: `Rejected ${formatInr(Number(payment.amount))} submitted by ${tenant?.name}: ${reason}`,
    });
    await notifyTenant(session, payment.tenant_id, {
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
  await withTransaction(async (session) => {
    const payment = await lockPayment(session, ctx, id);
    if (payment.status === 'void') throw Errors.conflict('This payment is already void.');
    if (payment.status === 'rejected') throw Errors.conflict('Rejected payments cannot be voided.');
    await clearPaymentAllocations(session, id);
    await col('payments').updateOne(
      { _id: id },
      { $set: { status: 'void', voided_at: new Date(), void_reason: reason, updated_at: new Date() } },
      { session },
    );
    if (payment.method === 'deposit') {
      // Undo the deposit adjustment so the money counts as deposit held again.
      await col('deposit_transactions').deleteMany({ payment_id: id }, { session });
    }
    await allocateTenant(session, ctx.accountId, payment.tenant_id);
    const tenant = await col('tenants').findOne({ _id: payment.tenant_id }, { session });
    await logActivity(session, ctx, {
      action: 'payment.voided',
      entityType: 'payment',
      entityId: id,
      summary: `Voided ${formatInr(Number(payment.amount))} from ${tenant?.name}: ${reason}`,
    });
  });
  return getPayment(ctx, id);
}
