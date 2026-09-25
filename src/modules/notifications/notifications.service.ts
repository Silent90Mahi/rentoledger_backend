import { db, type DbOrTrx } from '../../db/knex.js';
import { now } from '../../lib/clock.js';
import { Errors } from '../../lib/errors.js';

export type Audience = 'owner' | 'tenant';

export type NotificationType =
  | 'rent_overdue'
  | 'rent_due_soon'
  | 'payment_submitted'
  | 'payment_recorded'
  | 'payment_confirmed'
  | 'payment_rejected'
  | 'agreement_expiring'
  | 'rent_generated'
  | 'reminder'
  | 'partner_added';

export interface NewNotification {
  type: NotificationType;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  data?: Record<string, unknown> | null;
  /** Prevents sending the same notification twice to a user (e.g. "overdue:<chargeId>"). */
  dedupeKey?: string | null;
}

async function insertMany(
  q: DbOrTrx,
  userIds: string[],
  accountId: string | null,
  audience: Audience,
  n: NewNotification,
): Promise<number> {
  if (userIds.length === 0) return 0;
  const values = userIds.map((userId) => [
    userId,
    accountId,
    audience,
    n.type,
    n.title.slice(0, 200),
    n.body ?? null,
    n.entityType ?? null,
    n.entityId ?? null,
    n.data ? JSON.stringify(n.data) : null,
    n.dedupeKey ?? null,
  ]);
  const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)').join(', ');
  const result = await q.raw(
    `INSERT INTO notifications (user_id, account_id, audience, type, title, body, entity_type, entity_id, data, dedupe_key)
     VALUES ${placeholders}
     ON CONFLICT DO NOTHING`,
    values.flat(),
  );
  return result.rowCount ?? 0;
}

/**
 * Notifies landlord-side members of an account. `lateRentOnly` restricts the
 * recipients to members who kept "Late-rent notifications" switched on.
 */
export async function notifyAccountMembers(
  q: DbOrTrx,
  accountId: string,
  n: NewNotification,
  opts: { excludeUserId?: string | null; lateRentOnly?: boolean } = {},
): Promise<number> {
  const members = await q('account_members as m')
    .join('users as u', 'u.id', 'm.user_id')
    .where('m.account_id', accountId)
    .modify((qb) => {
      if (opts.excludeUserId) qb.whereNot('m.user_id', opts.excludeUserId);
      if (opts.lateRentOnly) qb.where('u.late_rent_notifications', true);
    })
    .pluck('m.user_id');
  return insertMany(q, members, accountId, 'owner', n);
}

/**
 * Notifies the app user (if any) whose phone matches the tenant record.
 * Automated rent reminders respect the user's notification switch; payment
 * confirmations and rejections are always delivered.
 */
export async function notifyTenant(
  q: DbOrTrx,
  tenantId: string,
  n: NewNotification,
  opts: { reminder?: boolean } = {},
): Promise<number> {
  const row = await q('tenants as t')
    .join('users as u', 'u.phone', 't.phone')
    .where('t.id', tenantId)
    .where('t.portal_enabled', true)
    .whereNull('t.archived_at')
    .modify((qb) => {
      if (opts.reminder) qb.where('u.late_rent_notifications', true);
    })
    .first('u.id as user_id', 't.account_id');
  if (!row) return 0;
  return insertMany(q, [row.user_id], row.account_id, 'tenant', n);
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  data: Record<string, unknown> | null;
  read: boolean;
  createdAt: string;
}

function mapNotification(r: Record<string, unknown>): NotificationItem {
  return {
    id: r.id as string,
    type: r.type as string,
    title: r.title as string,
    body: (r.body as string) ?? null,
    entityType: (r.entity_type as string) ?? null,
    entityId: (r.entity_id as string) ?? null,
    data: (r.data as Record<string, unknown>) ?? null,
    read: r.read_at !== null,
    createdAt: r.created_at as string,
  };
}

export async function listNotifications(
  userId: string,
  audience: Audience,
  opts: { page: number; pageSize: number; unreadOnly?: boolean },
): Promise<{ items: NotificationItem[]; total: number; unread: number }> {
  const base = db('notifications')
    .where({ user_id: userId, audience })
    .modify((q) => {
      if (opts.unreadOnly) q.whereNull('read_at');
    });
  const [{ count }] = await base.clone().count<{ count: number }[]>({ count: '*' });
  const rows = await base
    .clone()
    .select('*')
    .orderBy('created_at', 'desc')
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);
  const unread = await unreadCount(userId, audience);
  return { items: rows.map(mapNotification), total: Number(count), unread };
}

export async function unreadCount(userId: string, audience: Audience): Promise<number> {
  const [{ count }] = await db('notifications')
    .where({ user_id: userId, audience })
    .whereNull('read_at')
    .count<{ count: number }[]>({ count: '*' });
  return Number(count);
}

export async function markRead(userId: string, id: string): Promise<void> {
  const updated = await db('notifications').where({ id, user_id: userId }).update({ read_at: db.raw('COALESCE(read_at, ?)', [now()]) });
  if (!updated) throw Errors.notFound('Notification');
}

export async function markAllRead(userId: string, audience: Audience): Promise<number> {
  return db('notifications').where({ user_id: userId, audience }).whereNull('read_at').update({ read_at: now() });
}

export async function deleteNotification(userId: string, id: string): Promise<void> {
  const deleted = await db('notifications').where({ id, user_id: userId }).delete();
  if (!deleted) throw Errors.notFound('Notification');
}
