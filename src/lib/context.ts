import type { Request } from 'express';
import { todayIn } from './clock.js';
import { Errors } from './errors.js';

export type MemberRole = 'owner' | 'partner';

export interface AuthUser {
  id: string;
  phone: string;
  name: string | null;
}

export interface AccountInfo {
  id: string;
  name: string;
  role: MemberRole;
  timezone: string;
  gstEnabled: boolean;
  gstRate: number;
  reminderDaysBefore: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      account?: AccountInfo;
      tenantIds?: string[];
    }
  }
}

/** Everything an owner-side service needs to know about the caller. */
export interface Ctx {
  userId: string;
  userName: string | null;
  accountId: string;
  accountName: string;
  role: MemberRole;
  timezone: string;
  today: string;
  gstEnabled: boolean;
  gstRate: number;
  reminderDaysBefore: number;
}

export function ctxOf(req: Request): Ctx {
  if (!req.user || !req.account) throw Errors.unauthorized();
  return {
    userId: req.user.id,
    userName: req.user.name,
    accountId: req.account.id,
    accountName: req.account.name,
    role: req.account.role,
    timezone: req.account.timezone,
    today: todayIn(req.account.timezone),
    gstEnabled: req.account.gstEnabled,
    gstRate: req.account.gstRate,
    reminderDaysBefore: req.account.reminderDaysBefore,
  };
}

/** Tenant-portal caller: a signed-in user matched to one or more tenant records. */
export interface TenantCtx {
  userId: string;
  phone: string;
  tenantIds: string[];
}

export function tenantCtxOf(req: Request): TenantCtx {
  if (!req.user || !req.tenantIds) throw Errors.unauthorized();
  return { userId: req.user.id, phone: req.user.phone, tenantIds: req.tenantIds };
}
