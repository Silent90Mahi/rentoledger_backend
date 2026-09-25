import type { ClientSession, Filter } from 'mongodb';
import { isDuplicateKey } from '../../db/indexes.js';
import { $round2, col, lockDoc, newId, withTransaction, type Doc, type Session } from '../../db/mongo.js';
import type { Ctx } from '../../lib/context.js';
import { addDays, diffDays, humanDate, ordinal, startOfMonth } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import { formatInr, round2, subtractMoney } from '../../lib/money.js';
import { compareRows, resolveSort } from '../../lib/validation.js';
import { logActivity } from '../activity/activity.service.js';
import { depositHeldByAgreement } from '../finance/finance.queries.js';
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
import { chargeStatusStages, findCharges, mapCharge, type RentEntryDto } from '../rents/charge-query.js';
import { agreementRow, generateChargesForAgreement, resetGenerationThrottle } from '../rents/generation.service.js';
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

/** Agreements (scoped to the account) joined with unit, property and tenant names. */
async function agreementRows(ctx: Ctx, filter: Filter<Doc> = {}, session?: Session): Promise<Array<AgreementRow & Record<string, any>>> {
  const options = session ? { session } : {};
  const docs = await col('agreements').find({ ...filter, account_id: ctx.accountId }, options).toArray();
  if (docs.length === 0) return [];
  const units = new Map((await col('units').find({ _id: { $in: [...new Set(docs.map((a) => a.unit_id))] } }, options).toArray()).map((u) => [u._id, u]));
  const properties = new Map(
    (await col('properties').find({ _id: { $in: [...new Set([...units.values()].map((u) => u.property_id))] } }, options).toArray()).map((p) => [p._id, p]),
  );
  const tenants = new Map((await col('tenants').find({ _id: { $in: [...new Set(docs.map((a) => a.tenant_id))] } }, options).toArray()).map((t) => [t._id, t]));
  return docs.map((a) => {
    const u = units.get(a.unit_id);
    const p = u ? properties.get(u.property_id) : undefined;
    const t = tenants.get(a.tenant_id);
    return {
      ...(agreementRow(a) as AgreementRow & Record<string, any>),
      unit_name: u?.name,
      unit_type: u?.type,
      property_id: p?._id,
      property_name: p?.name,
      property_type: p?.type,
      tenant_name: t?.name,
      tenant_phone: t?.phone,
      tenant_business_name: t?.business_name ?? null,
    };
  });
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
    endDate: r.end_date ?? null,
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
    noticePeriodDays: r.notice_period_days ?? null,
    lockInMonths: r.lock_in_months ?? null,
    endedOn: r.ended_on ?? null,
    endReason: r.end_reason ?? null,
    notes: r.notes ?? null,
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
    { startDate: 'start_date', endDate: 'end_date', rent: 'rent_amount', createdAt: 'created_at', tenant: 'tenant_name' },
    { column: 'start_date', direction: 'desc' },
  );
  const filter: Filter<Doc> = {};
  if (opts.status && opts.status !== 'all') filter.status = opts.status;
  if (opts.unitId) filter.unit_id = opts.unitId;
  if (opts.tenantId) filter.tenant_id = opts.tenantId;
  if (opts.propertyId) filter.unit_id = { $in: await col('units').distinct('_id', { account_id: ctx.accountId, property_id: opts.propertyId }) };
  if (opts.expiringWithinDays !== undefined) {
    filter.status = 'active';
    filter.end_date = { $ne: null, $lte: addDays(ctx.today, opts.expiringWithinDays) };
  }
  let rows = await agreementRows(ctx, filter);
  if (opts.search) {
    const needle = opts.search.toLowerCase();
    rows = rows.filter((r) => [r.tenant_name, r.unit_name, r.property_name].some((v) => typeof v === 'string' && v.toLowerCase().includes(needle)));
  }
  rows.sort((a, b) => compareRows(a, b, sort.column, sort.direction));
  const page = rows.slice((opts.page - 1) * opts.pageSize, opts.page * opts.pageSize);
  return { total: rows.length, items: page.map((r) => mapAgreement(r, ctx.today)) };
}

async function depositSummaries(agreementIds: string[], session?: Session): Promise<Map<string, Omit<DepositSummary, 'agreed'>>> {
  const map = new Map<string, Omit<DepositSummary, 'agreed'>>();
  if (!agreementIds.length) return map;
  const rows = await col('deposit_transactions')
    .aggregate(
      [{ $match: { agreement_id: { $in: agreementIds } } }, { $group: { _id: { agreement_id: '$agreement_id', type: '$type' }, total: { $sum: '$amount' } } }],
      session ? { session } : {},
    )
    .toArray();
  for (const r of rows) {
    const s = map.get(r._id.agreement_id) ?? { received: 0, refunded: 0, deducted: 0, applied: 0, held: 0 };
    s[r._id.type as 'received' | 'refunded' | 'deducted' | 'applied'] = round2(r.total);
    map.set(r._id.agreement_id, s);
  }
  for (const s of map.values()) {
    s.held = round2(s.received - s.refunded - s.deducted - s.applied);
  }
  return map;
}

