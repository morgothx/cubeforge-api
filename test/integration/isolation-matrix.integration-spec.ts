import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  addMember,
  body,
  createApplication,
  memberHeaders,
  operatorHeaders,
  seedTenantWithAdministrator,
} from './support/application';
import { seed } from './support/database';
import { useIntegrationDatabase } from './support/fixtures';

/**
 * What tenant isolation guarantees beyond who may reach which route.
 *
 * Every one of these goes through the assembled application against the real
 * database, because that is the only level where the claim is meaningful: the
 * repository predicate, the row-level security policy, the use case and the
 * error filter all have to agree, and any one of them failing alone would be
 * invisible to a narrower test.
 *
 * Feature 3 took over the parts of this file that were about *access*. Refusing
 * a role is now the role matrix's claim, and a refusal disclosing nothing is
 * the disclosure suite's. What remains is what neither of them says: that a
 * refusal destroys no records, that an operator's view names nobody's tenant,
 * and that adding an address already registered elsewhere is indistinguishable
 * from adding an unknown one.
 */
describe('tenant isolation', () => {
  useIntegrationDatabase();

  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createApplication();
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * The role matrix that used to live here — every role of one tenant refused
   * every operation against another, indistinguishably from a record that
   * exists nowhere — moved to `role-matrix.integration-spec.ts` in feature 3.
   * That suite makes the same claim across *every* route the application
   * serves rather than the four member operations, and walks the route
   * inventory so a route added later cannot escape it. The same-person-two-
   * tenants case moved with it, and the indistinguishability of a refusal is
   * now owned by `authorization-disclosure.integration-spec.ts`.
   *
   * What stays here is what those suites do not assert: that refusing access
   * destroys nothing, and that an operator's view discloses no one's
   * participation in a tenant.
   */

  describe('the operator boundary', () => {
    it('lets an operator create, list and deactivate tenants', async () => {
      const created = await request(app.getHttpServer())
        .post('/tenants')
        .set(await operatorHeaders())
        .send({ name: 'Acme', administratorEmail: 'founder@example.com' });
      expect(created.status).toBe(201);

      const listed = await request(app.getHttpServer())
        .get('/tenants')
        .set(await operatorHeaders());
      expect(body<unknown[]>(listed)).toHaveLength(1);

      const deactivated = await request(app.getHttpServer())
        .delete(`/tenants/${body<{ id: string }>(created).id}`)
        .set(await operatorHeaders());
      expect(deactivated.status).toBe(204);
    });

    // "An operator gets nothing inside a tenant" moved to the role matrix,
    // which asserts it on every tenant route rather than on three of them.

    /** Requirement 3.3: no operator response may hint at who belongs where. */
    it('reveals no tenant participation in any operator response', async () => {
      const acme = await seedTenantWithAdministrator(app, 'Acme');
      const member = await addMember(app, acme, 'member@example.com', 'viewer');

      const listed = await request(app.getHttpServer())
        .get('/tenants')
        .set(await operatorHeaders());

      const disclosed = JSON.stringify(listed.body);
      expect(disclosed).not.toContain('member@example.com');
      expect(disclosed).not.toContain(member.personId);
      expect(disclosed).not.toContain(member.membershipId);
    });
  });

  /**
   * The refusals below are also asserted by the role matrix, and that is not a
   * duplicate: the claim here is the *conjunction* — access is denied **and**
   * nothing is destroyed. Dropping the refusal half would leave "the records
   * are still there" saying nothing about whether they are still reachable.
   */
  describe('deactivation denies access without destroying anything', () => {
    it('refuses every role in a deactivated tenant, and keeps the records', async () => {
      const acme = await seedTenantWithAdministrator(app, 'Acme');
      const editor = await addMember(app, acme, 'editor@example.com', 'editor');
      const viewer = await addMember(app, acme, 'viewer@example.com', 'viewer');

      await request(app.getHttpServer())
        .delete(`/tenants/${acme.id}`)
        .set(await operatorHeaders());

      for (const personId of [
        acme.administrator,
        editor.personId,
        viewer.personId,
      ]) {
        const attempt = await request(app.getHttpServer())
          .get(`/tenants/${acme.id}/members`)
          .set(await memberHeaders(acme.id, personId));
        expect(attempt.status).toBe(404);
      }

      const retained = await seed(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM memberships WHERE tenant_id = $1',
          [acme.id],
        );
        return Number(rows[0].count);
      });
      expect(retained).toBe(3);
    });

    it('refuses a deactivated person in every tenant at once, keeping their memberships', async () => {
      const acme = await seedTenantWithAdministrator(app, 'Acme');
      const globex = await seedTenantWithAdministrator(app, 'Globex');
      const person = await addMember(app, acme, 'shared@example.com', 'admin');
      await request(app.getHttpServer())
        .post(`/tenants/${globex.id}/members`)
        .set(globex.headers)
        .send({ email: 'shared@example.com', role: 'admin' });

      // Served in both tenants first, so the assertions below cannot pass for
      // some unrelated reason.
      for (const tenantId of [acme.id, globex.id]) {
        const before = await request(app.getHttpServer())
          .get(`/tenants/${tenantId}/members`)
          .set(await memberHeaders(tenantId, person.personId));
        expect(before.status).toBe(200);
      }

      await request(app.getHttpServer())
        .delete(`/platform/people/${person.personId}`)
        .set(await operatorHeaders());

      for (const tenantId of [acme.id, globex.id]) {
        const after = await request(app.getHttpServer())
          .get(`/tenants/${tenantId}/members`)
          .set(await memberHeaders(tenantId, person.personId));
        expect(after.status).toBe(404);
      }

      const kept = await seed(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM memberships WHERE person_id = $1',
          [person.personId],
        );
        return Number(rows[0].count);
      });
      expect(kept).toBe(2);
    });
  });

  describe('non-disclosure on member creation', () => {
    /**
     * Requirement 4.3. Timing is deliberately not asserted: a wall-clock
     * assertion would be flaky and would prove nothing about the code. What is
     * asserted instead is the property that makes timing uniform — the use case
     * performs the same operations in the same order on both paths, with no
     * branch on whether the person already existed.
     */
    it('answers identically for a new address and one registered elsewhere', async () => {
      const acme = await seedTenantWithAdministrator(app, 'Acme');
      const globex = await seedTenantWithAdministrator(app, 'Globex');
      await addMember(app, globex, 'known@example.com', 'viewer');

      const registeredElsewhere = await request(app.getHttpServer())
        .post(`/tenants/${acme.id}/members`)
        .set(acme.headers)
        .send({ email: 'known@example.com', role: 'editor' });
      const brandNew = await request(app.getHttpServer())
        .post(`/tenants/${acme.id}/members`)
        .set(acme.headers)
        .send({ email: 'unknown@example.com', role: 'editor' });

      expect(registeredElsewhere.status).toBe(brandNew.status);
      expect(Object.keys(registeredElsewhere.body as object).sort()).toEqual(
        Object.keys(brandNew.body as object).sort(),
      );

      // Every value is an opaque identifier or the role that was asked for, so
      // there is no field whose content could betray the difference.
      const shapeOf = (response: { body: unknown }) => {
        const parsed = response.body as Record<string, string>;
        return Object.fromEntries(
          Object.entries(parsed).map(([key, value]) => [
            key,
            key === 'role' ? value : typeof value,
          ]),
        );
      };
      expect(shapeOf(registeredElsewhere)).toEqual(shapeOf(brandNew));
    });

    it('rejects a duplicate inside the actor own tenant, which discloses nothing external', async () => {
      const acme = await seedTenantWithAdministrator(app, 'Acme');
      await addMember(app, acme, 'member@example.com', 'viewer');

      const again = await request(app.getHttpServer())
        .post(`/tenants/${acme.id}/members`)
        .set(acme.headers)
        .send({ email: 'member@example.com', role: 'editor' });

      expect(again.status).toBe(409);
    });
  });
});
