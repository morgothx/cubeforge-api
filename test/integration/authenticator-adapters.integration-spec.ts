import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PostgresAuthenticatorUnitOfWork } from '../../src/adapters/persistence/postgres/postgres-authenticator-unit-of-work';
import { PostgresTenantScopedUnitOfWork } from '../../src/adapters/persistence/postgres/postgres-tenant-scoped-unit-of-work';
import { RandomSecretGenerator } from '../../src/adapters/crypto/random-secret-generator';
import {
  passwordDigest,
  secretDigest,
} from '../../src/domain/credential/secrets';
import {
  apiKeyId,
  emailAddress,
  personId as toPersonId,
  signInId as toSignInId,
  tenantId as toTenantId,
} from '../../src/domain/identifiers';
import { asAuthenticator, runtimePool, seed } from './support/database';
import { useIntegrationDatabase } from './support/fixtures';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-02T00:00:00.000Z');

/**
 * The authenticating adapters against PostgreSQL. These are the ones that read
 * secret material, so what they can and cannot reach is the point.
 */
describe('the authenticating adapters', () => {
  useIntegrationDatabase();

  const secrets = new RandomSecretGenerator();
  let unitOfWork: PostgresAuthenticatorUnitOfWork;

  beforeAll(() => {
    unitOfWork = new PostgresAuthenticatorUnitOfWork(
      drizzle(runtimePool('authenticator')),
    );
  });

  async function aPerson(email: string): Promise<string> {
    const id = randomUUID();
    await seed((client) =>
      client.query('INSERT INTO people (id, email) VALUES ($1, $2)', [
        id,
        email,
      ]),
    );
    return id;
  }

  async function aTenant(name: string): Promise<string> {
    const id = randomUUID();
    await seed((client) =>
      client.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [
        id,
        name,
      ]),
    );
    return id;
  }

  describe('credentials', () => {
    it('finds a person who has no password, and one who has', async () => {
      const person = await aPerson('member@example.com');

      const before = await unitOfWork.runAuthenticating(({ credentials }) =>
        credentials.findByEmail(emailAddress('member@example.com')),
      );
      await unitOfWork.runAuthenticating(({ credentials }) =>
        credentials.establishPassword(
          toPersonId(person),
          passwordDigest('$argon2id$a-digest'),
          NOW,
        ),
      );
      const after = await unitOfWork.runAuthenticating(({ credentials }) =>
        credentials.findByEmail(emailAddress('member@example.com')),
      );

      expect(before).toEqual({
        personId: person,
        personStatus: 'active',
        passwordDigest: null,
      });
      expect(after?.passwordDigest).toBe('$argon2id$a-digest');
    });

    it('replaces a password rather than failing on the second attempt', async () => {
      const person = await aPerson('member@example.com');

      for (const digest of ['$argon2id$first', '$argon2id$second']) {
        await unitOfWork.runAuthenticating(({ credentials }) =>
          credentials.establishPassword(
            toPersonId(person),
            passwordDigest(digest),
            NOW,
          ),
        );
      }

      const stored = await unitOfWork.runAuthenticating(({ credentials }) =>
        credentials.findByPerson(toPersonId(person)),
      );
      expect(stored?.passwordDigest).toBe('$argon2id$second');
    });

    it('reports an address the platform does not know', async () => {
      await expect(
        unitOfWork.runAuthenticating(({ credentials }) =>
          credentials.findByEmail(emailAddress('stranger@example.com')),
        ),
      ).resolves.toBeNull();
    });

    it('keeps the first redemption when a token is marked twice', async () => {
      const person = await aPerson('member@example.com');
      const id = randomUUID();
      await seed((client) =>
        client.query(
          `INSERT INTO credential_setup_tokens (id, person_id, secret_digest, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [id, person, 'a-digest', LATER],
        ),
      );

      await unitOfWork.runAuthenticating(({ credentials }) =>
        credentials.markSetupTokenRedeemed(id, NOW),
      );
      await unitOfWork.runAuthenticating(({ credentials }) =>
        credentials.markSetupTokenRedeemed(id, LATER),
      );

      const token = await unitOfWork.runAuthenticating(({ credentials }) =>
        credentials.findSetupToken(secretDigest('a-digest')),
      );
      expect(token?.redeemedAt).toEqual(NOW);
    });
  });

  describe('sessions', () => {
    async function aToken(
      person: string,
      signIn: string,
      digest: string,
    ): Promise<string> {
      const id = randomUUID();
      await unitOfWork.runAuthenticating(({ sessions }) =>
        sessions.insert({
          id,
          signInId: toSignInId(signIn),
          personId: toPersonId(person),
          secretDigest: secretDigest(digest),
          sessionExpiresAt: LATER,
        }),
      );
      return id;
    }

    it('ends one family and leaves another alone', async () => {
      const person = await aPerson('member@example.com');
      const familyA = randomUUID();
      const familyB = randomUUID();
      await aToken(person, familyA, 'digest-a');
      await aToken(person, familyB, 'digest-b');

      await unitOfWork.runAuthenticating(({ sessions }) =>
        sessions.invalidateFamily(toSignInId(familyA), NOW),
      );

      const a = await unitOfWork.runAuthenticating(({ sessions }) =>
        sessions.findByDigest(secretDigest('digest-a')),
      );
      const b = await unitOfWork.runAuthenticating(({ sessions }) =>
        sessions.findByDigest(secretDigest('digest-b')),
      );
      expect(a?.invalidatedAt).toEqual(NOW);
      expect(b?.invalidatedAt).toBeNull();
    });

    it('does not overwrite when a session ended', async () => {
      const person = await aPerson('member@example.com');
      const family = randomUUID();
      await aToken(person, family, 'digest-a');

      await unitOfWork.runAuthenticating(({ sessions }) =>
        sessions.invalidateFamily(toSignInId(family), NOW),
      );
      await unitOfWork.runAuthenticating(({ sessions }) =>
        sessions.invalidateAllForPerson(toPersonId(person), LATER),
      );

      const token = await unitOfWork.runAuthenticating(({ sessions }) =>
        sessions.findByDigest(secretDigest('digest-a')),
      );
      expect(token?.invalidatedAt).toEqual(NOW);
    });
  });

  describe('resolving API keys', () => {
    async function aKey(
      tenant: string,
      digest: string,
      label = 'sync',
    ): Promise<string> {
      const id = randomUUID();
      await seed((client) =>
        client.query(
          `INSERT INTO api_keys (id, tenant_id, label, role, secret_digest)
           VALUES ($1, $2, $3, 'editor', $4)`,
          [id, tenant, label, digest],
        ),
      );
      return id;
    }

    it('resolves a key with no tenant published', async () => {
      const tenant = await aTenant('Acme');
      const key = await aKey(tenant, 'digest-acme');

      const resolved = await unitOfWork.runAuthenticating(({ apiKeys }) =>
        apiKeys.resolve(secretDigest('digest-acme')),
      );

      expect(resolved).toEqual({
        id: key,
        tenantId: tenant,
        role: 'editor',
      });
    });

    it('refuses a revoked key', async () => {
      const tenant = await aTenant('Acme');
      const key = await aKey(tenant, 'digest-acme');
      await seed((client) =>
        client.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [
          key,
        ]),
      );

      await expect(
        unitOfWork.runAuthenticating(({ apiKeys }) =>
          apiKeys.resolve(secretDigest('digest-acme')),
        ),
      ).resolves.toBeNull();
    });

    /** Requirement 6.3, decided during resolution so no caller can forget it. */
    it('refuses a key belonging to an inactive tenant', async () => {
      const tenant = await aTenant('Acme');
      await aKey(tenant, 'digest-acme');
      await seed((client) =>
        client.query("UPDATE tenants SET status = 'inactive' WHERE id = $1", [
          tenant,
        ]),
      );

      await expect(
        unitOfWork.runAuthenticating(({ apiKeys }) =>
          apiKeys.resolve(secretDigest('digest-acme')),
        ),
      ).resolves.toBeNull();
    });

    it('records the moment a key was last used', async () => {
      const tenant = await aTenant('Acme');
      const key = await aKey(tenant, 'digest-acme');

      await unitOfWork.runAuthenticating(({ apiKeys }) =>
        apiKeys.recordUse(apiKeyId(key), LATER),
      );

      const scoped = new PostgresTenantScopedUnitOfWork(
        drizzle(runtimePool('app')),
      );
      const [summary] = await scoped.runInTenant(
        toTenantId(tenant),
        ({ apiKeys }) => apiKeys.list(),
      );
      expect(summary.lastUsedAt).toEqual(LATER);
    });

    /** One table, two audiences: written by an administrator, read by the authenticator. */
    it('resolves a key an administrator issued through the tenant-scoped adapter', async () => {
      const tenant = await aTenant('Acme');
      const secret = secrets.generate();
      const scoped = new PostgresTenantScopedUnitOfWork(
        drizzle(runtimePool('app')),
      );
      const id = apiKeyId(randomUUID());
      await scoped.runInTenant(toTenantId(tenant), ({ apiKeys }) =>
        apiKeys.insert({
          id,
          label: 'issued by an admin',
          role: 'viewer',
          secretDigest: secrets.digest(secret),
          createdAt: NOW,
        }),
      );

      const resolved = await unitOfWork.runAuthenticating(({ apiKeys }) =>
        apiKeys.resolve(secrets.digest(secret)),
      );

      expect(resolved).toMatchObject({ id, tenantId: tenant, role: 'viewer' });
    });

    it('shows an administrator no key of another tenant', async () => {
      const acme = await aTenant('Acme');
      const globex = await aTenant('Globex');
      await aKey(globex, 'digest-globex', 'theirs');
      await aKey(acme, 'digest-acme', 'ours');

      const scoped = new PostgresTenantScopedUnitOfWork(
        drizzle(runtimePool('app')),
      );
      const listed = await scoped.runInTenant(toTenantId(acme), ({ apiKeys }) =>
        apiKeys.list(),
      );

      expect(listed.map((key) => key.label)).toEqual(['ours']);
    });
  });

  describe('operator status', () => {
    it('reports it from storage, so withdrawing takes effect at once', async () => {
      const person = await aPerson('founder@example.com');
      const isOperator = () =>
        unitOfWork.runAuthenticating(({ operators }) =>
          operators.isOperator(toPersonId(person)),
        );

      await expect(isOperator()).resolves.toBe(false);
      await seed((client) =>
        client.query('INSERT INTO platform_operators (person_id) VALUES ($1)', [
          person,
        ]),
      );
      await expect(isOperator()).resolves.toBe(true);
      await seed((client) =>
        client.query('DELETE FROM platform_operators WHERE person_id = $1', [
          person,
        ]),
      );
      await expect(isOperator()).resolves.toBe(false);
    });
  });

  describe('what this identity cannot reach', () => {
    /**
     * Asserted with raw SQL on the same connection, not through a repository:
     * the grant is the boundary, and a repository that simply lacks a method
     * would prove nothing about what the identity could do if one were added.
     */
    /**
     * Re-aimed in `caller-identity` task 3.1, which gave this identity a
     * `SELECT` on memberships confined to one published person.
     *
     * This test used to assert `permission denied`, and the absence of the
     * grant was the whole boundary. The boundary moved rather than dissolved:
     * the read exists, it discloses nothing without a person published, and it
     * is still a read. What the confinement itself is worth is proved in
     * `second-isolation-layer.integration-spec.ts`; what this asserts is that
     * the new grant did not turn an authenticating identity into a writer.
     */
    it('reads no membership unless a person is published, and writes none ever', async () => {
      const seen = await asAuthenticator(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          'SELECT id FROM memberships',
        );
        return rows;
      });
      expect(seen).toEqual([]);

      const person = await aPerson('writer@example.com');
      const tenant = await aTenant('Acme');
      await expect(
        asAuthenticator((client) =>
          client.query(
            'INSERT INTO memberships (id, tenant_id, person_id, role) VALUES ($1, $2, $3, $4)',
            [randomUUID(), tenant, person, 'admin'],
          ),
        ),
      ).rejects.toThrow(/permission denied for table memberships/);
    });

    it('may read people and tenants, which authentication needs', async () => {
      await expect(
        asAuthenticator((client) =>
          client.query('SELECT count(*) FROM people'),
        ),
      ).resolves.toBeDefined();
      await expect(
        asAuthenticator((client) =>
          client.query('SELECT count(*) FROM tenants'),
        ),
      ).resolves.toBeDefined();
    });
  });
});
