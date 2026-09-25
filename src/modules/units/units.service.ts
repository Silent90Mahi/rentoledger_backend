import { db } from '../../db/knex.js';
import type { Ctx } from '../../lib/context.js';
import { Errors, isPgError, PG_ERRORS } from '../../lib/errors.js';
import { likePattern, resolveSort } from '../../lib/validation.js';
import { logActivity } from '../activity/activity.service.js';
import { allocationTotals } from '../finance/finance.queries.js';
import { chargeQuery, mapCharge, type RentEntryDto } from '../rents/charge-query.js';
import { mapUnit, unitsWithOccupancy, type Occupancy, type UnitDto } from './occupancy.js';

export const UNIT_TYPES = ['shop', 'office', 'flat', 'house', 'room', 'warehouse', 'floor', 'land', 'other'] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export interface UnitInput {
  propertyId: string;
  name: string;
  type: UnitType;
  floor?: string | null;
  areaSqft?: number | null;
  defaultRent?: number | null;
  notes?: string | null;
}

export async function listUnits(
  ctx: Ctx,
  opts: {
    page: number;
    pageSize: number;
    search?: string;
    propertyId?: string;
    occupancy?: Occupancy;
    type?: UnitType;
    sort?: string;
    archived?: boolean;
  },
): Promise<{ items: UnitDto[]; total: number; counts: Record<Occupancy | 'all', number> }> {
  const sort = resolveSort(
    opts.sort,
    { name: 'lower(x.name)', rent: 'x.ca_rent_amount', createdAt: 'x.created_at', property: 'lower(x.property_name)', dueDay: 'x.ca_due_day' },
    { column: 'lower(x.name)', direction: 'asc' },
  );

  const inner = unitsWithOccupancy(db, ctx.accountId, ctx.today).modify((q) => {
    if (opts.archived) q.whereNotNull('u.archived_at');
    else q.whereNull('u.archived_at');
    if (opts.propertyId) q.where('u.property_id', opts.propertyId);
    if (opts.type) q.where('u.type', opts.type);
    if (opts.search) {
      const pattern = likePattern(opts.search);
      q.where((w) =>
        w
          .whereILike('u.name', pattern)
          .orWhereILike('p.name', pattern)
          .orWhereILike('ct.name', pattern)
          .orWhereILike('ct.phone', pattern)
          .orWhereILike('ct.business_name', pattern),
      );
    }
  });

  const countsRows = await db
    .from(inner.clone().as('x'))
    .select('x.occupancy')
    .count({ count: '*' })
    .groupBy('x.occupancy');
  const counts: Record<Occupancy | 'all', number> = { all: 0, occupied: 0, vacant: 0, reserved: 0 };
  for (const r of countsRows as any[]) {
    counts[r.occupancy as Occupancy] = Number(r.count);
    counts.all += Number(r.count);
  }

  const filtered = db.from(inner.as('x')).modify((q) => {
    if (opts.occupancy) q.where('x.occupancy', opts.occupancy);
  });
  const total = opts.occupancy ? counts[opts.occupancy] : counts.all;
  const rows = await filtered
    .select('x.*')
    .orderByRaw(`${sort.column} ${sort.direction} NULLS LAST, x.id`)
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);
  return { items: rows.map((r: Record<string, any>) => mapUnit(r, ctx.today)), total, counts };
}

async function findUnitRow(ctx: Ctx, id: string) {
  const row = await db('units').where({ id, account_id: ctx.accountId }).first();
  if (!row) throw Errors.notFound('Unit');
  return row;
}

export interface UnitAgreementSummary {
  id: string;
  status: 'active' | 'ended';
  tenant: { id: string; name: string; phone: string };
  startDate: string;
  endDate: string | null;
  endedOn: string | null;
  rentAmount: number;
  billingCycle: string;
  dueDay: number;
}

export interface UnitDetailDto extends UnitDto {
  agreements: UnitAgreementSummary[];
  recentEntries: RentEntryDto[];
  financials: { outstanding: number; overdue: number; collectedTotal: number };
}

export async function getUnit(ctx: Ctx, id: string): Promise<UnitDetailDto> {
  const row = await unitsWithOccupancy(db, ctx.accountId, ctx.today).where('u.id', id).first();
  if (!row) throw Errors.notFound('Unit');

  const agreements = await db('agreements as a')
    .join('tenants as t', 't.id', 'a.tenant_id')
    .where({ 'a.unit_id': id, 'a.account_id': ctx.accountId })
    .orderBy('a.start_date', 'desc')
    .select('a.*', 't.name as tenant_name', 't.phone as tenant_phone');

  const entries = await db
    .from(chargeQuery(db, { accountId: ctx.accountId }, ctx.today).where('c.unit_id', id).as('lc'))
    .whereNot('lc.status', 'void')
    .orderBy([
      { column: 'lc.period_start', order: 'desc' },
      { column: 'lc.created_at', order: 'desc' },
    ])
    .limit(6);

  const [fin] = await db('rent_charges as c')
    .leftJoin(allocationTotals(db, ctx.accountId).as('al'), 'al.charge_id', 'c.id')
    .where({ 'c.unit_id': id, 'c.account_id': ctx.accountId })
    .whereNull('c.voided_at')
    .select(db.raw('COALESCE(SUM(c.total_amount - COALESCE(al.paid, 0)), 0) AS outstanding'))
    .select(db.raw('COALESCE(SUM(CASE WHEN c.due_date < ?::date THEN c.total_amount - COALESCE(al.paid, 0) ELSE 0 END), 0) AS overdue', [ctx.today]))
    .select(db.raw('COALESCE(SUM(COALESCE(al.paid, 0)), 0) AS collected'));

  return {
    ...mapUnit(row, ctx.today),
    agreements: agreements.map((a) => ({
      id: a.id,
      status: a.status,
      tenant: { id: a.tenant_id, name: a.tenant_name, phone: a.tenant_phone },
      startDate: a.start_date,
      endDate: a.end_date,
      endedOn: a.ended_on,
      rentAmount: Number(a.rent_amount),
      billingCycle: a.billing_cycle,
      dueDay: a.due_day,
    })),
    recentEntries: entries.map((e) => mapCharge(e, ctx.today)),
    financials: {
      outstanding: Number(fin?.outstanding ?? 0),
      overdue: Number(fin?.overdue ?? 0),
      collectedTotal: Number(fin?.collected ?? 0),
    },
  };
}

