import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, auth, createOwner, entry, freezeToday, leaseSetup, ledger, pay, resetDatabase, V1 } from './helpers.js';

async function entriesOf(token: string, agreementId: string) {
  const body = await ledger(token, { agreementId, status: 'all' });
  return body.data.sort((a: any, b: any) => a.periodStart.localeCompare(b.periodStart));
}

async function tenantDetail(token: string, tenantId: string) {
  return (await api().get(`${V1}/tenants/${tenantId}`).set(auth(token)).expect(200)).body.data;
}

describe('rent, payments and balances', () => {
  let owner: string;

  beforeAll(async () => {
    await resetDatabase();
    freezeToday('2026-09-23');
    owner = await createOwner('9100000001', 'Ledger Owner');
  });

  beforeEach(() => freezeToday('2026-09-23'));

  it('generates monthly entries from the billing start with GST and statuses', async () => {
    const { agreement } = await leaseSetup(owner, {
      startDate: '2025-01-01',
      billingStartDate: '2026-07-01',
      rentAmount: 35000,
      dueDay: 10,
      gstApplicable: true,
      gstRate: 18,
    });
    const entries = await entriesOf(owner, agreement.id);
    expect(entries.map((e: any) => [e.periodStart, e.dueDate, e.totalAmount, e.status])).toEqual([
      ['2026-07-01', '2026-07-10', 41300, 'overdue'],
      ['2026-08-01', '2026-08-10', 41300, 'overdue'],
      ['2026-09-01', '2026-09-10', 41300, 'overdue'],
    ]);
    expect(entries[2]).toMatchObject({ baseAmount: 35000, gstAmount: 6300, daysOverdue: 13, periodLabel: 'September 2026' });
  });

  it('matches the specification example: rent 20,000 + previous due 10,000 - paid 15,000 = 15,000', async () => {
    const { tenant, agreement } = await leaseSetup(owner, { startDate: '2026-08-01', rentAmount: 20000, dueDay: 5 });
    // August: tenant paid only half.
    await pay(owner, { tenantId: tenant.id, amount: 10000, paidOn: '2026-08-06' });
    // September: tenant pays 15,000.
    await pay(owner, { tenantId: tenant.id, amount: 15000, paidOn: '2026-09-12' });

    const [aug, sep] = await entriesOf(owner, agreement.id);
    expect(aug).toMatchObject({ paidAmount: 20000, balance: 0, status: 'collected' });
    expect(sep).toMatchObject({ paidAmount: 5000, balance: 15000, status: 'overdue', isPartial: true });

    const detail = await entry(owner, sep.id);
    expect(detail.calculation).toMatchObject({
      periodTotal: 20000,
      previousDue: 10000,
      totalPayable: 30000,
      paid: 15000,
      remaining: 15000,
    });
    const t = await tenantDetail(owner, tenant.id);
    expect(t.financials).toMatchObject({ outstanding: 15000, overdue: 15000, totalCharged: 40000, totalPaid: 25000, netBalance: 15000 });
  });

  it('treats an opening balance as previous due', async () => {
    const { tenant, agreement } = await leaseSetup(owner, {
      startDate: '2024-04-01',
      billingStartDate: '2026-09-01',
      rentAmount: 20000,
      dueDay: 5,
      openingBalance: { amount: 10000 },
    });
    await pay(owner, { tenantId: tenant.id, amount: 15000, paidOn: '2026-09-15' });
    const entries = await entriesOf(owner, agreement.id);
    const rent = entries.find((e: any) => e.kind === 'rent');
    const opening = entries.find((e: any) => e.kind === 'opening_balance');
    expect(opening).toMatchObject({ totalAmount: 10000, status: 'collected', periodLabel: 'Previous outstanding' });
    const detail = await entry(owner, rent.id);
    expect(detail.calculation).toMatchObject({ previousDue: 10000, periodTotal: 20000, paid: 15000, remaining: 15000 });
  });

  it('supports several partial payments for one period', async () => {
    const { tenant, agreement } = await leaseSetup(owner, {
      startDate: '2026-09-01',
      rentAmount: 20000,
      dueDay: 28,
      gstApplicable: true,
      gstRate: 18,
    });
    const [sep] = await entriesOf(owner, agreement.id);
    expect(sep).toMatchObject({ totalAmount: 23600, status: 'pending' });

    await pay(owner, { tenantId: tenant.id, amount: 10000, paidOn: '2026-09-10', targetChargeId: sep.id });
    let [after] = await entriesOf(owner, agreement.id);
    expect(after).toMatchObject({ paidAmount: 10000, balance: 13600, status: 'pending', isPartial: true });
    const partial = await ledger(owner, { month: '2026-09', status: 'partial', agreementId: agreement.id });
    expect(partial.data).toHaveLength(1);

    await pay(owner, { tenantId: tenant.id, amount: 13600, paidOn: '2026-09-20', method: 'cash' });
    [after] = await entriesOf(owner, agreement.id);
    expect(after).toMatchObject({ paidAmount: 23600, balance: 0, status: 'collected', isPartial: false });
    const detail = await entry(owner, sep.id);
    expect(detail.payments.map((p: any) => [p.allocatedAmount, p.method])).toEqual([
      [10000, 'upi'],
      [13600, 'cash'],
    ]);
  });

  it('keeps advance payments as credit and applies them to future months automatically', async () => {
    const { tenant, agreement } = await leaseSetup(owner, { startDate: '2026-09-01', rentAmount: 10000, dueDay: 1 });
    await pay(owner, { tenantId: tenant.id, amount: 30000, paidOn: '2026-09-01' });
    let t = await tenantDetail(owner, tenant.id);
    expect(t.financials).toMatchObject({ outstanding: 0, advanceCredit: 20000, netBalance: -20000 });

    freezeToday('2026-10-02');
    const entries = await entriesOf(owner, agreement.id);
    expect(entries.map((e: any) => [e.periodStart, e.status])).toEqual([
      ['2026-09-01', 'collected'],
      ['2026-10-01', 'collected'],
    ]);
    t = await tenantDetail(owner, tenant.id);
    expect(t.financials.advanceCredit).toBe(10000);
  });

  it('turns a pending entry overdue once the due date passes', async () => {
    const { agreement } = await leaseSetup(owner, { startDate: '2026-09-01', rentAmount: 8000, dueDay: 25 });
    expect((await entriesOf(owner, agreement.id))[0].status).toBe('pending');
    freezeToday('2026-09-26');
    const [sep] = await entriesOf(owner, agreement.id);
    expect(sep).toMatchObject({ status: 'overdue', daysOverdue: 1 });
  });

  it('"Mark as collected" settles the chosen entry even when older dues exist', async () => {
    const { tenant, agreement } = await leaseSetup(owner, { startDate: '2026-08-01', rentAmount: 12000, dueDay: 5 });
    const [, sep] = await entriesOf(owner, agreement.id);
    const res = await api().post(`${V1}/rents/${sep.id}/collect`).set(auth(owner)).send({ method: 'cash' }).expect(201);
    expect(res.body.data.entry).toMatchObject({ status: 'collected', balance: 0 });
    expect(res.body.data.payment).toMatchObject({ amount: 12000, method: 'cash', status: 'confirmed', allocatedAmount: 12000 });
    const [aug] = await entriesOf(owner, agreement.id);
    expect(aug.status).toBe('overdue');
    // Collecting an already collected entry is a conflict.
    await api().post(`${V1}/rents/${sep.id}/collect`).set(auth(owner)).send({ method: 'cash' }).expect(409);
    const t = await tenantDetail(owner, tenant.id);
    expect(t.financials.outstanding).toBe(12000);
  });

  it('re-allocates when a payment is voided or edited', async () => {
    const { tenant, agreement } = await leaseSetup(owner, { startDate: '2026-08-01', rentAmount: 10000, dueDay: 5 });
    const p1 = await pay(owner, { tenantId: tenant.id, amount: 10000, paidOn: '2026-08-05' });
    const p2 = await pay(owner, { tenantId: tenant.id, amount: 10000, paidOn: '2026-09-05' });
    let entries = await entriesOf(owner, agreement.id);
    expect(entries.map((e: any) => e.status)).toEqual(['collected', 'collected']);

    // Voiding the August payment frees August; September stays paid by p2.
    await api().post(`${V1}/payments/${p1.id}/void`).set(auth(owner)).send({ reason: 'Cheque bounced' }).expect(200);
    entries = await entriesOf(owner, agreement.id);
    expect(entries.map((e: any) => [e.status, e.balance])).toEqual([
      ['overdue', 10000],
      ['collected', 0],
    ]);

    // Reducing p2 to 4,000 re-runs the FIFO allocation (oldest first).
    const edited = await api().patch(`${V1}/payments/${p2.id}`).set(auth(owner)).send({ amount: 4000 }).expect(200);
    expect(edited.body.data).toMatchObject({ amount: 4000, allocatedAmount: 4000 });
    entries = await entriesOf(owner, agreement.id);
    expect(entries.map((e: any) => e.balance)).toEqual([6000, 10000]);
    await api().patch(`${V1}/payments/${p1.id}`).set(auth(owner)).send({ amount: 1 }).expect(409); // void payments are locked
  });

  it('adjusting or cancelling an entry releases money as credit', async () => {
    const { tenant, agreement } = await leaseSetup(owner, { startDate: '2026-09-01', rentAmount: 10000, dueDay: 5 });
    await pay(owner, { tenantId: tenant.id, amount: 10000, paidOn: '2026-09-05' });
    const [sep] = await entriesOf(owner, agreement.id);

    const adjusted = await api().patch(`${V1}/rents/${sep.id}`).set(auth(owner)).send({ baseAmount: 7000, reason: 'Discount' }).expect(200);
    expect(adjusted.body.data).toMatchObject({ totalAmount: 7000, paidAmount: 7000, status: 'collected' });
    let t = await tenantDetail(owner, tenant.id);
    expect(t.financials.advanceCredit).toBe(3000);

    // A new custom charge is paid from the credit immediately.
    const charge = await api()
      .post(`${V1}/rents`)
      .set(auth(owner))
      .send({ agreementId: agreement.id, kind: 'maintenance', amount: 2500, dueDate: '2026-09-20', description: 'Water tank cleaning' })
      .expect(201);
    expect(charge.body.data).toMatchObject({ status: 'collected', paidAmount: 2500, periodLabel: 'Maintenance charge' });

    await api().post(`${V1}/rents/${sep.id}/void`).set(auth(owner)).send({ reason: 'Rent waived' }).expect(200);
    t = await tenantDetail(owner, tenant.id);
    expect(t.financials).toMatchObject({ outstanding: 0, advanceCredit: 7500 });
    const voided = await ledger(owner, { agreementId: agreement.id, status: 'void' });
    expect(voided.data[0]).toMatchObject({ id: sep.id, status: 'void', voidReason: 'Rent waived' });
  });

  it('ends an agreement: pro-rates the last month and cancels later months', async () => {
    const { tenant, agreement, unit } = await leaseSetup(owner, { startDate: '2026-07-01', rentAmount: 30000, dueDay: 1 });
    await pay(owner, { tenantId: tenant.id, amount: 90000, paidOn: '2026-07-01' }); // July, Aug, Sep
    const ended = await api()
      .post(`${V1}/agreements/${agreement.id}/end`)
      .set(auth(owner))
      .send({ endedOn: '2026-08-15', reason: 'Business closed' })
      .expect(200);
    expect(ended.body.data).toMatchObject({ status: 'ended', endedOn: '2026-08-15', phase: 'ended' });

    const entries = await entriesOf(owner, agreement.id);
    expect(entries.map((e: any) => [e.periodStart, e.periodEnd, e.totalAmount, e.status])).toEqual([
      ['2026-07-01', '2026-07-31', 30000, 'collected'],
      ['2026-08-01', '2026-08-15', 14516.13, 'collected'],
    ]);
    // The period after the move-out date is cancelled (hidden from "all", listed under "void").
    const cancelled = (await ledger(owner, { agreementId: agreement.id, status: 'void' })).data;
    expect(cancelled.map((e: any) => [e.periodStart, e.status])).toEqual([['2026-09-01', 'void']]);
    const t = await tenantDetail(owner, tenant.id);
    expect(t.financials).toMatchObject({ outstanding: 0, advanceCredit: 45483.87 });
    const unitDetail = (await api().get(`${V1}/units/${unit.id}`).set(auth(owner)).expect(200)).body.data;
    expect(unitDetail.occupancy).toBe('vacant');
    await api().post(`${V1}/agreements/${agreement.id}/end`).set(auth(owner)).send({ endedOn: '2026-08-20' }).expect(409);
  });

  it('tracks security deposits: received, applied to rent, refunded', async () => {
    const { tenant, agreement } = await leaseSetup(owner, {
      startDate: '2026-09-01',
      rentAmount: 15000,
      dueDay: 5,
      securityDeposit: 45000,
      depositReceived: { amount: 45000, date: '2026-09-01', method: 'bank_transfer' },
    });
    let detail = (await api().get(`${V1}/agreements/${agreement.id}`).set(auth(owner)).expect(200)).body.data;
    expect(detail.deposit).toMatchObject({ agreed: 45000, received: 45000, held: 45000 });

    // Use part of the deposit to settle September's rent.
    detail = (
      await api()
        .post(`${V1}/agreements/${agreement.id}/deposits`)
        .set(auth(owner))
        .send({ type: 'applied', amount: 15000, date: '2026-09-20' })
        .expect(201)
    ).body.data;
    expect(detail.deposit).toMatchObject({ applied: 15000, held: 30000 });
    const [sep] = await entriesOf(owner, agreement.id);
    expect(sep.status).toBe('collected');

    await api()
      .post(`${V1}/agreements/${agreement.id}/deposits`)
      .set(auth(owner))
      .send({ type: 'refunded', amount: 50000, date: '2026-09-21' })
      .expect(400);
    const refunded = (
      await api()
        .post(`${V1}/agreements/${agreement.id}/deposits`)
        .set(auth(owner))
        .send({ type: 'refunded', amount: 30000, date: '2026-09-21', method: 'upi' })
        .expect(201)
    ).body.data;
    expect(refunded.deposit.held).toBe(0);

    // Removing the adjustment puts the rent back to unpaid.
    const applied = refunded.depositTransactions.find((t: any) => t.type === 'applied');
    await api().delete(`${V1}/agreements/${agreement.id}/deposits/${applied.id}`).set(auth(owner)).expect(200);
    const [after] = await entriesOf(owner, agreement.id);
    expect(after.status).toBe('overdue');
    const t = await tenantDetail(owner, tenant.id);
    expect(t.financials.depositHeld).toBe(15000);
  });

  it('records cheques as pending until they clear', async () => {
    const { tenant, agreement } = await leaseSetup(owner, { startDate: '2026-09-01', rentAmount: 9000, dueDay: 5 });
    const [sep] = await entriesOf(owner, agreement.id);
    const cheque = await pay(owner, { tenantId: tenant.id, amount: 9000, paidOn: '2026-09-06', method: 'cheque', status: 'pending', targetChargeId: sep.id, reference: 'CHQ 000123' });
    expect(cheque.status).toBe('pending');
    expect((await entriesOf(owner, agreement.id))[0].status).toBe('to_confirm');
    await api().post(`${V1}/payments/${cheque.id}/confirm`).set(auth(owner)).expect(200);
    expect((await entriesOf(owner, agreement.id))[0].status).toBe('collected');
    await api().post(`${V1}/payments/${cheque.id}/confirm`).set(auth(owner)).expect(409);
  });

  it('bills quarterly agreements per quarter', async () => {
    const { agreement } = await leaseSetup(owner, { startDate: '2026-04-01', rentAmount: 60000, billingCycle: 'quarterly', dueDay: 7 });
    const entries = await entriesOf(owner, agreement.id);
    expect(entries.map((e: any) => [e.periodStart, e.periodEnd, e.periodLabel])).toEqual([
      ['2026-04-01', '2026-06-30', 'Apr 2026 – Jun 2026'],
      ['2026-07-01', '2026-09-30', 'Jul 2026 – Sep 2026'],
    ]);
  });

  it('produces a tenant statement with a running balance', async () => {
    const { tenant } = await leaseSetup(owner, { startDate: '2026-07-01', rentAmount: 10000, dueDay: 5 });
    await pay(owner, { tenantId: tenant.id, amount: 10000, paidOn: '2026-07-06' });
    await pay(owner, { tenantId: tenant.id, amount: 5000, paidOn: '2026-08-07' });
    const res = await api()
      .get(`${V1}/tenants/${tenant.id}/statement`)
      .query({ from: '2026-08-01', to: '2026-09-30' })
      .set(auth(owner))
      .expect(200);
    const s = res.body.data;
    expect(s.openingBalance).toBe(0);
    expect(s.lines.map((l: any) => [l.date, l.type, l.debit, l.credit, l.balance])).toEqual([
      ['2026-08-05', 'charge', 10000, 0, 10000],
      ['2026-08-07', 'payment', 0, 5000, 5000],
      ['2026-09-05', 'charge', 10000, 0, 15000],
    ]);
    expect(s.closingBalance).toBe(15000);
  });

  it('rejects invalid money and dates', async () => {
    const { tenant } = await leaseSetup(owner, { startDate: '2026-09-01', rentAmount: 1000, dueDay: 5 });
    const bad = await api()
      .post(`${V1}/payments`)
      .set(auth(owner))
      .send({ tenantId: tenant.id, amount: -5, paidOn: '2026-02-30', method: 'bitcoin' })
      .expect(400);
    expect(bad.body.error.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['amount', 'paidOn', 'method']));
    await api().post(`${V1}/payments`).set(auth(owner)).send({ tenantId: tenant.id, amount: 10.555, paidOn: '2026-09-01', method: 'cash' }).expect(400);
    const future = await api().post(`${V1}/payments`).set(auth(owner)).send({ tenantId: tenant.id, amount: 10, paidOn: '2026-12-01', method: 'cash' }).expect(400);
    expect(future.body.error.message).toContain('future');
  });
});
