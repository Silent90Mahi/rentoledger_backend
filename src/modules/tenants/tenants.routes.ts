import { Router } from 'express';
import { z } from 'zod';
import { ctxOf } from '../../lib/context.js';
import { created, noContent, ok, paged } from '../../lib/http.js';
import {
  idParam,
  paginationShape,
  parse,
  zBoolQuery,
  zDate,
  zEmail,
  zName,
  zOptionalPhone,
  zPhone,
  zText,
} from '../../lib/validation.js';
import {
  archiveTenant,
  createTenant,
  deleteTenant,
  getTenant,
  getTenantStatement,
  listTenants,
  restoreTenant,
  updateTenant,
} from './tenants.service.js';

export const tenantsRouter = Router();

const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .nullish()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    if (!/^[0-9]{2}[A-Z0-9]{13}$/.test(v)) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid 15-character GSTIN' });
      return z.NEVER;
    }
    return v;
  });

const tenantFields = {
  name: zName(120),
  phone: zPhone,
  email: zEmail,
  businessName: zText(160),
  gstin,
  idProofType: zText(30),
  idProofNumber: zText(40),
  address: zText(1000),
  emergencyContactName: zText(120),
  emergencyContactPhone: zOptionalPhone,
  notes: zText(2000),
  portalEnabled: z.boolean().optional(),
};

const createSchema = z.object(tenantFields);
const updateSchema = z.object(tenantFields).partial();
const listSchema = z.object({
  ...paginationShape,
  status: z.enum(['active', 'upcoming', 'past', 'new', 'all']).optional(),
  dues: z.enum(['any', 'overdue']).optional(),
  archived: zBoolQuery.optional(),
});
const statementSchema = z.object({ from: zDate.optional(), to: zDate.optional() });

tenantsRouter.get('/', async (req, res) => {
  const query = parse(listSchema, req.query);
  const { items, total, counts } = await listTenants(ctxOf(req), query);
  paged(res, items, { page: query.page, pageSize: query.pageSize, total }, { counts });
});

tenantsRouter.post('/', async (req, res) => {
  created(res, await createTenant(ctxOf(req), parse(createSchema, req.body)));
});

tenantsRouter.get('/:id', async (req, res) => {
  ok(res, await getTenant(ctxOf(req), idParam(req)));
});

tenantsRouter.get('/:id/statement', async (req, res) => {
  const range = parse(statementSchema, req.query);
  ok(res, await getTenantStatement(ctxOf(req), idParam(req), range));
});

tenantsRouter.patch('/:id', async (req, res) => {
  ok(res, await updateTenant(ctxOf(req), idParam(req), parse(updateSchema, req.body)));
});

tenantsRouter.post('/:id/archive', async (req, res) => {
  ok(res, await archiveTenant(ctxOf(req), idParam(req)));
});

tenantsRouter.post('/:id/restore', async (req, res) => {
  ok(res, await restoreTenant(ctxOf(req), idParam(req)));
});

tenantsRouter.delete('/:id', async (req, res) => {
  await deleteTenant(ctxOf(req), idParam(req));
  noContent(res);
});
