import { col, newId, opts, type Session } from '../../db/mongo.js';
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
  session: Session,
  userIds: string[],
  accountId: string | null,
  audience: Audience,
  n: NewNotification,
): Promise<number> {
  if (userIds.length === 0) return 0;
  const doc = (userId: string) => ({
    _id: newId(),
    user_id: userId,
    account_id: accountId,
    audience,
    type: n.type,
    title: n.title.slice(0, 200),
    body: n.body ?? null,
    entity_type: n.entityType ?? null,
    entity_id: n.entityId ?? null,
    data: n.data ?? null,
    read_at: null,
    created_at: new Date(),
  });
  if (!n.dedupeKey) {
    const result = await col('notifications').insertMany(userIds.map(doc), opts(session));
    return result.insertedCount;
  }
  // Upsert on (user, dedupe key): never sends the same notification twice and,
  // unlike a failing insert, does not abort the surrounding transaction.
  const result = await col('notifications').bulkWrite(
    userIds.map((userId) => ({
      updateOne: {
        filter: { user_id: userId, dedupe_key: n.dedupeKey },
        update: { $setOnInsert: (({ user_id: _u, ...rest }) => rest)(doc(userId)) },
        upsert: true,
      },
    })),
    opts(session),
  );
  return result.upsertedCount;
}

/**
 * Notifies landlord-side members of an account. `lateRentOnly` restricts the
 * recipients to members who kept "Late-rent notifications" switched on.
 */
export async function notifyAccountMembers(
  session: Session,
  accountId: string,
  n: NewNotification,
  options: { excludeUserId?: string | null; lateRentOnly?: boolean } = {},
): Promise<number> {
  const members = await col('account_members').find({ account_id: accountId }, opts(session)).toArray();
  let userIds = members.map((m) => m.user_id as string).filter((id) => id !== options.excludeUserId);
  if (options.lateRentOnly && userIds.length) {
    const users = await col('users')
      .find({ _id: { $in: userIds }, late_rent_notifications: true }, { ...opts(session), projection: { _id: 1 } })
      .toArray();
    userIds = users.map((u) => u._id);
  }
  return insertMany(session, userIds, accountId, 'owner', n);
}

/**
 * Notifies the app user (if any) whose phone matches the tenant record.
 * Automated rent reminders respect the user's notification switch; payment
 * confirmations and rejections are always delivered.
 */
export async function notifyTenant(
  session: Session,
  tenantId: string,
  n: NewNotification,
  options: { reminder?: boolean } = {},
): Promise<number> {
  const tenant = await col('tenants').findOne({ _id: tenantId, portal_enabled: true, archived_at: null }, opts(session));
  if (!tenant) return 0;
  const user = await col('users').findOne(
    { phone: tenant.phone, ...(options.reminder ? { late_rent_notifications: true } : {}) },
    opts(session),
  );
  if (!user) return 0;
  return insertMany(session, [user._id], tenant.account_id, 'tenant', n);
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
    id: r._id as string,
    type: r.type as string,
    title: r.title as string,
    body: (r.body as string) ?? null,
    entityType: (r.entity_type as string) ?? null,
    entityId: (r.entity_id as string) ?? null,
    data: (r.data as Record<string, unknown>) ?? null,
    read: r.read_at !== null && r.read_at !== undefined,
    createdAt: r.created_at as string,
  };
}

export async function listNotifications(
  userId: string,
  audience: Audience,
  query: { page: number; pageSize: number; unreadOnly?: boolean },
): Promise<{ items: NotificationItem[]; total: number; unread: number }> {
  const filter: Record<string, unknown> = { user_id: userId, audience, ...(query.unreadOnly ? { read_at: null } : {}) };
  const [total, rows, unread] = await Promise.all([
    col('notifications').countDocuments(filter),
    col('notifications')
      .find(filter)
      .sort({ created_at: -1, _id: -1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .toArray(),
    unreadCount(userId, audience),
  ]);
  return { items: rows.map(mapNotification), total, unread };
}

export async function unreadCount(userId: string, audience: Audience): Promise<number> {
  return col('notifications').countDocuments({ user_id: userId, audience, read_at: null });
}

export async function markRead(userId: string, id: string): Promise<void> {
  const found = await col('notifications').findOne({ _id: id, user_id: userId }, { projection: { read_at: 1 } });
  if (!found) throw Errors.notFound('Notification');
  if (!found.read_at) await col('notifications').updateOne({ _id: id, user_id: userId }, { $set: { read_at: now() } });
}

export async function markAllRead(userId: string, audience: Audience): Promise<number> {
  const result = await col('notifications').updateMany({ user_id: userId, audience, read_at: null }, { $set: { read_at: now() } });
  return result.modifiedCount;
}

export async function deleteNotification(userId: string, id: string): Promise<void> {
  const result = await col('notifications').deleteOne({ _id: id, user_id: userId });
  if (!result.deletedCount) throw Errors.notFound('Notification');
}
