import type { Filter } from 'mongodb';
import { isDuplicateKey } from '../../db/indexes.js';
import { col, contains, newId, withTransaction, type Doc } from '../../db/mongo.js';
import type { Ctx } from '../../lib/context.js';
import { addMonths, startOfMonth } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import { round2, subtractMoney } from '../../lib/money.js';
import { compareRows, resolveSort } from '../../lib/validation.js';
import { logActivity } from '../activity/activity.service.js';
import { depositHeldByAgreement, tenantFinancials, type TenantFinancials } from '../finance/finance.queries.js';
import { chargeStatusStages, findCharges, mapCharge, periodLabelFor, type RentEntryDto } from '../rents/charge-query.js';

export type TenantStatus = 'active' | 'upcoming' | 'past' | 'new';

export interface TenantInput {
  name: string;
  phone: string;
  email?: string | null;
  businessName?: string | null;
  gstin?: string | null;
  idProofType?: string | null;
  idProofNumber?: string | null;
  address?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  notes?: string | null;
  portalEnabled?: boolean;
}

export interface TenantUnitRef {
  agreementId: string;
  unitId: string;
  unitName: string;
  propertyId: string;
  propertyName: string;
}

export interface TenantDto {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  businessName: string | null;
  gstin: string | null;
  idProofType: string | null;
  idProofNumber: string | null;
  address: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  notes: string | null;
  portalEnabled: boolean;
  hasAppAccount: boolean;
  archived: boolean;
  status: TenantStatus;
  units: TenantUnitRef[];
  outstanding: number;
  overdue: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Tenants (matching `filter`, scoped to the account) with derived fields:
 * outstanding/overdue dues, lifecycle status, current units and whether the
 * phone number has signed in to the app.
 */
async function tenantRows(ctx: Ctx, filter: Filter<Doc> = {}): Promise<Array<Record<string, any>>> {
  const tenants = await col('tenants').find({ ...filter, account_id: ctx.accountId }).toArray();
  if (tenants.length === 0) return [];
  const ids = tenants.map((t) => t._id);

  const [dues, agreements, users] = await Promise.all([
    col('rent_charges')
      .aggregate([
        ...chargeStatusStages({ accountId: ctx.accountId }, ctx.today, { tenant_id: { $in: ids }, voided_at: null }),
        {
          $group: {
            _id: '$tenant_id',
            outstanding: { $sum: '$balance' },
            overdue: { $sum: { $cond: [{ $lt: ['$due_date', ctx.today] }, '$balance', 0] } },
          },
        },
      ])
      .toArray(),
    col('agreements').find({ account_id: ctx.accountId, tenant_id: { $in: ids } }).toArray(),
    col('users').find({ phone: { $in: [...new Set(tenants.map((t) => t.phone))] } }, { projection: { phone: 1 } }).toArray(),
  ]);
  const duesByTenant = new Map(dues.map((d) => [d._id, d]));
  const appPhones = new Set(users.map((u) => u.phone));

  const unitIds = [...new Set(agreements.map((a) => a.unit_id))];
  const units = new Map((await col('units').find({ _id: { $in: unitIds } }).toArray()).map((u) => [u._id, u]));
  const properties = new Map(
    (await col('properties').find({ _id: { $in: [...new Set([...units.values()].map((u) => u.property_id))] } }).toArray()).map((p) => [p._id, p]),
  );

  const byTenant = new Map<string, Doc[]>();
  for (const a of agreements) byTenant.set(a.tenant_id, [...(byTenant.get(a.tenant_id) ?? []), a]);

  return tenants.map((t) => {
    const list = byTenant.get(t._id) ?? [];
    const status = list.some((a) => a.start_date <= ctx.today && (a.status === 'active' || (a.ended_on && a.ended_on >= ctx.today)))
      ? 'active'
      : list.some((a) => a.status === 'active' && a.start_date > ctx.today)
        ? 'upcoming'
        : list.length
          ? 'past'
          : 'new';
    const currentUnits = list
      .filter((a) => a.status === 'active' || (a.ended_on && a.ended_on >= ctx.today))
      .map((a) => {
        const u = units.get(a.unit_id);
        const p = u ? properties.get(u.property_id) : undefined;
        return { agreementId: a._id, unitId: a.unit_id, unitName: u?.name ?? '', propertyId: p?._id ?? '', propertyName: p?.name ?? '' };
      })
      .sort((x, y) => x.unitName.localeCompare(y.unitName, 'en', { sensitivity: 'base', numeric: true }));
    const d = duesByTenant.get(t._id);
    return {
      ...t,
      id: t._id,
      outstanding: round2(d?.outstanding ?? 0),
      overdue: round2(d?.overdue ?? 0),
      has_app_account: appPhones.has(t.phone),
      status,
      units: currentUnits,
    };
  });
}

function mapTenant(r: Record<string, any>): TenantDto {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    email: r.email ?? null,
    businessName: r.business_name ?? null,
    gstin: r.gstin ?? null,
    idProofType: r.id_proof_type ?? null,
    idProofNumber: r.id_proof_number ?? null,
    address: r.address ?? null,
    emergencyContactName: r.emergency_contact_name ?? null,
    emergencyContactPhone: r.emergency_contact_phone ?? null,
    notes: r.notes ?? null,
    portalEnabled: r.portal_enabled,
    hasAppAccount: Boolean(r.has_app_account),
    archived: r.archived_at !== null && r.archived_at !== undefined,
    status: r.status,
    units: (r.units ?? []) as TenantUnitRef[],
    outstanding: Math.max(0, Number(r.outstanding ?? 0)),
    overdue: Math.max(0, Number(r.overdue ?? 0)),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listTenants(
  ctx: Ctx,
  opts: {
    page: number;
    pageSize: number;
    search?: string;
    status?: TenantStatus | 'all';
    dues?: 'any' | 'overdue';
    sort?: string;
    archived?: boolean;
  },
): Promise<{ items: TenantDto[]; total: number; counts: Record<string, number> }> {
  const sort = resolveSort(
    opts.sort,
    { name: 'name', createdAt: 'created_at', outstanding: 'outstanding', overdue: 'overdue' },
    { column: 'name', direction: 'asc' },
  );

  let rows = await tenantRows(ctx, { archived_at: opts.archived ? { $ne: null } : null });
  if (opts.search) {
    const needle = opts.search.toLowerCase();
    const digits = opts.search.replace(/\D/g, '');
    // Any unit the tenant has ever rented matches, not just current ones.
    const byUnit = await tenantIdsByUnitName(ctx, opts.search);
    rows = rows.filter(
      (r) =>
        byUnit.has(r.id) ||
        [r.name, r.business_name, r.email].some((v) => typeof v === 'string' && v.toLowerCase().includes(needle)) ||
        (digits.length >= 3 && String(r.phone).includes(digits)),
    );
  }

  const counts: Record<string, number> = { all: 0, active: 0, upcoming: 0, past: 0, new: 0 };
  for (const r of rows) {
    counts[r.status] += 1;
    counts.all += 1;
  }

  const filtered = rows.filter(
    (r) =>
      (!opts.status || opts.status === 'all' || r.status === opts.status) &&
      (opts.dues !== 'any' || r.outstanding > 0) &&
      (opts.dues !== 'overdue' || r.overdue > 0),
  );
  filtered.sort((a, b) => compareRows(a, b, sort.column, sort.direction));
  const page = filtered.slice((opts.page - 1) * opts.pageSize, opts.page * opts.pageSize);
  return { items: page.map(mapTenant), total: filtered.length, counts };
}

async function tenantIdsByUnitName(ctx: Ctx, search: string): Promise<Set<string>> {
  const unitIds = await col('units').distinct('_id', { account_id: ctx.accountId, name: contains(search) });
  if (unitIds.length === 0) return new Set();
  return new Set((await col('agreements').distinct('tenant_id', { account_id: ctx.accountId, unit_id: { $in: unitIds } })) as string[]);
}

export interface TenantAgreementSummary {
  id: string;
  status: 'active' | 'ended';
  isCurrent: boolean;
  unit: { id: string; name: string };
  property: { id: string; name: string };
  startDate: string;
  endDate: string | null;
  endedOn: string | null;
  rentAmount: number;
  billingCycle: string;
  dueDay: number;
  gstApplicable: boolean;
  gstRate: number;
  securityDeposit: number;
  depositHeld: number;
}

export interface TenantPaymentSummary {
  id: string;
  amount: number;
  paidOn: string;
  method: string;
  reference: string | null;
  status: string;
  source: string;
}

export interface TenantDetailDto extends TenantDto {
  financials: TenantFinancials;
  agreements: TenantAgreementSummary[];
  openEntries: RentEntryDto[];
  recentPayments: TenantPaymentSummary[];
}

export async function getTenant(ctx: Ctx, id: string): Promise<TenantDetailDto> {
  const [row] = await tenantRows(ctx, { _id: id });
  if (!row) throw Errors.notFound('Tenant');

  const [financials, agreementDocs, openEntries, payments] = await Promise.all([
    tenantFinancials(ctx.accountId, [id], ctx.today),
    col('agreements').find({ tenant_id: id, account_id: ctx.accountId }).sort({ status: 1, start_date: -1 }).toArray(),
    findCharges({ accountId: ctx.accountId }, ctx.today, { tenant_id: id, voided_at: null }, { sort: { due_date: 1, period_start: 1 } }).then((rows) =>
      rows.filter((r) => ['overdue', 'pending', 'to_confirm'].includes(r.status)),
    ),
    col('payments').find({ tenant_id: id, account_id: ctx.accountId }).sort({ paid_on: -1, created_at: -1 }).limit(10).toArray(),
  ]);

  const units = new Map((await col('units').find({ _id: { $in: agreementDocs.map((a) => a.unit_id) } }).toArray()).map((u) => [u._id, u]));
  const properties = new Map(
    (await col('properties').find({ _id: { $in: [...units.values()].map((u) => u.property_id) } }).toArray()).map((p) => [p._id, p]),
  );
  const agreements = agreementDocs.map((a): Record<string, any> => {
    const u = units.get(a.unit_id);
    const p = u ? properties.get(u.property_id) : undefined;
    return { ...a, id: a._id, unit_name: u?.name, property_id: p?._id ?? '', property_name: p?.name };
  });

  const held = await depositHeldByAgreement(agreements.map((a) => a.id));

  return {
    ...mapTenant(row),
    financials: financials.get(id)!,
    agreements: agreements.map((a) => ({
      id: a.id,
      status: a.status,
      isCurrent: a.start_date <= ctx.today && (a.status === 'active' || (a.ended_on && a.ended_on >= ctx.today)),
      unit: { id: a.unit_id, name: a.unit_name },
      property: { id: a.property_id, name: a.property_name },
      startDate: a.start_date,
      endDate: a.end_date ?? null,
      endedOn: a.ended_on ?? null,
      rentAmount: Number(a.rent_amount),
      billingCycle: a.billing_cycle,
      dueDay: a.due_day,
      gstApplicable: a.gst_applicable,
      gstRate: Number(a.gst_rate),
      securityDeposit: Number(a.security_deposit),
      depositHeld: held.get(a.id) ?? 0,
    })),
    openEntries: openEntries.map((e) => mapCharge(e, ctx.today)),
    recentPayments: payments.map((p) => ({
      id: p._id,
      amount: Number(p.amount),
      paidOn: p.paid_on,
      method: p.method,
      reference: p.reference ?? null,
      status: p.status,
      source: p.source,
    })),
  };
}

function toFields(input: Partial<TenantInput>) {
  const row: Record<string, unknown> = {};
  const map: Record<keyof TenantInput, string> = {
    name: 'name',
    phone: 'phone',
    email: 'email',
    businessName: 'business_name',
    gstin: 'gstin',
    idProofType: 'id_proof_type',
    idProofNumber: 'id_proof_number',
    address: 'address',
    emergencyContactName: 'emergency_contact_name',
    emergencyContactPhone: 'emergency_contact_phone',
    notes: 'notes',
    portalEnabled: 'portal_enabled',
  };
  for (const [key, column] of Object.entries(map)) {
    const value = input[key as keyof TenantInput];
    if (value !== undefined) row[column] = value;
  }
  return row;
}

function translateTenantError(error: unknown): never {
  if (isDuplicateKey(error)) {
    throw Errors.conflict('A tenant with this mobile number already exists.', [{ field: 'phone', message: 'Already exists' }]);
  }
  throw error;
}

async function findTenantRow(ctx: Ctx, id: string) {
  const row = await col('tenants').findOne({ _id: id, account_id: ctx.accountId });
  if (!row) throw Errors.notFound('Tenant');
  return row;
}

/** Fields for a new tenant document (shared with inline creation in agreements). */
export function newTenantDoc(accountId: string, input: TenantInput): Doc {
  const now = new Date();
  return {
    _id: newId(),
    account_id: accountId,
    email: null,
    business_name: null,
    gstin: null,
    id_proof_type: null,
    id_proof_number: null,
    address: null,
    emergency_contact_name: null,
    emergency_contact_phone: null,
    notes: null,
    portal_enabled: true,
    ...toFields(input),
    phone_key: input.phone,
    archived_at: null,
    created_at: now,
    updated_at: now,
  };
}

export async function createTenant(ctx: Ctx, input: TenantInput): Promise<TenantDetailDto> {
  let id: string;
  try {
    id = await withTransaction(async (session) => {
      const doc = newTenantDoc(ctx.accountId, input);
      await col('tenants').insertOne(doc, { session });
      await logActivity(session, ctx, { action: 'tenant.created', entityType: 'tenant', entityId: doc._id, summary: `Added tenant ${input.name}` });
      return doc._id;
    });
  } catch (error) {
    translateTenantError(error);
  }
  return getTenant(ctx, id);
}

export async function updateTenant(ctx: Ctx, id: string, input: Partial<TenantInput>): Promise<TenantDetailDto> {
  const tenant = await findTenantRow(ctx, id);
  const changes = toFields(input);
  if (input.phone !== undefined && !tenant.archived_at) changes.phone_key = input.phone;
  if (Object.keys(changes).length) {
    try {
      await withTransaction(async (session) => {
        await col('tenants').updateOne({ _id: id, account_id: ctx.accountId }, { $set: { ...changes, updated_at: new Date() } }, { session });
        await logActivity(session, ctx, { action: 'tenant.updated', entityType: 'tenant', entityId: id, summary: `Updated tenant ${input.name ?? tenant.name}` });
      });
    } catch (error) {
      translateTenantError(error);
    }
  }
  return getTenant(ctx, id);
}

export async function archiveTenant(ctx: Ctx, id: string): Promise<TenantDetailDto> {
  const tenant = await findTenantRow(ctx, id);
  const active = await col('agreements').findOne({ tenant_id: id, status: 'active' });
  if (active) throw Errors.conflict('End the active agreement of this tenant before archiving.');
  await withTransaction(async (session) => {
    const at = new Date();
    await col('tenants').updateOne({ _id: id }, { $set: { archived_at: at, updated_at: at }, $unset: { phone_key: '' } }, { session });
    await logActivity(session, ctx, { action: 'tenant.archived', entityType: 'tenant', entityId: id, summary: `Archived tenant ${tenant.name}` });
  });
  return getTenant(ctx, id);
}

export async function restoreTenant(ctx: Ctx, id: string): Promise<TenantDetailDto> {
  const tenant = await findTenantRow(ctx, id);
  try {
    await withTransaction(async (session) => {
      await col('tenants').updateOne({ _id: id }, { $set: { archived_at: null, phone_key: tenant.phone, updated_at: new Date() } }, { session });
      await logActivity(session, ctx, { action: 'tenant.restored', entityType: 'tenant', entityId: id, summary: `Restored tenant ${tenant.name}` });
    });
  } catch (error) {
    translateTenantError(error);
  }
  return getTenant(ctx, id);
}

export async function deleteTenant(ctx: Ctx, id: string): Promise<void> {
  const tenant = await findTenantRow(ctx, id);
  const agreement = await col('agreements').findOne({ tenant_id: id });
  const payment = await col('payments').findOne({ tenant_id: id });
  if (agreement || payment) {
    throw Errors.conflict('This tenant has agreements or payments. Archive the tenant instead of deleting.');
  }
  await withTransaction(async (session) => {
    await col('tenants').deleteOne({ _id: id, account_id: ctx.accountId }, { session });
    await logActivity(session, ctx, { action: 'tenant.deleted', entityType: 'tenant', entityId: id, summary: `Deleted tenant ${tenant.name}` });
  });
}

export interface StatementLine {
  date: string;
  type: 'charge' | 'payment';
  id: string;
  description: string;
  reference: string | null;
  debit: number;
  credit: number;
  balance: number;
}

export interface TenantStatement {
  tenant: { id: string; name: string; phone: string; businessName: string | null };
  from: string;
  to: string;
  openingBalance: number;
  totalCharges: number;
  totalPayments: number;
  closingBalance: number;
  lines: StatementLine[];
}

const METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  cheque: 'Cheque',
  card: 'Card',
  deposit: 'Security deposit adjustment',
  other: 'Other',
};

/**
 * Chronological account statement with a running balance
 * (charges by due date are debits, confirmed payments are credits).
 */
export async function getTenantStatement(ctx: Ctx, id: string, range: { from?: string; to?: string }): Promise<TenantStatement> {
  const tenant = await findTenantRow(ctx, id);
  const to = range.to ?? ctx.today;
  const from = range.from ?? startOfMonth(addMonths(to, -11));
  if (from > to) throw Errors.validation('"from" must be on or before "to".', [{ field: 'from', message: 'Invalid range' }]);

  const sumOf = async (name: 'rent_charges' | 'payments', match: Record<string, unknown>, field: string) => {
    const [r] = await col(name).aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: `$${field}` } } }]).toArray();
    return round2(r?.total ?? 0);
  };
  const openingBalance = subtractMoney(
    await sumOf('rent_charges', { tenant_id: id, account_id: ctx.accountId, voided_at: null, due_date: { $lt: from } }, 'total_amount'),
    await sumOf('payments', { tenant_id: id, account_id: ctx.accountId, status: 'confirmed', paid_on: { $lt: from } }, 'amount'),
  );

  const chargeDocs = await col('rent_charges')
    .find({ tenant_id: id, account_id: ctx.accountId, voided_at: null, due_date: { $gte: from, $lte: to } })
    .toArray();
  const unitNames = new Map(
    (await col('units').find({ _id: { $in: [...new Set(chargeDocs.map((c) => c.unit_id))] } }, { projection: { name: 1 } }).toArray()).map((u) => [
      u._id,
      u.name as string,
    ]),
  );
  const charges = chargeDocs.map((c) => ({ ...c, id: c._id, unit_name: unitNames.get(c.unit_id) }));
  const payments = (
    await col('payments').find({ tenant_id: id, account_id: ctx.accountId, status: 'confirmed', paid_on: { $gte: from, $lte: to } }).toArray()
  ).map((p) => ({ ...p, id: p._id }));

  const events = [
    ...charges.map((c) => ({
      date: c.due_date as string,
      order: 0,
      created: new Date(c.created_at).toISOString(),
      line: {
        type: 'charge' as const,
        id: c.id as string,
        description: `${c.unit_name} · ${c.kind === 'rent' ? `Rent ${periodLabelFor(c.kind, c.period_start, c.period_end)}` : c.description || periodLabelFor(c.kind, c.period_start, c.period_end)}`,
        reference: null,
        debit: Number(c.total_amount),
        credit: 0,
      },
    })),
    ...payments.map((p) => ({
      date: p.paid_on as string,
      order: 1,
      created: new Date(p.created_at).toISOString(),
      line: {
        type: 'payment' as const,
        id: p.id as string,
        description: `Payment received · ${METHOD_LABELS[p.method] ?? p.method}`,
        reference: p.reference ?? null,
        debit: 0,
        credit: Number(p.amount),
      },
    })),
  ].sort((a, b) => (a.date === b.date ? a.order - b.order || a.created.localeCompare(b.created) : a.date.localeCompare(b.date)));

  let balance = openingBalance;
  const lines: StatementLine[] = events.map((e) => {
    balance = round2(balance + e.line.debit - e.line.credit);
    return { date: e.date, ...e.line, balance };
  });

  const totalCharges = round2(charges.reduce((s, c) => s + Number(c.total_amount), 0));
  const totalPayments = round2(payments.reduce((s, p) => s + Number(p.amount), 0));
  return {
    tenant: { id: tenant._id, name: tenant.name, phone: tenant.phone, businessName: tenant.business_name ?? null },
    from,
    to,
    openingBalance,
    totalCharges,
    totalPayments,
    closingBalance: round2(openingBalance + totalCharges - totalPayments),
    lines,
  };
}
