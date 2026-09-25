import { beforeAll, describe, expect, it } from 'vitest';
import { api, auth, createOwner, freezeToday, leaseSetup, pay, resetDatabase, V1 } from './helpers.js';

/**
 * Controlled portfolio (today = 23 Sep 2026):
 *  A: 20,000 + 18% GST, due 5th, from Aug  -> Aug paid (23,600 on 5 Aug), Sep unpaid (overdue)
 *  B: 10,000, no GST, due 25th, from Sep   -> Sep pending; paid 4,000 on 20 Sep (partial)
 *  C: 15,000, no GST, due 1st, from Sep    -> Sep paid 15,000 on 1 Sep
 * Expenses: 5,000 on property A (10 Sep), 1,200 unassigned (Aug).
 */
describe('dashboard, reports and expenses', () => {
  let owner: string;
  let a: Awaited<ReturnType<typeof leaseSetup>>;
  let b: Awaited<ReturnType<typeof leaseSetup>>;
  let c: Awaited<ReturnType<typeof leaseSetup>>;

  beforeAll(async () => {
    await resetDatabase();
    freezeToday('2026-09-23');
    owner = await createOwner('9500000001', 'Report Owner');
    a = await leaseSetup(owner, { startDate: '2026-08-01', rentAmount: 20000, dueDay: 5, gstApplicable: true, gstRate: 18 }, { name: 'Tenant A', phone: '9500000011' });
    b = await leaseSetup(owner, { startDate: '2026-09-01', rentAmount: 10000, dueDay: 25 }, { name: 'Tenant B', phone: '9500000012' });
    c = await leaseSetup(owner, { startDate: '2026-09-01', rentAmount: 15000, dueDay: 1 }, { name: 'Tenant C', phone: '9500000013' });
    await pay(owner, { tenantId: a.tenant.id, amount: 23600, paidOn: '2026-08-05' });
    await pay(owner, { tenantId: b.tenant.id, amount: 4000, paidOn: '2026-09-20' });
    await pay(owner, { tenantId: c.tenant.id, amount: 15000, paidOn: '2026-09-01', method: 'cash' });
    await api()
      .post(`${V1}/expenses`)
      .set(auth(owner))
      .send({ category: 'repairs', amount: 5000, expenseDate: '2026-09-10', propertyId: a.property.id, payee: 'Plumber' })
      .expect(201);
    await api().post(`${V1}/expenses`).set(auth(owner)).send({ category: 'legal', amount: 1200, expenseDate: '2026-08-12' }).expect(201);
  });

  it('computes the monthly dashboard from transactions', async () => {
    const d = (await api().get(`${V1}/dashboard`).query({ month: '2026-09' }).set(auth(owner)).expect(200)).body.data;
    expect(d.rent).toMatchObject({
      expected: 48600, // 23,600 + 10,000 + 15,000
      collected: 19000, // B 4,000 + C 15,000
      gstCollected: 0,
      counts: { total: 3, collected: 1, pending: 1, overdue: 1, partial: 1 },
      outstanding: 29600, // A 23,600 + B 6,000
      outstandingPrevious: 0,
      overdueAmount: 23600,
    });
    expect(d.rent.collectionRate).toBeCloseTo(39.1, 1);
    expect(d.portfolio).toMatchObject({ properties: 3, units: 3, occupied: 3, vacant: 0, activeTenants: 3 });
    expect(d.finance).toMatchObject({ cashReceived: 19000, expenses: 5000, netIncome: 14000 });
    expect(d.overdue.map((e: any) => e.tenant.name)).toEqual(['Tenant A']);
    expect(d.upcoming[0]).toMatchObject({ source: 'entry', tenant: { name: 'Tenant B' }, amount: 6000, dueDate: '2026-09-25' });
    expect(d.trend.at(-1)).toMatchObject({ month: '2026-09', expected: 48600, collected: 19000 });

    const aug = (await api().get(`${V1}/dashboard`).query({ month: '2026-08' }).set(auth(owner)).expect(200)).body.data;
    expect(aug.rent).toMatchObject({ expected: 23600, collected: 23600, gstCollected: 3600, counts: { collected: 1 } });
    expect(aug.finance).toMatchObject({ cashReceived: 23600, expenses: 1200, netIncome: 22400 });
  });

  it('reports summary, collections, pending, properties, expenses and tenants', async () => {
    const range = { from: '2026-08-01', to: '2026-09-30' };
    const summary = (await api().get(`${V1}/reports/summary`).query(range).set(auth(owner)).expect(200)).body.data;
    expect(summary).toMatchObject({
      expected: 72200,
      collected: 42600,
      gstCollected: 3600,
      outstanding: 29600,
      overdue: 23600,
      expenses: 6200,
      netIncome: 36400,
    });

    const collections = (await api().get(`${V1}/reports/collections`).query(range).set(auth(owner)).expect(200)).body.data;
    expect(collections.series.map((s: any) => [s.period, s.expected, s.collected, s.expenses, s.net])).toEqual([
      ['2026-08', 23600, 23600, 1200, 22400],
      ['2026-09', 48600, 19000, 5000, 14000],
    ]);
    const yearly = (await api().get(`${V1}/reports/collections`).query({ ...range, groupBy: 'year' }).set(auth(owner)).expect(200)).body.data;
    expect(yearly.series).toHaveLength(1);
    expect(yearly.series[0]).toMatchObject({ period: '2026', expected: 72200, collected: 42600 });

    const pending = (await api().get(`${V1}/reports/pending`).set(auth(owner)).expect(200)).body.data;
    expect(pending.totals).toMatchObject({ outstanding: 29600, overdue: 23600 });
    expect(pending.totals.buckets).toMatchObject({ current: 6000, d1_30: 23600 });
    expect(pending.tenants[0]).toMatchObject({ tenant: { name: 'Tenant A' }, overdue: 23600, maxDaysOverdue: 18 });

    const properties = (await api().get(`${V1}/reports/properties`).query(range).set(auth(owner)).expect(200)).body.data;
    const propA = properties.items.find((i: any) => i.property.id === a.property.id);
    expect(propA).toMatchObject({ expected: 47200, collected: 23600, expenses: 5000, net: 18600, outstanding: 23600 });
    expect(properties.unassigned).toMatchObject({ expenses: 1200 });
    expect(properties.totals).toMatchObject({ collected: 42600, expenses: 6200, net: 36400 });

    const expenses = (await api().get(`${V1}/reports/expenses`).query(range).set(auth(owner)).expect(200)).body.data;
    expect(expenses.total).toBe(6200);
    expect(expenses.byCategory.map((x: any) => [x.category, x.amount])).toEqual([
      ['repairs', 5000],
      ['legal', 1200],
    ]);

    const tenants = (await api().get(`${V1}/reports/tenants`).query(range).set(auth(owner)).expect(200)).body;
    const ta = tenants.data.find((t: any) => t.tenant.name === 'Tenant A');
    expect(ta).toMatchObject({ billed: 47200, paid: 23600, outstanding: 23600, payments: 1 });

    await api().get(`${V1}/reports/summary`).query({ from: '2026-10-01', to: '2026-09-01' }).set(auth(owner)).expect(400);
  });

  it('filters payments and expenses with totals', async () => {
    const payments = (await api().get(`${V1}/payments`).query({ from: '2026-09-01', to: '2026-09-30' }).set(auth(owner)).expect(200)).body;
    expect(payments.meta.summary).toMatchObject({ count: 2, amount: 19000 });
    const cash = (await api().get(`${V1}/payments`).query({ method: 'cash' }).set(auth(owner)).expect(200)).body;
    expect(cash.data.map((p: any) => p.tenant.name)).toEqual(['Tenant C']);
    const search = (await api().get(`${V1}/payments`).query({ search: 'tenant b' }).set(auth(owner)).expect(200)).body;
    expect(search.meta.total).toBe(1);

    const list = (await api().get(`${V1}/expenses`).query({ from: '2026-09-01' }).set(auth(owner)).expect(200)).body;
    expect(list.meta.summary).toMatchObject({ count: 1, amount: 5000 });
    const id = list.data[0].id;
    const updated = (await api().patch(`${V1}/expenses/${id}`).set(auth(owner)).send({ amount: 5500, notes: 'Pipe replaced' }).expect(200)).body.data;
    expect(updated).toMatchObject({ amount: 5500, notes: 'Pipe replaced', property: { id: a.property.id }, categoryLabel: 'Repairs' });
    await api().post(`${V1}/expenses`).set(auth(owner)).send({ category: 'repairs', amount: 0, expenseDate: '2026-09-10' }).expect(400);
    await api().delete(`${V1}/expenses/${id}`).set(auth(owner)).expect(204);
    await api().get(`${V1}/expenses/${id}`).set(auth(owner)).expect(404);
    const categories = (await api().get(`${V1}/expenses/categories`).set(auth(owner)).expect(200)).body.data;
    expect(categories.length).toBeGreaterThan(5);
  });

  it('records activity for changes', async () => {
    const activity = (await api().get(`${V1}/account/activity`).set(auth(owner)).expect(200)).body;
    expect(activity.meta.total).toBeGreaterThan(5);
    expect(activity.data.some((x: any) => x.action === 'payment.recorded')).toBe(true);
  });
});
