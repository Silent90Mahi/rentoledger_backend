import { randomUUID } from 'node:crypto';
import { MongoClient, type ClientSession, type Collection, type Db, type Document, type TransactionOptions } from 'mongodb';
import { config } from '../config/env.js';

/**
 * MongoDB access.
 *
 * Conventions (they keep the service layer close to a relational model):
 * - `_id` is a UUID string (the public id); `toRow` exposes it as `id`.
 * - Field names are snake_case; references are `<entity>_id` UUID strings and
 *   every business document carries `account_id`.
 * - Business dates are `YYYY-MM-DD` strings (they sort and compare as text);
 *   audit timestamps are BSON dates. Money is a number in rupees (2 decimals).
 * - Multi-document changes run in a transaction (`withTransaction`), which
 *   requires a replica set (Atlas, a self-hosted replica set, or the
 *   single-node set that `npm run dev` starts).
 */

export type Doc = Document & { _id: string };
export type Session = ClientSession | undefined;

let client: MongoClient | null = null;
let database: Db | null = null;

function uri(): string {
  const value = process.env.MONGODB_URI ?? config.db.uri;
  if (!value) {
    throw new Error('MONGODB_URI is not configured. Run `npm run dev` (starts a local database automatically) or set MONGODB_URI.');
  }
  return value;
}

export function getClient(): MongoClient {
  if (!client) {
    client = new MongoClient(uri(), {
      maxPoolSize: config.db.poolMax,
      serverSelectionTimeoutMS: 15_000,
      appName: 'rentoledger-api',
      ignoreUndefined: true,
    });
  }
  return client;
}

export function getDb(): Db {
  if (!database) database = getClient().db(process.env.MONGODB_DB ?? config.db.name);
  return database;
}

export async function connectDb(): Promise<void> {
  await getClient().connect();
}

export async function closeDb(): Promise<void> {
  const current = client;
  client = null;
  database = null;
  if (current) await current.close();
}

/**
 * A collection handle. Documents are loosely typed (like query-builder rows);
 * services map them to typed DTOs explicitly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function col(name: CollectionName): Collection<any> {
  return getDb().collection(name);
}

export const COLLECTIONS = [
  'users',
  'accounts',
  'account_members',
  'otp_codes',
  'refresh_tokens',
  'properties',
  'units',
  'tenants',
  'agreements',
  'rent_charges',
  'payments',
  'payment_allocations',
  'deposit_transactions',
  'expenses',
  'notifications',
  'activity_logs',
  'locks',
] as const;
export type CollectionName = (typeof COLLECTIONS)[number];

export const newId = (): string => randomUUID();

/** `{ session }` option when running inside a transaction. */
export const opts = (session: Session) => (session ? { session } : {});

/** `_id` -> `id` (keeps every other field). */
export function toRow<T extends Record<string, any>>(doc: T | null | undefined): (Omit<T, '_id'> & { id: string }) | undefined {
  if (!doc) return undefined;
  const { _id, ...rest } = doc as any;
  return { id: _id, ...rest };
}

/** New document with id and timestamps. */
export function stamp<T extends Record<string, any>>(fields: T, withUpdated = true): T & { _id: string; created_at: Date; updated_at?: Date } {
  const at = new Date();
  return { _id: newId(), ...fields, created_at: at, ...(withUpdated ? { updated_at: at } : {}) } as any;
}

const TRANSACTION_OPTIONS: TransactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
};

/**
 * Runs `fn` in a transaction. The driver retries the whole callback on
 * transient errors and write conflicts, so `fn` must be safe to re-run
 * (no external side effects inside it).
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = getClient().startSession();
  try {
    let result: T;
    await session.withTransaction(async (s) => {
      result = await fn(s);
    }, TRANSACTION_OPTIONS);
    return result!;
  } finally {
    await session.endSession();
  }
}

/**
 * Serialises concurrent transactions on one document (the MongoDB take on
 * `SELECT ... FOR UPDATE`): writing to it makes any other transaction that
 * also locks it fail with a write conflict, which `withTransaction` retries.
 */
export async function lockDoc(name: CollectionName, id: string, session: ClientSession): Promise<boolean> {
  const result = await col(name).updateOne({ _id: id }, { $inc: { lock_version: 1 } }, { session });
  return result.matchedCount === 1;
}

/** Case-insensitive exact match for user text (escapes regex characters). */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `$regex` filter for "contains" search, case-insensitive. */
export function contains(value: string): { $regex: string; $options: string } {
  return { $regex: escapeRegex(value), $options: 'i' };
}

/** Rounds a money value to paise (avoids floating point residue in sums). */
export { round2 } from '../lib/money.js';

/** Aggregation expression rounding to 2 decimals. */
export const $round2 = (expr: unknown) => ({ $round: [expr, 2] });
