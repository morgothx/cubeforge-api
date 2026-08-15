import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  addMember,
  body,
  createApplication,
  seedTenantWithAdministrator,
  signInThrough,
} from './support/application';
import {
  asAppWithoutTenant,
  asAuthenticator,
  asPersonInTenant,
  seed,
} from './support/database';
import { seedCredential, useIntegrationDatabase } from './support/fixtures';

/**
 * Secret material is unreachable from the identity that serves tenant traffic.
 *
 * The credential tables are refused to it by grant, not by policy, and that
 * distinction is the whole claim: a policy that returns nothing is one
 * predicate away from returning something, while a missing grant fails the
 * statement whatever it asks for. So these tests insist on a permission error
 * and would not accept an empty result in its place.
 *
 * The second half asks the same question from the outside: whatever the
 * database allows, no response an administrator can obtain may carry a digest.
 */
describe('credentials are unreachable from the tenant-scoped identity', () => {
  useIntegrationDatabase();

  const SECRET_TABLES = [
    'person_credentials',
    'refresh_tokens',
    'credential_setup_tokens',
    'platform_operators',
  ] as const;

  /**
   * Every statement, not only `SELECT`. A grant widened for writes would leave
   * reads refused and still let the tenant-scoped identity set a password of
   * its choosing, which is the same disclosure taking one more step.
   */
  const STATEMENTS: readonly ((table: string) => string)[] = [
    (table) => `SELECT count(*) FROM ${table}`,
    (table) => `INSERT INTO ${table} DEFAULT VALUES`,
    (table) => `UPDATE ${table} SET person_id = person_id`,
    (table) => `DELETE FROM ${table}`,
  ];

  it.each(SECRET_TABLES)(
    'refuses the tenant-scoped identity every statement against %s',
    async (table) => {
      const tenant = await seedTenantWithAdministrator(
        await application(),
        `Acme-${table}`,
      );

      for (const statement of STATEMENTS) {
        const attempt = asPersonInTenant(tenant.id, (client) =>
          client.query(statement(table)),
        );

        await expect(attempt).rejects.toThrow(
          new RegExp(`permission denied for table ${table}`),
        );
      }
    },
  );

  it.each(SECRET_TABLES)(
    'refuses %s to the tenant-scoped identity even with no tenant published',
    async (table) => {
      // The shape a query that escaped the unit of work would take. It must
      // fail on the grant rather than fall through to a policy that happens to
      // match nothing when `app.current_tenant` is empty.
      const attempt = asAppWithoutTenant((client) =>
        client.query(`SELECT count(*) FROM ${table}`),
      );

      await expect(attempt).rejects.toThrow(
        new RegExp(`permission denied for table ${table}`),
      );
    },
  );

  it('holds no grant for the tenant-scoped identity on any secret table', async () => {
    // Asked of the catalogue as well as of the statements above, because a
    // grant of an unusual privilege — TRUNCATE, REFERENCES — would pass every
    // statement test and still be a grant nobody meant to give.
    const granted = await seed(async (client) => {
      const { rows } = await client.query<{
        table_name: string;
        privilege_type: string;
      }>(
        `SELECT table_name, privilege_type
           FROM information_schema.role_table_grants
          WHERE grantee = $1 AND table_name = ANY($2::text[])
          ORDER BY table_name, privilege_type`,
        ['cubeforge_app', [...SECRET_TABLES]],
      );
      return rows;
    });

    expect(granted).toEqual([]);
  });

  /**
   * The same two questions asked of the identity that *does* hold the grants.
   *
   * Without these, every assertion above would still pass if the tables had
   * been renamed, dropped, or made unreachable to everyone — a suite that
   * proves nothing is unreachable by proving nothing is there. These fail in
   * exactly the case the ones above cannot detect.
   */
  it('grants the authenticating identity what it was denied above', async () => {
    for (const table of SECRET_TABLES) {
      await expect(
        asAuthenticator((client) =>
          client.query(`SELECT count(*) FROM ${table}`),
        ),
      ).resolves.toBeDefined();
    }

    const granted = await seed(async (client) => {
      const { rows } = await client.query<{ table_name: string }>(
        `SELECT DISTINCT table_name
           FROM information_schema.role_table_grants
          WHERE grantee = $1 AND table_name = ANY($2::text[])
          ORDER BY table_name`,
        ['cubeforge_authenticator', [...SECRET_TABLES]],
      );
      return rows.map((row) => row.table_name);
    });

    expect(granted).toEqual([...SECRET_TABLES].sort());
  });

  describe('what an administrator can see of their own members', () => {
    const PASSWORD = 'correct horse battery staple';

    it('discloses no digest through any route they may call', async () => {
      const app = await application();
      const tenant = await seedTenantWithAdministrator(app, 'Acme');
      const member = await addMember(
        app,
        tenant,
        'member@acme.example.com',
        'editor',
      );
      await seedCredential(member.personId, PASSWORD);
      const digest = await storedDigest(member.personId);

      const responses = [
        await request(app.getHttpServer())
          .get(`/tenants/${tenant.id}/members`)
          .set(tenant.headers),
        await request(app.getHttpServer())
          .post(`/tenants/${tenant.id}/api-keys`)
          .set(tenant.headers)
          .send({ label: 'reporting' }),
        await request(app.getHttpServer())
          .get(`/tenants/${tenant.id}/api-keys`)
          .set(tenant.headers),
      ];

      for (const response of responses) {
        const serialized = JSON.stringify(response.body);
        expect(serialized).not.toContain(digest);
        // The prefix rather than the digest alone, so a different hash of the
        // same password would fail this too.
        expect(serialized).not.toContain('$argon2');
        expect(serialized.toLowerCase()).not.toContain('digest');
      }
    });

    it('gives the person themselves no route back to their own password', async () => {
      const app = await application();
      const tenant = await seedTenantWithAdministrator(app, 'Acme');
      const member = await addMember(
        app,
        tenant,
        'member@acme.example.com',
        'admin',
      );
      const session = await signInThrough(
        app,
        member.personId,
        'member@acme.example.com',
        PASSWORD,
      );
      const digest = await storedDigest(member.personId);

      // Signing in returns a session and nothing else. There is no operation
      // that returns an established password (1.7), so the closest thing to
      // asking for one is asking with the credential that owns it.
      const listed = await request(app.getHttpServer())
        .get(`/tenants/${tenant.id}/members`)
        .set(session.headers);

      expect(listed.status).toBe(200);
      expect(JSON.stringify(body(listed))).not.toContain(digest);
    });
  });

  let shared: INestApplication<App> | undefined;

  async function application(): Promise<INestApplication<App>> {
    shared ??= await createApplication();
    return shared;
  }

  afterAll(async () => {
    await shared?.close();
  });
});

/** Read through the one identity that may see it, to compare against. */
async function storedDigest(personId: string): Promise<string> {
  return seed(async (client) => {
    const { rows } = await client.query<{ password_digest: string }>(
      'SELECT password_digest FROM person_credentials WHERE person_id = $1',
      [personId],
    );
    const digest = rows[0]?.password_digest;
    // Guarded, because `not.toContain('')` is true of every response ever
    // written and would turn the assertions above into decoration.
    if (!digest?.startsWith('$argon2')) {
      throw new Error(
        `expected an argon2 digest to compare against, got ${JSON.stringify(digest)}`,
      );
    }
    return digest;
  });
}
