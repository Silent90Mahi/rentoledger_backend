import { col, newId, withTransaction } from '../../db/mongo.js';
import type { Ctx } from '../../lib/context.js';
import { isValidTimeZone } from '../../lib/clock.js';
import { Errors } from '../../lib/errors.js';
import { maskPhone } from '../../lib/phone.js';
import { logActivity } from '../activity/activity.service.js';
import { resetGenerationThrottle } from '../rents/generation.service.js';

export interface AccountSettingsDto {
  id: string;
  name: string;
  role: 'owner' | 'partner';
  gstEnabled: boolean;
  gstRate: number;
  currency: string;
  timezone: string;
  reminderDaysBefore: number;
  payeeName: string | null;
  upiId: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  memberCount: number;
  access: 'private' | 'shared';
  createdAt: string;
}

export interface AccountUpdateInput {
  name?: string;
  gstEnabled?: boolean;
  gstRate?: number;
  timezone?: string;
  reminderDaysBefore?: number;
  payeeName?: string | null;
  upiId?: string | null;
  bankAccountName?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
  bankName?: string | null;
}

export async function getAccountSettings(ctx: Ctx): Promise<AccountSettingsDto> {
  const row = await col('accounts').findOne({ _id: ctx.accountId });
  if (!row) throw Errors.notFound('Account');
  const count = await col('account_members').countDocuments({ account_id: ctx.accountId });
  return {
    id: row._id,
    name: row.name,
    role: ctx.role,
    gstEnabled: row.gst_enabled,
    gstRate: Number(row.gst_rate),
    currency: row.currency,
    timezone: row.timezone,
    reminderDaysBefore: row.reminder_days_before,
    payeeName: row.payee_name ?? null,
    upiId: row.upi_id ?? null,
    bankAccountName: row.bank_account_name ?? null,
    bankAccountNumber: row.bank_account_number ?? null,
    bankIfsc: row.bank_ifsc ?? null,
    bankName: row.bank_name ?? null,
    memberCount: Number(count),
    access: Number(count) > 1 ? 'shared' : 'private',
    createdAt: row.created_at,
  };
}

export async function updateAccountSettings(ctx: Ctx, input: AccountUpdateInput): Promise<AccountSettingsDto> {
  if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
    throw Errors.validation('Unknown time zone.', [{ field: 'timezone', message: 'Unknown time zone' }]);
  }
  const map: Record<keyof AccountUpdateInput, string> = {
    name: 'name',
    gstEnabled: 'gst_enabled',
    gstRate: 'gst_rate',
    timezone: 'timezone',
    reminderDaysBefore: 'reminder_days_before',
    payeeName: 'payee_name',
    upiId: 'upi_id',
    bankAccountName: 'bank_account_name',
    bankAccountNumber: 'bank_account_number',
    bankIfsc: 'bank_ifsc',
    bankName: 'bank_name',
  };
  const changes: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(map)) {
    const value = input[key as keyof AccountUpdateInput];
    if (value !== undefined) changes[column] = value;
  }
  if (Object.keys(changes).length) {
    await withTransaction(async (session) => {
      await col('accounts').updateOne({ _id: ctx.accountId }, { $set: { ...changes, updated_at: new Date() } }, { session });
      const parts: string[] = [];
      if (input.gstRate !== undefined) parts.push(`default GST rate ${input.gstRate}%`);
      if (input.gstEnabled !== undefined) parts.push(`GST ${input.gstEnabled ? 'enabled' : 'disabled'}`);
      if (input.upiId !== undefined || input.bankAccountNumber !== undefined) parts.push('payment details');
      if (input.reminderDaysBefore !== undefined) parts.push(`reminders ${input.reminderDaysBefore} days before due`);
      if (input.name !== undefined) parts.push(`name "${input.name}"`);
      await logActivity(session, ctx, {
        action: 'account.updated',
        entityType: 'account',
        entityId: ctx.accountId,
        summary: `Updated settings${parts.length ? `: ${parts.join(', ')}` : ''}`,
      });
    });
    if (input.timezone !== undefined) resetGenerationThrottle(ctx.accountId);
  }
  return getAccountSettings(ctx);
}

