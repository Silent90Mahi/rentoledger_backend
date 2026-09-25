import type { CreateIndexesOptions, IndexSpecification } from 'mongodb';
import { col, type CollectionName } from './mongo.js';

/**
 * Indexes and uniqueness rules. MongoDB has no CHECK/foreign-key constraints,
 * so rules the old schema enforced are kept here (unique indexes) and in the
 * services (reference and ownership checks inside transactions).
 *
 * Conditional uniqueness uses "key" fields that only exist while the rule
 * applies, with a partial index on `$type: 'string'`:
 * - properties.name_key      lower(name) while not archived   -> unique per account
 * - units.name_key           lower(name) while not archived   -> unique per property
 * - tenants.phone_key        phone while not archived         -> unique per account
 * - agreements.active_unit_id unit_id while status = active   -> one active agreement per unit
 * - rent_charges.rent_period_key "<agreement>|<period_start>" for rent entries -> one entry per period
 */

const onlyStrings = (field: string) => ({ partialFilterExpression: { [field]: { $type: 'string' } } });

const INDEXES: Array<[CollectionName, IndexSpecification, CreateIndexesOptions?]> = [
  ['users', { phone: 1 }, { unique: true, name: 'users_phone_key' }],

  ['account_members', { user_id: 1 }, { unique: true, name: 'account_members_user_key' }],
  ['account_members', { account_id: 1 }, { unique: true, name: 'account_members_one_owner', partialFilterExpression: { role: 'owner' } }],
  ['account_members', { account_id: 1, created_at: 1 }],

  ['otp_codes', { phone: 1, created_at: -1 }],
  ['refresh_tokens', { token_hash: 1 }, { unique: true, name: 'refresh_tokens_hash_key' }],
  ['refresh_tokens', { user_id: 1 }],

  ['properties', { account_id: 1, name_key: 1 }, { unique: true, name: 'properties_account_name_key', ...onlyStrings('name_key') }],
  ['properties', { account_id: 1, created_at: -1 }],

  ['units', { property_id: 1, name_key: 1 }, { unique: true, name: 'units_property_name_key', ...onlyStrings('name_key') }],
  ['units', { account_id: 1 }],
  ['units', { property_id: 1 }],

  ['tenants', { account_id: 1, phone_key: 1 }, { unique: true, name: 'tenants_account_phone_key', ...onlyStrings('phone_key') }],
  ['tenants', { phone: 1 }],
  ['tenants', { account_id: 1, name: 1 }],

  ['agreements', { active_unit_id: 1 }, { unique: true, name: 'agreements_one_active_per_unit', ...onlyStrings('active_unit_id') }],
  ['agreements', { account_id: 1, status: 1 }],
  ['agreements', { tenant_id: 1 }],
  ['agreements', { unit_id: 1, start_date: -1 }],

  ['rent_charges', { rent_period_key: 1 }, { unique: true, name: 'rent_charges_rent_period_key', ...onlyStrings('rent_period_key') }],
  ['rent_charges', { account_id: 1, period_start: 1 }],
  ['rent_charges', { account_id: 1, due_date: 1 }],
  ['rent_charges', { tenant_id: 1, due_date: 1 }],
  ['rent_charges', { agreement_id: 1, period_start: 1 }],
  ['rent_charges', { unit_id: 1 }],

  ['payments', { account_id: 1, paid_on: -1 }],
  ['payments', { tenant_id: 1, paid_on: 1 }],
  ['payments', { account_id: 1, status: 1 }],
  ['payments', { target_charge_id: 1 }, { partialFilterExpression: { target_charge_id: { $type: 'string' } } }],
  ['payments', { agreement_id: 1 }],

  ['payment_allocations', { payment_id: 1, charge_id: 1 }, { unique: true, name: 'payment_allocations_unique' }],
  ['payment_allocations', { charge_id: 1 }],
  ['payment_allocations', { account_id: 1 }],

  ['deposit_transactions', { agreement_id: 1, txn_date: 1 }],
  ['deposit_transactions', { account_id: 1, txn_date: 1 }],
  ['deposit_transactions', { tenant_id: 1 }],

  ['expenses', { account_id: 1, expense_date: -1 }],
  ['expenses', { property_id: 1 }],
  ['expenses', { unit_id: 1 }],

  ['notifications', { user_id: 1, dedupe_key: 1 }, { unique: true, name: 'notifications_user_dedupe_key', ...onlyStrings('dedupe_key') }],
  ['notifications', { user_id: 1, audience: 1, created_at: -1 }],

  ['activity_logs', { account_id: 1, created_at: -1 }],
  ['activity_logs', { entity_type: 1, entity_id: 1 }],
];

/** Creates any missing index (idempotent; safe to run on every start). */
export async function ensureIndexes(): Promise<number> {
  let created = 0;
  for (const [name, spec, options] of INDEXES) {
    await col(name).createIndex(spec, options ?? {});
    created++;
  }
  return created;
}

/** MongoDB duplicate-key error, optionally for a specific index. */
export function isDuplicateKey(error: unknown, indexName?: string): boolean {
  const e = error as { code?: number; message?: string; errmsg?: string };
  if (e?.code !== 11000) return false;
  if (!indexName) return true;
  return `${e.message ?? ''} ${e.errmsg ?? ''}`.includes(indexName);
}

/** Key helpers: keep the conditional-uniqueness fields consistent everywhere. */
export const keys = {
  name: (name: string) => name.trim().toLowerCase(),
  rentPeriod: (agreementId: string, periodStart: string) => `${agreementId}|${periodStart}`,
};
