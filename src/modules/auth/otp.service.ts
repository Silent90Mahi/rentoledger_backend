import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { col, newId, withTransaction } from '../../db/mongo.js';
import { now } from '../../lib/clock.js';
import { AppError, Errors } from '../../lib/errors.js';
import { maskPhone } from '../../lib/phone.js';
import { smsProvider } from './sms.js';

function hashCode(phone: string, code: string): string {
  return createHmac('sha256', config.otp.secret).update(`${phone}:${code}`).digest('hex');
}

export interface OtpRequestResult {
  phone: string;
  expiresInSeconds: number;
  resendInSeconds: number;
  /** Only present in non-production environments using the console SMS provider. */
  devCode?: string;
}

export async function requestOtp(phone: string, ip?: string): Promise<OtpRequestResult> {
  const current = now();
  const recent = await col('otp_codes')
    .find({ phone, created_at: { $gt: new Date(current.getTime() - 3_600_000) } }, { projection: { created_at: 1 } })
    .sort({ created_at: -1 })
    .toArray();

  if (recent.length >= config.otp.maxPerHour) {
    throw Errors.tooMany('Too many codes requested for this number. Please try again in an hour.');
  }
  if (recent.length > 0) {
    const elapsed = (current.getTime() - new Date(recent[0].created_at).getTime()) / 1000;
    const wait = Math.ceil(config.otp.resendCooldownSeconds - elapsed);
    if (wait > 0) {
      throw new AppError(429, 'TOO_MANY_REQUESTS', `Please wait ${wait} seconds before requesting a new code.`, [
        { field: 'resendInSeconds', message: String(wait) },
      ]);
    }
  }

  const code = config.otp.devCode ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(current.getTime() + config.otp.ttlSeconds * 1000);

  await withTransaction(async (session) => {
    // Only the most recent code is valid.
    await col('otp_codes').updateMany({ phone, consumed_at: null }, { $set: { consumed_at: current } }, { session });
    await col('otp_codes').insertOne(
      {
        _id: newId(),
        phone,
        code_hash: hashCode(phone, code),
        expires_at: expiresAt,
        attempts: 0,
        consumed_at: null,
        ip: ip?.slice(0, 64) ?? null,
        created_at: current,
      },
      { session },
    );
  });

  const minutes = Math.round(config.otp.ttlSeconds / 60);
  try {
    await smsProvider.send(phone, `${code} is your RentOLedger verification code. It expires in ${minutes} minutes. Do not share it with anyone.`);
  } catch (error) {
    logger.error({ err: error, phone: maskPhone(phone) }, 'Failed to send OTP');
    throw Errors.unavailable('We could not send the verification SMS. Please try again shortly.');
  }

  return {
    phone,
    expiresInSeconds: config.otp.ttlSeconds,
    resendInSeconds: config.otp.resendCooldownSeconds,
    ...(config.otp.exposeDevCode ? { devCode: code } : {}),
  };
}

type VerifyOutcome = { kind: 'ok' } | { kind: 'expired' } | { kind: 'locked' } | { kind: 'mismatch'; attemptsLeft: number };

/** Validates a code for the phone number and consumes it. Throws on any failure. */
export async function verifyOtp(phone: string, code: string): Promise<void> {
  // The transaction returns an outcome instead of throwing so that a failed
  // attempt is still committed (throwing would roll the counter back).
  const outcome = await withTransaction<VerifyOutcome>(async (session) => {
    const row = await col('otp_codes').findOne({ phone, consumed_at: null }, { sort: { created_at: -1 }, session });

    if (!row || new Date(row.expires_at).getTime() <= now().getTime()) return { kind: 'expired' };
    if (row.attempts >= config.otp.maxAttempts) return { kind: 'locked' };

    const expected = Buffer.from(row.code_hash, 'hex');
    const actual = Buffer.from(hashCode(phone, code), 'hex');
    const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
    const attempts = row.attempts + 1;

    // Updating the row inside the transaction serialises concurrent attempts (write conflict -> retry).
    if (!matches) {
      await col('otp_codes').updateOne({ _id: row._id }, { $set: { attempts } }, { session });
      return { kind: 'mismatch', attemptsLeft: config.otp.maxAttempts - attempts };
    }

    await col('otp_codes').updateOne({ _id: row._id }, { $set: { consumed_at: now(), attempts } }, { session });
    return { kind: 'ok' };
  });

  switch (outcome.kind) {
    case 'ok':
      return;
    case 'expired':
      throw Errors.badRequest('This code has expired or was replaced. Please request a new one.');
    case 'locked':
      throw Errors.tooMany('Too many incorrect attempts. Please request a new code.');
    case 'mismatch':
      if (outcome.attemptsLeft <= 0) throw Errors.tooMany('Too many incorrect attempts. Please request a new code.');
      throw Errors.badRequest(
        `Incorrect code. ${outcome.attemptsLeft} attempt${outcome.attemptsLeft === 1 ? '' : 's'} left.`,
        [{ field: 'code', message: 'Incorrect code' }],
      );
  }
}
