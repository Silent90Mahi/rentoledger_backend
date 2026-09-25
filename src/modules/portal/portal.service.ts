import { config } from '../../config/env.js';
import { col, newId, withTransaction } from '../../db/mongo.js';
import { now, todayIn } from '../../lib/clock.js';
import type { TenantCtx } from '../../lib/context.js';
import { humanDate, monthEnd, monthKeyOf, monthLabel, monthStart } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import { formatInr, round2 } from '../../lib/money.js';
import { logActivity } from '../activity/activity.service.js';
import { notifyAccountMembers } from '../notifications/notifications.service.js';
import { METHOD_LABELS, type PaymentMethod, type RecordableMethod } from '../payments/payment.types.js';
import { chargeStatusStages, findCharges, mapCharge, type RentEntryDto } from '../rents/charge-query.js';
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
  const tenants = await col('tenants').find({ _id: { $in: ctx.tenantIds } }).toArray();
  const accountIds = [...new Set(tenants.map((t) => t.account_id))];
  const accounts = new Map((await col('accounts').find({ _id: { $in: accountIds } }).toArray()).map((a) => [a._id, a]));
  const owners = await col('account_members').find({ account_id: { $in: accountIds }, role: 'owner' }).toArray();
  const ownerUsers = new Map((await col('users').find({ _id: { $in: owners.map((o) => o.user_id) } }).toArray()).map((u) => [u._id, u]));
  const ownerByAccount = new Map(owners.map((o) => [o.account_id, ownerUsers.get(o.user_id)]));
  return tenants
    .filter((t) => accounts.has(t.account_id))
    .map((t) => {
      const a = accounts.get(t.account_id)!;
      const o = ownerByAccount.get(t.account_id);
      return {
        tenantId: t._id,
        tenantName: t.name,
        accountId: a._id,
        accountName: a.name,
        timezone: a.timezone,
        payeeName: a.payee_name ?? null,
        upiId: a.upi_id ?? null,
        bankAccountName: a.bank_account_name ?? null,
        bankAccountNumber: a.bank_account_number ?? null,
        bankIfsc: a.bank_ifsc ?? null,
        bankName: a.bank_name ?? null,
        ownerName: o?.name ?? null,
        ownerPhone: o?.phone ?? null,
      };
    });
}

function tenantToday(list: Tenancy[]): string {
  return todayIn(list[0]?.timezone ?? config.defaults.timezone);
}

