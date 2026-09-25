import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { db } from '../../db/knex.js';
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
  const recent = await db('otp_codes')
    .where('phone', phone)
    .where('created_at', '>', new Date(current.getTime() - 3_600_000))
    .orderBy('created_at', 'desc')
    .select('created_at');

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

  await db.transaction(async (trx) => {
    // Only the most recent code is valid.
    await trx('otp_codes').where({ phone }).whereNull('consumed_at').update({ consumed_at: current });
    await trx('otp_codes').insert({
      phone,
      code_hash: hashCode(phone, code),
      expires_at: expiresAt,
      ip: ip?.slice(0, 64) ?? null,
      created_at: current,
    });
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
  const outcome = await db.transaction<VerifyOutcome>(async (trx) => {
    const row = await trx('otp_codes')
      .where({ phone })
      .whereNull('consumed_at')
      .orderBy('created_at', 'desc')
      .forUpdate()
      .first();

    if (!row || new Date(row.expires_at).getTime() <= now().getTime()) return { kind: 'expired' };
    if (row.attempts >= config.otp.maxAttempts) return { kind: 'locked' };

    const expected = Buffer.from(row.code_hash, 'hex');
    const actual = Buffer.from(hashCode(phone, code), 'hex');
    const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
    const attempts = row.attempts + 1;

    if (!matches) {
      await trx('otp_codes').where({ id: row.id }).update({ attempts });
      return { kind: 'mismatch', attemptsLeft: config.otp.maxAttempts - attempts };
    }

    await trx('otp_codes').where({ id: row.id }).update({ consumed_at: now(), attempts });
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
