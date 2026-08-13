import { Client } from 'pg';
import { loadDatabaseConfig } from '../src/adapters/persistence/postgres/database-config';

/**
 * Creates the migration identity, once per database, as the container's
 * superuser. Idempotent.
 *
 * This step exists because migrations must not run as a superuser. The runtime
 * identities are deliberately non-owners so row-level security applies to them,
 * and that distinction is meaningless if the account that owns the schema is
 * also the one serving requests. The app and operator roles are created by a
 * migration rather than here, so their grants stay reviewable in version
 * control.
 */
async function main(): Promise<void> {
  const config = loadDatabaseConfig(process.env);

  const superUser = process.env.POSTGRES_USER?.trim();
  const superPassword = process.env.POSTGRES_PASSWORD?.trim();
  if (!superUser || !superPassword) {
    throw new Error(
      'POSTGRES_USER and POSTGRES_PASSWORD (the local container superuser) are required to bootstrap roles',
    );
  }

  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: superUser,
    password: superPassword,
  });

  await client.connect();
  try {
    const { user, password } = config.migrator;

    const existing = await client.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [user],
    );
    const verb = existing.rowCount === 0 ? 'CREATE' : 'ALTER';

    // DDL cannot be parameterized and DO blocks accept no parameters, so the
    // server quotes the identifier and literal for us before they are spliced
    // into the statement.
    const quoted = await client.query<{
      role: string;
      secret: string;
      database: string;
    }>(
      'SELECT quote_ident($1) AS role, quote_literal($2) AS secret, quote_ident($3) AS database',
      [user, password, config.database],
    );
    const { role, secret, database } = quoted.rows[0];

    await client.query(`${verb} ROLE ${role} LOGIN PASSWORD ${secret} CREATEROLE`);
    await client.query(`GRANT CREATE, CONNECT ON DATABASE ${database} TO ${role}`);
    await client.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${role}`);

    process.stdout.write(`bootstrapped migration role "${user}"\n`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
