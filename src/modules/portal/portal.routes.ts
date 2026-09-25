import { Router } from 'express';
import { z } from 'zod';
import { tenantCtxOf } from '../../lib/context.js';
import { created, noContent, ok, paged } from '../../lib/http.js';
import { idParam, parse, zAmount, zDate, zId, zMonth, zPage, zPageSize, zText } from '../../lib/validation.js';
import { RECORDABLE_METHODS } from '../payments/payment.types.js';
import { portalCharge, portalCharges, portalPayments, portalSummary, submitPayment, withdrawPayment } from './portal.service.js';

/** Tenant-facing endpoints ("My Rent", "History", "Pay rent"). */
export const portalRouter = Router();

portalRouter.get('/summary', async (req, res) => {
  const { month } = parse(z.object({ month: zMonth.optional() }), req.query);
  ok(res, await portalSummary(tenantCtxOf(req), month));
});

portalRouter.get('/charges', async (req, res) => {
  const q = parse(z.object({ page: zPage, pageSize: zPageSize, status: z.enum(['all', 'unpaid', 'collected']).optional() }), req.query);
  const { items, total } = await portalCharges(tenantCtxOf(req), q);
  paged(res, items, { page: q.page, pageSize: q.pageSize, total });
});

portalRouter.get('/charges/:id', async (req, res) => {
  ok(res, await portalCharge(tenantCtxOf(req), idParam(req)));
});

portalRouter.get('/payments', async (req, res) => {
  const q = parse(z.object({ page: zPage, pageSize: zPageSize }), req.query);
  const { items, total } = await portalPayments(tenantCtxOf(req), q);
  paged(res, items, { page: q.page, pageSize: q.pageSize, total });
});

const submitSchema = z.object({
  chargeId: zId.nullish(),
  tenantId: zId.nullish(),
  amount: zAmount(),
  paidOn: zDate,
  method: z.enum(RECORDABLE_METHODS, 'Choose how you paid'),
  reference: zText(100),
  notes: zText(500),
});

portalRouter.post('/payments', async (req, res) => {
  created(res, await submitPayment(tenantCtxOf(req), parse(submitSchema, req.body)));
});

portalRouter.delete('/payments/:id', async (req, res) => {
  await withdrawPayment(tenantCtxOf(req), idParam(req));
  noContent(res);
});
