import { db, type Trx } from '../../db/knex.js';
import type { Ctx } from '../../lib/context.js';
import { addDays, diffDays, humanDate, ordinal, startOfMonth } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import { formatInr, round2, subtractMoney } from '../../lib/money.js';
import { likePattern, resolveSort } from '../../lib/validation.js';
import { logActivity } from '../activity/activity.service.js';
import { allocationTotals, depositHeldByAgreement } from '../finance/finance.queries.js';
import { allocateTenant, clearChargeAllocations, trimChargeAllocations } from '../payments/allocation.service.js';
import { METHOD_LABELS, type RecordableMethod } from '../payments/payment.types.js';
import {
  CYCLE_MONTHS,
  monthlyEquivalent,
  nextPeriodAfter,
  periodContaining,
  termsFromRow,
  type AgreementRow,
  type BillingCycle,
} from '../rents/billing.js';
import { chargeQuery, mapCharge, type RentEntryDto } from '../rents/charge-query.js';
import { generateChargesForAgreement, resetGenerationThrottle } from '../rents/generation.service.js';
import { createTenantInTrx, type NewTenantInput } from './tenant-inline.js';

export type AgreementPhase = 'upcoming' | 'active' | 'expired' | 'notice' | 'ended';

/** Unit types that are commercial premises (GST applies by default). */
export const COMMERCIAL_UNIT_TYPES = new Set(['shop', 'office', 'warehouse', 'floor', 'land', 'other']);

export interface AgreementCreateInput {
  unitId: string;
  tenantId?: string | null;
  newTenant?: NewTenantInput | null;
  startDate: string;
  endDate?: string | null;
  billingStartDate?: string | null;
  rentAmount: number;
  billingCycle: BillingCycle;
  dueDay: number;
  gstApplicable?: boolean;
  gstRate?: number | null;
  securityDeposit?: number;
  escalationPercent?: number;
  escalationIntervalMonths?: number;
  proratePartialPeriods?: boolean;
  noticePeriodDays?: number | null;
  lockInMonths?: number | null;
  notes?: string | null;
  openingBalance?: { amount: number; dueDate?: string | null; description?: string | null } | null;
  advancePayment?: { amount: number; paidOn: string; method: RecordableMethod; reference?: string | null } | null;
  depositReceived?: { amount: number; date: string; method?: RecordableMethod | null; reference?: string | null } | null;
}

export interface AgreementUpdateInput {
  endDate?: string | null;
  rentAmount?: number;
  dueDay?: number;
  gstApplicable?: boolean;
  gstRate?: number;
  securityDeposit?: number;
  escalationPercent?: number;
  escalationIntervalMonths?: number;
  proratePartialPeriods?: boolean;
  noticePeriodDays?: number | null;
  lockInMonths?: number | null;
  notes?: string | null;
}

export interface DepositSummary {
  agreed: number;
  received: number;
  refunded: number;
  deducted: number;
  applied: number;
  held: number;
}

export interface AgreementDto {
  id: string;
  status: 'active' | 'ended';
  phase: AgreementPhase;
  unit: { id: string; name: string; type: string };
  property: { id: string; name: string; type: string };
  tenant: { id: string; name: string; phone: string; businessName: string | null };
  startDate: string;
  endDate: string | null;
  billingStartDate: string;
  rentAmount: number;
  monthlyRent: number;
  billingCycle: BillingCycle;
  dueDay: number;
  dueDayLabel: string;
  gstApplicable: boolean;
  gstRate: number;
  rentWithGst: number;
  securityDeposit: number;
  escalationPercent: number;
  escalationIntervalMonths: number;
  proratePartialPeriods: boolean;
  noticePeriodDays: number | null;
  lockInMonths: number | null;
  endedOn: string | null;
  endReason: string | null;
  notes: string | null;
  daysToExpiry: number | null;
  nextDue: { periodStart: string; dueDate: string; amount: number } | null;
  createdAt: string;
  updatedAt: string;
}

export interface DepositTransactionDto {
  id: string;
  type: 'received' | 'refunded' | 'deducted' | 'applied';
  amount: number;
  date: string;
  method: string | null;
  reference: string | null;
  notes: string | null;
  paymentId: string | null;
  createdAt: string;
}

