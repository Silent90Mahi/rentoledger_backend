import type { Document } from 'mongodb';
import { col, contains, newId, withTransaction } from '../../db/mongo.js';
import type { Ctx } from '../../lib/context.js';
import { Errors } from '../../lib/errors.js';
import { formatInr, round2 } from '../../lib/money.js';
import { resolveSort } from '../../lib/validation.js';
import { logActivity } from '../activity/activity.service.js';

export const EXPENSE_CATEGORIES = [
  'maintenance',
  'repairs',
  'property_tax',
  'utilities',
  'insurance',
  'salary',
  'society',
  'legal',
  'commission',
  'cleaning',
  'security',
  'loan_interest',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  maintenance: 'Maintenance',
  repairs: 'Repairs',
  property_tax: 'Property tax',
  utilities: 'Utilities',
  insurance: 'Insurance',
  salary: 'Staff salary',
  society: 'Society charges',
  legal: 'Legal & documentation',
  commission: 'Brokerage / commission',
  cleaning: 'Cleaning',
  security: 'Security',
  loan_interest: 'Loan interest',
  other: 'Other',
};

export interface ExpenseInput {
  category: ExpenseCategory;
  amount: number;
  expenseDate: string;
  propertyId?: string | null;
  unitId?: string | null;
  payee?: string | null;
  method?: string | null;
  reference?: string | null;
  notes?: string | null;
}

