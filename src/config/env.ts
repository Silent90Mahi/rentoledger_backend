import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Values are read from process.env, optionally pre-populated from a `.env`
 * file in the working directory (or the file pointed to by ENV_FILE).
 * Real environment variables always win over values in the file.
 */
const envFile = process.env.ENV_FILE ?? path.resolve(process.cwd(), '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const booleanFlag = (defaultValue: boolean) =>
  z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(value);
    });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_PREFIX: z.string().default('/api/v1'),

  MONGODB_URI: z.string().optional(),
  MONGODB_DB: z.string().trim().min(1).max(63).default('rentoledger'),
  MONGODB_POOL_MAX: z.coerce.number().int().min(2).max(500).default(20),

  JWT_ACCESS_SECRET: z.string().optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  OTP_SECRET: z.string().optional(),
  OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(600).default(30),
  OTP_MAX_PER_HOUR: z.coerce.number().int().min(1).max(100).optional(),
  DEV_OTP_CODE: z
    .string()
    .regex(/^\d{6}$/, 'DEV_OTP_CODE must be exactly 6 digits')
    .optional(),
  EXPOSE_DEV_OTP: booleanFlag(true),
  // TEMPORARY, for demos before SMS is set up: return the sign-in code in the API response
  // (the app then fills it in automatically). Anyone who knows a phone number can sign in as it.
  OTP_DEMO_MODE: booleanFlag(false),

  SMS_PROVIDER: z.enum(['console', 'twilio']).default('console'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  ALLOW_CONSOLE_SMS_IN_PRODUCTION: booleanFlag(false),

  CORS_ORIGINS: z.string().optional(),
  TRUST_PROXY: z.string().default('false'),
  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),
  RATE_LIMIT_MAX: z.coerce.number().int().min(10).default(1500),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(3).optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  LOG_PRETTY: z.string().optional(),

  JOBS_ENABLED: booleanFlag(true),
  JOBS_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),

  DEFAULT_TIMEZONE: z.string().default('Asia/Kolkata'),
  DEFAULT_COUNTRY_CODE: z
    .string()
    .regex(/^\+\d{1,3}$/)
    .default('+91'),
});

// Blank values (e.g. `JWT_ACCESS_SECRET=` copied from .env.example) count as unset.
const rawEnv = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined && value.trim() !== ''));
const parsed = EnvSchema.safeParse(rawEnv);
if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${details}`);
  process.exit(1);
}

const env = parsed.data;
const isProduction = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

const DEV_ACCESS_SECRET = 'dev-only-access-secret-change-me-0123456789abcdef';
const DEV_OTP_SECRET = 'dev-only-otp-secret-change-me-0123456789';

function fail(message: string): never {
  // eslint-disable-next-line no-console
  console.error(`Configuration error: ${message}`);
  process.exit(1);
}

if (isProduction) {
  if (!env.MONGODB_URI) fail('MONGODB_URI is required in production.');
  if (!env.JWT_ACCESS_SECRET || env.JWT_ACCESS_SECRET.length < 32) {
    fail('JWT_ACCESS_SECRET must be set to a random string of at least 32 characters in production.');
  }
  if (!env.OTP_SECRET || env.OTP_SECRET.length < 16) {
    fail('OTP_SECRET must be set to a random string of at least 16 characters in production.');
  }
  if (env.DEV_OTP_CODE) fail('DEV_OTP_CODE must not be set in production.');
  if (env.SMS_PROVIDER === 'console' && !env.ALLOW_CONSOLE_SMS_IN_PRODUCTION && !env.OTP_DEMO_MODE) {
    fail('SMS_PROVIDER=console cannot deliver OTPs in production. Configure twilio or set ALLOW_CONSOLE_SMS_IN_PRODUCTION=true.');
  }
}

if (env.SMS_PROVIDER === 'twilio' && (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER)) {
  fail('SMS_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER.');
}

function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function parseCorsOrigins(value: string | undefined): string[] | '*' | 'dev-localhost' {
  if (!value || value.trim() === '') return isProduction ? [] : 'dev-localhost';
  if (value.trim() === '*') return '*';
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export const config = {
  env: env.NODE_ENV,
  isProduction,
  isTest,
  isDevelopment: env.NODE_ENV === 'development',
  server: {
    host: env.HOST,
    port: env.PORT,
    apiPrefix: env.API_PREFIX.replace(/\/$/, ''),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  },
  db: {
    uri: env.MONGODB_URI,
    name: env.MONGODB_DB,
    poolMax: env.MONGODB_POOL_MAX,
  },
  auth: {
    accessSecret: env.JWT_ACCESS_SECRET ?? DEV_ACCESS_SECRET,
    accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    usingDevSecrets: !env.JWT_ACCESS_SECRET || !env.OTP_SECRET,
  },
  otp: {
    secret: env.OTP_SECRET ?? DEV_OTP_SECRET,
    ttlSeconds: env.OTP_TTL_SECONDS,
    maxAttempts: env.OTP_MAX_ATTEMPTS,
    resendCooldownSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
    // Strict in production (SMS costs money); relaxed for local development and tests.
    maxPerHour: env.OTP_MAX_PER_HOUR ?? (isProduction ? 6 : 60),
    devCode: isProduction ? undefined : env.DEV_OTP_CODE,
    exposeDevCode: env.OTP_DEMO_MODE || (!isProduction && env.EXPOSE_DEV_OTP && env.SMS_PROVIDER === 'console'),
    demoMode: env.OTP_DEMO_MODE,
  },
  sms: {
    provider: env.SMS_PROVIDER,
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      fromNumber: env.TWILIO_FROM_NUMBER,
    },
  },
  cors: {
    origins: parseCorsOrigins(env.CORS_ORIGINS),
  },
  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MINUTES * 60_000,
    max: env.RATE_LIMIT_MAX,
    authMax: env.AUTH_RATE_LIMIT_MAX ?? (isProduction ? 30 : 300),
  },
  log: {
    level: env.LOG_LEVEL ?? (isTest ? 'silent' : isProduction ? 'info' : 'debug'),
    pretty: env.LOG_PRETTY ? env.LOG_PRETTY === 'true' : env.NODE_ENV === 'development',
  },
  jobs: {
    enabled: env.JOBS_ENABLED && !isTest,
    intervalMinutes: env.JOBS_INTERVAL_MINUTES,
  },
  defaults: {
    timezone: env.DEFAULT_TIMEZONE,
    countryCode: env.DEFAULT_COUNTRY_CODE,
  },
} as const;

export type AppConfig = typeof config;
