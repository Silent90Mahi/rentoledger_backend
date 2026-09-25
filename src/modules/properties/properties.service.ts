import { db } from '../../db/knex.js';
import type { Ctx } from '../../lib/context.js';
import { startOfMonth, endOfMonth, addMonths, addDays } from '../../lib/dates.js';
import { Errors, isPgError, PG_ERRORS } from '../../lib/errors.js';
import { round2 } from '../../lib/money.js';
import { likePattern, resolveSort } from '../../lib/validation.js';
import { logActivity } from '../activity/activity.service.js';
import { collectedByProperty, duesByProperty, expectedByProperty, expensesByProperty } from '../finance/finance.queries.js';
import { mapUnit, unitsWithOccupancy, type UnitDto } from '../units/occupancy.js';

export const PROPERTY_TYPES = ['building', 'complex', 'house', 'shop', 'office', 'warehouse', 'land', 'other'] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

/** Unit type used when a single-unit property creates its own unit. */
const DEFAULT_UNIT_TYPE: Record<PropertyType, string> = {
  building: 'flat',
  complex: 'shop',
  house: 'house',
  shop: 'shop',
  office: 'office',
  warehouse: 'warehouse',
  land: 'land',
  other: 'other',
};

export interface PropertyInput {
  name: string;
  type: PropertyType;
  addressLine?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  notes?: string | null;
}

export interface PropertyStats {
  units: number;
  occupied: number;
  reserved: number;
  vacant: number;
  occupancyRate: number;
  monthlyRent: number;
  outstanding: number;
  overdue: number;
}

export interface PropertyDto {
  id: string;
  name: string;
  type: PropertyType;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  notes: string | null;
  archived: boolean;
  stats: PropertyStats;
  createdAt: string;
  updatedAt: string;
}

function emptyStats(): PropertyStats {
  return { units: 0, occupied: 0, reserved: 0, vacant: 0, occupancyRate: 0, monthlyRent: 0, outstanding: 0, overdue: 0 };
}

function mapProperty(r: Record<string, any>, stats: PropertyStats): PropertyDto {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    addressLine: r.address_line ?? null,
    city: r.city ?? null,
    state: r.state ?? null,
    pincode: r.pincode ?? null,
    notes: r.notes ?? null,
    archived: r.archived_at !== null,
    stats,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function statsFor(ctx: Ctx, propertyIds: string[]): Promise<Map<string, PropertyStats>> {
  const map = new Map<string, PropertyStats>(propertyIds.map((id) => [id, emptyStats()]));
  if (propertyIds.length === 0) return map;

  const units = await unitsWithOccupancy(db, ctx.accountId, ctx.today)
    .whereIn('u.property_id', propertyIds)
    .whereNull('u.archived_at');
  for (const row of units) {
    const unit = mapUnit(row, ctx.today);
    const s = map.get(unit.property.id)!;
    s.units += 1;
    if (unit.occupancy === 'occupied') {
      s.occupied += 1;
      s.monthlyRent = round2(s.monthlyRent + (unit.currentAgreement?.monthlyRent ?? 0));
    } else if (unit.occupancy === 'reserved') s.reserved += 1;
    else s.vacant += 1;
  }

  const dues = await duesByProperty(db, ctx.accountId, ctx.today);
  for (const [id, s] of map) {
    s.occupancyRate = s.units ? Math.round((s.occupied / s.units) * 1000) / 10 : 0;
    const d = dues.get(id);
    if (d) {
      s.outstanding = d.outstanding;
      s.overdue = d.overdue;
    }
  }
  return map;
}

export async function listProperties(
  ctx: Ctx,
  opts: { page: number; pageSize: number; search?: string; type?: PropertyType; sort?: string; archived?: boolean },
): Promise<{ items: PropertyDto[]; total: number }> {
  const sort = resolveSort(
    opts.sort,
    { name: 'p.name', createdAt: 'p.created_at', updatedAt: 'p.updated_at', type: 'p.type', city: 'p.city' },
    { column: 'p.name', direction: 'asc' },
  );

  const base = db('properties as p')
    .where('p.account_id', ctx.accountId)
    .modify((q) => {
      if (opts.archived) q.whereNotNull('p.archived_at');
      else q.whereNull('p.archived_at');
      if (opts.type) q.where('p.type', opts.type);
      if (opts.search) {
        const pattern = likePattern(opts.search);
        q.where((w) =>
          w
            .whereILike('p.name', pattern)
            .orWhereILike('p.city', pattern)
            .orWhereILike('p.address_line', pattern)
            .orWhereExists(
              db('units as su')
                .whereRaw('su.property_id = p.id')
                .whereNull('su.archived_at')
                .whereILike('su.name', pattern),
            ),
        );
      }
    });

  const [{ count }] = await base.clone().count<{ count: number }[]>({ count: '*' });
  const rows = await base
    .clone()
    .select('p.*')
    .orderByRaw(`${sort.column === 'p.name' ? 'lower(p.name)' : sort.column} ${sort.direction}, p.id`)
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);
  const stats = await statsFor(ctx, rows.map((r: Record<string, any>) => r.id as string));
  return { total: Number(count), items: rows.map((r: Record<string, any>) => mapProperty(r, stats.get(r.id)!)) };
}

