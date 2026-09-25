import { Router } from 'express';
import { z } from 'zod';
import { ctxOf } from '../../lib/context.js';
import { created, noContent, ok, paged } from '../../lib/http.js';
import { idParam, paginationShape, parse, zAmount, zBoolQuery, zName, zText } from '../../lib/validation.js';
import { UNIT_TYPES } from '../units/units.service.js';
import {
  archiveProperty,
  createProperty,
  deleteProperty,
  getProperty,
  listProperties,
  PROPERTY_TYPES,
  restoreProperty,
  updateProperty,
} from './properties.service.js';

export const propertiesRouter = Router();

const pincode = z
  .string()
  .trim()
  .nullish()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    if (!/^\d{6}$/.test(v)) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid 6-digit PIN code' });
      return z.NEVER;
    }
    return v;
  });

const propertyFields = {
  name: zName(120),
  type: z.enum(PROPERTY_TYPES, 'Choose a property type'),
  addressLine: zText(255),
  city: zText(100),
  state: zText(100),
  pincode,
  notes: zText(2000),
};

const createSchema = z.object({
  ...propertyFields,
  singleUnit: z
    .object({
      name: zText(120),
      type: z.enum(UNIT_TYPES).nullish(),
      defaultRent: zAmount({ allowZero: true }).nullish(),
      areaSqft: zAmount().nullish(),
    })
    .nullish(),
});

const updateSchema = z.object(propertyFields).partial();

const listSchema = z.object({
  ...paginationShape,
  type: z.enum(PROPERTY_TYPES).optional(),
  archived: zBoolQuery.optional(),
});

propertiesRouter.get('/', async (req, res) => {
  const query = parse(listSchema, req.query);
  const { items, total } = await listProperties(ctxOf(req), query);
  paged(res, items, { page: query.page, pageSize: query.pageSize, total });
});

propertiesRouter.post('/', async (req, res) => {
  const input = parse(createSchema, req.body);
  created(res, await createProperty(ctxOf(req), input));
});

propertiesRouter.get('/:id', async (req, res) => {
  ok(res, await getProperty(ctxOf(req), idParam(req)));
});

propertiesRouter.patch('/:id', async (req, res) => {
  const input = parse(updateSchema, req.body);
  ok(res, await updateProperty(ctxOf(req), idParam(req), input));
});

propertiesRouter.post('/:id/archive', async (req, res) => {
  ok(res, await archiveProperty(ctxOf(req), idParam(req)));
});

propertiesRouter.post('/:id/restore', async (req, res) => {
  ok(res, await restoreProperty(ctxOf(req), idParam(req)));
});

propertiesRouter.delete('/:id', async (req, res) => {
  await deleteProperty(ctxOf(req), idParam(req));
  noContent(res);
});