export async function getAgreement(ctx: Ctx, id: string): Promise<AgreementDetailDto> {
  const [row] = await agreementRows(ctx, { _id: id });
  if (!row) throw Errors.notFound('Agreement');

  const [deposits, transactions, entries, [fin]] = await Promise.all([
    depositSummaries([id]),
    col('deposit_transactions').find({ agreement_id: id }).sort({ txn_date: -1, created_at: -1 }).toArray(),
    findCharges({ accountId: ctx.accountId }, ctx.today, { agreement_id: id, voided_at: null }, { sort: { period_start: -1, created_at: -1 }, limit: 24 }),
    col('rent_charges')
      .aggregate([
        ...chargeStatusStages({ accountId: ctx.accountId }, ctx.today, { agreement_id: id, voided_at: null }),
        {
          $group: {
            _id: null,
            charged: { $sum: '$total_amount' },
            collected: { $sum: '$paid_amount' },
            outstanding: { $sum: '$balance' },
            overdue: { $sum: { $cond: [{ $lt: ['$due_date', ctx.today] }, '$balance', 0] } },
          },
        },
        { $project: { charged: $round2('$charged'), collected: $round2('$collected'), outstanding: $round2('$outstanding'), overdue: $round2('$overdue') } },
      ])
      .toArray(),
  ]);

  const dep = deposits.get(id) ?? { received: 0, refunded: 0, deducted: 0, applied: 0, held: 0 };
  return {
    ...mapAgreement(row, ctx.today),
    deposit: { agreed: Number(row.security_deposit), ...dep },
    depositTransactions: transactions.map((t) => ({
      id: t._id,
      type: t.type,
      amount: Number(t.amount),
      date: t.txn_date,
      method: t.method ?? null,
      reference: t.reference ?? null,
      notes: t.notes ?? null,
      paymentId: t.payment_id ?? null,
      createdAt: t.created_at,
    })),
    financials: {
      charged: round2(fin?.charged ?? 0),
      collected: round2(fin?.collected ?? 0),
      outstanding: round2(fin?.outstanding ?? 0),
      overdue: round2(fin?.overdue ?? 0),
    },
    entries: entries.map((e) => mapCharge(e, ctx.today)),
  };
}

