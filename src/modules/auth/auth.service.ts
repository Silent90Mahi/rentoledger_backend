import { config } from '../../config/env.js';
import { col, newId, withTransaction } from '../../db/mongo.js';
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
  const user = await col('users').findOne({ _id: userId });
  if (!user) throw Errors.unauthorized('Your account no longer exists. Please sign in again.');

  const member = await col('account_members').findOne({ user_id: userId });
  const accountDoc = member ? await col('accounts').findOne({ _id: member.account_id }) : null;
  const membership = member && accountDoc
    ? {
        id: accountDoc._id,
        name: accountDoc.name,
        gst_enabled: accountDoc.gst_enabled,
        gst_rate: accountDoc.gst_rate,
        timezone: accountDoc.timezone,
        reminder_days_before: accountDoc.reminder_days_before,
        role: member.role,
        member_count: await col('account_members').countDocuments({ account_id: accountDoc._id }),
      }
    : null;

  const tenantDocs = await col('tenants')
    .find({ phone: user.phone, portal_enabled: true, archived_at: null })
    .sort({ created_at: 1 })
    .toArray();
  const accountNames = new Map(
    (await col('accounts').find({ _id: { $in: [...new Set(tenantDocs.map((t) => t.account_id))] } }).toArray()).map((a) => [a._id, a.name]),
  );
  const tenancies = tenantDocs
    .filter((t) => accountNames.has(t.account_id))
    .map((t) => ({ tenant_id: t._id, tenant_name: t.name, account_id: t.account_id, account_name: accountNames.get(t.account_id) }));

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
      id: user._id,
      phone: user.phone,
      name: user.name ?? null,
      email: user.email ?? null,
      lateRentNotifications: user.late_rent_notifications !== false,
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

  const { userId, isNewUser, tokens } = await withTransaction(async (session) => {
    let user = await col('users').findOne({ phone }, { session });
    let created = false;
    if (!user) {
      // Pre-fill the name from a tenant record so tenants are greeted by name.
      const tenant = await col('tenants').findOne({ phone, archived_at: null }, { sort: { created_at: 1 }, session });
      user = {
        _id: newId(),
        phone,
        name: tenant?.name ?? null,
        email: null,
        late_rent_notifications: true,
        last_login_at: null,
        created_at: now(),
        updated_at: now(),
      };
      await col('users').insertOne(user, { session });
      created = true;
    }
    // Also serialises concurrent sign-ins of the same user.
    await col('users').updateOne({ _id: user._id }, { $set: { last_login_at: now(), updated_at: now() } }, { session });
    const issued = await issueTokens(session, user._id, meta);
    return { userId: user._id as string, isNewUser: created, tokens: issued };
  });

  return { tokens, session: await buildSession(userId), isNewUser };
}

export async function completeOnboarding(
  userId: string,
  input: { name: string; accountName?: string | null; email?: string | null },
): Promise<Session> {
  await withTransaction(async (session) => {
    const existing = await col('account_members').findOne({ user_id: userId }, { session });
    if (existing) throw Errors.conflict('Your landlord account is already set up.');

    await col('users').updateOne(
      { _id: userId },
      { $set: { name: input.name, updated_at: now(), ...(input.email !== undefined ? { email: input.email } : {}) } },
      { session },
    );

    const account = {
      _id: newId(),
      name: input.accountName?.trim() || `${input.name.split(' ')[0]}'s Properties`,
      gst_enabled: true,
      gst_rate: 18,
      currency: 'INR',
      timezone: config.defaults.timezone,
      reminder_days_before: 3,
      payee_name: input.name,
      upi_id: null,
      bank_account_name: null,
      bank_account_number: null,
      bank_ifsc: null,
      bank_name: null,
      created_at: now(),
      updated_at: now(),
    };
    await col('accounts').insertOne(account, { session });
    await col('account_members').insertOne(
      { _id: newId(), account_id: account._id, user_id: userId, role: 'owner', invited_by: null, created_at: now() },
      { session },
    );
    await logActivity(session, { accountId: account._id, userId }, {
      action: 'account.created',
      entityType: 'account',
      entityId: account._id,
      summary: `${input.name} created the account "${account.name}"`,
    });
  });
  return buildSession(userId);
}
