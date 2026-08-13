import { resolve } from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadDatabaseConfig } from '../../../src/adapters/persistence/postgres/database-config';

/**
 * Brings the local database up to date once, before the suite runs.
 *
 * Migrations are applied as the schema owner, exactly as they are in
 * development, so the tests exercise the same grants and policies a real
 * deployment gets rather than a hand-built approximation of them.
 *
 * Creating the roles is deliberately not done here. Role creation needs the
 * container superuser and is a one-time act of local setup; doing it silently
 * from a test run would hide a missing prerequisite behind a green suite.
 */
export default async function globalSetup(): Promise<void> {
  const config = loadDatabaseConfig(process.env);

  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.migrator.user,
    password: config.migrator.password,
    max: 1,
  });

  try {
    await migrate(drizzle(pool), {
      migrationsFolder: resolve(__dirname, '../../../drizzle'),
    });
  } catch (error) {
    throw new Error(
      `could not migrate the integration database as "${config.migrator.user}" ` +
        `at ${config.host}:${config.port}/${config.database}. ` +
        'Start the local stack with `docker compose up -d postgres` and create the roles ' +
        'once with `pnpm db:bootstrap`.\n' +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await pool.end();
  }
}