async function assertUnitAvailable(session: ClientSession, ctx: Ctx, unitId: string, startDate: string) {
  const unit = await col('units').findOne({ _id: unitId, account_id: ctx.accountId }, { session });
  if (!unit) throw Errors.validation('Unit not found.', [{ field: 'unitId', message: 'Unit not found' }]);
  if (unit.archived_at) throw Errors.conflict('This unit is archived. Restore it before creating an agreement.');
  // Serialises concurrent "rent out" requests for the same unit.
  await lockDoc('units', unitId, session);

  const active = await col('agreements').findOne({ unit_id: unitId, status: 'active' }, { session });
  if (active) {
    const tenant = await col('tenants').findOne({ _id: active.tenant_id }, { session });
    throw Errors.conflict(`${unit.name} already has an active agreement with ${tenant?.name ?? 'another tenant'}. End it before adding a new tenant.`);
  }
  const overlapping = await col('agreements').findOne(
    { unit_id: unitId, status: 'ended', ended_on: { $gte: startDate } },
    { session, sort: { ended_on: -1 } },
  );
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

  let agreementId: string;
  try {
    agreementId = await withTransaction(async (session) => {
      const unit = await assertUnitAvailable(session, ctx, input.unitId, input.startDate);
      // GST defaults to on for commercial premises when the account charges GST;
      // residential rent is generally exempt.
      const gstApplicable = input.gstApplicable ?? (ctx.gstEnabled && COMMERCIAL_UNIT_TYPES.has(unit.type));
      const gstRate = gstApplicable ? (input.gstRate ?? ctx.gstRate) : 0;

      let tenantId = input.tenantId ?? null;
      let tenantName: string;
      if (tenantId) {
        const tenant = await col('tenants').findOne({ _id: tenantId, account_id: ctx.accountId }, { session });
        if (!tenant) throw Errors.validation('Tenant not found.', [{ field: 'tenantId', message: 'Tenant not found' }]);
        if (tenant.archived_at) throw Errors.conflict('This tenant is archived. Restore the tenant first.');
        tenantName = tenant.name;
      } else {
        const created = await createTenantInTrx(session, ctx, input.newTenant!);
        tenantId = created.id;
        tenantName = created.name;
      }

      const now = new Date();
      const doc = {
        _id: newId(),
        account_id: ctx.accountId,
        unit_id: input.unitId,
        tenant_id: tenantId,
        status: 'active',
        active_unit_id: input.unitId,
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
        escalation_base_date: null,
        prorate_partial_periods: input.proratePartialPeriods ?? true,
        notice_period_days: input.noticePeriodDays ?? null,
        lock_in_months: input.lockInMonths ?? null,
        ended_on: null,
        end_reason: null,
        notes: input.notes ?? null,
        created_by: ctx.userId,
        created_at: now,
        updated_at: now,
      };
      await col('agreements').insertOne(doc, { session });
      const agreement = agreementRow(doc);

      if (input.openingBalance && input.openingBalance.amount > 0) {
        const dueDate = input.openingBalance.dueDate ?? (billingStartDate <= ctx.today ? billingStartDate : ctx.today);
        await col('rent_charges').insertOne(
          {
            _id: newId(),
            account_id: ctx.accountId,
            agreement_id: doc._id,
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
            total_amount: input.openingBalance.amount,
            voided_at: null,
            void_reason: null,
            created_by: ctx.userId,
            created_at: now,
            updated_at: now,
          },
          { session },
        );
      }

      if (input.depositReceived && input.depositReceived.amount > 0) {
        await col('deposit_transactions').insertOne(
          {
            _id: newId(),
            account_id: ctx.accountId,
            agreement_id: doc._id,
            tenant_id: tenantId,
            type: 'received',
            amount: input.depositReceived.amount,
            txn_date: input.depositReceived.date,
            method: input.depositReceived.method ?? null,
            reference: input.depositReceived.reference ?? null,
            notes: 'Security deposit received at move-in',
            payment_id: null,
            recorded_by: ctx.userId,
            created_at: now,
          },
          { session },
        );
      }

      if (input.advancePayment && input.advancePayment.amount > 0) {
        await col('payments').insertOne(
          {
            _id: newId(),
            account_id: ctx.accountId,
            tenant_id: tenantId,
            agreement_id: doc._id,
            unit_id: input.unitId,
            target_charge_id: null,
            amount: input.advancePayment.amount,
            paid_on: input.advancePayment.paidOn,
            method: input.advancePayment.method,
            reference: input.advancePayment.reference ?? null,
            notes: 'Advance rent received at move-in',
            status: 'confirmed',
            source: 'owner',
            recorded_by: ctx.userId,
            confirmed_by: ctx.userId,
            confirmed_at: now,
            rejected_reason: null,
            voided_at: null,
            void_reason: null,
            created_at: now,
            updated_at: now,
          },
          { session },
        );
      }

      await generateChargesForAgreement(session, agreement, ctx.today, ctx.userId);
      await allocateTenant(session, ctx.accountId, tenantId!);

      await logActivity(session, ctx, {
        action: 'agreement.created',
        entityType: 'agreement',
        entityId: doc._id,
        summary: `Rented ${unit.name} to ${tenantName} at ${formatInr(input.rentAmount)}/${input.billingCycle === 'monthly' ? 'month' : input.billingCycle.replace('_', '-')}`,
      });
      return doc._id;
    });
  } catch (error) {
    if (isDuplicateKey(error, 'agreements_one_active_per_unit')) {
      throw Errors.conflict('This unit already has an active agreement. End it before adding a new tenant.');
    }
    if (isDuplicateKey(error, 'tenants_account_phone_key')) {
      throw Errors.conflict('A tenant with this mobile number already exists. Select the existing tenant instead.', [
        { field: 'newTenant.phone', message: 'Already exists' },
      ]);
    }
    throw error;
  }

  resetGenerationThrottle(ctx.accountId);
  return getAgreement(ctx, agreementId);
}

async function findAgreementRow(ctx: Ctx, id: string, session?: ClientSession, lock = false): Promise<AgreementRow> {
  const doc = await col('agreements').findOne({ _id: id, account_id: ctx.accountId }, session ? { session } : {});
  if (!doc) throw Errors.notFound('Agreement');
  if (lock && session) await lockDoc('agreements', id, session);
  return agreementRow(doc);
}

