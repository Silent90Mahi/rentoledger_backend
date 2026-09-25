import { rateLimit, type Options } from 'express-rate-limit';
import { config } from '../config/env.js';

const common: Partial<Options> = {
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => config.isTest,
  handler: (_req, res, _next, options) => {
    res.status(options.statusCode).json({
      success: false,
      error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please slow down and try again shortly.' },
    });
  },
};

/** Broad protection for the whole API. */
export const apiLimiter = rateLimit({
  ...common,
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.max,
});

/** Stricter limits for credential endpoints (per IP). */
export const authLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: config.rateLimit.authMax,
});

/** OTP sending costs money and can be abused for SMS pumping: keep it tight (per IP, per hour). */
export const otpLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60_000,
  limit: config.isProduction ? 20 : 500,
});
