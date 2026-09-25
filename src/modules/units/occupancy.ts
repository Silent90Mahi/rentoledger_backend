import type { Knex } from 'knex';
import { CYCLE_MONTHS, periodContaining, type BillingCycle, type BillingTerms } from '../rents/billing.js';

export type Occupancy = 'occupied' | 'vacant' | 'reserved';

/**
 * Units joined with their current agreement (tenant in possession today)
 * and the next upcoming agreement (future move-in).
 */
export function unitsWithOccupancy(q: Knex | Knex.Transaction, accountId: string, today: string): Knex.QueryBuilder {
  return q('units as u')
    .join('properties as p', 'p.id', 'u.property_id')
    .joinRaw(
      `LEFT JOIN LATERAL (
         SELECT a.id, a.tenant_id, a.rent_amount, a.billing_cycle, a.due_day, a.gst_applicable, a.gst_rate,
                a.security_deposit, a.start_date, a.end_date, a.ended_on, a.status, a.billing_start_date,
                a.escalation_percent, a.escalation_interval_months, a.escalation_base_date, a.prorate_partial_periods
           FROM agreements a
          WHERE a.unit_id = u.id
            AND a.start_date <= ?::date
            AND (a.status = 'active' OR a.ended_on >= ?::date)
          ORDER BY a.start_date DESC
          LIMIT 1
       ) ca ON true`,
      [today, today],
    )
    .joinRaw(
      `LEFT JOIN LATERAL (
         SELECT a.id, a.tenant_id, a.start_date, a.rent_amount, a.billing_cycle
           FROM agreements a
          WHERE a.unit_id = u.id AND a.status = 'active' AND a.start_date > ?::date
          ORDER BY a.start_date ASC
          LIMIT 1
       ) ua ON true`,
      [today],
    )
    .leftJoin('tenants as ct', 'ct.id', 'ca.tenant_id')
    .leftJoin('tenants as ut', 'ut.id', 'ua.tenant_id')
    .where('u.account_id', accountId)
    .select(
      'u.id',
      'u.property_id',
      'u.name',
      'u.type',
      'u.floor',
      'u.area_sqft',
      'u.default_rent',
      'u.notes',
      'u.archived_at',
      'u.created_at',
      'u.updated_at',
      'p.name as property_name',
      'p.type as property_type',
      'ca.id as ca_id',
      'ca.rent_amount as ca_rent_amount',
      'ca.billing_cycle as ca_billing_cycle',
      'ca.due_day as ca_due_day',
      'ca.gst_applicable as ca_gst_applicable',
      'ca.gst_rate as ca_gst_rate',
      'ca.security_deposit as ca_security_deposit',
      'ca.start_date as ca_start_date',
      'ca.end_date as ca_end_date',
      'ca.ended_on as ca_ended_on',
      'ca.billing_start_date as ca_billing_start_date',
      'ca.escalation_percent as ca_escalation_percent',
      'ca.escalation_interval_months as ca_escalation_interval_months',
      'ca.escalation_base_date as ca_escalation_base_date',
      'ca.prorate_partial_periods as ca_prorate_partial_periods',
      'ct.id as ct_id',
      'ct.name as ct_name',
      'ct.phone as ct_phone',
      'ct.business_name as ct_business_name',
      'ua.id as ua_id',
      'ua.start_date as ua_start_date',
      'ut.id as ut_id',
      'ut.name as ut_name',
      q.raw(
        `CASE WHEN ca.id IS NOT NULL THEN 'occupied' WHEN ua.id IS NOT NULL THEN 'reserved' ELSE 'vacant' END AS occupancy`,
      ),
    );
}

export interface UnitDto {
  id: string;
  name: string;
  type: string;
  floor: string | null;
  areaSqft: number | null;
  defaultRent: number | null;
  notes: string | null;
  archived: boolean;
  property: { id: string; name: string; type: string };
  occupancy: Occupancy;
  currentAgreement: {
    id: string;
    /** Contractual base rent per billing period. */
    rentAmount: number;
    /** Rent in force today (after escalations) per billing period. */
    currentRent: number;
    billingCycle: BillingCycle;
    monthlyRent: number;
    dueDay: number;
    gstApplicable: boolean;
    gstRate: number;
    securityDeposit: number;
    startDate: string;
    endDate: string | null;
    endedOn: string | null;
  } | null;
  tenant: { id: string; name: string; phone: string; businessName: string | null } | null;
  upcoming: { agreementId: string; tenantId: string; tenantName: string; startDate: string } | null;
  moveOutOn: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Rent in force on `today` (includes escalations), for one full billing period. */
function currentPeriodRent(r: Record<string, any>, today: string): number {
  const terms: BillingTerms = {
    startDate: r.ca_start_date,
    endDate: r.ca_end_date ?? null,
    endedOn: r.ca_ended_on ?? null,
    billingStartDate: r.ca_billing_start_date ?? r.ca_start_date,
    rentAmount: Number(r.ca_rent_amount),
    billingCycle: (r.ca_billing_cycle ?? 'monthly') as BillingCycle,
    dueDay: r.ca_due_day,
    gstApplicable: r.ca_gst_applicable,
    gstRate: Number(r.ca_gst_rate),
    escalationPercent: Number(r.ca_escalation_percent ?? 0),
    escalationIntervalMonths: Number(r.ca_escalation_interval_months ?? 12),
    escalationBaseDate: r.ca_escalation_base_date ?? null,
    proratePartialPeriods: r.ca_prorate_partial_periods ?? true,
  };
  if (!terms.escalationPercent) return terms.rentAmount;
  const period = periodContaining(terms, today);
  return period ? period.fullAmount : terms.rentAmount;
}

export function mapUnit(r: Record<string, any>, today: string): UnitDto {
  const cycle = (r.ca_billing_cycle ?? 'monthly') as BillingCycle;
  const currentRent = r.ca_id ? currentPeriodRent(r, today) : 0;
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    floor: r.floor ?? null,
    areaSqft: r.area_sqft === null || r.area_sqft === undefined ? null : Number(r.area_sqft),
    defaultRent: r.default_rent === null || r.default_rent === undefined ? null : Number(r.default_rent),
    notes: r.notes ?? null,
    archived: r.archived_at !== null && r.archived_at !== undefined,
    property: { id: r.property_id, name: r.property_name, type: r.property_type },
    occupancy: r.occupancy,
    currentAgreement: r.ca_id
      ? {
          id: r.ca_id,
          rentAmount: Number(r.ca_rent_amount),
          currentRent,
          billingCycle: cycle,
          monthlyRent: Math.round((currentRent / CYCLE_MONTHS[cycle]) * 100) / 100,
          dueDay: r.ca_due_day,
          gstApplicable: r.ca_gst_applicable,
          gstRate: Number(r.ca_gst_rate),
          securityDeposit: Number(r.ca_security_deposit),
          startDate: r.ca_start_date,
          endDate: r.ca_end_date ?? null,
          endedOn: r.ca_ended_on ?? null,
        }
      : null,
    tenant: r.ct_id ? { id: r.ct_id, name: r.ct_name, phone: r.ct_phone, businessName: r.ct_business_name ?? null } : null,
    upcoming: r.ua_id ? { agreementId: r.ua_id, tenantId: r.ut_id, tenantName: r.ut_name, startDate: r.ua_start_date } : null,
    moveOutOn: r.ca_ended_on ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
