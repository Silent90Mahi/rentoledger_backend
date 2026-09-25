import type { NextFunction, Request, Response } from 'express';
import { col } from '../db/mongo.js';
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
  const user = await col('users').findOne({ _id: userId }, { projection: { phone: 1, name: 1 } });
  if (!user) throw Errors.unauthorized('Your account no longer exists. Please sign in again.');
  req.user = { id: user._id, phone: user.phone, name: user.name ?? null };
  next();
}

/** Requires the user to be an owner or partner of an account (landlord side). */
export async function requireAccount(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.user) throw Errors.unauthorized();
  const member = await col('account_members').findOne({ user_id: req.user.id });
  const row = member ? await col('accounts').findOne({ _id: member.account_id }) : null;
  if (!row) {
    throw Errors.forbidden('Set up your landlord account to access this feature.');
  }
  req.account = {
    id: row._id,
    name: row.name,
    role: member!.role,
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
  const ids = (
    await col('tenants')
      .find({ phone: req.user.phone, portal_enabled: true, archived_at: null }, { projection: { _id: 1 } })
      .toArray()
  ).map((t) => t._id);
  if (ids.length === 0) {
    throw Errors.forbidden('No rental records are linked to your mobile number yet. Ask your landlord to add you.');
  }
  req.tenantIds = ids;
  next();
}
