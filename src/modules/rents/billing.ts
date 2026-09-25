/**
 * Pure billing engine: turns agreement terms into billing periods.
 *
 * Rules
 * - Periods are anchored to the first day of the agreement's start month.
 *   Monthly agreements bill calendar months, quarterly ones bill 3-month
 *   blocks starting from the start month, and so on.
 * - The first period starts on the agreement start date. When that is not
 *   the 1st, the period is partial and (optionally) pro-rated by days.
 * - The last period ends on the move-out date / fixed-term end date and is
 *   pro-rated the same way.
 * - The due date is `dueDay` of the period's first month, clamped to the
 *   month length and kept inside the period.
 * - Escalation: rent grows by `escalationPercent` every
 *   `escalationIntervalMonths`, counted from `escalationBaseDate`.
 * - GST is computed on the (possibly pro-rated) base amount.
 */
import {
  addDays,
  addMonths,
  dateWithDay,
  diffDays,
  minDate,
  monthsBetween,
  parts,
  startOfMonth,
} from '../../lib/dates.js';
import { gstFor, round2 } from '../../lib/money.js';

export type BillingCycle = 'monthly' | 'quarterly' | 'half_yearly' | 'yearly';

export const CYCLE_MONTHS: Record<BillingCycle, number> = {
  monthly: 1,
  quarterly: 3,
  half_yearly: 6,
  yearly: 12,
};

export interface BillingTerms {
  startDate: string;
  /** Contractual end of a fixed-term agreement. */
  endDate: string | null;
  /** Actual move-out date when the agreement was ended. */
  endedOn: string | null;
  /** Periods that end before this date are not billed (history kept outside the app). */
  billingStartDate: string;
  rentAmount: number;
  billingCycle: BillingCycle;
  dueDay: number;
  gstApplicable: boolean;
  gstRate: number;
  escalationPercent: number;
  escalationIntervalMonths: number;
  escalationBaseDate: string | null;
  proratePartialPeriods: boolean;
}

export interface BillingPeriod {
  index: number;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  fullAmount: number;
  baseAmount: number;
  gstRate: number;
  gstAmount: number;
  totalAmount: number;
  isPartial: boolean;
  daysBilled: number;
  daysInPeriod: number;
  escalationSteps: number;
}

export function effectiveEndDate(terms: Pick<BillingTerms, 'endDate' | 'endedOn'>): string | null {
  return minDate(terms.endDate, terms.endedOn);
}

/** Monthly-equivalent rent, used for rent-roll figures. */
export function monthlyEquivalent(rentAmount: number, cycle: BillingCycle): number {
  return round2(rentAmount / CYCLE_MONTHS[cycle]);
}

export function periodAt(terms: BillingTerms, index: number): BillingPeriod | null {
  if (index < 0) return null;
  const cycle = CYCLE_MONTHS[terms.billingCycle];
  const anchor = startOfMonth(terms.startDate);
  const windowStart = addMonths(anchor, index * cycle);
  const windowEnd = addDays(addMonths(anchor, (index + 1) * cycle), -1);
  const periodStart = index === 0 ? terms.startDate : windowStart;

  const end = effectiveEndDate(terms);
  if (end && periodStart > end) return null;
  const periodEnd = end && end < windowEnd ? end : windowEnd;

  const daysInPeriod = diffDays(windowStart, windowEnd) + 1;
  const daysBilled = diffDays(periodStart, periodEnd) + 1;
  const isPartial = daysBilled < daysInPeriod;

  const escalationBase = terms.escalationBaseDate ?? terms.startDate;
  const escalationSteps =
    terms.escalationPercent > 0 && periodStart > escalationBase
      ? Math.floor(monthsBetween(escalationBase, periodStart) / Math.max(1, terms.escalationIntervalMonths))
      : 0;
  const fullAmount = round2(terms.rentAmount * Math.pow(1 + terms.escalationPercent / 100, escalationSteps));
  const baseAmount =
    isPartial && terms.proratePartialPeriods ? round2((fullAmount * daysBilled) / daysInPeriod) : fullAmount;

  const { year, month } = parts(periodStart);
  let dueDate = dateWithDay(year, month, terms.dueDay);
  if (dueDate < periodStart) dueDate = periodStart;
  if (dueDate > periodEnd) dueDate = periodEnd;

  const gstRate = terms.gstApplicable ? terms.gstRate : 0;
  const gstAmount = gstFor(baseAmount, gstRate);

  return {
    index,
    periodStart,
    periodEnd,
    dueDate,
    fullAmount,
    baseAmount,
    gstRate,
    gstAmount,
    totalAmount: round2(baseAmount + gstAmount),
    isPartial,
    daysBilled,
    daysInPeriod,
    escalationSteps,
  };
}