export interface ExpenseDto {
  id: string;
  category: ExpenseCategory;
  categoryLabel: string;
  amount: number;
  expenseDate: string;
  payee: string | null;
  method: string | null;
  reference: string | null;
  notes: string | null;
  property: { id: string; name: string } | null;
  unit: { id: string; name: string } | null;
  createdBy: { id: string; name: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

/** Expense documents with unit/property/creator names; the property falls back to the unit's property. */
function expenseStages(accountId: string, match: Document = {}): Document[] {
  return [
    { $match: { ...match, account_id: accountId } },
    { $lookup: { from: 'units', localField: 'unit_id', foreignField: '_id', pipeline: [{ $project: { name: 1, property_id: 1 } }], as: '_u' } },
    { $addFields: { _u: { $first: '$_u' } } },
    { $addFields: { resolved_property_id: { $ifNull: ['$property_id', '$_u.property_id'] } } },
    { $lookup: { from: 'properties', localField: 'resolved_property_id', foreignField: '_id', pipeline: [{ $project: { name: 1 } }], as: '_p' } },
    { $lookup: { from: 'users', localField: 'created_by', foreignField: '_id', pipeline: [{ $project: { name: 1 } }], as: '_cb' } },
    {
      $addFields: {
        id: '$_id',
        unit_name: '$_u.name',
        resolved_property_id: { $first: '$_p._id' },
        property_name: { $first: '$_p.name' },
        created_by_name: { $first: '$_cb.name' },
      },
    },
    { $project: { _u: 0, _p: 0, _cb: 0 } },
  ];
}

function mapExpense(r: Record<string, any>): ExpenseDto {
  return {
    id: r.id,
    category: r.category,
    categoryLabel: EXPENSE_CATEGORY_LABELS[r.category as ExpenseCategory] ?? r.category,
    amount: Number(r.amount),
    expenseDate: r.expense_date,
    payee: r.payee ?? null,
    method: r.method ?? null,
    reference: r.reference ?? null,
    notes: r.notes ?? null,
    property: r.resolved_property_id ? { id: r.resolved_property_id, name: r.property_name } : null,
    unit: r.unit_id ? { id: r.unit_id, name: r.unit_name } : null,
    createdBy: r.created_by ? { id: r.created_by, name: r.created_by_name ?? null } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listExpenses(
  ctx: Ctx,
  opts: {
    page: number;
    pageSize: number;
    search?: string;
    category?: ExpenseCategory;
    propertyId?: string;
    unitId?: string;
    from?: string;
    to?: string;
    sort?: string;
  },
): Promise<{
  items: ExpenseDto[];
  total: number;
  summary: { count: number; amount: number; byCategory: Array<{ category: ExpenseCategory; label: string; amount: number; count: number }> };
}> {
  const sort = resolveSort(
    opts.sort,
    { date: 'expense_date', amount: 'amount', createdAt: 'created_at', category: 'category' },
    { column: 'expense_date', direction: 'desc' },
  );
  const match: Document = {};
  if (opts.category) match.category = opts.category;
  if (opts.unitId) match.unit_id = opts.unitId;
  if (opts.from || opts.to) match.expense_date = { ...(opts.from ? { $gte: opts.from } : {}), ...(opts.to ? { $lte: opts.to } : {}) };

  const pipeline = expenseStages(ctx.accountId, match);
  if (opts.propertyId) pipeline.push({ $match: { resolved_property_id: opts.propertyId } });
  if (opts.search) {
    const pattern = contains(opts.search);
    pipeline.push({ $match: { $or: [{ payee: pattern }, { notes: pattern }, { reference: pattern }, { property_name: pattern }] } });
  }

  const [result] = await col('expenses')
    .aggregate([
      ...pipeline,
      {
        $facet: {
          byCategory: [{ $group: { _id: '$category', amount: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { amount: -1 } }],
          rows: [
            { $sort: { [sort.column]: sort.direction === 'asc' ? 1 : -1, created_at: -1, _id: 1 } },
            { $skip: (opts.page - 1) * opts.pageSize },
            { $limit: opts.pageSize },
          ],
        },
      },
    ])
    .toArray();
  const byCategory = result.byCategory as Array<{ _id: ExpenseCategory; amount: number; count: number }>;
  const count = byCategory.reduce((s, r) => s + r.count, 0);
  const amount = byCategory.reduce((s, r) => s + r.amount, 0);

  return {
    items: result.rows.map(mapExpense),
    total: count,
    summary: {
      count,
      amount: round2(amount),
      byCategory: byCategory.map((r) => ({
        category: r._id,
        label: EXPENSE_CATEGORY_LABELS[r._id] ?? r._id,
        amount: round2(r.amount),
        count: r.count,
      })),
    },
  };
}

export async function getExpense(ctx: Ctx, id: string): Promise<ExpenseDto> {
  const [row] = await col('expenses').aggregate(expenseStages(ctx.accountId, { _id: id })).toArray();
  if (!row) throw Errors.notFound('Expense');
  return mapExpense(row);
}

async function resolveLocation(ctx: Ctx, propertyId?: string | null, unitId?: string | null) {
  let resolvedProperty = propertyId ?? null;
  if (unitId) {
    const unit = await col('units').findOne({ _id: unitId, account_id: ctx.accountId }, { projection: { property_id: 1 } });
    if (!unit) throw Errors.validation('Unit not found.', [{ field: 'unitId', message: 'Unit not found' }]);
    if (resolvedProperty && resolvedProperty !== unit.property_id) {
      throw Errors.validation('The unit does not belong to the selected property.', [{ field: 'unitId', message: 'Wrong property' }]);
    }
    resolvedProperty = unit.property_id;
  }
  if (resolvedProperty) {
    const property = await col('properties').findOne({ _id: resolvedProperty, account_id: ctx.accountId }, { projection: { _id: 1 } });
    if (!property) throw Errors.validation('Property not found.', [{ field: 'propertyId', message: 'Property not found' }]);
  }
  return { propertyId: resolvedProperty, unitId: unitId ?? null };
}

export async function createExpense(ctx: Ctx, input: ExpenseInput): Promise<ExpenseDto> {
  const location = await resolveLocation(ctx, input.propertyId, input.unitId);
  const id = await withTransaction(async (session) => {
    const expenseId = newId();
    const now = new Date();
    await col('expenses').insertOne(
      {
        _id: expenseId,
        account_id: ctx.accountId,
        property_id: location.propertyId,
        unit_id: location.unitId,
        category: input.category,
        amount: input.amount,
        expense_date: input.expenseDate,
        payee: input.payee ?? null,
        method: input.method ?? null,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        created_by: ctx.userId,
        created_at: now,
        updated_at: now,
      },
      { session },
    );
    await logActivity(session, ctx, {
      action: 'expense.created',
      entityType: 'expense',
      entityId: expenseId,
      summary: `Added ${EXPENSE_CATEGORY_LABELS[input.category].toLowerCase()} expense of ${formatInr(input.amount)}${input.payee ? ` to ${input.payee}` : ''}`,
    });
    return expenseId;
  });
  return getExpense(ctx, id);
}

export async function updateExpense(ctx: Ctx, id: string, input: Partial<ExpenseInput>): Promise<ExpenseDto> {
  const existing = await col('expenses').findOne({ _id: id, account_id: ctx.accountId });
  if (!existing) throw Errors.notFound('Expense');
  const changes: Record<string, unknown> = {};
  if (input.propertyId !== undefined || input.unitId !== undefined) {
    const location = await resolveLocation(
      ctx,
      input.propertyId !== undefined ? input.propertyId : existing.property_id,
      input.unitId !== undefined ? input.unitId : existing.unit_id,
    );
    changes.property_id = location.propertyId;
    changes.unit_id = location.unitId;
  }
  if (input.category !== undefined) changes.category = input.category;
  if (input.amount !== undefined) changes.amount = input.amount;
  if (input.expenseDate !== undefined) changes.expense_date = input.expenseDate;
  if (input.payee !== undefined) changes.payee = input.payee;
  if (input.method !== undefined) changes.method = input.method;
  if (input.reference !== undefined) changes.reference = input.reference;
  if (input.notes !== undefined) changes.notes = input.notes;
  if (Object.keys(changes).length) {
    await withTransaction(async (session) => {
      await col('expenses').updateOne({ _id: id }, { $set: { ...changes, updated_at: new Date() } }, { session });
      await logActivity(session, ctx, {
        action: 'expense.updated',
        entityType: 'expense',
        entityId: id,
        summary: `Updated an expense of ${formatInr(Number(input.amount ?? existing.amount))}`,
      });
    });
  }
  return getExpense(ctx, id);
}

export async function deleteExpense(ctx: Ctx, id: string): Promise<void> {
  const existing = await col('expenses').findOne({ _id: id, account_id: ctx.accountId });
  if (!existing) throw Errors.notFound('Expense');
  await withTransaction(async (session) => {
    await col('expenses').deleteOne({ _id: id }, { session });
    await logActivity(session, ctx, {
      action: 'expense.deleted',
      entityType: 'expense',
      entityId: id,
      summary: `Deleted ${EXPENSE_CATEGORY_LABELS[existing.category as ExpenseCategory].toLowerCase()} expense of ${formatInr(Number(existing.amount))}`,
    });
  });
}
