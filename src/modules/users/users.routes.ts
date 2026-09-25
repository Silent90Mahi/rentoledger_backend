import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/knex.js';
import { ok } from '../../lib/http.js';
import { parse, zEmail, zName } from '../../lib/validation.js';
import { buildSession } from '../auth/auth.service.js';
import { revokeAllSessions } from '../auth/token.service.js';

export const usersRouter = Router();

const updateSchema = z.object({
  name: zName(120).optional(),
  email: zEmail,
  lateRentNotifications: z.boolean().optional(),
});

usersRouter.get('/me', async (req, res) => {
  ok(res, await buildSession(req.user!.id));
});

usersRouter.patch('/me', async (req, res) => {
  const input = parse(updateSchema, req.body);
  const changes: Record<string, unknown> = {};
  if (input.name !== undefined) changes.name = input.name;
  if (input.email !== undefined) changes.email = input.email;
  if (input.lateRentNotifications !== undefined) changes.late_rent_notifications = input.lateRentNotifications;
  if (Object.keys(changes).length) await db('users').where({ id: req.user!.id }).update(changes);
  ok(res, await buildSession(req.user!.id));
});

/** Signs the user out of every device. */
usersRouter.post('/me/logout-all', async (req, res) => {
  await revokeAllSessions(req.user!.id);
  ok(res, { loggedOut: true });
});
