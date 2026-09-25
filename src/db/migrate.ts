import type { Knex } from 'knex';
import * as m0001 from './migrations/0001_initial_schema.js';

interface MigrationModule {
  up(knex: Knex): Promise<void>;
  down(knex: Knex): Promise<void>;
}

/**
 * Migrations are registered explicitly (instead of being discovered on disk)
 * so they behave identically under tsx in development and compiled JS in
 * production. Append new migrations to the end of this list.
 */
const MIGRATIONS: Record<string, MigrationModule> = {
  '0001_initial_schema': m0001,
};

class StaticMigrationSource implements Knex.MigrationSource<string> {
  getMigrations(): Promise<string[]> {
    return Promise.resolve(Object.keys(MIGRATIONS).sort());
  }

  getMigrationName(migration: string): string {
    return migration;
  }

  getMigration(migration: string): Promise<Knex.Migration> {
    const module = MIGRATIONS[migration];
    if (!module) throw new Error(`Unknown migration ${migration}`);
    return Promise.resolve(module);
  }
}

const migrationConfig: Knex.MigratorConfig = {
  migrationSource: new StaticMigrationSource(),
  tableName: 'knex_migrations',
};

export async function migrateLatest(db: Knex): Promise<string[]> {
  const [, applied] = (await db.migrate.latest(migrationConfig)) as [number, string[]];
  return applied;
}

export async function rollbackAll(db: Knex): Promise<string[]> {
  const [, rolledBack] = (await db.migrate.rollback(migrationConfig, true)) as [number, string[]];
  return rolledBack;
}

export async function rollbackLast(db: Knex): Promise<string[]> {
  const [, rolledBack] = (await db.migrate.rollback(migrationConfig)) as [number, string[]];
  return rolledBack;
}
