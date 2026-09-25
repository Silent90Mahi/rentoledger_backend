import { Router } from 'express';
import { z } from 'zod';
import { ctxOf } from '../../lib/context.js';
import { created, ok, paged } from '../../lib/http.js';
import { idParam, paginationShape, parse, zAmount, zDate, zId, zMonth, zText } from '../../lib/validation.js';
import { RECORDABLE_METHODS } from '../payments/payment.types.js';
import {
  collectCharge,
  createCharge,
  generateNow,
  getRent,
  listRents,
  remindCharge,
  updateCharge,
  voidCharge,
} from './rents.service.js';

export const rentsRouter = Router();

const listSchema = z.object({
  ...paginationShape,
  month: zMonth.optional(),
  status: z.enum(['all', 'overdue', 'to_confirm', 'pending', 'partial', 'collected', 'unpaid', 'void']).optional(),
  propertyId: zId.optional(),
  unitId: zId.optional(),
  tenantId: zId.optional(),
  agreementId: zId.optional(),
  kind: z.enum(['rent', 'opening_balance', 'maintenance', 'utility', 'late_fee', 'other']).optional(),
});

const createSchema = z.object({
  agreementId: zId,
  kind: z.enum(['opening_balance', 'maintenance', 'utility', 'late_fee', 'other'], 'Choose a charge type'),
  description: zText(255),
  amount: zAmount(),
  gstApplicable: z.boolean().optional(),
  dueDate: zDate,
  periodStart: zDate.nullish(),
  periodEnd: zDate.nullish(),
});

const updateSchema = z.object({
  baseAmount: zAmount({ allowZero: true }).optional(),
  dueDate: zDate.optional(),
  description: zText(255),
  reason: zText(500),
});

const voidSchema = z.object({ reason: z.string().trim().min(3, 'Please give a short reason').max(500) });

const collectSchema = z.object({
  amount: zAmount().optional(),
  paidOn: zDate.optional(),
  method: z.enum(RECORDABLE_METHODS, 'Choose a payment method'),
  reference: zText(100),
  notes: zText(1000),
});

rentsRouter.get('/', async (req, res) => {
  const query = parse(listSchema, req.query);
  const { items, total, counts, totals, earlierDues } = await listRents(ctxOf(req), query);
  paged(res, items, { page: query.page, pageSize: query.pageSize, total }, { counts, totals, earlierDues });
});

rentsRouter.post('/generate', async (req, res) => {
  ok(res, await generateNow(ctxOf(req)));
});

rentsRouter.post('/', async (req, res) => {
  created(res, await createCharge(ctxOf(req), parse(createSchema, req.body)));
});

rentsRouter.get('/:id', async (req, res) => {
  ok(res, await getRent(ctxOf(req), idParam(req)));
});

rentsRouter.patch('/:id', async (req, res) => {
  ok(res, await updateCharge(ctxOf(req), idParam(req), parse(updateSchema, req.body)));
});

rentsRouter.post('/:id/void', async (req, res) => {
  const { reason } = parse(voidSchema, req.body);
  ok(res, await voidCharge(ctxOf(req), idParam(req), reason));
});

rentsRouter.post('/:id/collect', async (req, res) => {
  created(res, await collectCharge(ctxOf(req), idParam(req), parse(collectSchema, req.body)));
});

rentsRouter.post('/:id/remind', async (req, res) => {
  ok(res, await remindCharge(ctxOf(req), idParam(req)));
});
