/**
 * Runs a TypeScript entry point against the local development database.
 *
 *   tsx scripts/with-dev-db.ts src/db/cli.ts reset
 *
 * Uses MONGODB_URI when it is set. Otherwise it reuses the local MongoDB that
 * `npm run dev` runs (or starts it for the duration of the command), so
 * `npm run db:reset` and friends work without any setup.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error('Usage: tsx scripts/with-dev-db.ts <entry.ts> [...args]');
  process.exit(1);
}

// Loads .env so MONGODB_URI / NODE_ENV from the file are honoured.
const { config } = await import('../src/config/env.js');

let stopDatabase: (() => Promise<void>) | null = null;
if (!process.env.MONGODB_URI && !config.db.uri) {
  if (config.isProduction) {
    console.error('MONGODB_URI must be set in production.');
    process.exit(1);
  }
  const { startEmbeddedMongo } = await import('./embedded-mongo.js');
  const embedded = await startEmbeddedMongo({
    dataDir: path.join(root, '.data', 'mongo'),
    port: Number(process.env.EMBEDDED_MONGO_PORT ?? 27027),
    log: (message) => console.log(message),
  });
  process.env.MONGODB_URI = embedded.uri;
  if (embedded.owned) stopDatabase = embedded.stop;
}

const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const code = await new Promise<number>((resolve) => {
  const child = spawn(process.execPath, [tsxCli, entry, ...args], { stdio: 'inherit', env: process.env });
  child.on('exit', (exitCode) => resolve(exitCode ?? 1));
});

if (stopDatabase) await stopDatabase().catch(() => undefined);
process.exit(code);
