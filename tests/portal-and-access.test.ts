import { beforeAll, describe, expect, it } from 'vitest';
import { runReminderTasks } from '../src/jobs/tasks.js';
import { api, auth, createOwner, freezeToday, leaseSetup, ledger, login, resetDatabase, V1 } from './helpers.js';

describe('tenant portal', () => {
  let owner: string;
  let tenantToken: string;
  let lease: Awaited<ReturnType<typeof leaseSetup>>;

  beforeAll(async () => {
    await resetDatabase();
    freezeToday('2026-09-23');
    owner = await createOwner('9200000001', 'Portal Owner');
    await api()
      .patch(`${V1}/account`)
      .set(auth(owner))
      .send({ upiId: 'portal.owner@okicici', payeeName: 'Portal Owner' })
      .expect(200);
    lease = await leaseSetup(
      owner,
      { startDate: '2026-08-01', rentAmount: 22000, dueDay: 5, gstApplicable: true, gstRate: 18 },
      { name: 'Ayushi Sharma', phone: '9812345673' },
    );
    // August paid, September outstanding.
    await api()
      .post(`${V1}/payments`)
      .set(auth(owner))
      .send({ tenantId: lease.tenant.id, amount: 25960, paidOn: '2026-08-05', method: 'upi' })
      .expect(201);
    const { token, session } = await login('9812345673');
    tenantToken = token;
    expect(session).toMatchObject({ defaultMode: 'tenant', modes: ['tenant'], user: { name: 'Ayushi Sharma' } });
  });

  it('shows the amount due, the rent entries and how to pay', async () => {
    const res = await api().get(`${V1}/portal/summary`).set(auth(tenantToken)).expect(200);
    const s = res.body.data;
    expect(s).toMatchObject({ name: 'Ayushi Sharma', month: '2026-09', amountDue: 25960, counts: { total: 1, pending: 1, paid: 0 } });
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ unit: { name: lease.unit.name }, baseAmount: 22000, gstAmount: 3960, totalAmount: 25960, status: 'overdue' });
    expect(s.landlords[0]).toMatchObject({ upiId: 'portal.owner@okicici', payeeName: 'Portal Owner' });

    const history = await api().get(`${V1}/portal/charges`).set(auth(tenantToken)).expect(200);
    expect(history.body.data.map((e: any) => [e.month, e.status])).toEqual([
      ['2026-09', 'overdue'],
      ['2026-08', 'collected'],
    ]);
  });

  it('lets the tenant report a payment that the owner then confirms', async () => {
    const summary = (await api().get(`${V1}/portal/summary`).set(auth(tenantToken)).expect(200)).body.data;
    const chargeId = summary.entries[0].id;
    const submitted = await api()
      .post(`${V1}/portal/payments`)
      .set(auth(tenantToken))
      .send({ chargeId, amount: 25960, paidOn: '2026-09-23', method: 'upi', reference: 'UPI428631907215' })
      .expect(201);
    expect(submitted.body.data).toMatchObject({ status: 'pending', source: 'tenant', amount: 25960 });
    // Duplicate submissions are rejected.
    await api()
      .post(`${V1}/portal/payments`)
      .set(auth(tenantToken))
      .send({ chargeId, amount: 25960, paidOn: '2026-09-23', method: 'upi', reference: 'UPI428631907215' })
      .expect(409);

    const toConfirm = await ledger(owner, { month: '2026-09', status: 'to_confirm' });
    expect(toConfirm.data).toHaveLength(1);
    expect(toConfirm.meta.counts.to_confirm).toBe(1);
    const ownerNotes = (await api().get(`${V1}/notifications`).set(auth(owner)).expect(200)).body;
    expect(ownerNotes.data.some((n: any) => n.type === 'payment_submitted')).toBe(true);

    const detail = (await api().get(`${V1}/rents/${chargeId}`).set(auth(owner)).expect(200)).body.data;
    expect(detail.pendingPayments).toHaveLength(1);
    await api().post(`${V1}/payments/${detail.pendingPayments[0].id}/confirm`).set(auth(owner)).expect(200);

    const after = (await api().get(`${V1}/portal/summary`).set(auth(tenantToken)).expect(200)).body.data;
    expect(after).toMatchObject({ amountDue: 0, counts: { paid: 1, pending: 0 } });
    const tenantNotes = (await api().get(`${V1}/notifications`).query({ audience: 'tenant' }).set(auth(tenantToken)).expect(200)).body;
    expect(tenantNotes.data.some((n: any) => n.type === 'payment_confirmed')).toBe(true);
  });

  it('lets the owner reject and the tenant withdraw submissions', async () => {
    const p1 = (
      await api()
        .post(`${V1}/portal/payments`)
        .set(auth(tenantToken))
        .send({ amount: 5000, paidOn: '2026-09-22', method: 'cash' })
        .expect(201)
    ).body.data;
    await api().post(`${V1}/payments/${p1.id}/reject`).set(auth(owner)).send({ reason: 'Not received' }).expect(200);
    const payments = (await api().get(`${V1}/portal/payments`).set(auth(tenantToken)).expect(200)).body.data;
    expect(payments.find((p: any) => p.id === p1.id)).toMatchObject({ status: 'rejected', rejectedReason: 'Not received' });

    const p2 = (
      await api()
        .post(`${V1}/portal/payments`)
        .set(auth(tenantToken))
        .send({ amount: 6000, paidOn: '2026-09-22', method: 'upi', reference: 'X1' })
        .expect(201)
    ).body.data;
    await api().delete(`${V1}/portal/payments/${p2.id}`).set(auth(tenantToken)).expect(204);
    await api().delete(`${V1}/portal/payments/${p1.id}`).set(auth(tenantToken)).expect(409);
  });

  it('keeps tenants out of landlord endpoints and other tenants’ data', async () => {
    await api().get(`${V1}/dashboard`).set(auth(tenantToken)).expect(403);
    await api().get(`${V1}/tenants`).set(auth(tenantToken)).expect(403);
    const other = await leaseSetup(owner, { startDate: '2026-09-01', rentAmount: 1000, dueDay: 5 }, { name: 'Someone Else', phone: '9812340000' });
    const otherEntry = (await ledger(owner, { agreementId: other.agreement.id })).data[0];
    await api().get(`${V1}/portal/charges/${otherEntry.id}`).set(auth(tenantToken)).expect(404);
    await api()
      .post(`${V1}/portal/payments`)
      .set(auth(tenantToken))
      .send({ chargeId: otherEntry.id, amount: 1000, paidOn: '2026-09-22', method: 'cash' })
      .expect(400);
    // A phone number without tenancies has no portal.
    const { token } = await login('9812349999');
    await api().get(`${V1}/portal/summary`).set(auth(token)).expect(403);
  });
});

