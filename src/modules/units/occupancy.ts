import type { Filter } from 'mongodb';
import { col, opts, type Doc, type Session } from '../../db/mongo.js';
import { CYCLE_MONTHS, periodContaining, type BillingCycle, type BillingTerms } from '../rents/billing.js';

export type Occupancy = 'occupied' | 'vacant' | 'reserved';

/**
 * Units (matching `filter`, always scoped to the account) with their current
 * agreement (tenant in possession today) and the next upcoming agreement
 * (future move-in). Rows use the field names the mapping code expects:
 * unit fields, `property_*`, `ca_*` (current agreement), `ct_*` (its tenant),
 * `ua_*` / `ut_*` (upcoming agreement/tenant) and `occupancy`.
 */
export async function unitsWithOccupancy(
  accountId: string,
  today: string,
  filter: Filter<Doc> = {},
  session?: Session,
): Promise<Array<Record<string, any>>> {
  const units = await col('units').find({ ...filter, account_id: accountId }, opts(session)).toArray();
  if (units.length === 0) return [];
  const unitIds = units.map((u) => u._id);

  const [properties, agreements] = await Promise.all([
    col('properties').find({ _id: { $in: [...new Set(units.map((u) => u.property_id))] } }, opts(session)).toArray(),
    col('agreements')
      .find({ account_id: accountId, unit_id: { $in: unitIds } }, opts(session))
      .sort({ start_date: -1 })
      .toArray(),
  ]);
  const propertyById = new Map(properties.map((p) => [p._id, p]));

  const current = new Map<string, Doc>();
  const upcoming = new Map<string, Doc>();
  for (const a of agreements) {
    // Sorted by start_date descending: the first match is the latest one.
    if (!current.has(a.unit_id) && a.start_date <= today && (a.status === 'active' || (a.ended_on && a.ended_on >= today))) {
      current.set(a.unit_id, a);
    }
    if (a.status === 'active' && a.start_date > today) {
      const seen = upcoming.get(a.unit_id);
      if (!seen || a.start_date < seen.start_date) upcoming.set(a.unit_id, a);
    }
  }

  const tenantIds = [...new Set([...current.values(), ...upcoming.values()].map((a) => a.tenant_id))];
  const tenants = new Map(
    (tenantIds.length ? await col('tenants').find({ _id: { $in: tenantIds } }, opts(session)).toArray() : []).map((t) => [t._id, t]),
  );

  return units.map((u) => {
    const p = propertyById.get(u.property_id);
    const ca = current.get(u._id);
    const ua = upcoming.get(u._id);
    const ct = ca ? tenants.get(ca.tenant_id) : undefined;
    const ut = ua ? tenants.get(ua.tenant_id) : undefined;
    return {
      id: u._id,
      property_id: u.property_id,
      name: u.name,
      type: u.type,
      floor: u.floor ?? null,
      area_sqft: u.area_sqft ?? null,
      default_rent: u.default_rent ?? null,
      notes: u.notes ?? null,
      archived_at: u.archived_at ?? null,
      created_at: u.created_at,
      updated_at: u.updated_at,
      property_name: p?.name,
      property_type: p?.type,
      property_archived_at: p?.archived_at ?? null,
      ca_id: ca?._id ?? null,
      ca_rent_amount: ca?.rent_amount,
      ca_billing_cycle: ca?.billing_cycle,
      ca_due_day: ca?.due_day,
      ca_gst_applicable: ca?.gst_applicable,
      ca_gst_rate: ca?.gst_rate,
      ca_security_deposit: ca?.security_deposit,
      ca_start_date: ca?.start_date,
      ca_end_date: ca?.end_date ?? null,
      ca_ended_on: ca?.ended_on ?? null,
      ca_billing_start_date: ca?.billing_start_date,
      ca_escalation_percent: ca?.escalation_percent,
      ca_escalation_interval_months: ca?.escalation_interval_months,
      ca_escalation_base_date: ca?.escalation_base_date ?? null,
      ca_prorate_partial_periods: ca?.prorate_partial_periods,
      ct_id: ct?._id ?? null,
      ct_name: ct?.name,
      ct_phone: ct?.phone,
      ct_business_name: ct?.business_name ?? null,
      ua_id: ua?._id ?? null,
      ua_start_date: ua?.start_date,
      ut_id: ut?._id ?? null,
      ut_name: ut?.name,
      occupancy: (ca ? 'occupied' : ua ? 'reserved' : 'vacant') as Occupancy,
    };
  });
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
