import { Router } from 'express';
import { z } from 'zod';
import { ctxOf } from '../../lib/context.js';
import { ok } from '../../lib/http.js';
import { parse, zMonth } from '../../lib/validation.js';
import { getDashboard } from './dashboard.service.js';

export const dashboardRouter = Router();

dashboardRouter.get('/', async (req, res) => {
  const { month } = parse(z.object({ month: zMonth.optional() }), req.query);
  ok(res, await getDashboard(ctxOf(req), month));
});
