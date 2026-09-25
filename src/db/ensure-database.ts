import pg from 'pg';

/**
 * Creates the database named in `connectionString` when it does not exist yet.
 * Makes a clean local setup work with any Postgres server the developer points
 * DATABASE_URL at. Failures (e.g. missing CREATEDB privilege) are reported but
 * not fatal: the subsequent connection attempt gives the real error.
 */
export async function ensureDatabaseExists(connectionString: string, ssl?: boolean): Promise<'created' | 'exists' | 'skipped'> {
  const url = new URL(connectionString);
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!dbName) return 'skipped';

  const adminUrl = new URL(connectionString);
  adminUrl.pathname = '/postgres';
  const client = new pg.Client({ connectionString: adminUrl.toString(), ssl: ssl ? { rejectUnauthorized: false } : undefined });
  try {
    await client.connect();
    const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (result.rowCount && result.rowCount > 0) return 'exists';
    const safeName = dbName.replace(/"/g, '""');
    await client.query(`CREATE DATABASE "${safeName}"`);
    return 'created';
  } catch {
    return 'skipped';
  } finally {
    await client.end().catch(() => undefined);
  }
}
