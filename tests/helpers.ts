import request from 'supertest';
import { createApp } from '../src/app.js';
import { getDb } from '../src/db/knex.js';
import { migrateLatest } from '../src/db/migrate.js';
import { setNowForTests } from '../src/lib/clock.js';
import { resetGenerationThrottle } from '../src/modules/rents/generation.service.js';

export const app = createApp();
export const api = () => request(app);
export const V1 = '/api/v1';

let migrated = false;

/** Empties every table (schema is migrated once per worker). */
export async function resetDatabase(): Promise<void> {
  const db = getDb();
  if (!migrated) {
    await migrateLatest(db);
    migrated = true;
  }
  await db.raw(`TRUNCATE users, accounts, account_members, otp_codes, refresh_tokens, properties, units, tenants,
                agreements, rent_charges, payments, payment_allocations, deposit_transactions, expenses,
                notifications, activity_logs RESTART IDENTITY CASCADE`);
  resetGenerationThrottle();
}

/** Freezes the application clock at noon IST on the given date. */
export function freezeToday(date: string): void {
  setNowForTests(`${date}T06:30:00.000Z`);
  resetGenerationThrottle();
}

export function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function login(phone: string): Promise<{ token: string; refreshToken: string; session: any }> {
  await api().post(`${V1}/auth/otp/request`).send({ phone }).expect(200);
  const res = await api().post(`${V1}/auth/otp/verify`).send({ phone, code: '123456' }).expect(200);
  return { token: res.body.data.accessToken, refreshToken: res.body.data.refreshToken, session: res.body.data.session };
}

/** Signs up a new landlord and returns their access token. */
export async function createOwner(phone = '9000000001', name = 'Test Owner'): Promise<string> {
  const { token } = await login(phone);
  await api().post(`${V1}/auth/onboarding`).set(auth(token)).send({ name, accountName: `${name} Estates` }).expect(200);
  return token;
}

export async function createProperty(token: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await api()
    .post(`${V1}/properties`)
    .set(auth(token))
    .send({ name: `Property ${Math.random().toString(36).slice(2, 7)}`, type: 'complex', ...body });
  if (res.status !== 201) throw new Error(`createProperty failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

export async function createUnit(token: string, propertyId: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await api()
    .post(`${V1}/units`)
    .set(auth(token))
    .send({ propertyId, name: `Unit ${Math.random().toString(36).slice(2, 7)}`, type: 'shop', ...body });
  if (res.status !== 201) throw new Error(`createUnit failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

export async function createTenant(token: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await api()
    .post(`${V1}/tenants`)
    .set(auth(token))
    .send({ name: 'Tenant', phone: `98${Math.floor(10000000 + Math.random() * 89999999)}`, ...body });
  if (res.status !== 201) throw new Error(`createTenant failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

export async function createAgreement(token: string, body: Record<string, unknown>): Promise<any> {
  const res = await api().post(`${V1}/agreements`).set(auth(token)).send(body);
  if (res.status !== 201) throw new Error(`createAgreement failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

/** Property + unit + tenant + agreement in one go. */
export async function leaseSetup(
  token: string,
  agreement: Record<string, unknown>,
  tenant: Record<string, unknown> = {},
): Promise<{ property: any; unit: any; tenant: any; agreement: any }> {
  const property = await createProperty(token);
  const unit = await createUnit(token, property.id);
  const t = await createTenant(token, tenant);
  // Tests bill from the agreement start and are GST-free unless they say otherwise.
  const a = await createAgreement(token, {
    unitId: unit.id,
    tenantId: t.id,
    billingCycle: 'monthly',
    billingStartDate: agreement.startDate,
    gstApplicable: false,
    ...agreement,
  });
  return { property, unit, tenant: t, agreement: a };
}

export async function ledger(token: string, query: Record<string, string | number> = {}): Promise<any> {
  const res = await api().get(`${V1}/rents`).query({ pageSize: 100, ...query }).set(auth(token)).expect(200);
  return res.body;
}

export async function entry(token: string, id: string): Promise<any> {
  const res = await api().get(`${V1}/rents/${id}`).set(auth(token)).expect(200);
  return res.body.data;
}

export async function pay(token: string, body: Record<string, unknown>): Promise<any> {
  const res = await api().post(`${V1}/payments`).set(auth(token)).send({ method: 'upi', ...body });
  if (res.status !== 201) throw new Error(`payment failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}
