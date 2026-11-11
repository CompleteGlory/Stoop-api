import pg from 'pg';

/** Creates the test database (with PostGIS) when it does not exist yet. */
export default async function globalSetup() {
  const url = new URL(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/placerating_test');
  const dbName = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';

  const adminClient = new pg.Client({ connectionString: admin.toString() });
  await adminClient.connect();
  try {
    const found = await adminClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (found.rowCount === 0) await adminClient.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await adminClient.end();
  }
}
