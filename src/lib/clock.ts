import { formatDate } from './dates.js';

/**
 * Central clock so business logic ("today", overdue checks) can be tested
 * deterministically. Only tests may override the current time.
 */
let fixedNow: Date | null = null;

export function now(): Date {
  return fixedNow ? new Date(fixedNow.getTime()) : new Date();
}

export function setNowForTests(value: Date | string | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Clock overrides are not allowed in production.');
  }
  fixedNow = value === null ? null : new Date(value);
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Calendar date (YYYY-MM-DD) for the given IANA time zone. */
export function todayIn(timeZone: string, at: Date = now()): string {
  try {
    const parts = formatterFor(timeZone).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return formatDate(at);
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