async function findProperty(ctx: Ctx, id: string) {
  const row = await db('properties').where({ id, account_id: ctx.accountId }).first();
  if (!row) throw Errors.notFound('Property');
  return row;
}

export interface PropertyDetailDto extends PropertyDto {
  units: UnitDto[];
  financials: {
    thisMonth: { expected: number; collected: number; expenses: number; net: number };
    last12Months: { collected: number; expenses: number; net: number };
  };
}

export async function getProperty(ctx: Ctx, id: string): Promise<PropertyDetailDto> {
  const row = await findProperty(ctx, id);
  const stats = (await statsFor(ctx, [id])).get(id)!;
  const unitRows = await unitsWithOccupancy(db, ctx.accountId, ctx.today)
    .where('u.property_id', id)
    .orderByRaw('u.archived_at IS NOT NULL, lower(u.name)');

  const monthFrom = startOfMonth(ctx.today);
  const monthTo = endOfMonth(ctx.today);
  const yearFrom = addDays(addMonths(ctx.today, -12), 1);
  const [expMonth, colMonth, expenseMonth, colYear, expenseYear] = await Promise.all([
    expectedByProperty(db, ctx.accountId, monthFrom, monthTo),
    collectedByProperty(db, ctx.accountId, monthFrom, monthTo),
    expensesByProperty(db, ctx.accountId, monthFrom, monthTo),
    collectedByProperty(db, ctx.accountId, yearFrom, ctx.today),
    expensesByProperty(db, ctx.accountId, yearFrom, ctx.today),
  ]);

  const collectedMonth = colMonth.get(id) ?? 0;
  const expensesMonth = expenseMonth.get(id) ?? 0;
  const collected12 = colYear.get(id) ?? 0;
  const expenses12 = expenseYear.get(id) ?? 0;

  return {
    ...mapProperty(row, stats),
    units: unitRows.map((r: Record<string, any>) => mapUnit(r, ctx.today)),
    financials: {
      thisMonth: {
        expected: expMonth.get(id) ?? 0,
        collected: collectedMonth,
        expenses: expensesMonth,
        net: round2(collectedMonth - expensesMonth),
      },
      last12Months: { collected: collected12, expenses: expenses12, net: round2(collected12 - expenses12) },
    },
  };
}

function toRow(input: Partial<PropertyInput>) {
  const row: Record<string, unknown> = {};
  if (input.name !== undefined) row.name = input.name;
  if (input.type !== undefined) row.type = input.type;
  if (input.addressLine !== undefined) row.address_line = input.addressLine;
  if (input.city !== undefined) row.city = input.city;
  if (input.state !== undefined) row.state = input.state;
  if (input.pincode !== undefined) row.pincode = input.pincode;
  if (input.notes !== undefined) row.notes = input.notes;
  return row;
}

function translateUniqueError(error: unknown): never {
  if (isPgError(error) && error.code === PG_ERRORS.UNIQUE_VIOLATION) {
    if (error.constraint === 'units_property_name_key') {
      throw Errors.conflict('A unit with this name already exists in the property.', [{ field: 'unitName', message: 'Already exists' }]);
    }
    throw Errors.conflict('A property with this name already exists.', [{ field: 'name', message: 'Already exists' }]);
  }
  throw error;
}

