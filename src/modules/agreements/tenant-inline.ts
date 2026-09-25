import type { ClientSession } from 'mongodb';
import { col } from '../../db/mongo.js';
import type { Ctx } from '../../lib/context.js';
import { Errors } from '../../lib/errors.js';
import { logActivity } from '../activity/activity.service.js';
import { newTenantDoc } from '../tenants/tenants.service.js';

export interface NewTenantInput {
  name: string;
  phone: string;
  email?: string | null;
  businessName?: string | null;
  gstin?: string | null;
  address?: string | null;
  portalEnabled?: boolean;
}

/** Creates a tenant as part of the "rent out a unit" flow (same transaction as the agreement). */
export async function createTenantInTrx(session: ClientSession, ctx: Ctx, input: NewTenantInput): Promise<{ id: string; name: string }> {
  const existing = await col('tenants').findOne({ account_id: ctx.accountId, phone: input.phone, archived_at: null }, { session });
  if (existing) {
    throw Errors.conflict(`${existing.name} is already a tenant with this mobile number. Select the existing tenant instead.`, [
      { field: 'newTenant.phone', message: 'Already exists' },
    ]);
  }
  const doc = newTenantDoc(ctx.accountId, {
    name: input.name,
    phone: input.phone,
    email: input.email ?? null,
    businessName: input.businessName ?? null,
    gstin: input.gstin ?? null,
    address: input.address ?? null,
    portalEnabled: input.portalEnabled ?? true,
  });
  await col('tenants').insertOne(doc, { session });
  await logActivity(session, ctx, { action: 'tenant.created', entityType: 'tenant', entityId: doc._id, summary: `Added tenant ${doc.name}` });
  return { id: doc._id, name: doc.name };
}
