import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { col } from '../src/db/mongo.js';
import { api, auth, createOwner, createProperty, createTenant, createUnit, freezeToday, leaseSetup, ledger, resetDatabase, V1 } from './helpers.js';

/**
 * MongoDB has no row locks; these tests fire requests at the same time to
 * check that transactions + document locks keep the money and the uniqueness
 * rules consistent.
 */
describe('concurrent requests', () => {
  let owner: string;

  beforeAll(async () => {
    await resetDatabase();
    freezeToday('2026-09-23');
    owner = await createOwner('9300000001', 'Race Owner');
  });

  beforeEach(() => freezeToday('2026-09-23'));

  it('never allocates more than a charge is worth when payments arrive together', async () => {
    const { tenant, agreement } = await leaseSetup(owner, { startDate: '2026-07-01', rentAmount: 10000, dueDay: 5 });
    // Three open months = 30,000 due. Ten simultaneous payments of 5,000 = 50,000.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        api().post(`${V1}/payments`).set(auth(owner)).send({ tenantId: tenant.id, amount: 5000, paidOn: '2026-09-20', method: 'upi', reference: `R${i}` }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);

    const entries = (await ledger(owner, { agreementId: agreement.id, status: 'all' })).data;
    expect(entries).toHaveLength(3);
    for (const e of entries) {
      expect(e.paidAmount).toBe(10000);
      expect(e.balance).toBe(0);
      expect(e.status).toBe('collected');
    }

    // Allocations per charge never exceed the charge, and the extra 20,000 is advance credit.
    const allocations = await col('payment_allocations').find({ charge_id: { $in: entries.map((e: any) => e.id) } }).toArray();
    const total = allocations.reduce((s, a) => s + a.amount, 0);
    expect(total).toBe(30000);
    const detail = (await api().get(`${V1}/tenants/${tenant.id}`).set(auth(owner)).expect(200)).body.data;
    expect(detail.financials.advanceCredit).toBe(20000);
    expect(detail.financials.outstanding).toBe(0);
  });

  it('lets only one of two simultaneous agreements rent out the same unit', async () => {
    const property = await createProperty(owner);
    const unit = await createUnit(owner, property.id);
    const [a, b] = await Promise.all([createTenant(owner), createTenant(owner)]);
    const results = await Promise.all(
      [a, b].map((t) =>
        api()
          .post(`${V1}/agreements`)
          .set(auth(owner))
          .send({ unitId: unit.id, tenantId: t.id, startDate: '2026-09-01', rentAmount: 12000, billingCycle: 'monthly', dueDay: 1 }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await col('agreements').countDocuments({ unit_id: unit.id, status: 'active' })).toBe(1);
  });

  it('generates each rent period once even when many reads trigger generation', async () => {
    const { agreement } = await leaseSetup(owner, { startDate: '2026-01-01', rentAmount: 8000, dueDay: 1 });
    await col('rent_charges').deleteMany({ agreement_id: agreement.id });
    await Promise.all(Array.from({ length: 8 }, () => api().post(`${V1}/rents/generate`).set(auth(owner)).expect(200)));
    const periods = await col('rent_charges').distinct('period_start', { agreement_id: agreement.id, kind: 'rent' });
    const count = await col('rent_charges').countDocuments({ agreement_id: agreement.id, kind: 'rent' });
    expect(count).toBe(9);
    expect(periods).toHaveLength(9);
  });

  it('confirms a tenant-reported payment only once', async () => {
    const { tenant, agreement } = await leaseSetup(owner, { startDate: '2026-09-01', rentAmount: 15000, dueDay: 10 });
    const pending = await api()
      .post(`${V1}/payments`)
      .set(auth(owner))
      .send({ tenantId: tenant.id, agreementId: agreement.id, amount: 15000, paidOn: '2026-09-20', method: 'cheque', status: 'pending' })
      .expect(201);
    const results = await Promise.all(Array.from({ length: 5 }, () => api().post(`${V1}/payments/${pending.body.data.id}/confirm`).set(auth(owner))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    const allocated = await col('payment_allocations').find({ payment_id: pending.body.data.id }).toArray();
    expect(allocated.reduce((s, a) => s + a.amount, 0)).toBe(15000);
  });
});