export async function createProperty(
  ctx: Ctx,
  input: PropertyInput & { singleUnit?: { name?: string | null; type?: string | null; defaultRent?: number | null; areaSqft?: number | null } | null },
): Promise<PropertyDetailDto> {
  let id: string;
  try {
    id = await db.transaction(async (trx) => {
      const [row] = await trx('properties')
        .insert({ ...toRow(input), account_id: ctx.accountId })
        .returning(['id', 'name']);
      if (input.singleUnit) {
        await trx('units').insert({
          account_id: ctx.accountId,
          property_id: row.id,
          name: input.singleUnit.name?.trim() || input.name,
          type: input.singleUnit.type ?? DEFAULT_UNIT_TYPE[input.type],
          default_rent: input.singleUnit.defaultRent ?? null,
          area_sqft: input.singleUnit.areaSqft ?? null,
        });
      }
      await logActivity(trx, ctx, {
        action: 'property.created',
        entityType: 'property',
        entityId: row.id,
        summary: `Added property ${row.name}`,
      });
      return row.id as string;
    });
  } catch (error) {
    translateUniqueError(error);
  }
  return getProperty(ctx, id);
}

export async function updateProperty(ctx: Ctx, id: string, input: Partial<PropertyInput>): Promise<PropertyDetailDto> {
  const existing = await findProperty(ctx, id);
  const changes = toRow(input);
  if (Object.keys(changes).length > 0) {
    try {
      await db.transaction(async (trx) => {
        await trx('properties').where({ id, account_id: ctx.accountId }).update(changes);
        await logActivity(trx, ctx, {
          action: 'property.updated',
          entityType: 'property',
          entityId: id,
          summary: `Updated property ${input.name ?? existing.name}`,
        });
      });
    } catch (error) {
      translateUniqueError(error);
    }
  }
  return getProperty(ctx, id);
}

export async function archiveProperty(ctx: Ctx, id: string): Promise<PropertyDetailDto> {
  const property = await findProperty(ctx, id);
  if (property.archived_at) return getProperty(ctx, id);
  const active = await db('agreements as a')
    .join('units as u', 'u.id', 'a.unit_id')
    .where('u.property_id', id)
    .where('a.status', 'active')
    .first('a.id');
  if (active) throw Errors.conflict('End the active agreements of this property before archiving it.');

  await db.transaction(async (trx) => {
    const archivedAt = new Date();
    await trx('properties').where({ id }).update({ archived_at: archivedAt });
    await trx('units').where({ property_id: id }).whereNull('archived_at').update({ archived_at: archivedAt });
    await logActivity(trx, ctx, { action: 'property.archived', entityType: 'property', entityId: id, summary: `Archived property ${property.name}` });
  });
  return getProperty(ctx, id);
}

export async function restoreProperty(ctx: Ctx, id: string): Promise<PropertyDetailDto> {
  const property = await findProperty(ctx, id);
  if (!property.archived_at) return getProperty(ctx, id);
  try {
    await db.transaction(async (trx) => {
      await trx('units').where({ property_id: id, archived_at: property.archived_at }).update({ archived_at: null });
      await trx('properties').where({ id }).update({ archived_at: null });
      await logActivity(trx, ctx, { action: 'property.restored', entityType: 'property', entityId: id, summary: `Restored property ${property.name}` });
    });
  } catch (error) {
    translateUniqueError(error);
  }
  return getProperty(ctx, id);
}

export async function deleteProperty(ctx: Ctx, id: string): Promise<void> {
  const property = await findProperty(ctx, id);
  const history = await db('agreements as a')
    .join('units as u', 'u.id', 'a.unit_id')
    .where('u.property_id', id)
    .first('a.id');
  const expense = await db('expenses').where({ property_id: id }).first('id');
  if (history || expense) {
    throw Errors.conflict('This property has rental or expense history. Archive it instead of deleting.');
  }
  await db.transaction(async (trx) => {
    await trx('expenses').whereIn('unit_id', trx('units').select('id').where({ property_id: id })).update({ unit_id: null });
    await trx('units').where({ property_id: id }).delete();
    await trx('properties').where({ id, account_id: ctx.accountId }).delete();
    await logActivity(trx, ctx, { action: 'property.deleted', entityType: 'property', entityId: id, summary: `Deleted property ${property.name}` });
  });
}
