export interface DatabaseIdentity {
  readonly user: string;
  readonly password: string;
}

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** Owns the schema and applies migrations. Never used to serve requests. */
  readonly migrator: DatabaseIdentity;
  /** Tenant-scoped runtime identity. Subject to row-level security. */
  readonly app: DatabaseIdentity;
  /** Platform-operator identity. Holds no grant on tenant-owned tables. */
  readonly operator: DatabaseIdentity;
  /**
   * Reads credentials, with no tenant context at all. Resolving an API key must
   * discover which tenant it belongs to, so it cannot run under a policy keyed
   * on the tenant it is trying to learn.
   */
  readonly authenticator: DatabaseIdentity;
}

type Env = Record<string, string | undefined>;

function collect(
  env: Env,
  keys: readonly string[],
  missing: string[],
): string[] {
  return keys.map((key) => {
    const value = env[key]?.trim() ?? '';
    if (value.length === 0) {
      missing.push(key);
    }
    return value;
  });
}

/**
 * Validated once at startup rather than at first query, so a misconfigured
 * deployment fails immediately and visibly instead of serving traffic until
 * something touches the database.
 *
 * Every missing key is reported together: discovering them one restart at a
 * time is a needless waste of the operator's afternoon.
 */
export function loadDatabaseConfig(env: Env): DatabaseConfig {
  const missing: string[] = [];

  const [host, rawPort, database] = collect(
    env,
    ['POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB'],
    missing,
  );
  const [migratorUser, migratorPassword] = collect(
    env,
    ['POSTGRES_MIGRATOR_USER', 'POSTGRES_MIGRATOR_PASSWORD'],
    missing,
  );
  const [appUser, appPassword] = collect(
    env,
    ['POSTGRES_APP_USER', 'POSTGRES_APP_PASSWORD'],
    missing,
  );
  const [operatorUser, operatorPassword] = collect(
    env,
    ['POSTGRES_OPERATOR_USER', 'POSTGRES_OPERATOR_PASSWORD'],
    missing,
  );
  const [authenticatorUser, authenticatorPassword] = collect(
    env,
    ['POSTGRES_AUTHENTICATOR_USER', 'POSTGRES_AUTHENTICATOR_PASSWORD'],
    missing,
  );

  if (missing.length > 0) {
    throw new Error(`missing database configuration: ${missing.join(', ')}`);
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `POSTGRES_PORT must be a positive integer, got "${rawPort}"`,
    );
  }

  // A table owner bypasses row-level security. If the runtime identities were
  // ever pointed at the migration user, every policy in the schema would become
  // decorative and the isolation guarantee would silently disappear — so this
  // is a startup failure, not a warning.
  for (const [label, user] of [
    ['POSTGRES_APP_USER', appUser],
    ['POSTGRES_OPERATOR_USER', operatorUser],
    ['POSTGRES_AUTHENTICATOR_USER', authenticatorUser],
  ] as const) {
    if (user === migratorUser) {
      throw new Error(
        `${label} must not be the schema owner (POSTGRES_MIGRATOR_USER): ` +
          'an owner bypasses row-level security',
      );
    }
  }

  return {
    host,
    port,
    database,
    migrator: { user: migratorUser, password: migratorPassword },
    app: { user: appUser, password: appPassword },
    operator: { user: operatorUser, password: operatorPassword },
    authenticator: {
      user: authenticatorUser,
      password: authenticatorPassword,
    },
  };
}
