import { isDuplicateKey, keys } from '../../db/indexes.js';
import { $round2, col, newId, withTransaction } from '../../db/mongo.js';
import type { Ctx } from '../../lib/context.js';
import { Errors } from '../../lib/errors.js';
import { round2 } from '../../lib/money.js';
import { compareRows, resolveSort } from '../../lib/validation.js';
import { logActivity } from '../activity/activity.service.js';
import { chargeStatusStages, findCharges, mapCharge, type RentEntryDto } from '../rents/charge-query.js';
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
    { name: 'name', rent: 'ca_rent_amount', createdAt: 'created_at', property: 'property_name', dueDay: 'ca_due_day' },
    { column: 'name', direction: 'asc' },
  );

  let rows = await unitsWithOccupancy(ctx.accountId, ctx.today, {
    archived_at: opts.archived ? { $ne: null } : null,
    ...(opts.propertyId ? { property_id: opts.propertyId } : {}),
    ...(opts.type ? { type: opts.type } : {}),
  });
  if (opts.search) {
    const needle = opts.search.toLowerCase();
    rows = rows.filter((r) =>
      [r.name, r.property_name, r.ct_name, r.ct_phone, r.ct_business_name].some((v) => typeof v === 'string' && v.toLowerCase().includes(needle)),
    );
  }

  const counts: Record<Occupancy | 'all', number> = { all: 0, occupied: 0, vacant: 0, reserved: 0 };
  for (const r of rows) {
    counts[r.occupancy as Occupancy] += 1;
    counts.all += 1;
  }

  const filtered = opts.occupancy ? rows.filter((r) => r.occupancy === opts.occupancy) : rows;
  const total = filtered.length;
  filtered.sort((a, b) => compareRows(a, b, sort.column, sort.direction));
  const page = filtered.slice((opts.page - 1) * opts.pageSize, opts.page * opts.pageSize);
  return { items: page.map((r) => mapUnit(r, ctx.today)), total, counts };
}

async function findUnitRow(ctx: Ctx, id: string) {
  const row = await col('units').findOne({ _id: id, account_id: ctx.accountId });
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
  const [row] = await unitsWithOccupancy(ctx.accountId, ctx.today, { _id: id });
  if (!row) throw Errors.notFound('Unit');

  const agreementDocs = await col('agreements').find({ unit_id: id, account_id: ctx.accountId }).sort({ start_date: -1 }).toArray();
  const tenants = new Map(
    (await col('tenants').find({ _id: { $in: agreementDocs.map((a) => a.tenant_id) } }).toArray()).map((t) => [t._id, t]),
  );
  const agreements = agreementDocs.map((a) => ({
    ...a,
    id: a._id,
    tenant_name: tenants.get(a.tenant_id)?.name,
    tenant_phone: tenants.get(a.tenant_id)?.phone,
  }));

  const entries = await findCharges({ accountId: ctx.accountId }, ctx.today, { unit_id: id, voided_at: null }, {
    sort: { period_start: -1, created_at: -1 },
    limit: 6,
  });

  const [fin] = await col('rent_charges')
    .aggregate([
      ...chargeStatusStages({ accountId: ctx.accountId }, ctx.today, { unit_id: id, voided_at: null }),
      {
        $group: {
          _id: null,
          outstanding: { $sum: '$balance' },
          overdue: { $sum: { $cond: [{ $lt: ['$due_date', ctx.today] }, '$balance', 0] } },
          collected: { $sum: '$paid_amount' },
        },
      },
      { $project: { outstanding: $round2('$outstanding'), overdue: $round2('$overdue'), collected: $round2('$collected') } },
    ])
    .toArray();

  return {
    ...mapUnit(row, ctx.today),
    agreements: agreements.map((a) => ({
      id: a.id,
      status: a.status,
      tenant: { id: a.tenant_id, name: a.tenant_name, phone: a.tenant_phone },
      startDate: a.start_date,
      endDate: a.end_date ?? null,
      endedOn: a.ended_on ?? null,
      rentAmount: Number(a.rent_amount),
      billingCycle: a.billing_cycle,
      dueDay: a.due_day,
    })),
    recentEntries: entries.map((e) => mapCharge(e, ctx.today)),
    financials: {
      outstanding: round2(fin?.outstanding ?? 0),
      overdue: round2(fin?.overdue ?? 0),
      collectedTotal: round2(fin?.collected ?? 0),
    },
  };
}

