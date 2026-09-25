/**
 * Money helpers. Amounts are stored as NUMERIC(14,2) in Postgres (exact) and
 * handled as rupees in JS. Any arithmetic in JS goes through integer paise to
 * avoid floating point drift.
 */

export function toPaise(amount: number): number {
  return Math.round(amount * 100);
}

export function fromPaise(paise: number): number {
  return paise / 100;
}

export function round2(amount: number): number {
  return fromPaise(toPaise(amount + (amount >= 0 ? Number.EPSILON : -Number.EPSILON)));
}

export function sumMoney(values: Array<number | null | undefined>): number {
  return fromPaise(values.reduce<number>((acc, v) => acc + toPaise(v ?? 0), 0));
}

export function subtractMoney(a: number, b: number): number {
  return fromPaise(toPaise(a) - toPaise(b));
}

export function minMoney(a: number, b: number): number {
  return toPaise(a) <= toPaise(b) ? a : b;
}

export function gstFor(base: number, rate: number): number {
  if (!rate) return 0;
  return round2((base * rate) / 100);
}

const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

/** Human friendly INR string used in notifications and activity summaries. */
export function formatInr(amount: number): string {
  return inrFormatter.format(amount);
}
