import type { TestProject } from 'vitest/node';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

let server: MongoMemoryReplSet | null = null;

/**
 * Starts a throwaway single-node MongoDB replica set (in memory) for the test
 * run. Set TEST_MONGODB_URI to run the suite against an existing replica set
 * instead (its `rentoledger_test` database is dropped by the tests).
 */
export async function setup(project: TestProject): Promise<void> {
  let uri = process.env.TEST_MONGODB_URI;
  if (!uri) {
    server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    uri = server.getUri();
  }
  project.provide('mongoUri', uri);
}

export async function teardown(): Promise<void> {
  if (server) await server.stop();
}
