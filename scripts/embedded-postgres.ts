/**
 * Zero-setup local PostgreSQL for development and tests.
 *
 * Uses the `embedded-postgres` dev dependency, which ships real PostgreSQL
 * binaries for macOS, Linux and Windows through npm. Production never uses
 * this: set DATABASE_URL to a managed/real PostgreSQL instance instead.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

export interface EmbeddedDatabase {
  url: string;
  /** True when this process started the server (and should stop it). */
  owned: boolean;
  stop(): Promise<void>;
}

const USER = 'postgres';
const PASSWORD = 'postgres';

async function canConnect(port: number, database = 'postgres'): Promise<boolean> {
  const client = new pg.Client({ host: '127.0.0.1', port, user: USER, password: PASSWORD, database, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureDatabase(port: number, database: string): Promise<void> {
  const client = new pg.Client({ host: '127.0.0.1', port, user: USER, password: PASSWORD, database: 'postgres' });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (!exists.rowCount) await client.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
  } finally {
    await client.end();
  }
}

export async function startEmbeddedPostgres(options: {
  dataDir: string;
  port: number;
  database: string;
  log?: (message: string) => void;
}): Promise<EmbeddedDatabase> {
  const log = options.log ?? ((m: string) => console.log(m));
  const url = `postgres://${USER}:${PASSWORD}@127.0.0.1:${options.port}/${options.database}`;

  // A server from a previous run may still be alive (e.g. after a crash): reuse it.
  if (await canConnect(options.port)) {
    await ensureDatabase(options.port, options.database);
    log(`[db] Reusing PostgreSQL already running on port ${options.port}`);
    return { url, owned: false, stop: async () => undefined };
  }

  const pidFile = path.join(options.dataDir, 'postmaster.pid');
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').split('\n')[0]);
    if (!pid || !processAlive(pid)) {
      rmSync(pidFile, { force: true });
    }
  }

  const server = new EmbeddedPostgres({
    databaseDir: options.dataDir,
    port: options.port,
    user: USER,
    password: PASSWORD,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale-provider=builtin', '--builtin-locale=C.UTF-8'],
    onLog: () => undefined,
    onError: (message) => {
      const text = String(message ?? '').trim();
      if (text && /FATAL|PANIC|could not/i.test(text)) log(`[db] ${text}`);
    },
  });

  if (!existsSync(path.join(options.dataDir, 'PG_VERSION'))) {
    log(`[db] Initialising a local PostgreSQL cluster in ${options.dataDir} (first run only)...`);
    await server.initialise();
  }
  await server.start();
  await ensureDatabase(options.port, options.database);
  log(`[db] PostgreSQL running on 127.0.0.1:${options.port} (database "${options.database}")`);

  return {
    url,
    owned: true,
    stop: async () => {
      await server.stop();
    },
  };
}
