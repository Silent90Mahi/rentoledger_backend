import type { Trx } from '../../db/knex.js';
import type { Ctx } from '../../lib/context.js';
import { Errors } from '../../lib/errors.js';
import { logActivity } from '../activity/activity.service.js';

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
export async function createTenantInTrx(trx: Trx, ctx: Ctx, input: NewTenantInput): Promise<{ id: string; name: string }> {
  const existing = await trx('tenants')
    .where({ account_id: ctx.accountId, phone: input.phone })
    .whereNull('archived_at')
    .first('id', 'name');
  if (existing) {
    throw Errors.conflict(`${existing.name} is already a tenant with this mobile number. Select the existing tenant instead.`, [
      { field: 'newTenant.phone', message: 'Already exists' },
    ]);
  }
  const [row] = await trx('tenants')
    .insert({
      account_id: ctx.accountId,
      name: input.name,
      phone: input.phone,
      email: input.email ?? null,
      business_name: input.businessName ?? null,
      gstin: input.gstin ?? null,
      address: input.address ?? null,
      portal_enabled: input.portalEnabled ?? true,
    })
    .returning(['id', 'name']);
  await logActivity(trx, ctx, { action: 'tenant.created', entityType: 'tenant', entityId: row.id, summary: `Added tenant ${row.name}` });
  return row;
}