/** Brings each landlord's entries up to date, using that landlord's own time zone. */
async function refreshCharges(list: Tenancy[]) {
  const accounts = new Map(list.map((t) => [t.accountId, t.timezone]));
  for (const [accountId, timezone] of accounts) await ensureAccountCharges(accountId, todayIn(timezone));
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
  await refreshCharges(list);
  const month = monthInput ?? monthKeyOf(today);
  const from = monthStart(month);
  const to = monthEnd(month);

  const rows = (
    await findCharges({ tenantIds: ctx.tenantIds }, today, { period_start: { $lte: to }, voided_at: null }, { sort: { due_date: 1 } })
  )
    .filter((r) => r.period_start >= from || ['overdue', 'pending', 'to_confirm'].includes(r.status))
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)) || String(a.unit_name).localeCompare(String(b.unit_name)));
  const entries = rows.map((r) => mapCharge(r, today));
  const thisMonth = entries.filter((e) => e.periodStart >= from);
  const unpaid = entries.filter((e) => e.balance > 0);

  const pendingDocs = await col('payments').find({ tenant_id: { $in: ctx.tenantIds }, status: 'pending' }).sort({ created_at: -1 }).toArray();
  const pendingUnits = new Map(
    (await col('units').find({ _id: { $in: pendingDocs.map((p) => p.unit_id).filter(Boolean) } }).toArray()).map((u) => [u._id, u.name]),
  );
  const pending = pendingDocs.map((p): Record<string, any> => ({ ...p, id: p._id, unit_name: p.unit_id ? (pendingUnits.get(p.unit_id) ?? null) : null }));

  const confirmed = await col('payments').find({ tenant_id: { $in: ctx.tenantIds }, status: 'confirmed' }, { projection: { amount: 1 } }).toArray();
  const [allocated] = await col('payment_allocations')
    .aggregate([{ $match: { payment_id: { $in: confirmed.map((p) => p._id) } } }, { $group: { _id: null, total: { $sum: '$amount' } } }])
    .toArray();
  const credit = { credit: round2(confirmed.reduce((sum, p) => sum + p.amount, 0) - (allocated?.total ?? 0)) };

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
      reference: p.reference ?? null,
      unitName: p.unit_name,
      targetChargeId: p.target_charge_id ?? null,
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
  await refreshCharges(list);
  const statusMatch =
    opts.status === 'unpaid'
      ? { status: { $in: ['overdue', 'pending', 'to_confirm'] } }
      : opts.status === 'collected'
        ? { status: 'collected' }
        : { status: { $ne: 'void' } };
  const [result] = await col('rent_charges')
    .aggregate([
      ...chargeStatusStages({ tenantIds: ctx.tenantIds }, today, { voided_at: null }),
      { $match: statusMatch },
      {
        $facet: {
          total: [{ $count: 'count' }],
          rows: [{ $sort: { period_start: -1, due_date: -1, _id: 1 } }, { $skip: (opts.page - 1) * opts.pageSize }, { $limit: opts.pageSize }],
        },
      },
    ])
    .toArray();
  const pageIds = (result.rows as Array<{ _id: string }>).map((r) => r._id);
  const rows = pageIds.length
    ? await findCharges({ tenantIds: ctx.tenantIds }, today, { _id: { $in: pageIds } }, { sort: { period_start: -1, due_date: -1, _id: 1 } })
    : [];
  return { items: rows.map((r) => mapCharge(r, today)), total: result.total[0]?.count ?? 0 };
}

