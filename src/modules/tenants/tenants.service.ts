import { db } from '../../db/knex.js';
import type { Ctx } from '../../lib/context.js';
import { addMonths, startOfMonth } from '../../lib/dates.js';
import { Errors, isPgError, PG_ERRORS } from '../../lib/errors.js';
import { round2, subtractMoney } from '../../lib/money.js';
import { likePattern, resolveSort } from '../../lib/validation.js';
import { logActivity } from '../activity/activity.service.js';
import { allocationTotals, depositHeldByAgreement, tenantFinancials, type TenantFinancials } from '../finance/finance.queries.js';
import { chargeQuery, mapCharge, periodLabelFor, type RentEntryDto } from '../rents/charge-query.js';

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

function tenantListQuery(ctx: Ctx) {
  const dues = db('rent_charges as c')
    .leftJoin(allocationTotals(db, ctx.accountId).as('al'), 'al.charge_id', 'c.id')
    .where('c.account_id', ctx.accountId)
    .whereNull('c.voided_at')
    .select('c.tenant_id')
    .select(db.raw('SUM(c.total_amount - COALESCE(al.paid, 0)) AS outstanding'))
    .select(db.raw('SUM(CASE WHEN c.due_date < ?::date THEN c.total_amount - COALESCE(al.paid, 0) ELSE 0 END) AS overdue', [ctx.today]))
    .groupBy('c.tenant_id');

  return db('tenants as t')
    .leftJoin(dues.as('d'), 'd.tenant_id', 't.id')
    .where('t.account_id', ctx.accountId)
    .select(
      't.*',
      db.raw('COALESCE(d.outstanding, 0) AS outstanding'),
      db.raw('COALESCE(d.overdue, 0) AS overdue'),
      db.raw('EXISTS (SELECT 1 FROM users usr WHERE usr.phone = t.phone) AS has_app_account'),
      db.raw(
        `CASE
           WHEN EXISTS (SELECT 1 FROM agreements a WHERE a.tenant_id = t.id AND a.start_date <= ?::date AND (a.status = 'active' OR a.ended_on >= ?::date)) THEN 'active'
           WHEN EXISTS (SELECT 1 FROM agreements a WHERE a.tenant_id = t.id AND a.status = 'active' AND a.start_date > ?::date) THEN 'upcoming'
           WHEN EXISTS (SELECT 1 FROM agreements a WHERE a.tenant_id = t.id) THEN 'past'
           ELSE 'new'
         END AS status`,
        [ctx.today, ctx.today, ctx.today],
      ),
      db.raw(
        `COALESCE((
           SELECT json_agg(json_build_object(
                    'agreementId', a.id, 'unitId', u.id, 'unitName', u.name,
                    'propertyId', p.id, 'propertyName', p.name) ORDER BY lower(u.name))
             FROM agreements a
             JOIN units u ON u.id = a.unit_id
             JOIN properties p ON p.id = u.property_id
            WHERE a.tenant_id = t.id AND (a.status = 'active' OR a.ended_on >= ?::date)
         ), '[]'::json) AS units`,
        [ctx.today],
      ),
    );
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
    archived: r.archived_at !== null,
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
    { name: 'lower(x.name)', createdAt: 'x.created_at', outstanding: 'x.outstanding', overdue: 'x.overdue' },
    { column: 'lower(x.name)', direction: 'asc' },
  );

  const inner = tenantListQuery(ctx).modify((q) => {
    if (opts.archived) q.whereNotNull('t.archived_at');
    else q.whereNull('t.archived_at');
    if (opts.search) {
      const pattern = likePattern(opts.search);
      const digits = opts.search.replace(/\D/g, '');
      q.where((w) => {
        w.whereILike('t.name', pattern)
          .orWhereILike('t.business_name', pattern)
          .orWhereILike('t.email', pattern)
          .orWhereExists(
            db('agreements as sa')
              .join('units as su', 'su.id', 'sa.unit_id')
              .whereRaw('sa.tenant_id = t.id')
              .whereILike('su.name', pattern),
          );
        if (digits.length >= 3) w.orWhere('t.phone', 'like', `%${digits}%`);
      });
    }
  });

  const countRows = await db.from(inner.clone().as('x')).select('x.status').count({ count: '*' }).groupBy('x.status');
  const counts: Record<string, number> = { all: 0, active: 0, upcoming: 0, past: 0, new: 0 };
  for (const r of countRows as any[]) {
    counts[r.status] = Number(r.count);
    counts.all += Number(r.count);
  }

  const filtered = db.from(inner.as('x')).modify((q) => {
    if (opts.status && opts.status !== 'all') q.where('x.status', opts.status);
    if (opts.dues === 'any') q.where('x.outstanding', '>', 0);
    if (opts.dues === 'overdue') q.where('x.overdue', '>', 0);
  });
  const [{ count }] = await filtered.clone().count<{ count: number }[]>({ count: '*' });
  const rows = await filtered
    .select('x.*')
    .orderByRaw(`${sort.column} ${sort.direction}, x.id`)
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);
  return { items: rows.map(mapTenant), total: Number(count), counts };
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
  const row = await tenantListQuery(ctx).where('t.id', id).first();
  if (!row) throw Errors.notFound('Tenant');

  const [financials, agreements, openEntries, payments] = await Promise.all([
    tenantFinancials(db, ctx.accountId, [id], ctx.today),
    db('agreements as a')
      .join('units as u', 'u.id', 'a.unit_id')
      .join('properties as p', 'p.id', 'u.property_id')
      .where({ 'a.tenant_id': id, 'a.account_id': ctx.accountId })
      .orderBy([
        { column: 'a.status', order: 'asc' },
        { column: 'a.start_date', order: 'desc' },
      ])
      .select('a.*', 'u.name as unit_name', 'p.id as property_id', 'p.name as property_name'),
    db
      .from(chargeQuery(db, { accountId: ctx.accountId }, ctx.today).where('c.tenant_id', id).as('lc'))
      .whereIn('lc.status', ['overdue', 'pending', 'to_confirm'])
      .orderBy([
        { column: 'lc.due_date', order: 'asc' },
        { column: 'lc.period_start', order: 'asc' },
      ]),
    db('payments')
      .where({ tenant_id: id, account_id: ctx.accountId })
      .orderBy([
        { column: 'paid_on', order: 'desc' },
        { column: 'created_at', order: 'desc' },
      ])
      .limit(10),
  ]);

  const held = await depositHeldByAgreement(db, agreements.map((a) => a.id));

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
      endDate: a.end_date,
      endedOn: a.ended_on,
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
      id: p.id,
      amount: Number(p.amount),
      paidOn: p.paid_on,
      method: p.method,
      reference: p.reference,
      status: p.status,
      source: p.source,
    })),
  };
}

