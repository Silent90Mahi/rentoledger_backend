/**
 * Database CLI:
 *   migrate   apply pending migrations (creates the database if missing)
 *   rollback  undo the last migration batch
 *   seed      load demo data into an empty database (--force allows it in production; never wipes data)
 *   reset     drop everything, migrate and seed (development only)
 */
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ensureDatabaseExists } from './ensure-database.js';
import { closeDb, getDb } from './knex.js';
import { migrateLatest, rollbackAll, rollbackLast } from './migrate.js';
import { seedDemoData } from './seed/demo.js';

async function isEmpty(): Promise<boolean> {
  const [{ count }] = await getDb()('users').count<{ count: number }[]>({ count: '*' });
  return Number(count) === 0;
}

async function run(command: string, force: boolean): Promise<void> {
  const url = process.env.DATABASE_URL ?? config.db.url;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Tip: `npm run dev` starts a local database automatically.');
  }
  switch (command) {
    case 'migrate': {
      if (!config.isProduction) await ensureDatabaseExists(url, config.db.ssl);
      const applied = await migrateLatest(getDb());
      logger.info(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date');
      return;
    }
    case 'rollback': {
      const rolledBack = await rollbackLast(getDb());
      logger.info(rolledBack.length ? `Rolled back: ${rolledBack.join(', ')}` : 'Nothing to roll back');
      return;
    }
    case 'seed': {
      if (config.isProduction && !force) throw new Error('Refusing to seed demo data in production (pass --force to override).');
      await migrateLatest(getDb());
      if (!(await isEmpty())) {
        logger.warn('Database already has data; skipping demo seed. In development, `npm run db:reset` starts over.');
        return;
      }
      await seedDemoData();
      return;
    }
    case 'reset': {
      if (config.isProduction) throw new Error('db:reset is disabled in production.');
      await ensureDatabaseExists(url, config.db.ssl);
      await rollbackAll(getDb());
      await migrateLatest(getDb());
      await seedDemoData();
      logger.info('Database reset with demo data');
      return;
    }
    default:
      throw new Error(`Unknown command "${command}". Use migrate | rollback | seed | reset.`);
  }
}

const [command = 'migrate', ...flags] = process.argv.slice(2);
try {
  await run(command, flags.includes('--force'));
  await closeDb();
  process.exit(0);
} catch (error) {
  logger.error({ err: error }, `db ${command} failed`);
  await closeDb();
  process.exit(1);
}
