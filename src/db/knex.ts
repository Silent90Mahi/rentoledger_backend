import knex, { type Knex } from 'knex';
import pg from 'pg';
import { config } from '../config/env.js';

// NUMERIC -> JS number (amounts are NUMERIC(14,2); well within double precision).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => Number(value));
// BIGINT (e.g. COUNT(*)) -> JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));
// DATE -> keep as 'YYYY-MM-DD' string to avoid time zone shifts.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

export type Db = Knex;
export type Trx = Knex.Transaction;
export type DbOrTrx = Knex | Knex.Transaction;

export function createDb(connectionString: string, poolMax = config.db.poolMax): Knex {
  return knex({
    client: 'pg',
    connection: {
      connectionString,
      ssl: config.db.ssl ? { rejectUnauthorized: config.db.sslRejectUnauthorized } : undefined,
      application_name: 'rentoledger-api',
    },
    pool: {
      min: 0,
      max: poolMax,
      afterCreate(conn: pg.Client, done: (err: Error | null, conn: pg.Client) => void) {
        // Timestamps are always handled in UTC; business dates use explicit parameters.
        conn.query("SET TIME ZONE 'UTC'; SET statement_timeout = '30s';", (err) => done(err ?? null, conn));
      },
    },
    acquireConnectionTimeout: 15_000,
  });
}

let instance: Knex | null = null;

/** Shared connection pool for the process. */
export function getDb(): Knex {
  if (!instance) {
    const url = process.env.DATABASE_URL ?? config.db.url;
    if (!url) {
      throw new Error('DATABASE_URL is not configured. Run `npm run dev` (starts a local database automatically) or set DATABASE_URL.');
    }
    instance = createDb(url);
  }
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    const current = instance;
    instance = null;
    await current.destroy();
  }
}

/** Proxy so modules can `import { db }` while the pool is still created lazily. */
export const db: Knex = new Proxy(function () {} as unknown as Knex, {
  apply(_target, _thisArg, args: unknown[]) {
    return (getDb() as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get(_target, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});