export interface AgreementDetailDto extends AgreementDto {
  deposit: DepositSummary;
  depositTransactions: DepositTransactionDto[];
  financials: { charged: number; collected: number; outstanding: number; overdue: number };
  entries: RentEntryDto[];
}

function phaseOf(row: AgreementRow, today: string): AgreementPhase {
  if (row.status === 'ended') return row.ended_on && row.ended_on >= today ? 'notice' : 'ended';
  if (row.start_date > today) return 'upcoming';
  if (row.end_date && row.end_date < today) return 'expired';
  return 'active';
}

function agreementBaseQuery(ctx: Ctx) {
  return db('agreements as a')
    .join('units as u', 'u.id', 'a.unit_id')
    .join('properties as p', 'p.id', 'u.property_id')
    .join('tenants as t', 't.id', 'a.tenant_id')
    .where('a.account_id', ctx.accountId)
    .select(
      'a.*',
      'u.name as unit_name',
      'u.type as unit_type',
      'p.id as property_id',
      'p.name as property_name',
      'p.type as property_type',
      't.name as tenant_name',
      't.phone as tenant_phone',
      't.business_name as tenant_business_name',
    );
}

function mapAgreement(r: AgreementRow & Record<string, any>, today: string): AgreementDto {
  const terms = termsFromRow(r);
  const upcoming = r.status === 'active' || (r.ended_on && r.ended_on >= today) ? nextPeriodAfter(terms, today) : null;
  const gstRate = Number(r.gst_rate);
  const rent = Number(r.rent_amount);
  return {
    id: r.id,
    status: r.status,
    phase: phaseOf(r, today),
    unit: { id: r.unit_id, name: r.unit_name, type: r.unit_type },
    property: { id: r.property_id, name: r.property_name, type: r.property_type },
    tenant: { id: r.tenant_id, name: r.tenant_name, phone: r.tenant_phone, businessName: r.tenant_business_name ?? null },
    startDate: r.start_date,
    endDate: r.end_date,
    billingStartDate: r.billing_start_date,
    rentAmount: rent,
    monthlyRent: monthlyEquivalent(rent, r.billing_cycle),
    billingCycle: r.billing_cycle,
    dueDay: r.due_day,
    dueDayLabel: `${ordinal(r.due_day)} ${r.billing_cycle === 'monthly' ? 'every month' : `of every ${CYCLE_MONTHS[r.billing_cycle as BillingCycle]}-month period`}`,
    gstApplicable: r.gst_applicable,
    gstRate,
    rentWithGst: r.gst_applicable ? round2(rent + (rent * gstRate) / 100) : rent,
    securityDeposit: Number(r.security_deposit),
    escalationPercent: Number(r.escalation_percent),
    escalationIntervalMonths: r.escalation_interval_months,
    proratePartialPeriods: r.prorate_partial_periods,
    noticePeriodDays: r.notice_period_days,
    lockInMonths: r.lock_in_months,
    endedOn: r.ended_on,
    endReason: r.end_reason,
    notes: r.notes,
    daysToExpiry: r.status === 'active' && r.end_date ? diffDays(today, r.end_date) : null,
    nextDue: upcoming ? { periodStart: upcoming.periodStart, dueDate: upcoming.dueDate, amount: upcoming.totalAmount } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listAgreements(
  ctx: Ctx,
  opts: {
    page: number;
    pageSize: number;
    search?: string;
    status?: 'active' | 'ended' | 'all';
    unitId?: string;
    tenantId?: string;
    propertyId?: string;
    expiringWithinDays?: number;
    sort?: string;
  },
): Promise<{ items: AgreementDto[]; total: number }> {
  const sort = resolveSort(
    opts.sort,
    { startDate: 'a.start_date', endDate: 'a.end_date', rent: 'a.rent_amount', createdAt: 'a.created_at', tenant: 'lower(t.name)' },
    { column: 'a.start_date', direction: 'desc' },
  );
  const base = agreementBaseQuery(ctx).modify((q) => {
    if (opts.status && opts.status !== 'all') q.where('a.status', opts.status);
    if (opts.unitId) q.where('a.unit_id', opts.unitId);
    if (opts.tenantId) q.where('a.tenant_id', opts.tenantId);
    if (opts.propertyId) q.where('u.property_id', opts.propertyId);
    if (opts.expiringWithinDays !== undefined) {
      q.where('a.status', 'active').whereNotNull('a.end_date').where('a.end_date', '<=', addDays(ctx.today, opts.expiringWithinDays));
    }
    if (opts.search) {
      const pattern = likePattern(opts.search);
      q.where((w) => w.whereILike('t.name', pattern).orWhereILike('u.name', pattern).orWhereILike('p.name', pattern));
    }
  });
  const [{ count }] = await base.clone().clearSelect().count<{ count: number }[]>({ count: '*' });
  const rows = await base
    .orderByRaw(`${sort.column} ${sort.direction} NULLS LAST, a.id`)
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);
  return { total: Number(count), items: rows.map((r: AgreementRow & Record<string, any>) => mapAgreement(r, ctx.today)) };
}

async function depositSummaries(q: typeof db | Trx, agreementIds: string[]): Promise<Map<string, Omit<DepositSummary, 'agreed'>>> {
  const map = new Map<string, Omit<DepositSummary, 'agreed'>>();
  if (!agreementIds.length) return map;
  const rows = await q('deposit_transactions')
    .whereIn('agreement_id', agreementIds)
    .select('agreement_id', 'type')
    .sum({ total: 'amount' })
    .groupBy('agreement_id', 'type');
  for (const r of rows as any[]) {
    const s = map.get(r.agreement_id) ?? { received: 0, refunded: 0, deducted: 0, applied: 0, held: 0 };
    s[r.type as 'received' | 'refunded' | 'deducted' | 'applied'] = Number(r.total);
    map.set(r.agreement_id, s);
  }
  for (const s of map.values()) {
    s.held = round2(s.received - s.refunded - s.deducted - s.applied);
  }
  return map;
}

export async function getAgreement(ctx: Ctx, id: string): Promise<AgreementDetailDto> {
  const row = await agreementBaseQuery(ctx).where('a.id', id).first();
  if (!row) throw Errors.notFound('Agreement');

  const [deposits, transactions, entries, fin] = await Promise.all([
    depositSummaries(db, [id]),
    db('deposit_transactions').where({ agreement_id: id }).orderBy([
      { column: 'txn_date', order: 'desc' },
      { column: 'created_at', order: 'desc' },
    ]),
    db
      .from(chargeQuery(db, { accountId: ctx.accountId }, ctx.today).where('c.agreement_id', id).as('lc'))
      .whereNot('lc.status', 'void')
      .orderBy([
        { column: 'lc.period_start', order: 'desc' },
        { column: 'lc.created_at', order: 'desc' },
      ])
      .limit(24),
    db('rent_charges as c')
      .leftJoin(allocationTotals(db, ctx.accountId).as('al'), 'al.charge_id', 'c.id')
      .where({ 'c.agreement_id': id })
      .whereNull('c.voided_at')
      .select(db.raw('COALESCE(SUM(c.total_amount), 0) AS charged'))
      .select(db.raw('COALESCE(SUM(COALESCE(al.paid, 0)), 0) AS collected'))
      .select(db.raw('COALESCE(SUM(c.total_amount - COALESCE(al.paid, 0)), 0) AS outstanding'))
      .select(db.raw('COALESCE(SUM(CASE WHEN c.due_date < ?::date THEN c.total_amount - COALESCE(al.paid, 0) ELSE 0 END), 0) AS overdue', [ctx.today]))
      .first(),
  ]);

  const dep = deposits.get(id) ?? { received: 0, refunded: 0, deducted: 0, applied: 0, held: 0 };
  return {
    ...mapAgreement(row, ctx.today),
    deposit: { agreed: Number(row.security_deposit), ...dep },
    depositTransactions: transactions.map((t) => ({
      id: t.id,
      type: t.type,
      amount: Number(t.amount),
      date: t.txn_date,
      method: t.method,
      reference: t.reference,
      notes: t.notes,
      paymentId: t.payment_id,
      createdAt: t.created_at,
    })),
    financials: {
      charged: Number(fin?.charged ?? 0),
      collected: Number(fin?.collected ?? 0),
      outstanding: Number(fin?.outstanding ?? 0),
      overdue: Number(fin?.overdue ?? 0),
    },
    entries: entries.map((e) => mapCharge(e, ctx.today)),
  };
}

async function assertUnitAvailable(trx: Trx, ctx: Ctx, unitId: string, startDate: string) {
  const unit = await trx('units').where({ id: unitId, account_id: ctx.accountId }).forUpdate().first();
  if (!unit) throw Errors.validation('Unit not found.', [{ field: 'unitId', message: 'Unit not found' }]);
  if (unit.archived_at) throw Errors.conflict('This unit is archived. Restore it before creating an agreement.');

  const active = await trx('agreements as a')
    .join('tenants as t', 't.id', 'a.tenant_id')
    .where({ 'a.unit_id': unitId, 'a.status': 'active' })
    .first('a.id', 't.name');
  if (active) {
    throw Errors.conflict(`${unit.name} already has an active agreement with ${active.name}. End it before adding a new tenant.`);
  }
  const overlapping = await trx('agreements')
    .where({ unit_id: unitId, status: 'ended' })
    .where('ended_on', '>=', startDate)
    .orderBy('ended_on', 'desc')
    .first('ended_on');
  if (overlapping) {
    throw Errors.conflict(
      `The previous tenant of ${unit.name} moves out on ${humanDate(overlapping.ended_on)}. The new agreement must start after that date.`,
      [{ field: 'startDate', message: 'Overlaps with previous agreement' }],
    );
  }
  return unit;
}

export async function createAgreement(ctx: Ctx, input: AgreementCreateInput): Promise<AgreementDetailDto> {
  if (!input.tenantId && !input.newTenant) {
    throw Errors.validation('Choose a tenant or add a new one.', [{ field: 'tenantId', message: 'This field is required' }]);
  }
  if (input.endDate && input.endDate < input.startDate) {
    throw Errors.validation('End date must be on or after the start date.', [{ field: 'endDate', message: 'Must be after start date' }]);
  }
  const defaultBillingStart = input.startDate >= startOfMonth(ctx.today) ? input.startDate : startOfMonth(ctx.today);
  const billingStartDate = input.billingStartDate ?? defaultBillingStart;
  if (billingStartDate < input.startDate) {
    throw Errors.validation('Billing cannot start before the agreement start date.', [
      { field: 'billingStartDate', message: 'Must be on or after start date' },
    ]);
  }
  if (input.endDate && billingStartDate > input.endDate) {
    throw Errors.validation('Billing start must be before the agreement end date.', [
      { field: 'billingStartDate', message: 'Must be before end date' },
    ]);
  }

  const agreementId = await db.transaction(async (trx) => {
    const unit = await assertUnitAvailable(trx, ctx, input.unitId, input.startDate);
    // GST defaults to on for commercial premises when the account charges GST;
    // residential rent is generally exempt.
    const gstApplicable = input.gstApplicable ?? (ctx.gstEnabled && COMMERCIAL_UNIT_TYPES.has(unit.type));
    const gstRate = gstApplicable ? (input.gstRate ?? ctx.gstRate) : 0;

    let tenantId = input.tenantId ?? null;
    let tenantName: string;
    if (tenantId) {
      const tenant = await trx('tenants').where({ id: tenantId, account_id: ctx.accountId }).first();
      if (!tenant) throw Errors.validation('Tenant not found.', [{ field: 'tenantId', message: 'Tenant not found' }]);
      if (tenant.archived_at) throw Errors.conflict('This tenant is archived. Restore the tenant first.');
      tenantName = tenant.name;
    } else {
      const created = await createTenantInTrx(trx, ctx, input.newTenant!);
      tenantId = created.id;
      tenantName = created.name;
    }

    const [agreement] = (await trx('agreements')
      .insert({
        account_id: ctx.accountId,
        unit_id: input.unitId,
        tenant_id: tenantId,
        status: 'active',
        start_date: input.startDate,
        end_date: input.endDate ?? null,
        billing_start_date: billingStartDate,
        rent_amount: input.rentAmount,
        billing_cycle: input.billingCycle,
        due_day: input.dueDay,
        gst_applicable: gstApplicable,
        gst_rate: gstRate,
        security_deposit: input.securityDeposit ?? 0,
        escalation_percent: input.escalationPercent ?? 0,
        escalation_interval_months: input.escalationIntervalMonths ?? 12,
        prorate_partial_periods: input.proratePartialPeriods ?? true,
        notice_period_days: input.noticePeriodDays ?? null,
        lock_in_months: input.lockInMonths ?? null,
        notes: input.notes ?? null,
        created_by: ctx.userId,
      })
      .returning('*')) as AgreementRow[];

    if (input.openingBalance && input.openingBalance.amount > 0) {
      const dueDate = input.openingBalance.dueDate ?? (billingStartDate <= ctx.today ? billingStartDate : ctx.today);
      await trx('rent_charges').insert({
        account_id: ctx.accountId,
        agreement_id: agreement.id,
        tenant_id: tenantId,
        unit_id: input.unitId,
        kind: 'opening_balance',
        description: input.openingBalance.description || 'Previous outstanding balance',
        period_start: dueDate,
        period_end: dueDate,
        due_date: dueDate,
        base_amount: input.openingBalance.amount,
        gst_rate: 0,
        gst_amount: 0,
        created_by: ctx.userId,
      });
    }

    if (input.depositReceived && input.depositReceived.amount > 0) {
      await trx('deposit_transactions').insert({
        account_id: ctx.accountId,
        agreement_id: agreement.id,
        tenant_id: tenantId,
        type: 'received',
        amount: input.depositReceived.amount,
        txn_date: input.depositReceived.date,
        method: input.depositReceived.method ?? null,
        reference: input.depositReceived.reference ?? null,
        notes: 'Security deposit received at move-in',
        recorded_by: ctx.userId,
      });
    }

    if (input.advancePayment && input.advancePayment.amount > 0) {
      await trx('payments').insert({
        account_id: ctx.accountId,
        tenant_id: tenantId,
        agreement_id: agreement.id,
        unit_id: input.unitId,
        amount: input.advancePayment.amount,
        paid_on: input.advancePayment.paidOn,
        method: input.advancePayment.method,
        reference: input.advancePayment.reference ?? null,
        notes: 'Advance rent received at move-in',
        status: 'confirmed',
        source: 'owner',
        recorded_by: ctx.userId,
        confirmed_by: ctx.userId,
        confirmed_at: new Date(),
      });
    }

    await generateChargesForAgreement(trx, agreement, ctx.today, ctx.userId);
    await allocateTenant(trx, ctx.accountId, tenantId!);

    await logActivity(trx, ctx, {
      action: 'agreement.created',
      entityType: 'agreement',
      entityId: agreement.id,
      summary: `Rented ${unit.name} to ${tenantName} at ${formatInr(input.rentAmount)}/${input.billingCycle === 'monthly' ? 'month' : input.billingCycle.replace('_', '-')}`,
    });
    return agreement.id;
  });

  resetGenerationThrottle(ctx.accountId);
  return getAgreement(ctx, agreementId);
}

async function findAgreementRow(trx: Trx | typeof db, ctx: Ctx, id: string, lock = false): Promise<AgreementRow> {
  const q = trx('agreements').where({ id, account_id: ctx.accountId });
  if (lock) q.forUpdate();
  const row = (await q.first()) as AgreementRow | undefined;
  if (!row) throw Errors.notFound('Agreement');
  return row;
}

export async function updateAgreement(ctx: Ctx, id: string, input: AgreementUpdateInput): Promise<AgreementDetailDto> {
  await db.transaction(async (trx) => {
    const current = await findAgreementRow(trx, ctx, id, true);
    if (current.status === 'ended' && (input.rentAmount !== undefined || input.dueDay !== undefined || input.endDate !== undefined)) {
      throw Errors.conflict('This agreement has ended; billing terms can no longer be changed.');
    }
    const changes: Record<string, unknown> = {};
    const changed: string[] = [];

    if (input.endDate !== undefined && input.endDate !== current.end_date) {
      if (input.endDate && input.endDate < current.start_date) {
        throw Errors.validation('End date must be on or after the start date.', [{ field: 'endDate', message: 'Must be after start date' }]);
      }
      if (input.endDate) {
        const later = await trx('rent_charges')
          .where({ agreement_id: id, kind: 'rent' })
          .whereNull('voided_at')
          .where('period_start', '>', input.endDate)
          .first('id');
        if (later) {
          throw Errors.conflict('Rent has already been billed after this date. Use "End agreement" to stop billing and settle the final period.');
        }
      }
      changes.end_date = input.endDate;
      changed.push('end date');
    }
    if (input.rentAmount !== undefined && input.rentAmount !== Number(current.rent_amount)) {
      changes.rent_amount = input.rentAmount;
      // New rent applies from the next billing period; escalation restarts from there.
      const next = nextPeriodAfter(termsFromRow(current), ctx.today);
      changes.escalation_base_date = next?.periodStart ?? ctx.today;
      changed.push(`rent to ${formatInr(input.rentAmount)}`);
    }
    if (input.dueDay !== undefined && input.dueDay !== current.due_day) {
      changes.due_day = input.dueDay;
      changed.push(`due day to ${ordinal(input.dueDay)}`);
    }
    if (input.gstApplicable !== undefined && input.gstApplicable !== current.gst_applicable) {
      changes.gst_applicable = input.gstApplicable;
      if (!input.gstApplicable) changes.gst_rate = 0;
      else if (input.gstRate === undefined && Number(current.gst_rate) === 0) changes.gst_rate = ctx.gstRate;
      changed.push(input.gstApplicable ? 'GST on' : 'GST off');
    }
    if (input.gstRate !== undefined && (changes.gst_applicable ?? current.gst_applicable)) {
      if (input.gstRate !== Number(current.gst_rate)) {
        changes.gst_rate = input.gstRate;
        changed.push(`GST rate to ${input.gstRate}%`);
      }
    }
    const simple: Array<[keyof AgreementUpdateInput, string]> = [
      ['securityDeposit', 'security_deposit'],
      ['escalationPercent', 'escalation_percent'],
      ['escalationIntervalMonths', 'escalation_interval_months'],
      ['proratePartialPeriods', 'prorate_partial_periods'],
      ['noticePeriodDays', 'notice_period_days'],
      ['lockInMonths', 'lock_in_months'],
      ['notes', 'notes'],
    ];
    for (const [key, column] of simple) {
      if (input[key] !== undefined) changes[column] = input[key];
    }
    if (Object.keys(changes).length === 0) return;

    await trx('agreements').where({ id }).update(changes);
    const updated = await findAgreementRow(trx, ctx, id);
    await generateChargesForAgreement(trx, updated, ctx.today, ctx.userId);
    const unit = await trx('units').where({ id: current.unit_id }).first('name');
    await logActivity(trx, ctx, {
      action: 'agreement.updated',
      entityType: 'agreement',
      entityId: id,
      summary: changed.length ? `Updated agreement for ${unit?.name}: ${changed.join(', ')}` : `Updated agreement for ${unit?.name}`,
    });
  });
  resetGenerationThrottle(ctx.accountId);
  return getAgreement(ctx, id);
}

/**
 * Ends an agreement on the move-out date: stops billing, cancels periods
 * after the move-out date (money paid for them becomes credit) and
 * pro-rates the final period when enabled.
 */
export async function endAgreement(
  ctx: Ctx,
  id: string,
  input: { endedOn: string; reason?: string | null },
): Promise<AgreementDetailDto> {
  await db.transaction(async (trx) => {
    const current = await findAgreementRow(trx, ctx, id, true);
    if (current.status === 'ended') throw Errors.conflict('This agreement has already ended.');
    if (input.endedOn < current.start_date) {
      throw Errors.validation('Move-out date cannot be before the agreement start date.', [
        { field: 'endedOn', message: 'Must be on or after start date' },
      ]);
    }

    await trx('agreements').where({ id }).update({ status: 'ended', ended_on: input.endedOn, end_reason: input.reason ?? null });
    const ended = await findAgreementRow(trx, ctx, id);

    // Bill every period up to the move-out date (or today, whichever is earlier).
    await generateChargesForAgreement(trx, ended, input.endedOn < ctx.today ? input.endedOn : ctx.today, ctx.userId);

    // Cancel periods that start after the move-out date.
    const future = await trx('rent_charges')
      .where({ agreement_id: id, kind: 'rent' })
      .whereNull('voided_at')
      .where('period_start', '>', input.endedOn)
      .select('id');
    for (const charge of future) {
      await clearChargeAllocations(trx, charge.id);
      await trx('rent_charges')
        .where({ id: charge.id })
        .update({ voided_at: new Date(), void_reason: `Agreement ended on ${humanDate(input.endedOn)}` });
    }

    // Re-price the final period so the tenant only pays for the days occupied.
    const finalPeriod = periodContaining(termsFromRow(ended), input.endedOn);
    if (finalPeriod) {
      const charge = await trx('rent_charges')
        .where({ agreement_id: id, kind: 'rent', period_start: finalPeriod.periodStart })
        .whereNull('voided_at')
        .first();
      if (charge && (Number(charge.base_amount) !== finalPeriod.baseAmount || charge.period_end !== finalPeriod.periodEnd)) {
        await trx('rent_charges').where({ id: charge.id }).update({
          period_end: finalPeriod.periodEnd,
          due_date: finalPeriod.dueDate < charge.due_date ? finalPeriod.dueDate : charge.due_date,
          base_amount: finalPeriod.baseAmount,
          gst_amount: finalPeriod.gstAmount,
          description: finalPeriod.isPartial ? `Pro-rated rent for ${finalPeriod.daysBilled} of ${finalPeriod.daysInPeriod} days` : charge.description,
        });
        await trimChargeAllocations(trx, charge.id, finalPeriod.totalAmount);
      }
    }

    await allocateTenant(trx, ctx.accountId, current.tenant_id);

    const unit = await trx('units').where({ id: current.unit_id }).first('name');
    const tenant = await trx('tenants').where({ id: current.tenant_id }).first('name');
    await logActivity(trx, ctx, {
      action: 'agreement.ended',
      entityType: 'agreement',
      entityId: id,
      summary: `${tenant?.name} moves out of ${unit?.name} on ${humanDate(input.endedOn)}${input.reason ? ` (${input.reason})` : ''}`,
    });
  });
  resetGenerationThrottle(ctx.accountId);
  return getAgreement(ctx, id);
}

export async function deleteAgreement(ctx: Ctx, id: string): Promise<void> {
  await db.transaction(async (trx) => {
    const current = await findAgreementRow(trx, ctx, id, true);
    const allocation = await trx('payment_allocations as pa')
      .join('rent_charges as c', 'c.id', 'pa.charge_id')
      .where('c.agreement_id', id)
      .first('pa.id');
    const payment = await trx('payments').where({ agreement_id: id }).whereIn('status', ['confirmed', 'pending']).first('id');
    const deposit = await trx('deposit_transactions').where({ agreement_id: id }).first('id');
    if (allocation || payment || deposit) {
      throw Errors.conflict('Payments or deposits are recorded against this agreement. End the agreement instead of deleting it.');
    }
    await trx('payments').where({ agreement_id: id }).update({ agreement_id: null });
    await trx('agreements').where({ id }).delete();
    const unit = await trx('units').where({ id: current.unit_id }).first('name');
    await logActivity(trx, ctx, {
      action: 'agreement.deleted',
      entityType: 'agreement',
      entityId: id,
      summary: `Deleted the agreement for ${unit?.name}`,
    });
  });
}

// ---------------------------------------------------------------------------
// Security deposits
// ---------------------------------------------------------------------------

export async function addDepositTransaction(
  ctx: Ctx,
  agreementId: string,
  input: {
    type: 'received' | 'refunded' | 'deducted' | 'applied';
    amount: number;
    date: string;
    method?: RecordableMethod | null;
    reference?: string | null;
    notes?: string | null;
  },
): Promise<AgreementDetailDto> {
  await db.transaction(async (trx) => {
    const agreement = await findAgreementRow(trx, ctx, agreementId, true);
    const summary = (await depositSummaries(trx, [agreementId])).get(agreementId);
    const held = summary?.held ?? 0;
    if (input.type !== 'received' && input.amount > held) {
      throw Errors.validation(`Only ${formatInr(held)} of the deposit is held.`, [{ field: 'amount', message: 'Exceeds deposit held' }]);
    }

    let paymentId: string | null = null;
    if (input.type === 'applied') {
      const [payment] = await trx('payments')
        .insert({
          account_id: ctx.accountId,
          tenant_id: agreement.tenant_id,
          agreement_id: agreementId,
          unit_id: agreement.unit_id,
          amount: input.amount,
          paid_on: input.date,
          method: 'deposit',
          reference: input.reference ?? null,
          notes: input.notes || 'Adjusted from security deposit',
          status: 'confirmed',
          source: 'system',
          recorded_by: ctx.userId,
          confirmed_by: ctx.userId,
          confirmed_at: new Date(),
        })
        .returning('id');
      paymentId = payment.id;
    }

    await trx('deposit_transactions').insert({
      account_id: ctx.accountId,
      agreement_id: agreementId,
      tenant_id: agreement.tenant_id,
      type: input.type,
      amount: input.amount,
      txn_date: input.date,
      method: input.type === 'applied' ? null : (input.method ?? null),
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      payment_id: paymentId,
      recorded_by: ctx.userId,
    });

    if (paymentId) await allocateTenant(trx, ctx.accountId, agreement.tenant_id);

    const tenant = await trx('tenants').where({ id: agreement.tenant_id }).first('name');
    const verbs = { received: 'Received', refunded: 'Refunded', deducted: 'Deducted', applied: 'Adjusted against rent' };
    await logActivity(trx, ctx, {
      action: `deposit.${input.type}`,
      entityType: 'agreement',
      entityId: agreementId,
      summary: `${verbs[input.type]} security deposit ${formatInr(input.amount)} · ${tenant?.name}${input.method ? ` (${METHOD_LABELS[input.method]})` : ''}`,
    });
  });
  return getAgreement(ctx, agreementId);
}

export async function deleteDepositTransaction(ctx: Ctx, agreementId: string, txnId: string): Promise<AgreementDetailDto> {
  await db.transaction(async (trx) => {
    const agreement = await findAgreementRow(trx, ctx, agreementId, true);
    const txn = await trx('deposit_transactions').where({ id: txnId, agreement_id: agreementId, account_id: ctx.accountId }).first();
    if (!txn) throw Errors.notFound('Deposit transaction');

    if (txn.type === 'received') {
      const summary = (await depositSummaries(trx, [agreementId])).get(agreementId);
      const heldAfter = subtractMoney(summary?.held ?? 0, Number(txn.amount));
      if (heldAfter < 0) {
        throw Errors.conflict('Part of this deposit was already refunded, deducted or adjusted. Remove those entries first.');
      }
    }
    if (txn.type === 'applied' && txn.payment_id) {
      await trx('payment_allocations').where({ payment_id: txn.payment_id }).delete();
      await trx('payments').where({ id: txn.payment_id }).update({ status: 'void', voided_at: new Date(), void_reason: 'Deposit adjustment removed' });
    }
    await trx('deposit_transactions').where({ id: txnId }).delete();
    await allocateTenant(trx, ctx.accountId, agreement.tenant_id);
    await logActivity(trx, ctx, {
      action: 'deposit.deleted',
      entityType: 'agreement',
      entityId: agreementId,
      summary: `Removed a security deposit entry of ${formatInr(Number(txn.amount))} (${txn.type})`,
    });
  });
  return getAgreement(ctx, agreementId);
}

export { depositHeldByAgreement };
