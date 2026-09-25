import { Router } from 'express';
import { z } from 'zod';
import { ctxOf } from '../../lib/context.js';
import { addMonths, startOfMonth } from '../../lib/dates.js';
import { ok, paged } from '../../lib/http.js';
import { parse, zDate, zId, zPage, zPageSize, zSearch } from '../../lib/validation.js';
import {
  collectionsReport,
  expenseReport,
  pendingReport,
  propertyIncomeReport,
  reportSummary,
  tenantHistoryReport,
} from './reports.service.js';

export const reportsRouter = Router();

const rangeSchema = z.object({
  from: zDate.optional(),
  to: zDate.optional(),
  propertyId: zId.optional(),
});

/** Defaults to the last 12 months (including the current one). */
function resolveRange(today: string, input: { from?: string; to?: string }) {
  const to = input.to ?? today;
  const from = input.from ?? startOfMonth(addMonths(to, -11));
  return { from, to };
}

reportsRouter.get('/summary', async (req, res) => {
  const ctx = ctxOf(req);
  const q = parse(rangeSchema, req.query);
  ok(res, await reportSummary(ctx, { ...resolveRange(ctx.today, q), propertyId: q.propertyId }));
});

reportsRouter.get('/collections', async (req, res) => {
  const ctx = ctxOf(req);
  const q = parse(rangeSchema.extend({ groupBy: z.enum(['month', 'year']).default('month') }), req.query);
  ok(res, await collectionsReport(ctx, { ...resolveRange(ctx.today, q), groupBy: q.groupBy, propertyId: q.propertyId }));
});

reportsRouter.get('/pending', async (req, res) => {
  const q = parse(z.object({ propertyId: zId.optional(), search: zSearch }), req.query);
  ok(res, await pendingReport(ctxOf(req), q));
});

reportsRouter.get('/properties', async (req, res) => {
  const ctx = ctxOf(req);
  const q = parse(rangeSchema, req.query);
  ok(res, await propertyIncomeReport(ctx, resolveRange(ctx.today, q)));
});

reportsRouter.get('/expenses', async (req, res) => {
  const ctx = ctxOf(req);
  const q = parse(rangeSchema, req.query);
  ok(res, await expenseReport(ctx, { ...resolveRange(ctx.today, q), propertyId: q.propertyId }));
});

reportsRouter.get('/tenants', async (req, res) => {
  const ctx = ctxOf(req);
  const q = parse(rangeSchema.extend({ search: zSearch, page: zPage, pageSize: zPageSize }), req.query);
  const result = await tenantHistoryReport(ctx, { ...resolveRange(ctx.today, q), search: q.search, page: q.page, pageSize: q.pageSize });
  paged(res, result.items, { page: q.page, pageSize: q.pageSize, total: result.total }, { from: result.from, to: result.to });
});
