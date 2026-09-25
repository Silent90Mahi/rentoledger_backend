/**
 * Zero-setup local MongoDB for development and tests.
 *
 * Starts a single-node replica set (transactions need a replica set) with the
 * `mongodb-memory-server` dev dependency, which downloads the official
 * `mongod` binary once and caches it. Production never uses this: set
 * MONGODB_URI to MongoDB Atlas or your own replica set instead.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

export interface EmbeddedDatabase {
  uri: string;
  /** True when this process started the server (and should stop it). */
  owned: boolean;
  stop(): Promise<void>;
}

const REPLICA_SET = 'rs0';

async function isRunning(uri: string): Promise<boolean> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 1500, directConnection: true });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
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

export async function startEmbeddedMongo(options: {
  dataDir: string;
  port: number;
  log?: (message: string) => void;
}): Promise<EmbeddedDatabase> {
  const log = options.log ?? ((m: string) => console.log(m));
  const uri = `mongodb://127.0.0.1:${options.port}/?replicaSet=${REPLICA_SET}`;

  // A server from a previous run may still be alive (e.g. `npm run dev` in another terminal): reuse it.
  if (await isRunning(`mongodb://127.0.0.1:${options.port}/`)) {
    log(`[db] Reusing MongoDB already running on port ${options.port}`);
    return { uri, owned: false, stop: async () => undefined };
  }

  // Remove a stale lock left by a crashed mongod so it can start again.
  const lockFile = path.join(options.dataDir, 'mongod.lock');
  if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, 'utf8').trim());
    if (!pid || !processAlive(pid)) rmSync(lockFile, { force: true });
  }

  const firstRun = !existsSync(path.join(options.dataDir, 'WiredTiger'));
  mkdirSync(options.dataDir, { recursive: true });
  if (firstRun) log(`[db] Starting a local MongoDB replica set in ${options.dataDir} (first run downloads mongod once)...`);

  const server = await MongoMemoryReplSet.create({
    replSet: { count: 1, name: REPLICA_SET, storageEngine: 'wiredTiger' },
    instanceOpts: [{ port: options.port, dbPath: options.dataDir }],
  });
  log(`[db] MongoDB running on 127.0.0.1:${options.port} (replica set "${REPLICA_SET}")`);

  return {
    uri,
    owned: true,
    stop: async () => {
      await server.stop({ doCleanup: false, force: false });
    },
  };
}