function toRow(input: Partial<TenantInput>) {
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
  if (isPgError(error) && error.code === PG_ERRORS.UNIQUE_VIOLATION) {
    throw Errors.conflict('A tenant with this mobile number already exists.', [{ field: 'phone', message: 'Already exists' }]);
  }
  throw error;
}

async function findTenantRow(ctx: Ctx, id: string) {
  const row = await db('tenants').where({ id, account_id: ctx.accountId }).first();
  if (!row) throw Errors.notFound('Tenant');
  return row;
}

export async function createTenant(ctx: Ctx, input: TenantInput): Promise<TenantDetailDto> {
  let id: string;
  try {
    id = await db.transaction(async (trx) => {
      const [row] = await trx('tenants').insert({ ...toRow(input), account_id: ctx.accountId }).returning(['id']);
      await logActivity(trx, ctx, { action: 'tenant.created', entityType: 'tenant', entityId: row.id, summary: `Added tenant ${input.name}` });
      return row.id as string;
    });
  } catch (error) {
    translateTenantError(error);
  }
  return getTenant(ctx, id);
}

export async function updateTenant(ctx: Ctx, id: string, input: Partial<TenantInput>): Promise<TenantDetailDto> {
  const tenant = await findTenantRow(ctx, id);
  const changes = toRow(input);
  if (Object.keys(changes).length) {
    try {
      await db.transaction(async (trx) => {
        await trx('tenants').where({ id, account_id: ctx.accountId }).update(changes);
        await logActivity(trx, ctx, { action: 'tenant.updated', entityType: 'tenant', entityId: id, summary: `Updated tenant ${input.name ?? tenant.name}` });
      });
    } catch (error) {
      translateTenantError(error);
    }
  }
  return getTenant(ctx, id);
}

