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

  // The migration fixes these names structurally. If the environment points the
  // application somewhere else, the grants and policies would silently apply to
  // a role nobody connects as — so a mismatch fails here instead.
  const canonical = {
    app: 'cubeforge_app',
    operator: 'cubeforge_operator',
    authenticator: 'cubeforge_authenticator',
  } as const;
  for (const identity of ['app', 'operator', 'authenticator'] as const) {
    if (config[identity].user !== canonical[identity]) {
      throw new Error(
        `POSTGRES_${identity.toUpperCase()}_USER must be "${canonical[identity]}" ` +
          `to match the grants in the migration, got "${config[identity].user}"`,
      );
    }
  }

  await client.connect();
  try {
    await grantLogin(client, config.migrator, { createRole: true });
    await grantLogin(client, config.app, { createRole: false });
    await grantLogin(client, config.operator, { createRole: false });
    await grantLogin(client, config.authenticator, { createRole: false });

    const { rows } = await client.query<{ role: string; database: string }>(
      'SELECT quote_ident($1) AS role, quote_ident($2) AS database',
      [config.migrator.user, config.database],
    );
    const { role, database } = rows[0];

    await client.query(`GRANT CREATE, CONNECT ON DATABASE ${database} TO ${role}`);
    await client.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${role}`);

    process.stdout.write(
      `bootstrapped roles: ${config.migrator.user}, ${config.app.user}, ` +
        `${config.operator.user}, ${config.authenticator.user}\n`,
    );
  } finally {
    await client.end();
  }
}

/**
 * Creates the role if absent, then sets LOGIN and its password. Passwords live
 * only in the environment; the migration owns the role's grants and policies.
 *
 * DDL cannot be parameterized and `DO` blocks accept no parameters, so the
 * server quotes the identifier and literal before they are spliced in.
 */
async function grantLogin(
  client: Client,
  identity: { readonly user: string; readonly password: string },
  options: { readonly createRole: boolean },
): Promise<void> {
  const { rows } = await client.query<{ role: string; secret: string }>(
    'SELECT quote_ident($1) AS role, quote_literal($2) AS secret',
    [identity.user, identity.password],
  );
  const { role, secret } = rows[0];

  const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
    identity.user,
  ]);
  if (existing.rowCount === 0) {
    await client.query(`CREATE ROLE ${role} NOLOGIN`);
  }

  const attributes = options.createRole ? 'LOGIN CREATEROLE' : 'LOGIN';
  await client.query(`ALTER ROLE ${role} ${attributes} PASSWORD ${secret}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
