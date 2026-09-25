import { Router, type Request } from 'express';
import { z } from 'zod';
import { Errors } from '../../lib/errors.js';
import { noContent, ok, paged } from '../../lib/http.js';
import { idParam, parse, zBoolQuery, zPage, zPageSize } from '../../lib/validation.js';
import {
  deleteNotification,
  listNotifications,
  markAllRead,
  markRead,
  unreadCount,
  type Audience,
} from './notifications.service.js';

/**
 * Notifications belong to a user. The `audience` query parameter selects the
 * landlord-side (owner) or tenant-side feed for users who have both roles.
 */
export const notificationsRouter = Router();

const audienceSchema = z.object({ audience: z.enum(['owner', 'tenant']).default('owner') });

function userId(req: Request): string {
  if (!req.user) throw Errors.unauthorized();
  return req.user.id;
}

notificationsRouter.get('/', async (req, res) => {
  const q = parse(audienceSchema.extend({ page: zPage, pageSize: zPageSize, unreadOnly: zBoolQuery.optional() }), req.query);
  const { items, total, unread } = await listNotifications(userId(req), q.audience as Audience, q);
  paged(res, items, { page: q.page, pageSize: q.pageSize, total }, { unread });
});

notificationsRouter.get('/unread-count', async (req, res) => {
  const q = parse(audienceSchema, req.query);
  ok(res, { unread: await unreadCount(userId(req), q.audience as Audience) });
});

notificationsRouter.post('/read-all', async (req, res) => {
  const q = parse(audienceSchema, { ...req.query, ...(req.body ?? {}) });
  ok(res, { updated: await markAllRead(userId(req), q.audience as Audience) });
});

notificationsRouter.post('/:id/read', async (req, res) => {
  await markRead(userId(req), idParam(req));
  ok(res, { read: true });
});

notificationsRouter.delete('/:id', async (req, res) => {
  await deleteNotification(userId(req), idParam(req));
  noContent(res);
});