describe('shared access (partners)', () => {
  let owner: string;

  beforeAll(async () => {
    await resetDatabase();
    freezeToday('2026-09-23');
    owner = await createOwner('9300000001', 'Sharing Owner');
  });

  it('adds a partner who then sees the same data', async () => {
    const members = (
      await api().post(`${V1}/account/members`).set(auth(owner)).send({ name: 'Priya Partner', phone: '9300000002' }).expect(201)
    ).body.data;
    expect(members.map((m: any) => [m.name, m.role])).toEqual([
      ['Sharing Owner', 'owner'],
      ['Priya Partner', 'partner'],
    ]);
    const account = (await api().get(`${V1}/account`).set(auth(owner)).expect(200)).body.data;
    expect(account).toMatchObject({ access: 'shared', memberCount: 2 });

    await leaseSetup(owner, { startDate: '2026-09-01', rentAmount: 5000, dueDay: 5 });
    const { token: partner, session } = await login('9300000002');
    expect(session.account).toMatchObject({ role: 'partner', name: 'Sharing Owner Estates' });
    const list = (await api().get(`${V1}/properties`).set(auth(partner)).expect(200)).body;
    expect(list.meta.total).toBe(1);

    // Partners cannot manage members.
    await api().post(`${V1}/account/members`).set(auth(partner)).send({ name: 'X', phone: '9300000003' }).expect(403);
    await api().post(`${V1}/account/members`).set(auth(owner)).send({ name: 'Again', phone: '9300000002' }).expect(409);
  });

  it('removing a partner revokes access immediately', async () => {
    const { token: partner, session } = await login('9300000002');
    await api().delete(`${V1}/account/members/${session.user.id}`).set(auth(owner)).expect(200);
    await api().get(`${V1}/properties`).set(auth(partner)).expect(403);
  });
});