export async function portalCharge(ctx: TenantCtx, id: string) {
  const list = await tenancies(ctx);
  const today = tenantToday(list);
  const [row] = await findCharges({ tenantIds: ctx.tenantIds }, today, { _id: id });
  if (!row) throw Errors.notFound('Rent entry');
  const entry = mapCharge(row, today);
  const payments = await col('payment_allocations')
    .aggregate([
      { $match: { charge_id: id } },
      { $lookup: { from: 'payments', localField: 'payment_id', foreignField: '_id', as: 'p' } },
      { $unwind: '$p' },
      { $sort: { 'p.paid_on': 1 } },
      { $project: { allocated: '$amount', id: '$p._id', amount: '$p.amount', paid_on: '$p.paid_on', method: '$p.method', reference: '$p.reference' } },
    ])
    .toArray();
  const pending = (await col('payments').find({ target_charge_id: id, status: 'pending', tenant_id: { $in: ctx.tenantIds } }).toArray()).map((p): Record<string, any> => ({
    ...p,
    id: p._id,
  }));
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
      reference: p.reference ?? null,
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
  const filter = { tenant_id: { $in: ctx.tenantIds } };
  const [total, docs] = await Promise.all([
    col('payments').countDocuments(filter),
    col('payments')
      .find(filter)
      .sort({ paid_on: -1, created_at: -1 })
      .skip((opts.page - 1) * opts.pageSize)
      .limit(opts.pageSize)
      .toArray(),
  ]);
  const units = new Map((await col('units').find({ _id: { $in: docs.map((p) => p.unit_id).filter(Boolean) } }).toArray()).map((u) => [u._id, u.name]));
  return {
    total,
    items: docs.map((p) => ({
      id: p._id as string,
      amount: Number(p.amount),
      paidOn: p.paid_on,
      method: p.method,
      methodLabel: METHOD_LABELS[p.method as PaymentMethod] ?? p.method,
      reference: p.reference ?? null,
      notes: p.notes ?? null,
      status: p.status,
      source: p.source,
      unitName: p.unit_id ? (units.get(p.unit_id) ?? null) : null,
      rejectedReason: p.rejected_reason ?? null,
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
  let charge: { id: string; tenant_id: string; agreement_id: string; unit_id: string; unit_name: string; voided_at: Date | null } | undefined;

  if (input.chargeId) {
    const doc = await col('rent_charges').findOne({ _id: input.chargeId, tenant_id: { $in: ctx.tenantIds } });
    if (doc) {
      const unit = await col('units').findOne({ _id: doc.unit_id }, { projection: { name: 1 } });
      charge = { id: doc._id, tenant_id: doc.tenant_id, agreement_id: doc.agreement_id, unit_id: doc.unit_id, unit_name: unit?.name, voided_at: doc.voided_at ?? null };
    }
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

  const duplicate = await col('payments').findOne({
    tenant_id: tenantId,
    status: 'pending',
    amount: input.amount,
    paid_on: input.paidOn,
    ...(input.chargeId ? { target_charge_id: input.chargeId } : {}),
    created_at: { $gt: new Date(now().getTime() - 10 * 60_000) },
  });
  if (duplicate) throw Errors.conflict('You already submitted this payment. Your landlord will confirm it shortly.');

  let unitId = charge?.unit_id ?? null;
  let agreementId = charge?.agreement_id ?? null;
  let unitName = charge?.unit_name ?? null;
  if (!charge) {
    const agreement = await col('agreements').findOne(
      { tenant_id: tenantId, $or: [{ status: 'active' }, { ended_on: { $gte: today } }] },
      { sort: { start_date: -1 } },
    );
    unitId = agreement?.unit_id ?? null;
    agreementId = agreement?._id ?? null;
    unitName = agreement ? ((await col('units').findOne({ _id: agreement.unit_id }))?.name ?? null) : null;
  }

  const paymentId = await withTransaction(async (session) => {
    const id = newId();
    const at = new Date();
    await col('payments').insertOne(
      {
        _id: id,
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
        confirmed_by: null,
        confirmed_at: null,
        rejected_reason: null,
        voided_at: null,
        void_reason: null,
        created_at: at,
        updated_at: at,
      },
      { session },
    );
    const where = unitName ? ` for ${unitName}` : '';
    await logActivity(session, { accountId: tenancy.accountId, userId: ctx.userId }, {
      action: 'payment.submitted',
      entityType: 'payment',
      entityId: id,
      summary: `${tenancy.tenantName} reported paying ${formatInr(input.amount)}${where} via ${METHOD_LABELS[input.method]} — to confirm`,
    });
    await notifyAccountMembers(session, tenancy.accountId, {
      type: 'payment_submitted',
      title: `${tenancy.tenantName} paid ${formatInr(input.amount)} — please confirm`,
      body: `${METHOD_LABELS[input.method]} payment on ${humanDate(input.paidOn)}${where}${input.reference ? ` (ref ${input.reference})` : ''}.`,
      entityType: 'payment',
      entityId: id,
      data: { chargeId: charge?.id ?? null },
    });
    return id;
  });

  const [created] = (await portalPayments(ctx, { page: 1, pageSize: 50 })).items.filter((p) => p.id === paymentId);
  return created;
}

/** A tenant may withdraw a submission the landlord has not acted on yet. */
export async function withdrawPayment(ctx: TenantCtx, id: string) {
  await withTransaction(async (session) => {
    const payment = await col('payments').findOneAndUpdate(
      { _id: id, tenant_id: { $in: ctx.tenantIds } },
      { $inc: { lock_version: 1 } },
      { session, returnDocument: 'before' },
    );
    if (!payment) throw Errors.notFound('Payment');
    if (payment.status !== 'pending' || payment.source !== 'tenant') {
      throw Errors.conflict('Only payments awaiting confirmation can be withdrawn.');
    }
    await col('payments').updateOne(
      { _id: id },
      { $set: { status: 'void', voided_at: now(), void_reason: 'Withdrawn by tenant', updated_at: now() } },
      { session },
    );
    const tenant = await col('tenants').findOne({ _id: payment.tenant_id }, { session });
    await logActivity(session, { accountId: payment.account_id, userId: ctx.userId }, {
      action: 'payment.withdrawn',
      entityType: 'payment',
      entityId: id,
      summary: `${tenant?.name} withdrew a payment submission of ${formatInr(Number(payment.amount))}`,
    });
  });
}
