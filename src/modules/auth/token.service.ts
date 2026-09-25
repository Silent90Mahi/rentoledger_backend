import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../../config/env.js';
import { col, newId, withTransaction, type Session } from '../../db/mongo.js';
import { now } from '../../lib/clock.js';
import { Errors } from '../../lib/errors.js';
import { logger } from '../../config/logger.js';

const ISSUER = 'rentoledger-api';
const AUDIENCE = 'rentoledger-app';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export function signAccessToken(userId: string): { token: string; expiresIn: number } {
  const expiresIn = config.auth.accessTokenTtlSeconds;
  const token = jwt.sign({ typ: 'access' }, config.auth.accessSecret, {
    algorithm: 'HS256',
    subject: userId,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn,
  });
  return { token, expiresIn };
}

export function verifyAccessToken(token: string): { userId: string } {
  try {
    const payload = jwt.verify(token, config.auth.accessSecret, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    }) as jwt.JwtPayload;
    if (payload.typ !== 'access' || typeof payload.sub !== 'string') throw Errors.unauthorized('Invalid token.');
    return { userId: payload.sub };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) throw Errors.tokenExpired();
    throw Errors.unauthorized('Invalid or malformed access token.');
  }
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

interface ClientMeta {
  userAgent?: string;
  ip?: string;
}

async function storeRefreshToken(session: Session, userId: string, meta: ClientMeta): Promise<{ id: string; raw: string }> {
  const raw = randomBytes(48).toString('base64url');
  const expiresAt = new Date(now().getTime() + config.auth.refreshTokenTtlDays * 86_400_000);
  const id = newId();
  await col('refresh_tokens').insertOne(
    {
      _id: id,
      user_id: userId,
      token_hash: hashToken(raw),
      expires_at: expiresAt,
      revoked_at: null,
      replaced_by: null,
      user_agent: meta.userAgent?.slice(0, 255) ?? null,
      ip: meta.ip?.slice(0, 64) ?? null,
      created_at: now(),
    },
    session ? { session } : {},
  );
  return { id, raw };
}

export async function issueTokens(session: Session, userId: string, meta: ClientMeta): Promise<IssuedTokens> {
  const access = signAccessToken(userId);
  const refresh = await storeRefreshToken(session, userId, meta);
  return { accessToken: access.token, refreshToken: refresh.raw, expiresIn: access.expiresIn, tokenType: 'Bearer' };
}

/**
 * Exchanges a refresh token for a new token pair (rotation). Presenting a
 * token that was already rotated revokes every session of that user, which
 * contains the damage if a refresh token was stolen.
 */
export async function rotateRefreshToken(raw: string, meta: ClientMeta): Promise<{ userId: string; tokens: IssuedTokens }> {
  // The transaction returns an outcome rather than throwing, so that the
  // "revoke everything" reaction to token reuse is committed, not rolled back.
  const outcome = await withTransaction(async (session) => {
    const row = await col('refresh_tokens').findOne({ token_hash: hashToken(raw) }, { session });
    if (!row) return { kind: 'missing' as const };
    if (row.revoked_at) {
      await col('refresh_tokens').updateMany({ user_id: row.user_id, revoked_at: null }, { $set: { revoked_at: now() } }, { session });
      return { kind: 'reused' as const, userId: row.user_id as string };
    }
    if (new Date(row.expires_at).getTime() <= now().getTime()) return { kind: 'expired' as const };
    // Revoking first (conditional on still being active) makes concurrent rotations of the same token conflict.
    const revoked = await col('refresh_tokens').updateOne(
      { _id: row._id, revoked_at: null },
      { $set: { revoked_at: now() } },
      { session },
    );
    if (revoked.modifiedCount !== 1) return { kind: 'missing' as const };
    const access = signAccessToken(row.user_id);
    const next = await storeRefreshToken(session, row.user_id, meta);
    await col('refresh_tokens').updateOne({ _id: row._id }, { $set: { replaced_by: next.id } }, { session });
    return {
      kind: 'ok' as const,
      userId: row.user_id as string,
      tokens: { accessToken: access.token, refreshToken: next.raw, expiresIn: access.expiresIn, tokenType: 'Bearer' as const },
    };
  });

  switch (outcome.kind) {
    case 'ok':
      return { userId: outcome.userId, tokens: outcome.tokens };
    case 'reused':
      logger.warn({ userId: outcome.userId }, 'Refresh token reuse detected; all sessions revoked');
      throw Errors.unauthorized('Session expired. Please sign in again.');
    case 'missing':
      throw Errors.unauthorized('Session not found. Please sign in again.');
    default:
      throw Errors.unauthorized('Session expired. Please sign in again.');
  }
}

export async function revokeRefreshToken(raw: string): Promise<void> {
  await col('refresh_tokens').updateOne({ token_hash: hashToken(raw), revoked_at: null }, { $set: { revoked_at: now() } });
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await col('refresh_tokens').updateMany({ user_id: userId, revoked_at: null }, { $set: { revoked_at: now() } });
}
