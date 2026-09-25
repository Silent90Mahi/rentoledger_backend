import type { NextFunction, Request, Response } from 'express';
import { db } from '../db/knex.js';
import { Errors } from '../lib/errors.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

/** Verifies the access token and loads the user. */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(req);
  if (!token) throw Errors.unauthorized();
  const { userId } = verifyAccessToken(token);
  const user = await db('users').select('id', 'phone', 'name').where({ id: userId }).first();
  if (!user) throw Errors.unauthorized('Your account no longer exists. Please sign in again.');
  req.user = { id: user.id, phone: user.phone, name: user.name };
  next();
}

/** Requires the user to be an owner or partner of an account (landlord side). */
export async function requireAccount(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.user) throw Errors.unauthorized();
  const row = await db('account_members as m')
    .join('accounts as a', 'a.id', 'm.account_id')
    .select(
      'a.id',
      'a.name',
      'a.timezone',
      'a.gst_enabled',
      'a.gst_rate',
      'a.reminder_days_before',
      'm.role',
    )
    .where('m.user_id', req.user.id)
    .first();
  if (!row) {
    throw Errors.forbidden('Set up your landlord account to access this feature.');
  }
  req.account = {
    id: row.id,
    name: row.name,
    role: row.role,
    timezone: row.timezone,
    gstEnabled: row.gst_enabled,
    gstRate: row.gst_rate,
    reminderDaysBefore: row.reminder_days_before,
  };
  next();
}

/** Restricts an endpoint to the account owner (e.g. managing partners). */
export function requireOwner(req: Request, _res: Response, next: NextFunction): void {
  if (req.account?.role !== 'owner') {
    throw Errors.forbidden('Only the account owner can do this.');
  }
  next();
}

/** Tenant portal: the signed-in phone number must belong to at least one tenant record. */
export async function requireTenant(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.user) throw Errors.unauthorized();
  const ids = await db('tenants')
    .where({ phone: req.user.phone, portal_enabled: true })
    .whereNull('archived_at')
    .pluck('id');
  if (ids.length === 0) {
    throw Errors.forbidden('No rental records are linked to your mobile number yet. Ask your landlord to add you.');
  }
  req.tenantIds = ids;
  next();
}
