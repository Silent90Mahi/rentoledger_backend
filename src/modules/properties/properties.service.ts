import { isDuplicateKey, keys } from '../../db/indexes.js';
import { col, contains, newId, withTransaction, type Doc } from '../../db/mongo.js';
import type { Filter } from 'mongodb';
import type { Ctx } from '../../lib/context.js';
import { startOfMonth, endOfMonth, addMonths, addDays } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import { round2 } from '../../lib/money.js';
import { resolveSort } from '../../lib/validation.js';
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
    id: r._id ?? r.id,
    name: r.name,
    type: r.type,
    addressLine: r.address_line ?? null,
    city: r.city ?? null,
    state: r.state ?? null,
    pincode: r.pincode ?? null,
    notes: r.notes ?? null,
    archived: r.archived_at !== null && r.archived_at !== undefined,
    stats,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function statsFor(ctx: Ctx, propertyIds: string[]): Promise<Map<string, PropertyStats>> {
  const map = new Map<string, PropertyStats>(propertyIds.map((id) => [id, emptyStats()]));
  if (propertyIds.length === 0) return map;

  const units = await unitsWithOccupancy(ctx.accountId, ctx.today, { property_id: { $in: propertyIds }, archived_at: null });
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

  const dues = await duesByProperty(ctx.accountId, ctx.today);
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
    { name: 'name', createdAt: 'created_at', updatedAt: 'updated_at', type: 'type', city: 'city' },
    { column: 'name', direction: 'asc' },
  );

  const filter: Filter<Doc> = { account_id: ctx.accountId, archived_at: opts.archived ? { $ne: null } : null };
  if (opts.type) filter.type = opts.type;
  if (opts.search) {
    const pattern = contains(opts.search);
    const withUnit = await col('units').distinct('property_id', { account_id: ctx.accountId, archived_at: null, name: pattern });
    filter.$or = [{ name: pattern }, { city: pattern }, { address_line: pattern }, { _id: { $in: withUnit } }];
  }

  const direction = sort.direction === 'asc' ? 1 : -1;
  const [total, rows] = await Promise.all([
    col('properties').countDocuments(filter),
    col('properties')
      .find(filter)
      .collation({ locale: 'en', strength: 2 })
      .sort({ [sort.column]: direction, _id: 1 })
      .skip((opts.page - 1) * opts.pageSize)
      .limit(opts.pageSize)
      .toArray(),
  ]);
  const stats = await statsFor(ctx, rows.map((r) => r._id));
  return { total, items: rows.map((r) => mapProperty(r, stats.get(r._id)!)) };
}

