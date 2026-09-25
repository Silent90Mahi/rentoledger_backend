import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../../lib/http.js';
import { parse, zEmail, zName, zPhone, zText } from '../../lib/validation.js';
import { authenticate } from '../../middleware/auth.js';
import { authLimiter, otpLimiter } from '../../middleware/rate-limit.js';
import { buildSession, completeOnboarding, loginWithOtp } from './auth.service.js';
import { requestOtp } from './otp.service.js';
import { revokeRefreshToken, rotateRefreshToken } from './token.service.js';

export const authRouter = Router();

const phoneBody = z.object({ phone: zPhone });
const verifyBody = z.object({
  phone: zPhone,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
const refreshBody = z.object({ refreshToken: z.string().min(20, 'Invalid refresh token').max(200) });
const onboardingBody = z.object({
  name: zName(120),
  accountName: zText(120),
  email: zEmail,
});

function clientMeta(req: { get(name: string): string | undefined; ip?: string }) {
  return { userAgent: req.get('user-agent'), ip: req.ip };
}

authRouter.post('/otp/request', otpLimiter, async (req, res) => {
  const { phone } = parse(phoneBody, req.body);
  ok(res, await requestOtp(phone, req.ip));
});

authRouter.post('/otp/verify', authLimiter, async (req, res) => {
  const { phone, code } = parse(verifyBody, req.body);
  const result = await loginWithOtp(phone, code, clientMeta(req));
  ok(res, { ...result.tokens, isNewUser: result.isNewUser, session: result.session });
});

authRouter.post('/refresh', authLimiter, async (req, res) => {
  const { refreshToken } = parse(refreshBody, req.body);
  const { tokens } = await rotateRefreshToken(refreshToken, clientMeta(req));
  ok(res, tokens);
});

authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = parse(refreshBody, req.body);
  await revokeRefreshToken(refreshToken);
  ok(res, { loggedOut: true });
});

authRouter.get('/me', authenticate, async (req, res) => {
  ok(res, await buildSession(req.user!.id));
});

authRouter.post('/onboarding', authenticate, async (req, res) => {
  const input = parse(onboardingBody, req.body);
  ok(res, await completeOnboarding(req.user!.id, input));
});
