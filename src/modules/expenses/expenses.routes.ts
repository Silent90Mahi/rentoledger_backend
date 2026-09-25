import { Router } from 'express';
import { z } from 'zod';
import { ctxOf } from '../../lib/context.js';
import { created, noContent, ok, paged } from '../../lib/http.js';
import { idParam, paginationShape, parse, zAmount, zDate, zId, zText } from '../../lib/validation.js';
import { RECORDABLE_METHODS } from '../payments/payment.types.js';
import {
  createExpense,
  deleteExpense,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  getExpense,
  listExpenses,
  updateExpense,
} from './expenses.service.js';

export const expensesRouter = Router();

const fields = {
  category: z.enum(EXPENSE_CATEGORIES, 'Choose a category'),
  amount: zAmount(),
  expenseDate: zDate,
  propertyId: zId.nullish(),
  unitId: zId.nullish(),
  payee: zText(160),
  method: z.enum(RECORDABLE_METHODS).nullish(),
  reference: zText(100),
  notes: zText(2000),
};

const createSchema = z.object(fields);
const updateSchema = z.object(fields).partial();
const listSchema = z.object({
  ...paginationShape,
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  propertyId: zId.optional(),
  unitId: zId.optional(),
  from: zDate.optional(),
  to: zDate.optional(),
});

expensesRouter.get('/categories', (_req, res) => {
  ok(
    res,
    EXPENSE_CATEGORIES.map((value) => ({ value, label: EXPENSE_CATEGORY_LABELS[value] })),
  );
});

expensesRouter.get('/', async (req, res) => {
  const query = parse(listSchema, req.query);
  const { items, total, summary } = await listExpenses(ctxOf(req), query);
  paged(res, items, { page: query.page, pageSize: query.pageSize, total }, { summary });
});

expensesRouter.post('/', async (req, res) => {
  created(res, await createExpense(ctxOf(req), parse(createSchema, req.body)));
});

expensesRouter.get('/:id', async (req, res) => {
  ok(res, await getExpense(ctxOf(req), idParam(req)));
});

expensesRouter.patch('/:id', async (req, res) => {
  ok(res, await updateExpense(ctxOf(req), idParam(req), parse(updateSchema, req.body)));
});

expensesRouter.delete('/:id', async (req, res) => {
  await deleteExpense(ctxOf(req), idParam(req));
  noContent(res);
});
