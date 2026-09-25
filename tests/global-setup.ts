import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import knex from 'knex';
import { startEmbeddedPostgres, type EmbeddedDatabase } from '../scripts/embedded-postgres.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let database: EmbeddedDatabase | null = null;

/**
 * Starts (or reuses) a PostgreSQL server for the test run. Set
 * TEST_DATABASE_URL to run the suite against an existing server instead.
 */
export async function setup(project: TestProject): Promise<void> {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    database = await startEmbeddedPostgres({
      dataDir: path.join(root, '.data', 'postgres-test'),
      port: Number(process.env.TEST_PG_PORT ?? 54330),
      database: 'rentoledger_test',
      log: () => undefined,
    });
    url = database.url;
  }

  // Start every run from an empty schema.
  const admin = knex({ client: 'pg', connection: url });
  await admin.raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.destroy();

  project.provide('databaseUrl', url);
}

export async function teardown(): Promise<void> {
  if (database?.owned) await database.stop();
}
