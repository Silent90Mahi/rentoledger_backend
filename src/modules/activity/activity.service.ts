import { col, newId, opts, type Session } from '../../db/mongo.js';

export interface ActivityEntry {
  action: string;
  entityType?: string;
  entityId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}

/** Appends an audit/activity record. Pass the transaction session of the change. */
export async function logActivity(
  session: Session,
  who: { accountId: string; userId?: string | null },
  entry: ActivityEntry,
): Promise<void> {
  await col('activity_logs').insertOne(
    {
      _id: newId(),
      account_id: who.accountId,
      user_id: who.userId ?? null,
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      summary: entry.summary,
      metadata: entry.metadata ?? null,
      created_at: new Date(),
    },
    opts(session),
  );
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
  query: { page: number; pageSize: number; entityType?: string; entityId?: string },
): Promise<{ items: ActivityItem[]; total: number }> {
  const filter: Record<string, unknown> = { account_id: accountId };
  if (query.entityType) filter.entity_type = query.entityType;
  if (query.entityId) filter.entity_id = query.entityId;

  const [total, rows] = await Promise.all([
    col('activity_logs').countDocuments(filter),
    col('activity_logs')
      .aggregate([
        { $match: filter },
        { $sort: { created_at: -1, _id: -1 } },
        { $skip: (query.page - 1) * query.pageSize },
        { $limit: query.pageSize },
        { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'u' } },
        { $addFields: { actor_name: { $first: '$u.name' } } },
        { $project: { u: 0 } },
      ])
      .toArray(),
  ]);

  return {
    total,
    items: rows.map((r) => ({
      id: r._id,
      action: r.action,
      entityType: r.entity_type ?? null,
      entityId: r.entity_id ?? null,
      summary: r.summary,
      actorName: r.actor_name ?? null,
      createdAt: r.created_at,
    })),
  };
}
