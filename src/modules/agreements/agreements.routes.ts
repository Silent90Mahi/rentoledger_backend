import { Router } from 'express';
import { z } from 'zod';
import { ctxOf } from '../../lib/context.js';
import { created, noContent, ok, paged } from '../../lib/http.js';
import {
  idParam,
  paginationShape,
  parse,
  zAmount,
  zDate,
  zEmail,
  zId,
  zInt,
  zName,
  zPercent,
  zPhone,
  zText,
} from '../../lib/validation.js';
import { RECORDABLE_METHODS } from '../payments/payment.types.js';
import {
  addDepositTransaction,
  createAgreement,
  deleteAgreement,
  deleteDepositTransaction,
  endAgreement,
  getAgreement,
  listAgreements,
  updateAgreement,
} from './agreements.service.js';

export const agreementsRouter = Router();

const billingCycle = z.enum(['monthly', 'quarterly', 'half_yearly', 'yearly'], 'Choose a billing cycle');

const createSchema = z.object({
  unitId: zId,
  tenantId: zId.nullish(),
  newTenant: z
    .object({
      name: zName(120),
      phone: zPhone,
      email: zEmail,
      businessName: zText(160),
      address: zText(1000),
      portalEnabled: z.boolean().optional(),
    })
    .nullish(),
  startDate: zDate,
  endDate: zDate.nullish(),
  billingStartDate: zDate.nullish(),
  rentAmount: zAmount(),
  billingCycle: billingCycle.default('monthly'),
  dueDay: zInt(1, 31),
  gstApplicable: z.boolean().optional(),
  gstRate: zPercent(100).nullish(),
  securityDeposit: zAmount({ allowZero: true }).optional(),
  escalationPercent: zPercent(100).optional(),
  escalationIntervalMonths: zInt(1, 120).optional(),
  proratePartialPeriods: z.boolean().optional(),
  noticePeriodDays: zInt(0, 365).nullish(),
  lockInMonths: zInt(0, 240).nullish(),
  notes: zText(2000),
  openingBalance: z
    .object({ amount: zAmount({ allowZero: true }), dueDate: zDate.nullish(), description: zText(255) })
    .nullish(),
  advancePayment: z
    .object({
      amount: zAmount({ allowZero: true }),
      paidOn: zDate,
      method: z.enum(RECORDABLE_METHODS),
      reference: zText(100),
    })
    .nullish(),
  depositReceived: z
    .object({
      amount: zAmount({ allowZero: true }),
      date: zDate,
      method: z.enum(RECORDABLE_METHODS).nullish(),
      reference: zText(100),
    })
    .nullish(),
});

const updateSchema = z.object({
  endDate: zDate.nullish(),
  rentAmount: zAmount().optional(),
  dueDay: zInt(1, 31).optional(),
  gstApplicable: z.boolean().optional(),
  gstRate: zPercent(100).optional(),
  securityDeposit: zAmount({ allowZero: true }).optional(),
  escalationPercent: zPercent(100).optional(),
  escalationIntervalMonths: zInt(1, 120).optional(),
  proratePartialPeriods: z.boolean().optional(),
  noticePeriodDays: zInt(0, 365).nullish(),
  lockInMonths: zInt(0, 240).nullish(),
  notes: zText(2000),
});

const endSchema = z.object({ endedOn: zDate, reason: zText(500) });

const listSchema = z.object({
  ...paginationShape,
  status: z.enum(['active', 'ended', 'all']).optional(),
  unitId: zId.optional(),
  tenantId: zId.optional(),
  propertyId: zId.optional(),
  expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
});

const depositSchema = z.object({
  type: z.enum(['received', 'refunded', 'deducted', 'applied']),
  amount: zAmount(),
  date: zDate,
  method: z.enum(RECORDABLE_METHODS).nullish(),
  reference: zText(100),
  notes: zText(500),
});

agreementsRouter.get('/', async (req, res) => {
  const query = parse(listSchema, req.query);
  const { items, total } = await listAgreements(ctxOf(req), query);
  paged(res, items, { page: query.page, pageSize: query.pageSize, total });
});

agreementsRouter.post('/', async (req, res) => {
  const input = parse(createSchema, req.body);
  created(res, await createAgreement(ctxOf(req), input));
});

agreementsRouter.get('/:id', async (req, res) => {
  ok(res, await getAgreement(ctxOf(req), idParam(req)));
});

agreementsRouter.patch('/:id', async (req, res) => {
  ok(res, await updateAgreement(ctxOf(req), idParam(req), parse(updateSchema, req.body)));
});

agreementsRouter.post('/:id/end', async (req, res) => {
  ok(res, await endAgreement(ctxOf(req), idParam(req), parse(endSchema, req.body)));
});

agreementsRouter.delete('/:id', async (req, res) => {
  await deleteAgreement(ctxOf(req), idParam(req));
  noContent(res);
});

agreementsRouter.post('/:id/deposits', async (req, res) => {
  created(res, await addDepositTransaction(ctxOf(req), idParam(req), parse(depositSchema, req.body)));
});

agreementsRouter.delete('/:id/deposits/:txnId', async (req, res) => {
  ok(res, await deleteDepositTransaction(ctxOf(req), idParam(req), idParam(req, 'txnId')));
});