function toRow(input: Partial<UnitInput>) {
  const row: Record<string, unknown> = {};
  if (input.propertyId !== undefined) row.property_id = input.propertyId;
  if (input.name !== undefined) row.name = input.name;
  if (input.type !== undefined) row.type = input.type;
  if (input.floor !== undefined) row.floor = input.floor;
  if (input.areaSqft !== undefined) row.area_sqft = input.areaSqft;
  if (input.defaultRent !== undefined) row.default_rent = input.defaultRent;
  if (input.notes !== undefined) row.notes = input.notes;
  return row;
}

function translateUnitError(error: unknown): never {
  if (isPgError(error) && error.code === PG_ERRORS.UNIQUE_VIOLATION) {
    throw Errors.conflict('A unit with this name already exists in this property.', [{ field: 'name', message: 'Already exists' }]);
  }
  throw error;
}

async function assertPropertyUsable(ctx: Ctx, propertyId: string) {
  const property = await db('properties').where({ id: propertyId, account_id: ctx.accountId }).first();
  if (!property) throw Errors.validation('Property not found.', [{ field: 'propertyId', message: 'Property not found' }]);
  if (property.archived_at) throw Errors.conflict('This property is archived. Restore it before adding units.');
  return property;
}

export async function createUnit(ctx: Ctx, input: UnitInput): Promise<UnitDetailDto> {
  const property = await assertPropertyUsable(ctx, input.propertyId);
  let id: string;
  try {
    id = await db.transaction(async (trx) => {
      const [row] = await trx('units').insert({ ...toRow(input), account_id: ctx.accountId }).returning(['id']);
      await logActivity(trx, ctx, {
        action: 'unit.created',
        entityType: 'unit',
        entityId: row.id,
        summary: `Added unit ${input.name} in ${property.name}`,
      });
      return row.id as string;
    });
  } catch (error) {
    translateUnitError(error);
  }
  return getUnit(ctx, id);
}

export async function updateUnit(ctx: Ctx, id: string, input: Partial<UnitInput>): Promise<UnitDetailDto> {
  const unit = await findUnitRow(ctx, id);
  if (input.propertyId && input.propertyId !== unit.property_id) {
    await assertPropertyUsable(ctx, input.propertyId);
  }
  const changes = toRow(input);
  if (Object.keys(changes).length) {
    try {
      await db.transaction(async (trx) => {
        await trx('units').where({ id, account_id: ctx.accountId }).update(changes);
        await logActivity(trx, ctx, { action: 'unit.updated', entityType: 'unit', entityId: id, summary: `Updated unit ${input.name ?? unit.name}` });
      });
    } catch (error) {
      translateUnitError(error);
    }
  }
  return getUnit(ctx, id);
}

export async function archiveUnit(ctx: Ctx, id: string): Promise<UnitDetailDto> {
  const unit = await findUnitRow(ctx, id);
  const active = await db('agreements').where({ unit_id: id, status: 'active' }).first('id');
  if (active) throw Errors.conflict('End the active agreement of this unit before archiving it.');
  await db.transaction(async (trx) => {
    await trx('units').where({ id }).update({ archived_at: new Date() });
    await logActivity(trx, ctx, { action: 'unit.archived', entityType: 'unit', entityId: id, summary: `Archived unit ${unit.name}` });
  });
  return getUnit(ctx, id);
}

export async function restoreUnit(ctx: Ctx, id: string): Promise<UnitDetailDto> {
  const unit = await findUnitRow(ctx, id);
  const property = await db('properties').where({ id: unit.property_id }).first();
  if (property?.archived_at) throw Errors.conflict('Restore the property first.');
  try {
    await db.transaction(async (trx) => {
      await trx('units').where({ id }).update({ archived_at: null });
      await logActivity(trx, ctx, { action: 'unit.restored', entityType: 'unit', entityId: id, summary: `Restored unit ${unit.name}` });
    });
  } catch (error) {
    translateUnitError(error);
  }
  return getUnit(ctx, id);
}

export async function deleteUnit(ctx: Ctx, id: string): Promise<void> {
  const unit = await findUnitRow(ctx, id);
  const history = await db('agreements').where({ unit_id: id }).first('id');
  if (history) throw Errors.conflict('This unit has rental history. Archive it instead of deleting.');
  await db.transaction(async (trx) => {
    await trx('expenses').where({ unit_id: id }).update({ unit_id: null });
    await trx('units').where({ id, account_id: ctx.accountId }).delete();
    await logActivity(trx, ctx, { action: 'unit.deleted', entityType: 'unit', entityId: id, summary: `Deleted unit ${unit.name}` });
  });
}