async function findProperty(ctx: Ctx, id: string) {
  const row = await col('properties').findOne({ _id: id, account_id: ctx.accountId });
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
  const unitRows = (await unitsWithOccupancy(ctx.accountId, ctx.today, { property_id: id })).sort(
    (a, b) => Number(a.archived_at !== null) - Number(b.archived_at !== null) || String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base', numeric: true }),
  );

  const monthFrom = startOfMonth(ctx.today);
  const monthTo = endOfMonth(ctx.today);
  const yearFrom = addDays(addMonths(ctx.today, -12), 1);
  const [expMonth, colMonth, expenseMonth, colYear, expenseYear] = await Promise.all([
    expectedByProperty(ctx.accountId, monthFrom, monthTo),
    collectedByProperty(ctx.accountId, monthFrom, monthTo),
    expensesByProperty(ctx.accountId, monthFrom, monthTo),
    collectedByProperty(ctx.accountId, yearFrom, ctx.today),
    expensesByProperty(ctx.accountId, yearFrom, ctx.today),
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

function toFields(input: Partial<PropertyInput>) {
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
  if (isDuplicateKey(error, 'units_property_name_key')) {
    throw Errors.conflict('A unit with this name already exists in the property.', [{ field: 'unitName', message: 'Already exists' }]);
  }
  if (isDuplicateKey(error)) {
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
    id = await withTransaction(async (session) => {
      const now = new Date();
      const property = {
        _id: newId(),
        account_id: ctx.accountId,
        address_line: null,
        city: null,
        state: null,
        pincode: null,
        notes: null,
        ...toFields(input),
        name_key: keys.name(input.name),
        archived_at: null,
        created_at: now,
        updated_at: now,
      };
      await col('properties').insertOne(property as Doc, { session });
      if (input.singleUnit) {
        const unitName = input.singleUnit.name?.trim() || input.name;
        await col('units').insertOne(
          {
            _id: newId(),
            account_id: ctx.accountId,
            property_id: property._id,
            name: unitName,
            name_key: keys.name(unitName),
            type: input.singleUnit.type ?? DEFAULT_UNIT_TYPE[input.type],
            floor: null,
            default_rent: input.singleUnit.defaultRent ?? null,
            area_sqft: input.singleUnit.areaSqft ?? null,
            notes: null,
            archived_at: null,
            created_at: now,
            updated_at: now,
          },
          { session },
        );
      }
      await logActivity(session, ctx, {
        action: 'property.created',
        entityType: 'property',
        entityId: property._id,
        summary: `Added property ${input.name}`,
      });
      return property._id;
    });
  } catch (error) {
    translateUniqueError(error);
  }
  return getProperty(ctx, id);
}

export async function updateProperty(ctx: Ctx, id: string, input: Partial<PropertyInput>): Promise<PropertyDetailDto> {
  const existing = await findProperty(ctx, id);
  const changes = toFields(input);
  if (input.name !== undefined && !existing.archived_at) changes.name_key = keys.name(input.name);
  if (Object.keys(changes).length > 0) {
    try {
      await withTransaction(async (session) => {
        await col('properties').updateOne({ _id: id, account_id: ctx.accountId }, { $set: { ...changes, updated_at: new Date() } }, { session });
        await logActivity(session, ctx, {
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
  const unitIds = await col('units').distinct('_id', { property_id: id, account_id: ctx.accountId });
  const active = await col('agreements').findOne({ account_id: ctx.accountId, unit_id: { $in: unitIds }, status: 'active' });
  if (active) throw Errors.conflict('End the active agreements of this property before archiving it.');

  await withTransaction(async (session) => {
    const archivedAt = new Date();
    await col('properties').updateOne({ _id: id }, { $set: { archived_at: archivedAt, updated_at: archivedAt }, $unset: { name_key: '' } }, { session });
    await col('units').updateMany(
      { property_id: id, archived_at: null },
      { $set: { archived_at: archivedAt, updated_at: archivedAt }, $unset: { name_key: '' } },
      { session },
    );
    await logActivity(session, ctx, { action: 'property.archived', entityType: 'property', entityId: id, summary: `Archived property ${property.name}` });
  });
  return getProperty(ctx, id);
}

export async function restoreProperty(ctx: Ctx, id: string): Promise<PropertyDetailDto> {
  const property = await findProperty(ctx, id);
  if (!property.archived_at) return getProperty(ctx, id);
  try {
    await withTransaction(async (session) => {
      // Units archived together with the property come back with it.
      const units = await col('units').find({ property_id: id, archived_at: property.archived_at }, { session }).toArray();
      for (const unit of units) {
        await col('units').updateOne(
          { _id: unit._id },
          { $set: { archived_at: null, name_key: keys.name(unit.name), updated_at: new Date() } },
          { session },
        );
      }
      await col('properties').updateOne(
        { _id: id },
        { $set: { archived_at: null, name_key: keys.name(property.name), updated_at: new Date() } },
        { session },
      );
      await logActivity(session, ctx, { action: 'property.restored', entityType: 'property', entityId: id, summary: `Restored property ${property.name}` });
    });
  } catch (error) {
    translateUniqueError(error);
  }
  return getProperty(ctx, id);
}

export async function deleteProperty(ctx: Ctx, id: string): Promise<void> {
  const property = await findProperty(ctx, id);
  const unitIds = await col('units').distinct('_id', { property_id: id, account_id: ctx.accountId });
  const history = await col('agreements').findOne({ account_id: ctx.accountId, unit_id: { $in: unitIds } });
  const expense = await col('expenses').findOne({ account_id: ctx.accountId, property_id: id });
  if (history || expense) {
    throw Errors.conflict('This property has rental or expense history. Archive it instead of deleting.');
  }
  await withTransaction(async (session) => {
    await col('expenses').updateMany({ account_id: ctx.accountId, unit_id: { $in: unitIds } }, { $set: { unit_id: null } }, { session });
    await col('units').deleteMany({ property_id: id, account_id: ctx.accountId }, { session });
    await col('properties').deleteOne({ _id: id, account_id: ctx.accountId }, { session });
    await logActivity(session, ctx, { action: 'property.deleted', entityType: 'property', entityId: id, summary: `Deleted property ${property.name}` });
  });
}
