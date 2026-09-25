import { z } from 'zod';
import { Errors } from './errors.js';
import { isValidDateString, isValidMonthKey } from './dates.js';
import { normalizePhone } from './phone.js';

// Friendlier default messages for the most common failures.
z.config({
  customError: (issue) => {
    if (issue.code === 'invalid_type' && issue.input === undefined) return 'This field is required';
    if (issue.code === 'invalid_type' && issue.input === null) return 'This field is required';
    return undefined;
  },
});

/**
 * Parses untrusted input with a zod schema, converting failures into a
 * VALIDATION_ERROR AppError with per-field details.
 */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => ({
    field: issue.path.length ? issue.path.join('.') : undefined,
    message: issue.message,
  }));
  const first = details[0];
  const message = first?.field ? `${humanizeField(first.field)}: ${first.message}` : first?.message ?? 'Invalid request.';
  throw Errors.validation(message, details);
}

function humanizeField(field: string): string {
  const last = field.split('.').pop() ?? field;
  const spaced = last.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

const numberLike = z.union([
  z.number(),
  z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d+)?$/, 'Must be a number')
    .transform(Number),
]);

/** Monetary amount in rupees with at most two decimal places. */
export function zAmount(options: { allowZero?: boolean; max?: number } = {}) {
  const { allowZero = false, max = 100_000_000_000 } = options;
  return numberLike.pipe(
    z
      .number()
      .refine((v) => (allowZero ? v >= 0 : v > 0), {
        message: allowZero ? 'Must be zero or more' : 'Must be greater than zero',
      })
      .refine((v) => v <= max, { message: `Must not exceed ${max.toLocaleString('en-IN')}` })
      .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, {
        message: 'At most 2 decimal places are allowed',
      }),
  );
}

export function zPercent(max = 100) {
  return numberLike.pipe(
    z
      .number()
      .min(0, 'Must be zero or more')
      .max(max, `Must not exceed ${max}`)
      .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, {
        message: 'At most 2 decimal places are allowed',
      }),
  );
}

export function zInt(min: number, max: number) {
  return numberLike.pipe(z.number().int('Must be a whole number').min(min, `Must be at least ${min}`).max(max, `Must be at most ${max}`));
}

export const zId = z.uuid('Must be a valid id');

export const zDate = z
  .string()
  .trim()
  .refine(isValidDateString, { message: 'Must be a valid date (YYYY-MM-DD)' });

export const zMonth = z
  .string()
  .trim()
  .refine(isValidMonthKey, { message: 'Must be a month in YYYY-MM format' });

export const zPhone = z
  .string()
  .trim()
  .min(1, 'This field is required')
  .transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid 10-digit mobile number' });
      return z.NEVER;
    }
    return normalized;
  });

/** Required, trimmed, non-empty string. */
export function zName(max = 120) {
  return z
    .string()
    .trim()
    .min(1, 'This field is required')
    .max(max, `Must be at most ${max} characters`);
}

/** Optional free text: empty strings become null. */
export function zText(max = 1000) {
  return z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters`)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));
}

export const zOptionalPhone = z
  .string()
  .trim()
  .nullish()
  .transform((value, ctx) => {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid 10-digit mobile number' });
      return z.NEVER;
    }
    return normalized;
  });

export const zEmail = z
  .string()
  .trim()
  .toLowerCase()
  .nullish()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    if (!z.email().safeParse(v).success || v.length > 254) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid email address' });
      return z.NEVER;
    }
    return v;
  });

export const zBoolQuery = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const zPage = z.coerce.number().int().min(1).max(100_000).default(1);
export const zPageSize = z.coerce.number().int().min(1).max(100).default(20);
export const zSearch = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((v) => (v ? v : undefined));
export const zSort = z
  .string()
  .trim()
  .regex(/^-?[a-zA-Z_]+$/, 'Invalid sort field')
  .optional();

export const paginationShape = {
  page: zPage,
  pageSize: zPageSize,
  search: zSearch,
  sort: zSort,
};

/** Resolves a `sort` query param (e.g. `-createdAt`) against a whitelist of SQL columns. */
export function resolveSort(
  sort: string | undefined,
  allowed: Record<string, string>,
  fallback: { column: string; direction: 'asc' | 'desc' },
): { column: string; direction: 'asc' | 'desc' } {
  if (!sort) return fallback;
  const direction = sort.startsWith('-') ? 'desc' : 'asc';
  const key = sort.replace(/^-/, '');
  const column = allowed[key];
  if (!column) {
    throw Errors.validation(`Cannot sort by "${key}". Allowed: ${Object.keys(allowed).join(', ')}`, [
      { field: 'sort', message: 'Unsupported sort field' },
    ]);
  }
  return { column, direction };
}

const idParams = z.object({ id: zId });

/** Validates the `:id` route parameter as a UUID. */
export function idParam(req: { params: Record<string, string | string[] | undefined> }, name = 'id'): string {
  const value = req.params[name];
  const result = idParams.safeParse({ id: value });
  if (!result.success) throw Errors.notFound();
  return result.data.id;
}

/** Escapes LIKE/ILIKE wildcards in user supplied search terms. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
