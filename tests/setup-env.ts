import { inject } from 'vitest';

// Must run before any application module reads the configuration.
process.env.MONGODB_URI = inject('mongoUri');
process.env.MONGODB_DB = 'rentoledger_test';
