/**
 * Demo data: a realistic Lucknow-based portfolio with shops, godowns, an
 * office, a flat and a villa, ~6 months of rent history, partial/advance
 * payments, previous dues, a payment awaiting confirmation, deposits,
 * a past tenant, an upcoming tenant and expenses.
 *
 * Everything is created through the real services (billing engine,
 * allocation, activity log), and dates are relative to "today", so the
 * demo always looks current.
 */
import { config } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { todayIn } from '../../lib/clock.js';
import type { Ctx } from '../../lib/context.js';
import { addDays, addMonths, dateWithDay, minDate, parts, startOfMonth } from '../../lib/dates.js';
import { addDepositTransaction, createAgreement, endAgreement } from '../../modules/agreements/agreements.service.js';
import { createExpense, type ExpenseCategory } from '../../modules/expenses/expenses.service.js';
import { createPayment } from '../../modules/payments/payments.service.js';
import type { RecordableMethod } from '../../modules/payments/payment.types.js';
import { submitPayment } from '../../modules/portal/portal.service.js';
import { createProperty } from '../../modules/properties/properties.service.js';
import { createUnit } from '../../modules/units/units.service.js';
import { runReminderTasks } from '../../jobs/tasks.js';
import { db } from '../knex.js';

export const DEMO_OWNER_PHONE = '+919876543210';
export const DEMO_PARTNER_PHONE = '+919876543211';
export const DEMO_TENANT_PHONE = '+919812345673';

