import { randomUUID } from 'node:crypto';
import {
  Argon2PasswordHasher,
  loadHashingConfig,
} from '../../src/adapters/crypto/argon2-password-hasher';
import { passwordDigest } from '../../src/domain/credential/secrets';
import { asAuthenticator, asPersonInTenant, seed } from './support/database';
import {
  seedCredential,
  seedOperator,
  seedTenant,
  useIntegrationDatabase,
} from './support/fixtures';

/**
 * Exercises the harness additions of task 2.4, and with them the boundary the
 * credential tables exist to draw: the authenticating identity can read secret
 * material and the tenant-scoped identity cannot reach it at all.
 */
describe('the credential harness', () => {
  useIntegrationDatabase();

  async function seedPerson(email: string): Promise<string> {
    const id = randomUUID();
    await seed((client) =>
      client.query('INSERT INTO people (id, email) VALUES ($1, $2)', [
        id,
        email,
      ]),
    );
    return id;
  }

  it('arranges a credential the authenticating identity can verify', async () => {
    const person = await seedPerson('member@example.com');
    await seedCredential(person, 'correct horse battery staple');

    const stored = await asAuthenticator(async (client) => {
      const { rows } = await client.query<{ password_digest: string }>(
        'SELECT password_digest FROM person_credentials WHERE person_id = $1',
        [person],
      );
      return rows[0].password_digest;
    });

    const hasher = new Argon2PasswordHasher(loadHashingConfig(process.env));
    await expect(
      hasher.verify('correct horse battery staple', passwordDigest(stored)),
    ).resolves.toBe(true);
    await expect(
      hasher.verify('the wrong one entirely', passwordDigest(stored)),
    ).resolves.toBe(false);
  });

  it('keeps every credential table out of reach of the tenant-scoped identity', async () => {
    const tenant = await seedTenant({ name: 'Acme' });
    const person = await seedPerson('member@example.com');
    await seedCredential(person, 'correct horse battery staple');

    for (const table of [
      'person_credentials',
      'refresh_tokens',
      'credential_setup_tokens',
      'platform_operators',
    ]) {
      const attempt = asPersonInTenant(tenant.id, (client) =>
        client.query(`SELECT count(*) FROM ${table}`),
      );

      // A permission error, not an empty result: the difference matters,
      // because an empty result would mean the grant exists and only the policy
      // is doing the work.
      await expect(attempt).rejects.toThrow(
        new RegExp(`permission denied for table ${table}`),
      );
    }
  });

  it('records operator status the way the bootstrap script does', async () => {
    const person = await seedPerson('founder@example.com');
    await seedOperator(person);
    await seedOperator(person);

    const recorded = await asAuthenticator(async (client) => {
      const { rows } = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM platform_operators WHERE person_id = $1',
        [person],
      );
      return Number(rows[0].count);
    });

    expect(recorded).toBe(1);
  });

  it('leaves no credential behind between tests', async () => {
    const remaining = await asAuthenticator(async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `SELECT (
           (SELECT count(*) FROM person_credentials) +
           (SELECT count(*) FROM refresh_tokens) +
           (SELECT count(*) FROM credential_setup_tokens) +
           (SELECT count(*) FROM platform_operators)
         )::text AS count`,
      );
      return Number(rows[0].count);
    });

    expect(remaining).toBe(0);
  });
});