export async function updateAgreement(ctx: Ctx, id: string, input: AgreementUpdateInput): Promise<AgreementDetailDto> {
  await withTransaction(async (session) => {
    const current = await findAgreementRow(ctx, id, session, true);
    if (current.status === 'ended' && (input.rentAmount !== undefined || input.dueDay !== undefined || input.endDate !== undefined)) {
      throw Errors.conflict('This agreement has ended; billing terms can no longer be changed.');
    }
    const changes: Record<string, unknown> = {};
    const changed: string[] = [];

    if (input.endDate !== undefined && input.endDate !== (current.end_date ?? null)) {
      if (input.endDate && input.endDate < current.start_date) {
        throw Errors.validation('End date must be on or after the start date.', [{ field: 'endDate', message: 'Must be after start date' }]);
      }
      if (input.endDate) {
        const later = await col('rent_charges').findOne(
          { agreement_id: id, kind: 'rent', voided_at: null, period_start: { $gt: input.endDate } },
          { session },
        );
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

    await col('agreements').updateOne({ _id: id }, { $set: { ...changes, updated_at: new Date() } }, { session });
    const updated = await findAgreementRow(ctx, id, session);
    await generateChargesForAgreement(session, updated, ctx.today, ctx.userId);
    const unit = await col('units').findOne({ _id: current.unit_id }, { session });
    await logActivity(session, ctx, {
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
  await withTransaction(async (session) => {
    const current = await findAgreementRow(ctx, id, session, true);
    if (current.status === 'ended') throw Errors.conflict('This agreement has already ended.');
    if (input.endedOn < current.start_date) {
      throw Errors.validation('Move-out date cannot be before the agreement start date.', [
        { field: 'endedOn', message: 'Must be on or after start date' },
      ]);
    }

    await col('agreements').updateOne(
      { _id: id },
      { $set: { status: 'ended', ended_on: input.endedOn, end_reason: input.reason ?? null, updated_at: new Date() }, $unset: { active_unit_id: '' } },
      { session },
    );
    const ended = await findAgreementRow(ctx, id, session);

    // Bill every period up to the move-out date (or today, whichever is earlier).
    await generateChargesForAgreement(session, ended, input.endedOn < ctx.today ? input.endedOn : ctx.today, ctx.userId);

    // Cancel periods that start after the move-out date.
    const future = await col('rent_charges')
      .find({ agreement_id: id, kind: 'rent', voided_at: null, period_start: { $gt: input.endedOn } }, { session, projection: { _id: 1 } })
      .toArray();
    for (const charge of future) {
      await clearChargeAllocations(session, charge._id);
      await col('rent_charges').updateOne(
        { _id: charge._id },
        { $set: { voided_at: new Date(), void_reason: `Agreement ended on ${humanDate(input.endedOn)}`, updated_at: new Date() } },
        { session },
      );
    }

    // Re-price the final period so the tenant only pays for the days occupied.
    const finalPeriod = periodContaining(termsFromRow(ended), input.endedOn);
    if (finalPeriod) {
      const charge = await col('rent_charges').findOne(
        { agreement_id: id, kind: 'rent', period_start: finalPeriod.periodStart, voided_at: null },
        { session },
      );
      if (charge && (Number(charge.base_amount) !== finalPeriod.baseAmount || charge.period_end !== finalPeriod.periodEnd)) {
        await col('rent_charges').updateOne(
          { _id: charge._id },
          {
            $set: {
              period_end: finalPeriod.periodEnd,
              due_date: finalPeriod.dueDate < charge.due_date ? finalPeriod.dueDate : charge.due_date,
              base_amount: finalPeriod.baseAmount,
              gst_amount: finalPeriod.gstAmount,
              total_amount: round2(finalPeriod.baseAmount + finalPeriod.gstAmount),
              description: finalPeriod.isPartial ? `Pro-rated rent for ${finalPeriod.daysBilled} of ${finalPeriod.daysInPeriod} days` : charge.description,
              updated_at: new Date(),
            },
          },
          { session },
        );
        await trimChargeAllocations(session, charge._id, finalPeriod.totalAmount);
      }
    }

    await allocateTenant(session, ctx.accountId, current.tenant_id);

    const unit = await col('units').findOne({ _id: current.unit_id }, { session });
    const tenant = await col('tenants').findOne({ _id: current.tenant_id }, { session });
    await logActivity(session, ctx, {
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
  await withTransaction(async (session) => {
    const current = await findAgreementRow(ctx, id, session, true);
    const chargeIds = await col('rent_charges').distinct('_id', { agreement_id: id }, { session });
    const allocation = chargeIds.length ? await col('payment_allocations').findOne({ charge_id: { $in: chargeIds } }, { session }) : null;
    const payment = await col('payments').findOne({ agreement_id: id, status: { $in: ['confirmed', 'pending'] } }, { session });
    const deposit = await col('deposit_transactions').findOne({ agreement_id: id }, { session });
    if (allocation || payment || deposit) {
      throw Errors.conflict('Payments or deposits are recorded against this agreement. End the agreement instead of deleting it.');
    }
    await col('payments').updateMany({ agreement_id: id }, { $set: { agreement_id: null } }, { session });
    // Charges belong to the agreement (cascade, as the old foreign key did).
    await col('payments').updateMany({ target_charge_id: { $in: chargeIds } }, { $set: { target_charge_id: null } }, { session });
    await col('rent_charges').deleteMany({ agreement_id: id }, { session });
    await col('agreements').deleteOne({ _id: id }, { session });
    const unit = await col('units').findOne({ _id: current.unit_id }, { session });
    await logActivity(session, ctx, {
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
  await withTransaction(async (session) => {
    const agreement = await findAgreementRow(ctx, agreementId, session, true);
    const summary = (await depositSummaries([agreementId], session)).get(agreementId);
    const held = summary?.held ?? 0;
    if (input.type !== 'received' && input.amount > held) {
      throw Errors.validation(`Only ${formatInr(held)} of the deposit is held.`, [{ field: 'amount', message: 'Exceeds deposit held' }]);
    }

    const now = new Date();
    let paymentId: string | null = null;
    if (input.type === 'applied') {
      paymentId = newId();
      await col('payments').insertOne(
        {
          _id: paymentId,
          account_id: ctx.accountId,
          tenant_id: agreement.tenant_id,
          agreement_id: agreementId,
          unit_id: agreement.unit_id,
          target_charge_id: null,
          amount: input.amount,
          paid_on: input.date,
          method: 'deposit',
          reference: input.reference ?? null,
          notes: input.notes || 'Adjusted from security deposit',
          status: 'confirmed',
          source: 'system',
          recorded_by: ctx.userId,
          confirmed_by: ctx.userId,
          confirmed_at: now,
          rejected_reason: null,
          voided_at: null,
          void_reason: null,
          created_at: now,
          updated_at: now,
        },
        { session },
      );
    }

    await col('deposit_transactions').insertOne(
      {
        _id: newId(),
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
        created_at: now,
      },
      { session },
    );

    if (paymentId) await allocateTenant(session, ctx.accountId, agreement.tenant_id);

    const tenant = await col('tenants').findOne({ _id: agreement.tenant_id }, { session });
    const verbs = { received: 'Received', refunded: 'Refunded', deducted: 'Deducted', applied: 'Adjusted against rent' };
    await logActivity(session, ctx, {
      action: `deposit.${input.type}`,
      entityType: 'agreement',
      entityId: agreementId,
      summary: `${verbs[input.type]} security deposit ${formatInr(input.amount)} · ${tenant?.name}${input.method ? ` (${METHOD_LABELS[input.method]})` : ''}`,
    });
  });
  return getAgreement(ctx, agreementId);
}

export async function deleteDepositTransaction(ctx: Ctx, agreementId: string, txnId: string): Promise<AgreementDetailDto> {
  await withTransaction(async (session) => {
    const agreement = await findAgreementRow(ctx, agreementId, session, true);
    const txn = await col('deposit_transactions').findOne({ _id: txnId, agreement_id: agreementId, account_id: ctx.accountId }, { session });
    if (!txn) throw Errors.notFound('Deposit transaction');

    if (txn.type === 'received') {
      const summary = (await depositSummaries([agreementId], session)).get(agreementId);
      const heldAfter = subtractMoney(summary?.held ?? 0, Number(txn.amount));
      if (heldAfter < 0) {
        throw Errors.conflict('Part of this deposit was already refunded, deducted or adjusted. Remove those entries first.');
      }
    }
    if (txn.type === 'applied' && txn.payment_id) {
      await col('payment_allocations').deleteMany({ payment_id: txn.payment_id }, { session });
      await col('payments').updateOne(
        { _id: txn.payment_id },
        { $set: { status: 'void', voided_at: new Date(), void_reason: 'Deposit adjustment removed', updated_at: new Date() } },
        { session },
      );
    }
    await col('deposit_transactions').deleteOne({ _id: txnId }, { session });
    await allocateTenant(session, ctx.accountId, agreement.tenant_id);
    await logActivity(session, ctx, {
      action: 'deposit.deleted',
      entityType: 'agreement',
      entityId: agreementId,
      summary: `Removed a security deposit entry of ${formatInr(Number(txn.amount))} (${txn.type})`,
    });
  });
  return getAgreement(ctx, agreementId);
}

export { depositHeldByAgreement };