function toFields(input: Partial<UnitInput>) {
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
  if (isDuplicateKey(error)) {
    throw Errors.conflict('A unit with this name already exists in this property.', [{ field: 'name', message: 'Already exists' }]);
  }
  throw error;
}

async function assertPropertyUsable(ctx: Ctx, propertyId: string) {
  const property = await col('properties').findOne({ _id: propertyId, account_id: ctx.accountId });
  if (!property) throw Errors.validation('Property not found.', [{ field: 'propertyId', message: 'Property not found' }]);
  if (property.archived_at) throw Errors.conflict('This property is archived. Restore it before adding units.');
  return property;
}

export async function createUnit(ctx: Ctx, input: UnitInput): Promise<UnitDetailDto> {
  const property = await assertPropertyUsable(ctx, input.propertyId);
  let id: string;
  try {
    id = await withTransaction(async (session) => {
      const now = new Date();
      const unitId = newId();
      await col('units').insertOne(
        {
          _id: unitId,
          account_id: ctx.accountId,
          floor: null,
          area_sqft: null,
          default_rent: null,
          notes: null,
          ...toFields(input),
          name_key: keys.name(input.name),
          archived_at: null,
          created_at: now,
          updated_at: now,
        },
        { session },
      );
      await logActivity(session, ctx, {
        action: 'unit.created',
        entityType: 'unit',
        entityId: unitId,
        summary: `Added unit ${input.name} in ${property.name}`,
      });
      return unitId;
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
  const changes = toFields(input);
  if (input.name !== undefined && !unit.archived_at) changes.name_key = keys.name(input.name);
  if (Object.keys(changes).length) {
    try {
      await withTransaction(async (session) => {
        await col('units').updateOne({ _id: id, account_id: ctx.accountId }, { $set: { ...changes, updated_at: new Date() } }, { session });
        await logActivity(session, ctx, { action: 'unit.updated', entityType: 'unit', entityId: id, summary: `Updated unit ${input.name ?? unit.name}` });
      });
    } catch (error) {
      translateUnitError(error);
    }
  }
  return getUnit(ctx, id);
}

export async function archiveUnit(ctx: Ctx, id: string): Promise<UnitDetailDto> {
  const unit = await findUnitRow(ctx, id);
  const active = await col('agreements').findOne({ unit_id: id, status: 'active' });
  if (active) throw Errors.conflict('End the active agreement of this unit before archiving it.');
  await withTransaction(async (session) => {
    const at = new Date();
    await col('units').updateOne({ _id: id }, { $set: { archived_at: at, updated_at: at }, $unset: { name_key: '' } }, { session });
    await logActivity(session, ctx, { action: 'unit.archived', entityType: 'unit', entityId: id, summary: `Archived unit ${unit.name}` });
  });
  return getUnit(ctx, id);
}

export async function restoreUnit(ctx: Ctx, id: string): Promise<UnitDetailDto> {
  const unit = await findUnitRow(ctx, id);
  const property = await col('properties').findOne({ _id: unit.property_id });
  if (property?.archived_at) throw Errors.conflict('Restore the property first.');
  try {
    await withTransaction(async (session) => {
      await col('units').updateOne({ _id: id }, { $set: { archived_at: null, name_key: keys.name(unit.name), updated_at: new Date() } }, { session });
      await logActivity(session, ctx, { action: 'unit.restored', entityType: 'unit', entityId: id, summary: `Restored unit ${unit.name}` });
    });
  } catch (error) {
    translateUnitError(error);
  }
  return getUnit(ctx, id);
}

export async function deleteUnit(ctx: Ctx, id: string): Promise<void> {
  const unit = await findUnitRow(ctx, id);
  const history = await col('agreements').findOne({ unit_id: id });
  if (history) throw Errors.conflict('This unit has rental history. Archive it instead of deleting.');
  await withTransaction(async (session) => {
    await col('expenses').updateMany({ account_id: ctx.accountId, unit_id: id }, { $set: { unit_id: null } }, { session });
    await col('units').deleteOne({ _id: id, account_id: ctx.accountId }, { session });
    await logActivity(session, ctx, { action: 'unit.deleted', entityType: 'unit', entityId: id, summary: `Deleted unit ${unit.name}` });
  });
}