/** Index of the period containing `date` (may be negative if before start). */
function indexForDate(terms: BillingTerms, date: string): number {
  const cycle = CYCLE_MONTHS[terms.billingCycle];
  const anchor = startOfMonth(terms.startDate);
  const months = (parts(date).year - parts(anchor).year) * 12 + (parts(date).month - parts(anchor).month);
  return Math.floor(months / cycle);
}

/**
 * Every billable period whose start is on or before `uptoDate`.
 * Periods ending before the billing start date are skipped.
 */
export function periodsThrough(terms: BillingTerms, uptoDate: string, maxPeriods = 600): BillingPeriod[] {
  const result: BillingPeriod[] = [];
  const firstIndex = Math.max(0, indexForDate(terms, terms.billingStartDate) - 1);
  for (let i = firstIndex; i < firstIndex + maxPeriods; i++) {
    const period = periodAt(terms, i);
    if (!period || period.periodStart > uptoDate) break;
    if (period.periodEnd >= terms.billingStartDate) result.push(period);
  }
  return result;
}

/** The first billable period that starts after `date`, if the agreement continues. */
export function nextPeriodAfter(terms: BillingTerms, date: string): BillingPeriod | null {
  const start = Math.max(0, indexForDate(terms, date));
  for (let i = start; i < start + 3; i++) {
    const period = periodAt(terms, i);
    if (!period) return null;
    if (period.periodStart > date && period.periodEnd >= terms.billingStartDate) return period;
  }
  return null;
}

/** The period that contains `date`, if any. */
export function periodContaining(terms: BillingTerms, date: string): BillingPeriod | null {
  const idx = Math.max(0, indexForDate(terms, date));
  for (const i of [idx, idx - 1, idx + 1]) {
    const period = periodAt(terms, i);
    if (period && period.periodStart <= date && period.periodEnd >= date) return period;
  }
  return null;
}

// Shape of an agreements row as returned by the database.
export interface AgreementRow {
  id: string;
  account_id: string;
  unit_id: string;
  tenant_id: string;
  status: 'active' | 'ended';
  start_date: string;
  end_date: string | null;
  billing_start_date: string;
  rent_amount: number;
  billing_cycle: BillingCycle;
  due_day: number;
  gst_applicable: boolean;
  gst_rate: number;
  security_deposit: number;
  escalation_percent: number;
  escalation_interval_months: number;
  escalation_base_date: string | null;
  prorate_partial_periods: boolean;
  notice_period_days: number | null;
  lock_in_months: number | null;
  ended_on: string | null;
  end_reason: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export function termsFromRow(row: AgreementRow): BillingTerms {
  return {
    startDate: row.start_date,
    endDate: row.end_date,
    endedOn: row.ended_on,
    billingStartDate: row.billing_start_date,
    rentAmount: Number(row.rent_amount),
    billingCycle: row.billing_cycle,
    dueDay: row.due_day,
    gstApplicable: row.gst_applicable,
    gstRate: Number(row.gst_rate),
    escalationPercent: Number(row.escalation_percent),
    escalationIntervalMonths: row.escalation_interval_months,
    escalationBaseDate: row.escalation_base_date,
    proratePartialPeriods: row.prorate_partial_periods,
  };
}
