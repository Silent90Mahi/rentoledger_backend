import { Router } from 'express';
import { z } from 'zod';
import { ctxOf } from '../../lib/context.js';
import { created, ok, paged } from '../../lib/http.js';
import { idParam, paginationShape, parse, zAmount, zDate, zId, zText } from '../../lib/validation.js';
import { PAYMENT_METHODS, PAYMENT_STATUSES, RECORDABLE_METHODS } from './payment.types.js';
import {
  confirmPayment,
  createPayment,
  getPayment,
  listPayments,
  rejectPayment,
  updatePayment,
  voidPayment,
} from './payments.service.js';

export const paymentsRouter = Router();

const createSchema = z.object({
  tenantId: zId,
  agreementId: zId.nullish(),
  targetChargeId: zId.nullish(),
  amount: zAmount(),
  paidOn: zDate,
  method: z.enum(RECORDABLE_METHODS, 'Choose a payment method'),
  reference: zText(100),
  notes: zText(1000),
  status: z.enum(['confirmed', 'pending']).optional(),
});

const updateSchema = z.object({
  amount: zAmount().optional(),
  paidOn: zDate.optional(),
  method: z.enum(RECORDABLE_METHODS).optional(),
  reference: zText(100),
  notes: zText(1000),
});

const reasonSchema = z.object({ reason: z.string().trim().min(3, 'Please give a short reason').max(500) });

const listSchema = z.object({
  ...paginationShape,
  tenantId: zId.optional(),
  propertyId: zId.optional(),
  unitId: zId.optional(),
  agreementId: zId.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
  source: z.enum(['owner', 'tenant', 'system']).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
});

paymentsRouter.get('/', async (req, res) => {
  const query = parse(listSchema, req.query);
  const { items, total, summary } = await listPayments(ctxOf(req), query);
  paged(res, items, { page: query.page, pageSize: query.pageSize, total }, { summary });
});

paymentsRouter.post('/', async (req, res) => {
  created(res, await createPayment(ctxOf(req), parse(createSchema, req.body)));
});

paymentsRouter.get('/:id', async (req, res) => {
  ok(res, await getPayment(ctxOf(req), idParam(req)));
});

paymentsRouter.patch('/:id', async (req, res) => {
  ok(res, await updatePayment(ctxOf(req), idParam(req), parse(updateSchema, req.body)));
});

paymentsRouter.post('/:id/confirm', async (req, res) => {
  ok(res, await confirmPayment(ctxOf(req), idParam(req)));
});

paymentsRouter.post('/:id/reject', async (req, res) => {
  const { reason } = parse(reasonSchema, req.body);
  ok(res, await rejectPayment(ctxOf(req), idParam(req), reason));
});

paymentsRouter.post('/:id/void', async (req, res) => {
  const { reason } = parse(reasonSchema, req.body);
  ok(res, await voidPayment(ctxOf(req), idParam(req), reason));
});
