import { Router } from 'express';
import { z } from 'zod';
import { ctxOf } from '../../lib/context.js';
import { noContent, ok, paged } from '../../lib/http.js';
import { idParam, parse, zInt, zName, zPage, zPageSize, zPercent, zPhone, zText } from '../../lib/validation.js';
import { requireOwner } from '../../middleware/auth.js';
import { listActivity } from '../activity/activity.service.js';
import { addPartner, getAccountSettings, leaveAccount, listMembers, removeMember, updateAccountSettings } from './accounts.service.js';

export const accountRouter = Router();

const upi = z
  .string()
  .trim()
  .nullish()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    if (!/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/.test(v)) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid UPI ID (e.g. name@bank)' });
      return z.NEVER;
    }
    return v;
  });

const ifsc = z
  .string()
  .trim()
  .toUpperCase()
  .nullish()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v)) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid 11-character IFSC code' });
      return z.NEVER;
    }
    return v;
  });

const accountNumber = z
  .string()
  .trim()
  .nullish()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    if (!/^\d{9,18}$/.test(v)) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid bank account number (9-18 digits)' });
      return z.NEVER;
    }
    return v;
  });

const updateSchema = z.object({
  name: zName(120).optional(),
  gstEnabled: z.boolean().optional(),
  gstRate: zPercent(100).optional(),
  timezone: z.string().trim().min(3).max(64).optional(),
  reminderDaysBefore: zInt(0, 30).optional(),
  payeeName: zText(120),
  upiId: upi,
  bankAccountName: zText(120),
  bankAccountNumber: accountNumber,
  bankIfsc: ifsc,
  bankName: zText(120),
});

accountRouter.get('/', async (req, res) => {
  ok(res, await getAccountSettings(ctxOf(req)));
});

accountRouter.patch('/', async (req, res) => {
  ok(res, await updateAccountSettings(ctxOf(req), parse(updateSchema, req.body)));
});

accountRouter.get('/members', async (req, res) => {
  ok(res, await listMembers(ctxOf(req)));
});

accountRouter.post('/members', requireOwner, async (req, res) => {
  const input = parse(z.object({ name: zName(120), phone: zPhone }), req.body);
  res.status(201).json({ success: true, data: await addPartner(ctxOf(req), input) });
});

accountRouter.delete('/members/:userId', requireOwner, async (req, res) => {
  ok(res, await removeMember(ctxOf(req), idParam(req, 'userId')));
});

accountRouter.post('/leave', async (req, res) => {
  await leaveAccount(ctxOf(req));
  noContent(res);
});

accountRouter.get('/activity', async (req, res) => {
  const q = parse(z.object({ page: zPage, pageSize: zPageSize, entityType: z.string().max(40).optional(), entityId: z.uuid().optional() }), req.query);
  const { items, total } = await listActivity(ctxOf(req).accountId, q);
  paged(res, items, { page: q.page, pageSize: q.pageSize, total });
});
