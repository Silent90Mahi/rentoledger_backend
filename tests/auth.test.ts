import { beforeAll, describe, expect, it } from 'vitest';
import { col } from '../src/db/mongo.js';
import { api, auth, createOwner, freezeToday, login, resetDatabase, V1 } from './helpers.js';

describe('authentication', () => {
  beforeAll(async () => {
    await resetDatabase();
    freezeToday('2026-09-23');
  });

  it('rejects invalid phone numbers', async () => {
    const res = await api().post(`${V1}/auth/otp/request`).send({ phone: '12345' }).expect(400);
    expect(res.body).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    expect(res.body.error.details[0].field).toBe('phone');
  });

  it('sends an OTP and exposes it only in development', async () => {
    const res = await api().post(`${V1}/auth/otp/request`).send({ phone: '98765 00001' }).expect(200);
    expect(res.body.data).toMatchObject({ phone: '+919876500001', expiresInSeconds: 300, devCode: '123456' });
    const stored = await col('otp_codes').findOne({ phone: '+919876500001' });
    expect(stored.code_hash).not.toContain('123456');
  });

  it('counts wrong attempts and locks the code', async () => {
    const phone = '9876500002';
    await api().post(`${V1}/auth/otp/request`).send({ phone }).expect(200);
    for (let i = 4; i >= 1; i--) {
      const res = await api().post(`${V1}/auth/otp/verify`).send({ phone, code: '000000' }).expect(400);
      expect(res.body.error.message).toContain(`${i} attempt`);
    }
    await api().post(`${V1}/auth/otp/verify`).send({ phone, code: '000000' }).expect(429);
    // Even the right code is refused once locked.
    await api().post(`${V1}/auth/otp/verify`).send({ phone, code: '123456' }).expect(429);
  });

  it('rejects a code that was never requested', async () => {
    await api().post(`${V1}/auth/otp/verify`).send({ phone: '9876500003', code: '123456' }).expect(400);
  });

  it('signs up a new user who must onboard as a landlord', async () => {
    const { token, session } = await login('9876500004');
    expect(session.defaultMode).toBe('onboarding');
    expect(session.account).toBeNull();
    await api().get(`${V1}/properties`).set(auth(token)).expect(403);

    const res = await api()
      .post(`${V1}/auth/onboarding`)
      .set(auth(token))
      .send({ name: 'Meera Kapoor', accountName: 'Kapoor Estates' })
      .expect(200);
    expect(res.body.data).toMatchObject({ defaultMode: 'owner', account: { name: 'Kapoor Estates', role: 'owner', gstRate: 18 } });
    await api().get(`${V1}/properties`).set(auth(token)).expect(200);
    // Onboarding twice is a conflict.
    await api().post(`${V1}/auth/onboarding`).set(auth(token)).send({ name: 'Meera' }).expect(409);
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const { refreshToken } = await login('9876500004');
    const first = await api().post(`${V1}/auth/refresh`).send({ refreshToken }).expect(200);
    expect(first.body.data.accessToken).toBeTruthy();
    const second = first.body.data.refreshToken;
    // Old token reused -> every session of the user is revoked.
    await api().post(`${V1}/auth/refresh`).send({ refreshToken }).expect(401);
    await api().post(`${V1}/auth/refresh`).send({ refreshToken: second }).expect(401);
  });

  it('logs out by revoking the refresh token', async () => {
    const { refreshToken } = await login('9876500004');
    await api().post(`${V1}/auth/logout`).send({ refreshToken }).expect(200);
    await api().post(`${V1}/auth/refresh`).send({ refreshToken }).expect(401);
  });

  it('protects endpoints and reports malformed tokens', async () => {
    const res = await api().get(`${V1}/dashboard`).expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    await api().get(`${V1}/dashboard`).set(auth('not-a-token')).expect(401);
  });

  it('updates the profile and notification preference', async () => {
    const token = await createOwner('9876500005', 'Profile Owner');
    const res = await api()
      .patch(`${V1}/users/me`)
      .set(auth(token))
      .send({ name: 'Profile Owner Jr', email: 'OWNER@Example.com', lateRentNotifications: false })
      .expect(200);
    expect(res.body.data.user).toMatchObject({ name: 'Profile Owner Jr', email: 'owner@example.com', lateRentNotifications: false });
  });

  it('returns 404 envelopes for unknown routes and ids', async () => {
    const token = await createOwner('9876500006', 'Route Owner');
    const res = await api().get(`${V1}/does-not-exist`).set(auth(token)).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    await api().get(`${V1}/properties/not-a-uuid`).set(auth(token)).expect(404);
    await api().get(`${V1}/properties/00000000-0000-4000-8000-000000000000`).set(auth(token)).expect(404);
  });
});
