import { db } from '../../db/knex.js';
import type { Ctx } from '../../lib/context.js';
import { Errors } from '../../lib/errors.js';
import { formatInr } from '../../lib/money.js';
import { likePattern, resolveSort } from '../../lib/validation.js';
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

function expenseQuery(ctx: Ctx) {
  return db('expenses as e')
    .leftJoin('units as u', 'u.id', 'e.unit_id')
    .leftJoin('properties as p', 'p.id', db.raw('COALESCE(e.property_id, u.property_id)'))
    .leftJoin('users as cb', 'cb.id', 'e.created_by')
    .where('e.account_id', ctx.accountId)
    .select('e.*', 'u.name as unit_name', 'p.id as resolved_property_id', 'p.name as property_name', 'cb.name as created_by_name');
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
    { date: 'e.expense_date', amount: 'e.amount', createdAt: 'e.created_at', category: 'e.category' },
    { column: 'e.expense_date', direction: 'desc' },
  );
  const base = expenseQuery(ctx).modify((q) => {
    if (opts.category) q.where('e.category', opts.category);
    if (opts.propertyId) q.where('p.id', opts.propertyId);
    if (opts.unitId) q.where('e.unit_id', opts.unitId);
    if (opts.from) q.where('e.expense_date', '>=', opts.from);
    if (opts.to) q.where('e.expense_date', '<=', opts.to);
    if (opts.search) {
      const pattern = likePattern(opts.search);
      q.where((w) => w.whereILike('e.payee', pattern).orWhereILike('e.notes', pattern).orWhereILike('e.reference', pattern).orWhereILike('p.name', pattern));
    }
  });

  const byCategory = await db
    .from(base.clone().as('x'))
    .select('x.category')
    .sum({ amount: 'x.amount' })
    .count({ count: '*' })
    .groupBy('x.category')
    .orderBy('amount', 'desc');
  const count = byCategory.reduce((s: number, r: any) => s + Number(r.count), 0);
  const amount = byCategory.reduce((s: number, r: any) => s + Number(r.amount), 0);

  const rows = await base
    .orderByRaw(`${sort.column} ${sort.direction}, e.created_at DESC, e.id`)
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);

  return {
    items: rows.map(mapExpense),
    total: count,
    summary: {
      count,
      amount: Math.round(amount * 100) / 100,
      byCategory: byCategory.map((r: any) => ({
        category: r.category,
        label: EXPENSE_CATEGORY_LABELS[r.category as ExpenseCategory] ?? r.category,
        amount: Number(r.amount),
        count: Number(r.count),
      })),
    },
  };
}

export async function getExpense(ctx: Ctx, id: string): Promise<ExpenseDto> {
  const row = await expenseQuery(ctx).where('e.id', id).first();
  if (!row) throw Errors.notFound('Expense');
  return mapExpense(row);
}

async function resolveLocation(ctx: Ctx, propertyId?: string | null, unitId?: string | null) {
  let resolvedProperty = propertyId ?? null;
  if (unitId) {
    const unit = await db('units').where({ id: unitId, account_id: ctx.accountId }).first('property_id');
    if (!unit) throw Errors.validation('Unit not found.', [{ field: 'unitId', message: 'Unit not found' }]);
    if (resolvedProperty && resolvedProperty !== unit.property_id) {
      throw Errors.validation('The unit does not belong to the selected property.', [{ field: 'unitId', message: 'Wrong property' }]);
    }
    resolvedProperty = unit.property_id;
  }
  if (resolvedProperty) {
    const property = await db('properties').where({ id: resolvedProperty, account_id: ctx.accountId }).first('id');
    if (!property) throw Errors.validation('Property not found.', [{ field: 'propertyId', message: 'Property not found' }]);
  }
  return { propertyId: resolvedProperty, unitId: unitId ?? null };
}

export async function createExpense(ctx: Ctx, input: ExpenseInput): Promise<ExpenseDto> {
  const location = await resolveLocation(ctx, input.propertyId, input.unitId);
  const id = await db.transaction(async (trx) => {
    const [row] = await trx('expenses')
      .insert({
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
      })
      .returning('id');
    await logActivity(trx, ctx, {
      action: 'expense.created',
      entityType: 'expense',
      entityId: row.id,
      summary: `Added ${EXPENSE_CATEGORY_LABELS[input.category].toLowerCase()} expense of ${formatInr(input.amount)}${input.payee ? ` to ${input.payee}` : ''}`,
    });
    return row.id as string;
  });
  return getExpense(ctx, id);
}

export async function updateExpense(ctx: Ctx, id: string, input: Partial<ExpenseInput>): Promise<ExpenseDto> {
  const existing = await db('expenses').where({ id, account_id: ctx.accountId }).first();
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
    await db.transaction(async (trx) => {
      await trx('expenses').where({ id }).update(changes);
      await logActivity(trx, ctx, {
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
  const existing = await db('expenses').where({ id, account_id: ctx.accountId }).first();
  if (!existing) throw Errors.notFound('Expense');
  await db.transaction(async (trx) => {
    await trx('expenses').where({ id }).delete();
    await logActivity(trx, ctx, {
      action: 'expense.deleted',
      entityType: 'expense',
      entityId: id,
      summary: `Deleted ${EXPENSE_CATEGORY_LABELS[existing.category as ExpenseCategory].toLowerCase()} expense of ${formatInr(Number(existing.amount))}`,
    });
  });
}
