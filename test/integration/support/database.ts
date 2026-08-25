import { Pool, type PoolClient } from 'pg';
import {
  loadDatabaseConfig,
  type DatabaseConfig,
} from '../../../src/adapters/persistence/postgres/database-config';

/**
 * The three runtime identities an integration test may need, plus one the
 * production code never has.
 *
 * `app`, `operator` and `authenticator` are the identities the running system
 * uses, and tests reach the database through them precisely so row-level
 * security applies exactly as it will in production. `superuser` exists only to
 * arrange
 * fixtures: FORCE ROW LEVEL SECURITY subjects even the schema owner to the
 * policies, so there is no non-superuser identity that can seed a tenant and
 * its members. Using it for assertions would prove nothing, so nothing outside
 * `seed` should.
 */
type Identity = 'app' | 'operator' | 'authenticator' | 'superuser';

const pools = new Map<Identity, Pool>();
let cachedConfig: DatabaseConfig | undefined;

export function databaseConfig(): DatabaseConfig {
  cachedConfig ??= loadDatabaseConfig(process.env);
  return cachedConfig;
}

function superuserCredentials(): { user: string; password: string } {
  const user = process.env.POSTGRES_USER?.trim();
  const password = process.env.POSTGRES_PASSWORD?.trim();
  if (!user || !password) {
    throw new Error(
      'POSTGRES_USER and POSTGRES_PASSWORD (the local container superuser) are required ' +
        'to seed integration fixtures, because forced row-level security applies to the schema owner',
    );
  }
  return { user, password };
}

function poolFor(identity: Identity): Pool {
  const existing = pools.get(identity);
  if (existing) {
    return existing;
  }

  const config = databaseConfig();
  const credentials =
    identity === 'superuser' ? superuserCredentials() : config[identity];

  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: credentials.user,
    password: credentials.password,
    // The suite runs single-threaded against one database; a wide pool would
    // only make a leaked connection harder to notice.
    max: 4,
  });
  pools.set(identity, pool);
  return pool;
}

/**
 * The pools the runtime identities connect through, for tests that exercise the
 * real adapters rather than issuing SQL themselves. Both are closed by
 * `closeDatabaseConnections`.
 */
export function runtimePool(
  identity: 'app' | 'operator' | 'authenticator',
): Pool {
  return poolFor(identity);
}

/**
 * A connection that row-level security does not apply to, for the one suite
 * that needs to observe the application's own tenant predicate with the
 * database's protection switched off.
 *
 * Nothing else may use this to make an assertion: everywhere else, running
 * without policies would prove the opposite of what the test claims.
 */
export function policyBypassingPool(): Pool {
  return poolFor('superuser');
}

/**
 * Runs `work` inside one transaction, committing on success and rolling back on
 * failure. Committing matters: a test that writes and then asserts through a
 * second connection would see nothing if the harness rolled everything back.
 */
async function inTransaction<T>(
  identity: Identity,
  work: (client: PoolClient) => Promise<T>,
  onBegin?: (client: PoolClient) => Promise<void>,
): Promise<T> {
  const client = await poolFor(identity).connect();
  try {
    await client.query('BEGIN');
    await onBegin?.(client);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Acts as the application identity inside the given tenant.
 *
 * The tenant is published with the transaction-local form of `set_config`, the
 * same way the unit of work will. Connection-level settings would survive the
 * connection's return to the pool and leak the tenant into whatever request
 * picked it up next — which is the exact failure this whole layer exists to
 * prevent, so the harness must not model it any other way.
 */
export async function asPersonInTenant<T>(
  tenantId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return inTransaction('app', work, async (client) => {
    await client.query('SELECT set_config($1, $2, true)', [
      'app.current_tenant',
      tenantId,
    ]);
  });
}

/**
 * Acts as the application identity with no tenant published, which is how a
 * query that escaped the unit of work would reach the database. Every policy
 * must return nothing here.
 */
export async function asAppWithoutTenant<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return inTransaction('app', work);
}

/**
 * Acts as the authenticating identity: the only one that may read secret
 * material, and the only one with no tenant context at all.
 */
export async function asAuthenticator<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return inTransaction('authenticator', work);
}

/**
 * Acts as the authenticating identity with a person published, which is how a
 * caller's own memberships are read across every tenant they belong to.
 *
 * The person is published with the transaction-local form of `set_config`, for
 * the reason the tenant is: connections are pooled, and a session-level setting
 * would carry the person into whatever request took the connection next.
 *
 * Raw SQL rather than the unit of work on purpose. What this proves is a
 * property of the database — that the policy confines the read whatever the
 * query says — so the test must not route through the adapter whose correctness
 * is the thing in question.
 */
export async function asAuthenticatorForPerson<T>(
  personId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return inTransaction('authenticator', work, async (client) => {
    await client.query('SELECT set_config($1, $2, true)', [
      'app.current_person',
      personId,
    ]);
  });
}

/** Acts as the platform operator, which holds no grant on memberships at all. */
export async function asOperator<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return inTransaction('operator', work);
}

/** Arranges fixtures. Bypasses row-level security; never assert through it. */
export async function seed<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return inTransaction('superuser', work);
}

/**
 * Returns the database to an empty state. `TRUNCATE` is not filtered by
 * row-level security, so this removes every tenant's rows rather than only
 * those some policy would have revealed.
 */
export async function resetDatabase(): Promise<void> {
  // The credential tables are listed explicitly rather than relying on CASCADE
  // from `people`, so adding a table without adding it here fails visibly the
  // first time a test leaks a row instead of silently much later.
  await poolFor('superuser').query(
    `TRUNCATE stock_movements, inventory_products, inventory_locations,
              refresh_tokens, credential_setup_tokens, person_credentials,
              platform_operators, api_keys, memberships, people, tenants CASCADE`,
  );
}

export async function closeDatabaseConnections(): Promise<void> {
  await Promise.all([...pools.values()].map((pool) => pool.end()));
  pools.clear();
}
