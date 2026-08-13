import { randomUUID } from 'node:crypto';
import {
  Argon2PasswordHasher,
  loadHashingConfig,
} from '../../../src/adapters/crypto/argon2-password-hasher';
import { closeDatabaseConnections, resetDatabase, seed } from './database';

/**
 * Registers the lifecycle every integration suite needs: an empty database
 * before each test, and no open connections when the suite ends.
 *
 * Resetting before rather than after leaves the last test's rows in place for
 * inspection when something fails, and still guarantees isolation even if a
 * previous suite crashed mid-test.
 */
export function useIntegrationDatabase(): void {
  beforeEach(resetDatabase);
  afterAll(closeDatabaseConnections);
}

export interface SeededTenant {
  readonly id: string;
  readonly name: string;
}

export interface SeededMember {
  readonly personId: string;
  readonly membershipId: string;
  readonly email: string;
}

export async function seedTenant(
  attributes: { name?: string; status?: 'active' | 'inactive' } = {},
): Promise<SeededTenant> {
  const id = randomUUID();
  const name = attributes.name ?? `tenant-${id.slice(0, 8)}`;
  await seed((client) =>
    client.query('INSERT INTO tenants (id, name, status) VALUES ($1, $2, $3)', [
      id,
      name,
      attributes.status ?? 'active',
    ]),
  );
  return { id, name };
}

/**
 * Creates a person and attaches them to a tenant. The two go together because a
 * person with no membership anywhere is invisible to every application query by
 * design, so seeding one alone is almost never what a test means.
 */
export async function seedMember(attributes: {
  tenantId: string;
  role?: 'admin' | 'editor' | 'viewer';
  email?: string;
  personId?: string;
  personStatus?: 'active' | 'deactivated';
  membershipStatus?: 'active' | 'revoked';
}): Promise<SeededMember> {
  const personId = attributes.personId ?? randomUUID();
  const membershipId = randomUUID();
  const email =
    attributes.email ?? `person-${personId.slice(0, 8)}@example.com`;

  await seed(async (client) => {
    if (attributes.personId === undefined) {
      await client.query(
        'INSERT INTO people (id, email, status) VALUES ($1, $2, $3)',
        [personId, email, attributes.personStatus ?? 'active'],
      );
    }
    await client.query(
      'INSERT INTO memberships (id, tenant_id, person_id, role, status) VALUES ($1, $2, $3, $4, $5)',
      [
        membershipId,
        attributes.tenantId,
        personId,
        attributes.role ?? 'viewer',
        attributes.membershipStatus ?? 'active',
      ],
    );
  });

  return { personId, membershipId, email };
}

/**
 * Gives a person a usable password without going through the operator flow.
 *
 * Most tests are about something other than how a credential came to exist, and
 * making each of them issue and redeem a setup token would bury what they are
 * actually asserting. The tests that *are* about that flow go through it.
 */
export async function seedCredential(
  personId: string,
  password: string,
): Promise<void> {
  const digest = await hasher().hash(password);
  await seed((client) =>
    client.query(
      `INSERT INTO person_credentials (person_id, password_digest)
       VALUES ($1, $2)
       ON CONFLICT (person_id) DO UPDATE SET password_digest = excluded.password_digest`,
      [personId, digest],
    ),
  );
}

/** Records a person as a platform operator, as the bootstrap script would. */
export async function seedOperator(personId: string): Promise<void> {
  await seed((client) =>
    client.query(
      `INSERT INTO platform_operators (person_id) VALUES ($1)
       ON CONFLICT (person_id) DO NOTHING`,
      [personId],
    ),
  );
}

let sharedHasher: Argon2PasswordHasher | undefined;

/**
 * One hasher for the suite, at the configured cost. Hashing is deliberately
 * slow, so seeding several people per test would otherwise dominate the run.
 */
function hasher(): Argon2PasswordHasher {
  sharedHasher ??= new Argon2PasswordHasher(loadHashingConfig(process.env));
  return sharedHasher;
}
