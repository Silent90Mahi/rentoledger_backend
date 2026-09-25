import { db, type DbOrTrx } from '../../db/knex.js';

export interface ActivityEntry {
  action: string;
  entityType?: string;
  entityId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}

/** Appends an audit/activity record. Call inside the same transaction as the change. */
export async function logActivity(
  q: DbOrTrx,
  who: { accountId: string; userId?: string | null },
  entry: ActivityEntry,
): Promise<void> {
  await q('activity_logs').insert({
    account_id: who.accountId,
    user_id: who.userId ?? null,
    action: entry.action,
    entity_type: entry.entityType ?? null,
    entity_id: entry.entityId ?? null,
    summary: entry.summary,
    metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
  });
}

export interface ActivityItem {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  summary: string;
  actorName: string | null;
  createdAt: string;
}

export async function listActivity(
  accountId: string,
  opts: { page: number; pageSize: number; entityType?: string; entityId?: string },
): Promise<{ items: ActivityItem[]; total: number }> {
  const base = db('activity_logs as l')
    .leftJoin('users as u', 'u.id', 'l.user_id')
    .where('l.account_id', accountId)
    .modify((q) => {
      if (opts.entityType) q.where('l.entity_type', opts.entityType);
      if (opts.entityId) q.where('l.entity_id', opts.entityId);
    });

  const [{ count }] = await base.clone().count<{ count: number }[]>({ count: '*' });
  const rows = await base
    .clone()
    .select('l.id', 'l.action', 'l.entity_type', 'l.entity_id', 'l.summary', 'l.created_at', 'u.name as actor_name')
    .orderBy('l.created_at', 'desc')
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);

  return {
    total: Number(count),
    items: rows.map((r: Record<string, any>) => ({
      id: r.id,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      summary: r.summary,
      actorName: r.actor_name,
      createdAt: r.created_at,
    })),
  };
}
