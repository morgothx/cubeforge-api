import type { INestApplication } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PostgresTenantScopedUnitOfWork } from '../../src/adapters/persistence/postgres/postgres-tenant-scoped-unit-of-work';
import {
  apiKeyId as toApiKeyId,
  tenantId as toTenantId,
} from '../../src/domain/identifiers';
import {
  body,
  createApplication,
  operatorHeaders,
  seedTenantWithAdministrator,
  type SeededTenant,
} from './support/application';
import {
  asPersonInTenant,
  policyBypassingPool,
  seed,
} from './support/database';
import { useIntegrationDatabase } from './support/fixtures';

interface IssuedKey {
  readonly id: string;
  readonly secret: string;
}

/**
 * An API key names one tenant, and nothing it is presented against can widen
 * that.
 *
 * Every refusal here is a 404, which makes the HTTP status a weak witness on
 * its own: a machine principal is refused on member routes whatever tenant it
 * belongs to. So each test also asks storage what happened — whether the key
 * resolved at all, whether the row was touched — because that is where a
 * missing tenant check would show.
 */
describe('API keys are confined to their tenant', () => {
  useIntegrationDatabase();

  describe('as seen through the routes', () => {
    it('shows an administrator no key belonging to another tenant', async () => {
      const app = await application();
      const acme = await seedTenantWithAdministrator(app, 'Acme');
      const globex = await seedTenantWithAdministrator(app, 'Globex');
      const key = await issueKey(acme, 'inventory sync');

      const listed = await request(app.getHttpServer())
        .get(`/tenants/${globex.id}/api-keys`)
        .set(globex.headers);

      expect(listed.status).toBe(200);
      expect(body(listed)).toEqual([]);
      expect(JSON.stringify(body(listed))).not.toContain(key.id);
    });

    it("refuses an administrator revoking another tenant's key, and leaves it usable", async () => {
      const app = await application();
      const acme = await seedTenantWithAdministrator(app, 'Acme');
      const globex = await seedTenantWithAdministrator(app, 'Globex');
      const key = await issueKey(acme, 'inventory sync');

      const attempt = await request(app.getHttpServer())
        .delete(`/tenants/${globex.id}/api-keys/${key.id}`)
        .set(globex.headers);

      expect(attempt.status).toBe(404);
      // The refusal has to be a refusal, not a revocation reported as one.
      expect(await revocationOf(key.id)).toBeNull();
      expect(await stillResolves(key)).toBe(true);
    });

    it("gains nothing by presenting a key against another tenant's path", async () => {
      const app = await application();
      const acme = await seedTenantWithAdministrator(app, 'Acme');
      const globex = await seedTenantWithAdministrator(app, 'Globex');
      const key = await issueKey(acme, 'inventory sync');

      const trespass = await request(app.getHttpServer())
        .get(`/tenants/${globex.id}/members`)
        .set({ 'x-api-key': key.secret });

      expect(trespass.status).toBe(404);
      // The key did resolve — the tenant it resolved to is simply not the one
      // in the path. Asserting the recorded use distinguishes "refused because
      // it is another tenant's key" from "refused because nothing recognized
      // it", which is the difference a removed tenant check would erase.
      expect(await lastUseOf(key.id)).not.toBeNull();
      expect(await keyCountIn(globex.id)).toBe(0);
    });

    it('stops recognizing a key once it is revoked', async () => {
      const app = await application();
      const acme = await seedTenantWithAdministrator(app, 'Acme');
      const key = await issueKey(acme, 'inventory sync');
      expect(await stillResolves(key)).toBe(true);

      const revoked = await request(app.getHttpServer())
        .delete(`/tenants/${acme.id}/api-keys/${key.id}`)
        .set(acme.headers);
      expect(revoked.status).toBe(204);

      expect(await stillResolves(key)).toBe(false);
    });

    it('stops recognizing a key when its tenant is deactivated', async () => {
      const app = await application();
      const acme = await seedTenantWithAdministrator(app, 'Acme');
      const key = await issueKey(acme, 'inventory sync');
      expect(await stillResolves(key)).toBe(true);

      const deactivated = await request(app.getHttpServer())
        .delete(`/tenants/${acme.id}`)
        .set(await operatorHeaders());
      expect(deactivated.status).toBe(204);

      // The key itself was never revoked; it is the tenant that stopped being
      // one, and resolution has to notice.
      expect(await revocationOf(key.id)).toBeNull();
      expect(await stillResolves(key)).toBe(false);
    });
  });

  describe('as seen by the database, with no predicate to help it', () => {
    it('returns another tenant no key at all', async () => {
      const app = await application();
      const acme = await seedTenantWithAdministrator(app, 'Acme');
      const globex = await seedTenantWithAdministrator(app, 'Globex');
      await issueKey(acme, 'inventory sync');

      // The query a repository with its scoping removed would issue.
      const visible = await asPersonInTenant(globex.id, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          'SELECT id FROM api_keys',
        );
        return rows;
      });

      expect(visible).toEqual([]);
    });

    it("refuses a write aimed at another tenant's key", async () => {
      const app = await application();
      const acme = await seedTenantWithAdministrator(app, 'Acme');
      const globex = await seedTenantWithAdministrator(app, 'Globex');
      const key = await issueKey(acme, 'inventory sync');

      const written = await asPersonInTenant(globex.id, async (client) => {
        const result = await client.query(
          'UPDATE api_keys SET revoked_at = now() WHERE id = $1',
          [key.id],
        );
        return result.rowCount;
      });

      expect(written).toBe(0);
      expect(await revocationOf(key.id)).toBeNull();
    });
  });

  /**
   * The same confinement asked of the repository alone, connected as an
   * identity policies do not apply to.
   *
   * Without this, every test above passes with the repository's tenant
   * predicate deleted — row-level security covers for it, which is exactly what
   * the second layer is for and exactly why it cannot be the only witness.
   * Verified by deleting the predicate: these two fail and nothing else does.
   */
  describe("with the database's protection switched off", () => {
    const unpoliced = new PostgresTenantScopedUnitOfWork(
      drizzle(policyBypassingPool()),
    );

    it('lists no key of another tenant', async () => {
      const app = await application();
      const acme = await seedTenantWithAdministrator(app, 'Acme');
      const globex = await seedTenantWithAdministrator(app, 'Globex');
      await issueKey(acme, 'inventory sync');

      const seen = await unpoliced.runInTenant(
        toTenantId(globex.id),
        ({ apiKeys }) => apiKeys.list(),
      );

      expect(seen).toEqual([]);
    });

    it('revokes no key of another tenant, and does not find one', async () => {
      const app = await application();
      const acme = await seedTenantWithAdministrator(app, 'Acme');
      const globex = await seedTenantWithAdministrator(app, 'Globex');
      const key = await issueKey(acme, 'inventory sync');

      const found = await unpoliced.runInTenant(
        toTenantId(globex.id),
        async ({ apiKeys }) => {
          await apiKeys.revoke(toApiKeyId(key.id), new Date());
          return apiKeys.findById(toApiKeyId(key.id));
        },
      );

      expect(found).toBeNull();
      expect(await revocationOf(key.id)).toBeNull();
    });
  });

  async function issueKey(
    tenant: SeededTenant,
    label: string,
  ): Promise<IssuedKey> {
    const app = await application();
    const issued = await request(app.getHttpServer())
      .post(`/tenants/${tenant.id}/api-keys`)
      .set(tenant.headers)
      .send({ label, role: 'editor' });
    if (issued.status !== 201) {
      throw new Error(
        `issuing a key failed with ${issued.status}: ${JSON.stringify(issued.body)}`,
      );
    }
    return body<IssuedKey>(issued);
  }

  /**
   * Whether the platform still recognizes the secret, read from the moment of
   * use rather than from a status code — every outcome available to a machine
   * principal is a 404, so the status says nothing.
   */
  async function stillResolves(key: IssuedKey): Promise<boolean> {
    const app = await application();
    const before = await lastUseOf(key.id);
    await request(app.getHttpServer())
      .get('/tenants')
      .set({ 'x-api-key': key.secret });
    const after = await lastUseOf(key.id);
    return after !== null && after !== before;
  }

  async function lastUseOf(id: string): Promise<string | null> {
    return column(id, 'last_used_at');
  }

  async function revocationOf(id: string): Promise<string | null> {
    return column(id, 'revoked_at');
  }

  async function column(id: string, name: string): Promise<string | null> {
    return seed(async (client) => {
      const { rows } = await client.query<{ value: string | null }>(
        `SELECT ${name}::text AS value FROM api_keys WHERE id = $1`,
        [id],
      );
      if (rows.length === 0) {
        throw new Error(`no api key with id ${id}`);
      }
      return rows[0].value;
    });
  }

  async function keyCountIn(tenantId: string): Promise<number> {
    return seed(async (client) => {
      const { rows } = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM api_keys WHERE tenant_id = $1',
        [tenantId],
      );
      return Number(rows[0].count);
    });
  }

  let shared: INestApplication<App> | undefined;

  async function application(): Promise<INestApplication<App>> {
    shared ??= await createApplication();
    return shared;
  }

  afterAll(async () => {
    await shared?.close();
  });
});
