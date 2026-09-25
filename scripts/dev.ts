/**
 * `npm run dev` — one command local development.
 *
 * 1. Loads .env (optional).
 * 2. Uses DATABASE_URL when set; otherwise starts an embedded PostgreSQL in
 *    ./.data/postgres (no install, no Docker needed).
 * 3. Applies migrations and loads demo data into an empty database.
 * 4. Runs the API with automatic restart on file changes.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
process.env.NODE_ENV ??= 'development';

const { config } = await import('../src/config/env.js');
const { ensureDatabaseExists } = await import('../src/db/ensure-database.js');
const { closeDb, getDb } = await import('../src/db/knex.js');
const { migrateLatest } = await import('../src/db/migrate.js');

const log = (message: string) => console.log(message);

let stopDatabase: (() => Promise<void>) | null = null;
let databaseUrl = process.env.DATABASE_URL;

if (databaseUrl) {
  const status = await ensureDatabaseExists(databaseUrl, config.db.ssl);
  if (status === 'created') log('[db] Created database from DATABASE_URL');
  log('[db] Using DATABASE_URL');
} else {
  const { startEmbeddedPostgres } = await import('./embedded-postgres.js');
  const embedded = await startEmbeddedPostgres({
    dataDir: path.join(root, '.data', 'postgres'),
    port: Number(process.env.EMBEDDED_PG_PORT ?? 54329),
    database: 'rentoledger',
    log,
  });
  databaseUrl = embedded.url;
  process.env.DATABASE_URL = databaseUrl;
  if (embedded.owned) stopDatabase = embedded.stop;
}

try {
  const applied = await migrateLatest(getDb());
  if (applied.length) log(`[db] Applied migrations: ${applied.join(', ')}`);
  const [{ count }] = await getDb()('users').count<{ count: number }[]>({ count: '*' });
  if (Number(count) === 0 && process.env.SEED_DEMO_DATA !== 'false') {
    log('[db] Empty database: loading demo data...');
    const { seedDemoData } = await import('../src/db/seed/demo.js');
    await seedDemoData();
    log('[db] Demo data ready. Sign in with 98765 43210 (owner) or 98123 45673 (tenant).');
  }
} catch (error) {
  console.error('[db] Database setup failed:', error);
  await closeDb();
  if (stopDatabase) await stopDatabase();
  process.exit(1);
}
await closeDb();

const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
let child: ChildProcess | null = spawn(process.execPath, [tsxCli, 'watch', '--clear-screen=false', 'src/server.ts'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: databaseUrl, DEV_OTP_CODE: process.env.DEV_OTP_CODE ?? '123456' },
});

let exiting = false;
async function shutdown(code: number) {
  if (exiting) return;
  exiting = true;
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      child!.once('exit', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }
  child = null;
  if (stopDatabase) {
    log('[db] Stopping local PostgreSQL...');
    await stopDatabase().catch(() => undefined);
  }
  process.exit(code);
}

child.on('exit', (code) => {
  if (!exiting) void shutdown(code ?? 0);
});
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