export async function seedDemoData(): Promise<void> {
  const timezone = config.defaults.timezone;
  const today = todayIn(timezone);
  const monthStartToday = startOfMonth(today);
  const billingStart = addMonths(monthStartToday, -5); // six billed months incl. the current one

  const { owner, account } = await db.transaction(async (trx) => {
    const [owner] = await trx('users')
      .insert({ phone: DEMO_OWNER_PHONE, name: 'Vaibhav Dixit', email: 'vaibhav@example.com', last_login_at: new Date() })
      .returning('*');
    const [account] = await trx('accounts')
      .insert({
        name: 'Dixit Properties',
        gst_enabled: true,
        gst_rate: 18,
        timezone,
        reminder_days_before: 3,
        payee_name: 'Vaibhav Dixit',
        upi_id: 'vaibhav.dixit@okhdfcbank',
        bank_account_name: 'Vaibhav Dixit',
        bank_account_number: '50100234567891',
        bank_ifsc: 'HDFC0001234',
        bank_name: 'HDFC Bank, Hazratganj',
      })
      .returning('*');
    await trx('account_members').insert({ account_id: account.id, user_id: owner.id, role: 'owner' });
    const [partner] = await trx('users').insert({ phone: DEMO_PARTNER_PHONE, name: 'Priya Dixit' }).returning('*');
    await trx('account_members').insert({ account_id: account.id, user_id: partner.id, role: 'partner', invited_by: owner.id });
    // Tenants who already use the app (so they receive in-app notifications).
    await trx('users').insert([
      { phone: DEMO_TENANT_PHONE, name: 'Ayushi Sharma', last_login_at: new Date() },
      { phone: '+919812345674', name: 'Neha Sharma', last_login_at: new Date() },
    ]);
    return { owner, account };
  });

  const ctx: Ctx = {
    userId: owner.id,
    userName: owner.name,
    accountId: account.id,
    accountName: account.name,
    role: 'owner',
    timezone,
    today,
    gstEnabled: true,
    gstRate: 18,
    reminderDaysBefore: 3,
  };

  /** A date in the month `offset` months from now, never later than today. */
  const onDay = (offset: number, day: number) => {
    const { year, month } = parts(addMonths(monthStartToday, offset));
    return minDate(dateWithDay(year, month, day), today)!;
  };
  const isPast = (date: string) => date <= today;

  // ---------------------------------------------------------------- Properties
  const mainMarket = await createProperty(ctx, {
    name: 'Main Market Complex',
    type: 'complex',
    addressLine: 'Main Market, Hazratganj',
    city: 'Lucknow',
    state: 'Uttar Pradesh',
    pincode: '226001',
    notes: 'Ground floor shops with a first-floor office.',
  });
  const godowns = await createProperty(ctx, {
    name: 'Riverside Godowns',
    type: 'warehouse',
    addressLine: 'Plot 18, Transport Nagar',
    city: 'Lucknow',
    state: 'Uttar Pradesh',
    pincode: '226012',
  });
  const cafeBuilding = await createProperty(ctx, {
    name: 'Corner Cafe Building',
    type: 'building',
    addressLine: 'Vibhuti Khand, Gomti Nagar',
    city: 'Lucknow',
    state: 'Uttar Pradesh',
    pincode: '226010',
  });
  const villa = await createProperty(ctx, {
    name: 'Villa 12, Green Park',
    type: 'house',
    addressLine: 'Green Park Colony, Indira Nagar',
    city: 'Lucknow',
    state: 'Uttar Pradesh',
    pincode: '226016',
    singleUnit: { defaultRent: 45000, areaSqft: 2400 },
  });
  const arcade = await createProperty(ctx, {
    name: 'City Centre Arcade',
    type: 'complex',
    addressLine: 'Kapoorthala, Aliganj',
    city: 'Lucknow',
    state: 'Uttar Pradesh',
    pincode: '226024',
  });

  // --------------------------------------------------------------------- Units
  const shop4 = await createUnit(ctx, { propertyId: mainMarket.id, name: 'Shop No. 4, Main Market', type: 'shop', floor: 'Ground', areaSqft: 180, defaultRent: 20000 });
  await createUnit(ctx, { propertyId: mainMarket.id, name: 'Shop No. 5', type: 'shop', floor: 'Ground', areaSqft: 175, defaultRent: 19000 });
  const office101 = await createUnit(ctx, { propertyId: mainMarket.id, name: 'Office 101', type: 'office', floor: 'First', areaSqft: 350, defaultRent: 28000 });
  const godownB2 = await createUnit(ctx, { propertyId: godowns.id, name: 'Godown B2', type: 'warehouse', areaSqft: 1200, defaultRent: 15000 });
  const godownB3 = await createUnit(ctx, { propertyId: godowns.id, name: 'Godown B3', type: 'warehouse', areaSqft: 1350, defaultRent: 16000 });
  const cafe = await createUnit(ctx, { propertyId: cafeBuilding.id, name: 'Corner Cafe Unit', type: 'shop', floor: 'Ground', areaSqft: 600, defaultRent: 35000 });
  const flat = await createUnit(ctx, { propertyId: cafeBuilding.id, name: 'First Floor Flat', type: 'flat', floor: 'First', areaSqft: 900, defaultRent: 18000 });
  const shop37 = await createUnit(ctx, { propertyId: arcade.id, name: 'Shop No 37', type: 'shop', floor: 'Ground', areaSqft: 220, defaultRent: 22000 });
  const shop38 = await createUnit(ctx, { propertyId: arcade.id, name: 'Shop No 38', type: 'shop', floor: 'Ground', areaSqft: 210, defaultRent: 21000 });
  const villaUnit = villa.units[0];

  // ------------------------------------------------------------------ Tenancies
  async function lease(opts: {
    unitId: string;
    tenant: { name: string; phone: string; businessName?: string; email?: string };
    startDate: string;
    rent: number;
    dueDay: number;
    gst: boolean;
    deposit: number;
    endDate?: string;
    escalation?: number;
    openingBalance?: number;
    notice?: number;
  }) {
    const agreement = await createAgreement(ctx, {
      unitId: opts.unitId,
      newTenant: { name: opts.tenant.name, phone: opts.tenant.phone, businessName: opts.tenant.businessName ?? null, email: opts.tenant.email ?? null },
      startDate: opts.startDate,
      endDate: opts.endDate ?? null,
      billingStartDate: opts.startDate > billingStart ? opts.startDate : billingStart,
      rentAmount: opts.rent,
      billingCycle: 'monthly',
      dueDay: opts.dueDay,
      gstApplicable: opts.gst,
      gstRate: opts.gst ? 18 : 0,
      securityDeposit: opts.deposit,
      escalationPercent: opts.escalation ?? 0,
      escalationIntervalMonths: 12,
      noticePeriodDays: opts.notice ?? 30,
      lockInMonths: 11,
      openingBalance: opts.openingBalance ? { amount: opts.openingBalance, description: 'Unpaid rent carried over from the old register' } : null,
      depositReceived: opts.deposit ? { amount: opts.deposit, date: opts.startDate, method: 'bank_transfer', reference: null } : null,
    });
    return agreement;
  }

  async function pay(tenantId: string, amount: number, paidOn: string, method: RecordableMethod, reference?: string, targetChargeId?: string) {
    if (!isPast(paidOn) || amount <= 0) return;
    await createPayment(ctx, { tenantId, amount, paidOn, method, reference: reference ?? null, targetChargeId: targetChargeId ?? null });
  }

  /** Pays every monthly rent in [fromOffset, toOffset] in full, a few days around the due date. */
  async function payMonths(tenantId: string, monthly: number, dueDay: number, fromOffset: number, toOffset: number, method: RecordableMethod, lateDays = 0) {
    for (let offset = fromOffset; offset <= toOffset; offset++) {
      const paidOn = onDay(offset, Math.min(28, dueDay + (Math.abs(offset * 7 + dueDay) % 3) + lateDays));
      await pay(tenantId, monthly, paidOn, method, method === 'upi' ? `UPI${String(410000000000 + offset * 7919 + dueDay).slice(0, 12)}` : undefined);
    }
  }

  // Shop No. 4 — Ramesh Kumar: always pays, but this month's rent is outstanding.
  const ramesh = await lease({
    unitId: shop4.id,
    tenant: { name: 'Ramesh Kumar', phone: '+919812345670', businessName: 'Ramesh Garments' },
    startDate: addMonths(monthStartToday, -14),
    rent: 20000,
    dueDay: 5,
    gst: true,
    deposit: 60000,
  });
  await payMonths(ramesh.tenant.id, 23600, 5, -5, -1, 'upi');

  // Office 101 — Sharma Associates: partial payment last month, has reported paying this month (to confirm).
  const neha = await lease({
    unitId: office101.id,
    tenant: { name: 'Neha Sharma', phone: '+919812345674', businessName: 'Sharma Associates', email: 'neha@sharmaassociates.in' },
    startDate: addMonths(monthStartToday, -8),
    rent: 28000,
    dueDay: 7,
    gst: true,
    deposit: 84000,
  });
  await payMonths(neha.tenant.id, 33040, 7, -5, -2, 'bank_transfer');
  await pay(neha.tenant.id, 20000, onDay(-1, 12), 'bank_transfer', 'NEFT-HDFC-88213');

  // Godown B2 — Verma & Sons: pays by cheque, this month overdue.
  const verma = await lease({
    unitId: godownB2.id,
    tenant: { name: 'Verma & Sons', phone: '+919812345672', businessName: 'Verma & Sons Transport' },
    startDate: addMonths(monthStartToday, -20),
    rent: 15000,
    dueDay: 1,
    gst: true,
    deposit: 45000,
  });
  await payMonths(verma.tenant.id, 17700, 1, -5, -1, 'cheque', 2);

  // Corner Cafe — Anita Traders: carried-over dues and irregular payments.
  const anita = await lease({
    unitId: cafe.id,
    tenant: { name: 'Anita Traders', phone: '+919812345671', businessName: 'Anita Traders (Corner Cafe)' },
    startDate: addMonths(monthStartToday, -26),
    rent: 35000,
    dueDay: 10,
    gst: true,
    deposit: 100000,
    openingBalance: 10000,
  });
  await pay(anita.tenant.id, 51300, onDay(-5, 12), 'upi', 'UPI412233445566');
  await pay(anita.tenant.id, 41300, onDay(-4, 11), 'upi', 'UPI412233998877');
  await pay(anita.tenant.id, 30000, onDay(-3, 15), 'cash');
  await pay(anita.tenant.id, 41300, onDay(-2, 10), 'upi', 'UPI413355667788');
  await pay(anita.tenant.id, 41300, onDay(-1, 14), 'upi', 'UPI413399001122');

  // First Floor Flat — Rahul Mehta: residential (no GST), paid up and one month in advance.
  const rahul = await lease({
    unitId: flat.id,
    tenant: { name: 'Rahul Mehta', phone: '+919812345676', email: 'rahul.mehta@example.com' },
    startDate: addMonths(monthStartToday, -9),
    rent: 18000,
    dueDay: 5,
    gst: false,
    deposit: 36000,
  });
  await payMonths(rahul.tenant.id, 18000, 5, -5, -1, 'upi');
  await pay(rahul.tenant.id, 36000, onDay(0, 3), 'upi', 'UPI414455667700');

  // Villa 12 — Arjun Singh: 5% yearly escalation, pays on the 1st.
  const arjun = await lease({
    unitId: villaUnit.id,
    tenant: { name: 'Arjun Singh', phone: '+919812345677', email: 'arjun.singh@example.com' },
    startDate: addMonths(monthStartToday, -15),
    rent: 45000,
    dueDay: 1,
    gst: false,
    deposit: 135000,
    escalation: 5,
    endDate: addDays(addMonths(monthStartToday, 1), 19),
    notice: 60,
  });
  for (let offset = -5; offset <= 0; offset++) {
    // Pay whatever the entry for that month is (escalation changes the amount).
    const charge = await db('rent_charges')
      .where({ agreement_id: arjun.id, kind: 'rent' })
      .whereBetween('period_start', [addMonths(monthStartToday, offset), addDays(addMonths(monthStartToday, offset + 1), -1)])
      .first('id', 'total_amount');
    if (charge) await pay(arjun.tenant.id, Number(charge.total_amount), onDay(offset, 2), 'bank_transfer', `IMPS-${offset + 900}`, charge.id);
  }

  // Shop No 37 — Ayushi Sharma (uses the tenant app): this month is overdue.
  const ayushi = await lease({
    unitId: shop37.id,
    tenant: { name: 'Ayushi Sharma', phone: DEMO_TENANT_PHONE, businessName: 'Ayushi Boutique' },
    startDate: addMonths(monthStartToday, -7),
    rent: 22000,
    dueDay: 5,
    gst: true,
    deposit: 50000,
  });
  await payMonths(ayushi.tenant.id, 25960, 5, -5, -1, 'upi');

  // Shop No 38 — Deepak Gupta: moved out two months ago; deposit settled.
  const deepak = await lease({
    unitId: shop38.id,
    tenant: { name: 'Deepak Gupta', phone: '+919812345678', businessName: 'Gupta Electronics' },
    startDate: addMonths(monthStartToday, -18),
    rent: 21000,
    dueDay: 5,
    gst: true,
    deposit: 40000,
  });
  await payMonths(deepak.tenant.id, 24780, 5, -5, -2, 'upi');
  const movedOut = addDays(addMonths(monthStartToday, -1), -1);
  await endAgreement(ctx, deepak.id, { endedOn: movedOut, reason: 'Tenant relocated to a bigger shop' });
  await addDepositTransaction(ctx, deepak.id, { type: 'deducted', amount: 5000, date: addDays(movedOut, 3), notes: 'Shutter and wiring repairs' });
  await addDepositTransaction(ctx, deepak.id, { type: 'refunded', amount: 35000, date: addDays(movedOut, 5), method: 'bank_transfer', reference: 'NEFT-REF-5521' });

  // Godown B3 — Kapoor Logistics: signed, moving in next month (unit shows as reserved).
  await lease({
    unitId: godownB3.id,
    tenant: { name: 'Kapoor Logistics', phone: '+919812345675', businessName: 'Kapoor Logistics Pvt Ltd' },
    startDate: addMonths(monthStartToday, 1),
    rent: 16000,
    dueDay: 1,
    gst: true,
    deposit: 48000,
  });
  await db('deposit_transactions')
    .whereIn('agreement_id', db('agreements').select('id').where({ unit_id: godownB3.id }))
    .update({ txn_date: minDate(today, addMonths(monthStartToday, 1))! });

  // Neha reports this month's payment from the tenant app -> "To confirm".
  const nehaEntry = await db('rent_charges')
    .where({ agreement_id: neha.id, kind: 'rent' })
    .where('period_start', '>=', monthStartToday)
    .first('id');
  const nehaUser = await db('users').where({ phone: '+919812345674' }).first('id');
  if (nehaEntry && nehaUser) {
    await submitPayment(
      { userId: nehaUser.id, phone: '+919812345674', tenantIds: [neha.tenant.id] },
      { chargeId: nehaEntry.id, amount: 33040, paidOn: today, method: 'upi', reference: 'UPI428631907215', notes: 'Paid via PhonePe' },
    );
  }

  // ------------------------------------------------------------------ Expenses
  const expenses: Array<{ category: ExpenseCategory; amount: number; offset: number; day: number; propertyId?: string; unitId?: string; payee?: string; notes?: string; method?: RecordableMethod }> = [
    { category: 'legal', amount: 4500, offset: -5, day: 8, propertyId: mainMarket.id, payee: 'Sub-Registrar Office', notes: 'Agreement registration & stamp duty' },
    { category: 'property_tax', amount: 24000, offset: -4, day: 20, propertyId: mainMarket.id, payee: 'Lucknow Municipal Corporation', method: 'bank_transfer' },
    { category: 'insurance', amount: 18000, offset: -3, day: 3, propertyId: villa.id, payee: 'HDFC ERGO', notes: 'Annual home insurance premium', method: 'bank_transfer' },
    { category: 'repairs', amount: 8500, offset: -2, day: 14, propertyId: cafeBuilding.id, unitId: cafe.id, payee: 'Sharma Electricals', notes: 'Kitchen exhaust & wiring', method: 'upi' },
    { category: 'commission', amount: 16000, offset: -1, day: 22, propertyId: godowns.id, unitId: godownB3.id, payee: 'Awasthi Realty', notes: 'Brokerage for new tenant (Kapoor Logistics)', method: 'bank_transfer' },
    { category: 'repairs', amount: 3200, offset: 0, day: 4, propertyId: arcade.id, unitId: shop38.id, payee: 'Local contractor', notes: 'Shutter repair before re-letting', method: 'cash' },
  ];
  for (let offset = -5; offset <= 0; offset++) {
    expenses.push({ category: 'salary', amount: 12000, offset, day: 1, propertyId: mainMarket.id, payee: 'Security guard (Ram Prasad)', method: 'cash' });
    expenses.push({ category: 'society', amount: 2500, offset, day: 6, propertyId: villa.id, payee: 'Green Park RWA', method: 'upi' });
    expenses.push({ category: 'utilities', amount: 3100 + ((offset + 6) % 3) * 250, offset, day: 18, propertyId: godowns.id, payee: 'LESA (electricity)', method: 'upi' });
    expenses.push({ category: 'cleaning', amount: 1500, offset, day: 25, propertyId: arcade.id, payee: 'Common area cleaning', method: 'cash' });
  }
  for (const e of expenses) {
    const { year, month } = parts(addMonths(monthStartToday, e.offset));
    const date = dateWithDay(year, month, e.day);
    if (!isPast(date)) continue; // not incurred yet
    await createExpense(ctx, {
      category: e.category,
      amount: e.amount,
      expenseDate: date,
      propertyId: e.propertyId ?? null,
      unitId: e.unitId ?? null,
      payee: e.payee ?? null,
      method: e.method ?? null,
      notes: e.notes ?? null,
    });
  }

  // Make the activity feed chronological for the demo (payments/expenses at their real dates).
  await db.raw(
    `UPDATE activity_logs l SET created_at = ((p.paid_on + time '10:30') AT TIME ZONE ?)
       FROM payments p
      WHERE l.entity_id = p.id AND l.action IN ('payment.recorded', 'payment.submitted') AND p.paid_on < ?::date`,
    [timezone, today],
  );
  await db.raw(
    `UPDATE activity_logs l SET created_at = ((e.expense_date + time '18:00') AT TIME ZONE ?)
       FROM expenses e
      WHERE l.entity_id = e.id AND l.action = 'expense.created' AND e.expense_date < ?::date`,
    [timezone, today],
  );

  const reminders = await runReminderTasks();
  logger.info({ reminders }, 'Demo data created');
}
