/**
 * Database CLI:
 *   migrate   create collections and indexes (idempotent; also runs on server start)
 *   seed      load demo data into an empty database (--force allows it in production; never wipes data)
 *   reset     drop the database, recreate indexes and load demo data (development only)
 */
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ensureIndexes } from './indexes.js';
import { closeDb, col, connectDb, getDb } from './mongo.js';
import { seedDemoData } from './seed/demo.js';

async function isEmpty(): Promise<boolean> {
  return (await col('users').countDocuments({}, { limit: 1 })) === 0;
}

async function run(command: string, force: boolean): Promise<void> {
  if (!process.env.MONGODB_URI && !config.db.uri) {
    throw new Error('MONGODB_URI is not set. Tip: `npm run dev` starts a local database automatically.');
  }
  await connectDb();
  switch (command) {
    case 'migrate': {
      const count = await ensureIndexes();
      logger.info(`Database ready (${count} indexes checked)`);
      return;
    }
    case 'seed': {
      if (config.isProduction && !force) throw new Error('Refusing to seed demo data in production (pass --force to override).');
      await ensureIndexes();
      if (!(await isEmpty())) {
        logger.warn('Database already has data; skipping demo seed. In development, `npm run db:reset` starts over.');
        return;
      }
      await seedDemoData();
      return;
    }
    case 'reset': {
      if (config.isProduction) throw new Error('db:reset is disabled in production.');
      await getDb().dropDatabase();
      await ensureIndexes();
      await seedDemoData();
      logger.info('Database reset with demo data');
      return;
    }
    default:
      throw new Error(`Unknown command "${command}". Use migrate | seed | reset.`);
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
