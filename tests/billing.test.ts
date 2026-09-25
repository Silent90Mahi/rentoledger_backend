import { describe, expect, it } from 'vitest';
import { addMonths, dateWithDay, monthsBetween } from '../src/lib/dates.js';
import { gstFor, round2, sumMoney } from '../src/lib/money.js';
import { normalizePhone } from '../src/lib/phone.js';
import { nextPeriodAfter, periodAt, periodContaining, periodsThrough, type BillingTerms } from '../src/modules/rents/billing.js';

const base: BillingTerms = {
  startDate: '2026-01-01',
  endDate: null,
  endedOn: null,
  billingStartDate: '2026-01-01',
  rentAmount: 20000,
  billingCycle: 'monthly',
  dueDay: 5,
  gstApplicable: false,
  gstRate: 0,
  escalationPercent: 0,
  escalationIntervalMonths: 12,
  escalationBaseDate: null,
  proratePartialPeriods: true,
};

describe('billing engine', () => {
  it('bills calendar months with the due day of each month', () => {
    const periods = periodsThrough(base, '2026-03-15');
    expect(periods.map((p) => [p.periodStart, p.periodEnd, p.dueDate, p.totalAmount])).toEqual([
      ['2026-01-01', '2026-01-31', '2026-01-05', 20000],
      ['2026-02-01', '2026-02-28', '2026-02-05', 20000],
      ['2026-03-01', '2026-03-31', '2026-03-05', 20000],
    ]);
  });

  it('adds GST on top of the base rent', () => {
    const p = periodAt({ ...base, rentAmount: 35000, gstApplicable: true, gstRate: 18 }, 0)!;
    expect(p.baseAmount).toBe(35000);
    expect(p.gstAmount).toBe(6300);
    expect(p.totalAmount).toBe(41300);
  });

  it('pro-rates a first period that starts mid-month and keeps the due date inside it', () => {
    const terms = { ...base, startDate: '2026-09-20', billingStartDate: '2026-09-20', rentAmount: 30000 };
    const first = periodAt(terms, 0)!;
    expect(first.periodStart).toBe('2026-09-20');
    expect(first.periodEnd).toBe('2026-09-30');
    expect(first.isPartial).toBe(true);
    expect(first.baseAmount).toBe(11000); // 30000 * 11 / 30
    expect(first.dueDate).toBe('2026-09-20');
    const second = periodAt(terms, 1)!;
    expect([second.periodStart, second.periodEnd, second.baseAmount]).toEqual(['2026-10-01', '2026-10-31', 30000]);
  });

  it('can charge a full first period when pro-rating is off', () => {
    const p = periodAt({ ...base, startDate: '2026-09-20', billingStartDate: '2026-09-20', proratePartialPeriods: false }, 0)!;
    expect(p.baseAmount).toBe(20000);
  });

  it('clamps due day 31 to the last day of short months', () => {
    const terms = { ...base, dueDay: 31 };
    expect(periodAt(terms, 1)!.dueDate).toBe('2026-02-28');
    expect(periodAt(terms, 3)!.dueDate).toBe('2026-04-30');
  });

  it('supports quarterly and yearly billing', () => {
    const quarterly = { ...base, billingCycle: 'quarterly' as const, rentAmount: 60000 };
    expect(periodsThrough(quarterly, '2026-12-31').map((p) => [p.periodStart, p.periodEnd])).toEqual([
      ['2026-01-01', '2026-03-31'],
      ['2026-04-01', '2026-06-30'],
      ['2026-07-01', '2026-09-30'],
      ['2026-10-01', '2026-12-31'],
    ]);
    const yearly = periodAt({ ...base, billingCycle: 'yearly', rentAmount: 240000 }, 0)!;
    expect([yearly.periodStart, yearly.periodEnd, yearly.totalAmount]).toEqual(['2026-01-01', '2026-12-31', 240000]);
  });

  it('applies yearly escalation from each anniversary', () => {
    const terms = { ...base, escalationPercent: 5 };
    expect(periodAt(terms, 11)!.baseAmount).toBe(20000); // Dec 2026
    expect(periodAt(terms, 12)!.baseAmount).toBe(21000); // Jan 2027
    expect(periodAt(terms, 24)!.baseAmount).toBe(22050); // Jan 2028
  });

  it('stops at the move-out date and pro-rates the final period', () => {
    const terms = { ...base, endedOn: '2026-03-10' };
    const periods = periodsThrough(terms, '2026-12-31');
    expect(periods).toHaveLength(3);
    const last = periods[2];
    expect([last.periodStart, last.periodEnd, last.isPartial]).toEqual(['2026-03-01', '2026-03-10', true]);
    expect(last.baseAmount).toBe(round2((20000 * 10) / 31));
  });

  it('skips periods before the billing start date', () => {
    const terms = { ...base, startDate: '2024-06-15', billingStartDate: '2026-09-01' };
    const periods = periodsThrough(terms, '2026-10-15');
    expect(periods.map((p) => p.periodStart)).toEqual(['2026-09-01', '2026-10-01']);
  });

  it('finds the next and the current period', () => {
    expect(nextPeriodAfter(base, '2026-03-15')!.periodStart).toBe('2026-04-01');
    expect(periodContaining(base, '2026-03-15')!.periodStart).toBe('2026-03-01');
    expect(nextPeriodAfter({ ...base, endDate: '2026-03-31' }, '2026-03-15')).toBeNull();
  });
});

describe('money, dates and phone helpers', () => {
  it('rounds money safely', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(sumMoney([0.1, 0.2, 0.3])).toBe(0.6);
    expect(gstFor(12345, 18)).toBe(2222.1);
    expect(gstFor(999.99, 18)).toBe(180);
  });

  it('does calendar arithmetic without time zone drift', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(dateWithDay(2028, 2, 31)).toBe('2028-02-29');
    expect(monthsBetween('2025-09-20', '2026-09-01')).toBe(11);
    expect(monthsBetween('2025-09-20', '2026-09-20')).toBe(12);
  });

  it('normalises Indian mobile numbers', () => {
    expect(normalizePhone('98765 43210')).toBe('+919876543210');
    expect(normalizePhone('+91-98765-43210')).toBe('+919876543210');
    expect(normalizePhone('09876543210')).toBe('+919876543210');
    expect(normalizePhone('919876543210')).toBe('+919876543210');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('5876543210')).toBeNull();
  });
});
