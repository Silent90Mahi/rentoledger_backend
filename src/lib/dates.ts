/**
 * Calendar-date helpers working on ISO date strings (YYYY-MM-DD).
 * All arithmetic is done in UTC so results never depend on the server's
 * local time zone. Month keys use the form YYYY-MM.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function isValidDateString(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

export function isValidMonthKey(value: string): boolean {
  const m = MONTH_RE.exec(value);
  if (!m) return false;
  const month = Number(m[2]);
  const year = Number(m[1]);
  return month >= 1 && month <= 12 && year >= 1900 && year <= 2200;
}

export function parseDate(value: string): Date {
  const m = DATE_RE.exec(value);
  if (!m) throw new Error(`Invalid date: ${value}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function parts(value: string): { year: number; month: number; day: number } {
  const d = parseDate(value);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Builds a date, clamping the day to the last day of the month (e.g. 31 Feb -> 28/29 Feb). */
export function dateWithDay(year: number, month1: number, day: number): string {
  const normalizedYear = year + Math.floor((month1 - 1) / 12);
  const normalizedMonth = ((((month1 - 1) % 12) + 12) % 12) + 1;
  const clamped = Math.min(day, daysInMonth(normalizedYear, normalizedMonth));
  return formatDate(new Date(Date.UTC(normalizedYear, normalizedMonth - 1, clamped)));
}

export function addDays(value: string, days: number): string {
  return formatDate(new Date(parseDate(value).getTime() + days * MS_PER_DAY));
}

/** Adds calendar months keeping the day of month where possible (clamped at month end). */
export function addMonths(value: string, months: number): string {
  const { year, month, day } = parts(value);
  return dateWithDay(year, month + months, day);
}

export function startOfMonth(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

export function endOfMonth(value: string): string {
  const { year, month } = parts(value);
  return dateWithDay(year, month, 31);
}

export function monthKeyOf(value: string): string {
  return value.slice(0, 7);
}

export function monthStart(monthKey: string): string {
  return `${monthKey}-01`;
}

export function monthEnd(monthKey: string): string {
  return endOfMonth(monthStart(monthKey));
}

export function addMonthsToKey(monthKey: string, months: number): string {
  return monthKeyOf(addMonths(monthStart(monthKey), months));
}

/** Number of days from `from` to `to` (positive when `to` is later). */
export function diffDays(from: string, to: string): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / MS_PER_DAY);
}

/** Whole calendar months elapsed from `from` to `to` (0 when to < from). */
export function monthsBetween(from: string, to: string): number {
  const a = parts(from);
  const b = parts(to);
  let months = (b.year - a.year) * 12 + (b.month - a.month);
  if (b.day < a.day && b.day < daysInMonth(b.year, b.month)) months -= 1;
  return Math.max(0, months);
}

export function maxDate(...values: Array<string | null | undefined>): string | null {
  const defined = values.filter((v): v is string => !!v);
  if (defined.length === 0) return null;
  return defined.reduce((a, b) => (a >= b ? a : b));
}

export function minDate(...values: Array<string | null | undefined>): string | null {
  const defined = values.filter((v): v is string => !!v);
  if (defined.length === 0) return null;
  return defined.reduce((a, b) => (a <= b ? a : b));
}

/** Inclusive list of month keys between two month keys. */
export function monthKeysBetween(fromKey: string, toKey: string, limit = 240): string[] {
  const keys: string[] = [];
  let current = fromKey;
  while (current <= toKey && keys.length < limit) {
    keys.push(current);
    current = addMonthsToKey(current, 1);
  }
  return keys;
}

export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

export function shortMonthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTH_SHORT[m - 1]} ${y}`;
}

/** e.g. 05 Sept 2026 — the en-IN style the app uses, so notification text matches the screens. */
export function humanDate(value: string): string {
  const { year, month, day } = parts(value);
  const monthName = month === 9 ? 'Sept' : MONTH_SHORT[month - 1];
  return `${String(day).padStart(2, '0')} ${monthName} ${year}`;
}

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