export async function archiveTenant(ctx: Ctx, id: string): Promise<TenantDetailDto> {
  const tenant = await findTenantRow(ctx, id);
  const active = await db('agreements').where({ tenant_id: id, status: 'active' }).first('id');
  if (active) throw Errors.conflict('End the active agreement of this tenant before archiving.');
  await db.transaction(async (trx) => {
    await trx('tenants').where({ id }).update({ archived_at: new Date() });
    await logActivity(trx, ctx, { action: 'tenant.archived', entityType: 'tenant', entityId: id, summary: `Archived tenant ${tenant.name}` });
  });
  return getTenant(ctx, id);
}

export async function restoreTenant(ctx: Ctx, id: string): Promise<TenantDetailDto> {
  const tenant = await findTenantRow(ctx, id);
  try {
    await db.transaction(async (trx) => {
      await trx('tenants').where({ id }).update({ archived_at: null });
      await logActivity(trx, ctx, { action: 'tenant.restored', entityType: 'tenant', entityId: id, summary: `Restored tenant ${tenant.name}` });
    });
  } catch (error) {
    translateTenantError(error);
  }
  return getTenant(ctx, id);
}

export async function deleteTenant(ctx: Ctx, id: string): Promise<void> {
  const tenant = await findTenantRow(ctx, id);
  const agreement = await db('agreements').where({ tenant_id: id }).first('id');
  const payment = await db('payments').where({ tenant_id: id }).first('id');
  if (agreement || payment) {
    throw Errors.conflict('This tenant has agreements or payments. Archive the tenant instead of deleting.');
  }
  await db.transaction(async (trx) => {
    await trx('tenants').where({ id, account_id: ctx.accountId }).delete();
    await logActivity(trx, ctx, { action: 'tenant.deleted', entityType: 'tenant', entityId: id, summary: `Deleted tenant ${tenant.name}` });
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

  const [openCharges] = await db('rent_charges')
    .where({ tenant_id: id, account_id: ctx.accountId })
    .whereNull('voided_at')
    .where('due_date', '<', from)
    .sum({ total: 'total_amount' });
  const [openPayments] = await db('payments')
    .where({ tenant_id: id, account_id: ctx.accountId, status: 'confirmed' })
    .where('paid_on', '<', from)
    .sum({ total: 'amount' });
  const openingBalance = subtractMoney(Number(openCharges?.total ?? 0), Number(openPayments?.total ?? 0));

  const charges = await db('rent_charges as c')
    .join('units as u', 'u.id', 'c.unit_id')
    .where({ 'c.tenant_id': id, 'c.account_id': ctx.accountId })
    .whereNull('c.voided_at')
    .whereBetween('c.due_date', [from, to])
    .select('c.id', 'c.kind', 'c.description', 'c.period_start', 'c.period_end', 'c.due_date', 'c.total_amount', 'c.created_at', 'u.name as unit_name');
  const payments = await db('payments')
    .where({ tenant_id: id, account_id: ctx.accountId, status: 'confirmed' })
    .whereBetween('paid_on', [from, to])
    .select('id', 'amount', 'paid_on', 'method', 'reference', 'created_at');

  const events = [
    ...charges.map((c) => ({
      date: c.due_date as string,
      order: 0,
      created: String(c.created_at),
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
      created: String(p.created_at),
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
    tenant: { id: tenant.id, name: tenant.name, phone: tenant.phone, businessName: tenant.business_name },
    from,
    to,
    openingBalance,
    totalCharges,
    totalPayments,
    closingBalance: round2(openingBalance + totalCharges - totalPayments),
    lines,
  };
}
