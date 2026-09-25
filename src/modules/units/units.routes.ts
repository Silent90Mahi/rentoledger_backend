import { Router } from 'express';
import { z } from 'zod';
import { ctxOf } from '../../lib/context.js';
import { created, noContent, ok, paged } from '../../lib/http.js';
import { idParam, paginationShape, parse, zAmount, zBoolQuery, zId, zName, zText } from '../../lib/validation.js';
import { archiveUnit, createUnit, deleteUnit, getUnit, listUnits, restoreUnit, UNIT_TYPES, updateUnit } from './units.service.js';

export const unitsRouter = Router();

const unitFields = {
  propertyId: zId,
  name: zName(120),
  type: z.enum(UNIT_TYPES, 'Choose a unit type'),
  floor: zText(20),
  areaSqft: zAmount().nullish(),
  defaultRent: zAmount({ allowZero: true }).nullish(),
  notes: zText(2000),
};

const createSchema = z.object(unitFields);
const updateSchema = z.object(unitFields).partial();
const listSchema = z.object({
  ...paginationShape,
  propertyId: zId.optional(),
  occupancy: z.enum(['occupied', 'vacant', 'reserved']).optional(),
  type: z.enum(UNIT_TYPES).optional(),
  archived: zBoolQuery.optional(),
});

unitsRouter.get('/', async (req, res) => {
  const query = parse(listSchema, req.query);
  const { items, total, counts } = await listUnits(ctxOf(req), query);
  paged(res, items, { page: query.page, pageSize: query.pageSize, total }, { counts });
});

unitsRouter.post('/', async (req, res) => {
  created(res, await createUnit(ctxOf(req), parse(createSchema, req.body)));
});

unitsRouter.get('/:id', async (req, res) => {
  ok(res, await getUnit(ctxOf(req), idParam(req)));
});

unitsRouter.patch('/:id', async (req, res) => {
  ok(res, await updateUnit(ctxOf(req), idParam(req), parse(updateSchema, req.body)));
});

unitsRouter.post('/:id/archive', async (req, res) => {
  ok(res, await archiveUnit(ctxOf(req), idParam(req)));
});

unitsRouter.post('/:id/restore', async (req, res) => {
  ok(res, await restoreUnit(ctxOf(req), idParam(req)));
});

unitsRouter.delete('/:id', async (req, res) => {
  await deleteUnit(ctxOf(req), idParam(req));
  noContent(res);
});
