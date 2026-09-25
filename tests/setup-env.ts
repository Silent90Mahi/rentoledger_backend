import { inject } from 'vitest';

// Must run before any application module reads the configuration.
process.env.DATABASE_URL = inject('databaseUrl');
