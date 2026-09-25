import { db } from '../../db/knex.js';
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
  const row = await db('accounts').where({ id: ctx.accountId }).first();
  if (!row) throw Errors.notFound('Account');
  const [{ count }] = await db('account_members').where({ account_id: ctx.accountId }).count<{ count: number }[]>({ count: '*' });
  return {
    id: row.id,
    name: row.name,
    role: ctx.role,
    gstEnabled: row.gst_enabled,
    gstRate: Number(row.gst_rate),
    currency: row.currency,
    timezone: row.timezone,
    reminderDaysBefore: row.reminder_days_before,
    payeeName: row.payee_name,
    upiId: row.upi_id,
    bankAccountName: row.bank_account_name,
    bankAccountNumber: row.bank_account_number,
    bankIfsc: row.bank_ifsc,
    bankName: row.bank_name,
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
    await db.transaction(async (trx) => {
      await trx('accounts').where({ id: ctx.accountId }).update(changes);
      const parts: string[] = [];
      if (input.gstRate !== undefined) parts.push(`default GST rate ${input.gstRate}%`);
      if (input.gstEnabled !== undefined) parts.push(`GST ${input.gstEnabled ? 'enabled' : 'disabled'}`);
      if (input.upiId !== undefined || input.bankAccountNumber !== undefined) parts.push('payment details');
      if (input.reminderDaysBefore !== undefined) parts.push(`reminders ${input.reminderDaysBefore} days before due`);
      if (input.name !== undefined) parts.push(`name "${input.name}"`);
      await logActivity(trx, ctx, {
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
  const rows = await db('account_members as m')
    .join('users as u', 'u.id', 'm.user_id')
    .where('m.account_id', ctx.accountId)
    .orderByRaw(`CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.created_at`)
    .select('m.user_id', 'm.role', 'm.created_at', 'u.name', 'u.phone', 'u.last_login_at');
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    phone: r.phone,
    role: r.role,
    isYou: r.user_id === ctx.userId,
    hasSignedIn: r.last_login_at !== null,
    joinedAt: r.created_at,
  }));
}

/** Gives a partner (co-owner, family member, manager) shared access to the account. */
export async function addPartner(ctx: Ctx, input: { name: string; phone: string }): Promise<MemberDto[]> {
  await db.transaction(async (trx) => {
    let user = await trx('users').where({ phone: input.phone }).forUpdate().first();
    if (user) {
      const membership = await trx('account_members').where({ user_id: user.id }).first();
      if (membership?.account_id === ctx.accountId) throw Errors.conflict('This person already has access to your account.');
      if (membership) {
        throw Errors.conflict('This mobile number already manages another RentOLedger account and cannot be added as a partner.');
      }
      if (!user.name) await trx('users').where({ id: user.id }).update({ name: input.name });
    } else {
      [user] = await trx('users').insert({ phone: input.phone, name: input.name }).returning('*');
    }
    await trx('account_members').insert({ account_id: ctx.accountId, user_id: user.id, role: 'partner', invited_by: ctx.userId });
    await trx('notifications').insert({
      user_id: user.id,
      account_id: ctx.accountId,
      audience: 'owner',
      type: 'partner_added',
      title: `You now have access to ${ctx.accountName}`,
      body: `${ctx.userName ?? 'The owner'} shared their rent ledger with you.`,
    });
    await logActivity(trx, ctx, {
      action: 'member.added',
      entityType: 'user',
      entityId: user.id,
      summary: `Shared access with ${input.name} (${maskPhone(input.phone)})`,
    });
  });
  return listMembers(ctx);
}

export async function removeMember(ctx: Ctx, userId: string): Promise<MemberDto[]> {
  await db.transaction(async (trx) => {
    const member = await trx('account_members as m')
      .join('users as u', 'u.id', 'm.user_id')
      .where({ 'm.account_id': ctx.accountId, 'm.user_id': userId })
      .first('m.id', 'm.role', 'u.name');
    if (!member) throw Errors.notFound('Member');
    if (member.role === 'owner') throw Errors.conflict('The account owner cannot be removed.');
    await trx('account_members').where({ id: member.id }).delete();
    await logActivity(trx, ctx, {
      action: 'member.removed',
      entityType: 'user',
      entityId: userId,
      summary: `Removed ${member.name ?? 'a partner'}'s access`,
    });
  });
  return listMembers(ctx);
}

/** Lets a partner leave an account they were added to. */
export async function leaveAccount(ctx: Ctx): Promise<void> {
  if (ctx.role === 'owner') throw Errors.conflict('The owner cannot leave their own account.');
  await db.transaction(async (trx) => {
    await trx('account_members').where({ account_id: ctx.accountId, user_id: ctx.userId }).delete();
    await logActivity(trx, ctx, { action: 'member.left', entityType: 'user', entityId: ctx.userId, summary: `${ctx.userName ?? 'A partner'} left the account` });
  });
}