export interface MemberDto {
  userId: string;
  name: string | null;
  phone: string;
  role: 'owner' | 'partner';
  isYou: boolean;
  hasSignedIn: boolean;
  joinedAt: string;
}

export async function listMembers(ctx: Ctx): Promise<MemberDto[]> {
  const members = await col('account_members').find({ account_id: ctx.accountId }).sort({ created_at: 1 }).toArray();
  const users = new Map((await col('users').find({ _id: { $in: members.map((m) => m.user_id) } }).toArray()).map((u) => [u._id, u]));
  return members
    .filter((m) => users.has(m.user_id))
    .sort((a, b) => (a.role === 'owner' ? 0 : 1) - (b.role === 'owner' ? 0 : 1))
    .map((m) => {
      const u = users.get(m.user_id)!;
      return {
        userId: m.user_id,
        name: u.name ?? null,
        phone: u.phone,
        role: m.role,
        isYou: m.user_id === ctx.userId,
        hasSignedIn: u.last_login_at !== null && u.last_login_at !== undefined,
        joinedAt: m.created_at,
      };
    });
}

/** Gives a partner (co-owner, family member, manager) shared access to the account. */
export async function addPartner(ctx: Ctx, input: { name: string; phone: string }): Promise<MemberDto[]> {
  await withTransaction(async (session) => {
    let user = await col('users').findOne({ phone: input.phone }, { session });
    if (user) {
      const membership = await col('account_members').findOne({ user_id: user._id }, { session });
      if (membership?.account_id === ctx.accountId) throw Errors.conflict('This person already has access to your account.');
      if (membership) {
        throw Errors.conflict('This mobile number already manages another RentOLedger account and cannot be added as a partner.');
      }
      if (!user.name) await col('users').updateOne({ _id: user._id }, { $set: { name: input.name, updated_at: new Date() } }, { session });
    } else {
      user = {
        _id: newId(),
        phone: input.phone,
        name: input.name,
        email: null,
        late_rent_notifications: true,
        last_login_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      await col('users').insertOne(user, { session });
    }
    await col('account_members').insertOne(
      { _id: newId(), account_id: ctx.accountId, user_id: user._id, role: 'partner', invited_by: ctx.userId, created_at: new Date() },
      { session },
    );
    await col('notifications').insertOne(
      {
        _id: newId(),
        user_id: user._id,
        account_id: ctx.accountId,
        audience: 'owner',
        type: 'partner_added',
        title: `You now have access to ${ctx.accountName}`,
        body: `${ctx.userName ?? 'The owner'} shared their rent ledger with you.`,
        entity_type: null,
        entity_id: null,
        data: null,
        read_at: null,
        created_at: new Date(),
      },
      { session },
    );
    await logActivity(session, ctx, {
      action: 'member.added',
      entityType: 'user',
      entityId: user._id,
      summary: `Shared access with ${input.name} (${maskPhone(input.phone)})`,
    });
  });
  return listMembers(ctx);
}

export async function removeMember(ctx: Ctx, userId: string): Promise<MemberDto[]> {
  await withTransaction(async (session) => {
    const member = await col('account_members').findOne({ account_id: ctx.accountId, user_id: userId }, { session });
    if (!member) throw Errors.notFound('Member');
    if (member.role === 'owner') throw Errors.conflict('The account owner cannot be removed.');
    const user = await col('users').findOne({ _id: userId }, { session });
    await col('account_members').deleteOne({ _id: member._id }, { session });
    await logActivity(session, ctx, {
      action: 'member.removed',
      entityType: 'user',
      entityId: userId,
      summary: `Removed ${user?.name ?? 'a partner'}'s access`,
    });
  });
  return listMembers(ctx);
}

/** Lets a partner leave an account they were added to. */
export async function leaveAccount(ctx: Ctx): Promise<void> {
  if (ctx.role === 'owner') throw Errors.conflict('The owner cannot leave their own account.');
  await withTransaction(async (session) => {
    await col('account_members').deleteOne({ account_id: ctx.accountId, user_id: ctx.userId }, { session });
    await logActivity(session, ctx, { action: 'member.left', entityType: 'user', entityId: ctx.userId, summary: `${ctx.userName ?? 'A partner'} left the account` });
  });
}
