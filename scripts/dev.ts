/**
 * `npm run dev` — one command local development.
 *
 * 1. Loads .env (optional).
 * 2. Uses MONGODB_URI when set; otherwise starts a local single-node MongoDB
 *    replica set in ./.data/mongo (no install, no Docker needed).
 * 3. Creates indexes and loads demo data into an empty database.
 * 4. Runs the API with automatic restart on file changes.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
process.env.NODE_ENV ??= 'development';

await import('../src/config/env.js');
const { closeDb, col, connectDb } = await import('../src/db/mongo.js');
const { ensureIndexes } = await import('../src/db/indexes.js');

const log = (message: string) => console.log(message);

let stopDatabase: (() => Promise<void>) | null = null;
let databaseUri = process.env.MONGODB_URI;

if (databaseUri) {
  log('[db] Using MONGODB_URI');
} else {
  const { startEmbeddedMongo } = await import('./embedded-mongo.js');
  const embedded = await startEmbeddedMongo({
    dataDir: path.join(root, '.data', 'mongo'),
    port: Number(process.env.EMBEDDED_MONGO_PORT ?? 27027),
    log,
  });
  databaseUri = embedded.uri;
  process.env.MONGODB_URI = databaseUri;
  if (embedded.owned) stopDatabase = embedded.stop;
}

try {
  await connectDb();
  await ensureIndexes();
  const count = await col('users').countDocuments({}, { limit: 1 });
  if (count === 0 && process.env.SEED_DEMO_DATA !== 'false') {
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
  env: { ...process.env, MONGODB_URI: databaseUri, DEV_OTP_CODE: process.env.DEV_OTP_CODE ?? '123456' },
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
    log('[db] Stopping local MongoDB...');
    await stopDatabase().catch(() => undefined);
  }
  process.exit(code);
}

child.on('exit', (code) => {
  if (!exiting) void shutdown(code ?? 0);
});
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
