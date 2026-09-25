import { config } from '../../config/env.js';
import { db } from '../../db/knex.js';
import { now } from '../../lib/clock.js';
import { Errors } from '../../lib/errors.js';
import { logActivity } from '../activity/activity.service.js';
import { verifyOtp } from './otp.service.js';
import { issueTokens, type IssuedTokens } from './token.service.js';

export type AppMode = 'owner' | 'tenant';

export interface SessionUser {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  lateRentNotifications: boolean;
}

export interface SessionAccount {
  id: string;
  name: string;
  role: 'owner' | 'partner';
  gstEnabled: boolean;
  gstRate: number;
  timezone: string;
  reminderDaysBefore: number;
  memberCount: number;
}

export interface SessionTenancy {
  tenantId: string;
  tenantName: string;
  accountId: string;
  accountName: string;
}

export interface Session {
  user: SessionUser;
  account: SessionAccount | null;
  tenancies: SessionTenancy[];
  modes: AppMode[];
  defaultMode: AppMode | 'onboarding';
}

export async function buildSession(userId: string): Promise<Session> {
  const user = await db('users').where({ id: userId }).first();
  if (!user) throw Errors.unauthorized('Your account no longer exists. Please sign in again.');

  const membership = await db('account_members as m')
    .join('accounts as a', 'a.id', 'm.account_id')
    .where('m.user_id', userId)
    .select(
      'a.id',
      'a.name',
      'a.gst_enabled',
      'a.gst_rate',
      'a.timezone',
      'a.reminder_days_before',
      'm.role',
      db.raw('(SELECT COUNT(*) FROM account_members x WHERE x.account_id = a.id) AS member_count'),
    )
    .first();

  const tenancies = await db('tenants as t')
    .join('accounts as a', 'a.id', 't.account_id')
    .where({ 't.phone': user.phone, 't.portal_enabled': true })
    .whereNull('t.archived_at')
    .select('t.id as tenant_id', 't.name as tenant_name', 'a.id as account_id', 'a.name as account_name')
    .orderBy('t.created_at');

  const account: SessionAccount | null = membership
    ? {
        id: membership.id,
        name: membership.name,
        role: membership.role,
        gstEnabled: membership.gst_enabled,
        gstRate: membership.gst_rate,
        timezone: membership.timezone,
        reminderDaysBefore: membership.reminder_days_before,
        memberCount: Number(membership.member_count),
      }
    : null;

  const modes: AppMode[] = [];
  if (account) modes.push('owner');
  if (tenancies.length) modes.push('tenant');

  return {
    user: {
      id: user.id,
      phone: user.phone,
      name: user.name,
      email: user.email,
      lateRentNotifications: user.late_rent_notifications,
    },
    account,
    tenancies: tenancies.map((t) => ({
      tenantId: t.tenant_id,
      tenantName: t.tenant_name,
      accountId: t.account_id,
      accountName: t.account_name,
    })),
    modes,
    defaultMode: modes[0] ?? 'onboarding',
  };
}

export async function loginWithOtp(
  phone: string,
  code: string,
  meta: { userAgent?: string; ip?: string },
): Promise<{ tokens: IssuedTokens; session: Session; isNewUser: boolean }> {
  await verifyOtp(phone, code);

  const { userId, isNewUser, tokens } = await db.transaction(async (trx) => {
    let user = await trx('users').where({ phone }).forUpdate().first();
    let created = false;
    if (!user) {
      // Pre-fill the name from a tenant record so tenants are greeted by name.
      const tenant = await trx('tenants').where({ phone }).whereNull('archived_at').orderBy('created_at').first('name');
      [user] = await trx('users')
        .insert({ phone, name: tenant?.name ?? null })
        .returning('*');
      created = true;
    }
    await trx('users').where({ id: user.id }).update({ last_login_at: now() });
    const issued = await issueTokens(trx, user.id, meta);
    return { userId: user.id as string, isNewUser: created, tokens: issued };
  });

  return { tokens, session: await buildSession(userId), isNewUser };
}

export async function completeOnboarding(
  userId: string,
  input: { name: string; accountName?: string | null; email?: string | null },
): Promise<Session> {
  await db.transaction(async (trx) => {
    const existing = await trx('account_members').where({ user_id: userId }).first();
    if (existing) throw Errors.conflict('Your landlord account is already set up.');

    await trx('users')
      .where({ id: userId })
      .update({ name: input.name, ...(input.email !== undefined ? { email: input.email } : {}) });

    const [account] = await trx('accounts')
      .insert({
        name: input.accountName?.trim() || `${input.name.split(' ')[0]}'s Properties`,
        timezone: config.defaults.timezone,
        payee_name: input.name,
      })
      .returning(['id', 'name']);

    await trx('account_members').insert({ account_id: account.id, user_id: userId, role: 'owner' });
    await logActivity(trx, { accountId: account.id, userId }, {
      action: 'account.created',
      entityType: 'account',
      entityId: account.id,
      summary: `${input.name} created the account "${account.name}"`,
    });
  });
  return buildSession(userId);
}