describe('notifications and reminders', () => {
  let owner: string;
  let partner: string;

  beforeAll(async () => {
    await resetDatabase();
    freezeToday('2026-09-23');
    owner = await createOwner('9400000001', 'Notify Owner');
    await api().post(`${V1}/account/members`).set(auth(owner)).send({ name: 'Quiet Partner', phone: '9400000002' }).expect(201);
    partner = (await login('9400000002')).token;
    await api().patch(`${V1}/users/me`).set(auth(partner)).send({ lateRentNotifications: false }).expect(200);
    await leaseSetup(owner, { startDate: '2026-09-01', rentAmount: 7000, dueDay: 5 }, { name: 'Late Payer', phone: '9400000010' });
    await leaseSetup(owner, { startDate: '2026-09-01', rentAmount: 9000, dueDay: 25 }, { name: 'Soon Payer', phone: '9400000011' });
    await login('9400000011'); // tenant has the app
  });

  it('notifies owners about overdue rent once, respecting preferences', async () => {
    const first = await runReminderTasks();
    expect(first.overdue).toBe(1); // owner only; partner opted out
    const again = await runReminderTasks();
    expect(again.overdue).toBe(0); // de-duplicated

    const notes = (await api().get(`${V1}/notifications`).set(auth(owner)).expect(200)).body;
    const overdue = notes.data.find((n: any) => n.type === 'rent_overdue');
    expect(overdue.title).toContain('rent overdue');
    expect(notes.meta.unread).toBeGreaterThan(0);
    const partnerNotes = (await api().get(`${V1}/notifications`).set(auth(partner)).expect(200)).body;
    expect(partnerNotes.data.filter((n: any) => n.type === 'rent_overdue')).toHaveLength(0);
  });

  it('reminds tenants shortly before the due date', async () => {
    freezeToday('2026-09-23'); // due on the 25th, reminder window is 3 days
    const report = await runReminderTasks();
    expect(report.dueSoon).toBe(0); // already sent in the previous run
    const tenant = await login('9400000011');
    const notes = (await api().get(`${V1}/notifications`).query({ audience: 'tenant' }).set(auth(tenant.token)).expect(200)).body;
    expect(notes.data.map((n: any) => n.type)).toContain('rent_due_soon');
  });

  it('marks notifications as read', async () => {
    const list = (await api().get(`${V1}/notifications`).set(auth(owner)).expect(200)).body;
    await api().post(`${V1}/notifications/${list.data[0].id}/read`).set(auth(owner)).expect(200);
    await api().post(`${V1}/notifications/read-all`).set(auth(owner)).send({ audience: 'owner' }).expect(200);
    const count = (await api().get(`${V1}/notifications/unread-count`).set(auth(owner)).expect(200)).body.data;
    expect(count.unread).toBe(0);
  });

  it('builds a reminder message with WhatsApp and SMS links', async () => {
    const entries = (await ledger(owner, { status: 'overdue' })).data;
    const res = await api().post(`${V1}/rents/${entries[0].id}/remind`).set(auth(owner)).expect(200);
    expect(res.body.data.message).toContain('Late Payer');
    expect(res.body.data.whatsappUrl).toMatch(/^https:\/\/wa\.me\/91\d{10}\?text=/);
    expect(res.body.data.smsUrl).toMatch(/^sms:\+91/);
  });
});
