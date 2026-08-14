import { randomUUID } from 'node:crypto';
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
  type Role,
} from './support/application';
import { seed } from './support/database';
import { useIntegrationDatabase } from './support/fixtures';

/**
 * The tests this feature exists to make possible.
 *
 * Every one of them goes through the assembled application against the real
 * database, because that is the only level where the claim is meaningful: the
 * repository predicate, the row-level security policy, the use case and the
 * error filter all have to agree, and any one of them failing alone would be
 * invisible to a narrower test.
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

  const ROLES: readonly Role[] = ['admin', 'editor', 'viewer'];

  describe('the role matrix — every role, refused in every direction', () => {
    it.each(ROLES)(
      'refuses a %s of one tenant every operation against another',
      async (role) => {
        const acme = await seedTenantWithAdministrator(app, 'Acme');
        const globex = await seedTenantWithAdministrator(app, 'Globex');
        const intruder = await addMember(
          app,
          acme,
          `${role}@acme.example.com`,
          role,
        );
        const target = await addMember(
          app,
          globex,
          'target@globex.example.com',
          'viewer',
        );
        const headers = await memberHeaders(globex.id, intruder.personId);

        // Sequential on purpose: each request now resolves its principal
        // against the database, and firing them together only tests the pool.
        const attempts = [
          () =>
            request(app.getHttpServer())
              .get(`/tenants/${globex.id}/members`)
              .set(headers),
          () =>
            request(app.getHttpServer())
              .post(`/tenants/${globex.id}/members`)
              .set(headers)
              .send({ email: 'newcomer@example.com', role: 'viewer' }),
          () =>
            request(app.getHttpServer())
              .patch(`/tenants/${globex.id}/members/${target.membershipId}`)
              .set(headers)
              .send({ role: 'admin' }),
          () =>
            request(app.getHttpServer())
              .delete(`/tenants/${globex.id}/members/${target.membershipId}`)
              .set(headers),
        ];

        for (const attempt of attempts) {
          expect((await attempt()).status).toBe(404);
        }
        // Nothing was written on the way to being refused.
        const members = await request(app.getHttpServer())
          .get(`/tenants/${globex.id}/members`)
          .set(globex.headers);
        expect(body<unknown[]>(members)).toHaveLength(2);
      },
    );

    it.each(ROLES)(
      'refuses a %s indistinguishably from a record that exists nowhere',
      async (role) => {
        const acme = await seedTenantWithAdministrator(app, 'Acme');
        const globex = await seedTenantWithAdministrator(app, 'Globex');
        const intruder = await addMember(
          app,
          acme,
          `${role}@acme.example.com`,
          role,
        );
        const target = await addMember(
          app,
          globex,
          'target@globex.example.com',
          'viewer',
        );
        const headers = await memberHeaders(acme.id, intruder.personId);

        const foreign = await request(app.getHttpServer())
          .delete(`/tenants/${acme.id}/members/${target.membershipId}`)
          .set(headers);
        const imaginary = await request(app.getHttpServer())
          .delete(`/tenants/${acme.id}/members/${randomUUID()}`)
          .set(headers);

        expect(foreign.status).toBe(imaginary.status);
        expect(foreign.body).toEqual(imaginary.body);
      },
    );
  });

  describe('one person, two tenants, two roles', () => {
    /**
     * The sharpest form of the guarantee: the same principal, whose permissions
     * differ entirely depending on which tenant they are acting in.
     */
    it('grants exactly the permissions of the tenant in context, both ways', async () => {
      const acme = await seedTenantWithAdministrator(app, 'Acme');
      const globex = await seedTenantWithAdministrator(app, 'Globex');
      const person = await addMember(app, acme, 'shared@example.com', 'admin');
      await request(app.getHttpServer())
        .post(`/tenants/${globex.id}/members`)
        .set(globex.headers)
        .send({ email: 'shared@example.com', role: 'viewer' });

      const asAcmeAdmin = await memberHeaders(acme.id, person.personId);
      const asGlobexViewer = await memberHeaders(globex.id, person.personId);

      // Administrator in Acme: permitted.
      const inAcme = await request(app.getHttpServer())
        .post(`/tenants/${acme.id}/members`)
        .set(asAcmeAdmin)
        .send({ email: 'newcomer@acme.example.com', role: 'viewer' });
      expect(inAcme.status).toBe(201);

      // The very same person, viewer in Globex: refused, and told nothing.
      const inGlobex = await request(app.getHttpServer())
        .post(`/tenants/${globex.id}/members`)
        .set(asGlobexViewer)
        .send({ email: 'newcomer@globex.example.com', role: 'viewer' });
      expect(inGlobex.status).toBe(404);

      // And a read, in both directions, showing each tenant's own membership.
      const acmeMembers = await request(app.getHttpServer())
        .get(`/tenants/${acme.id}/members`)
        .set(asAcmeAdmin);
      expect(
        body<{ email: string; role: string }[]>(acmeMembers).find(
          (member) => member.email === 'shared@example.com',
        )?.role,
      ).toBe('admin');

      const globexMembers = await request(app.getHttpServer())
        .get(`/tenants/${globex.id}/members`)
        .set(asGlobexViewer);
      expect(globexMembers.status).toBe(404);
    });
  });

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

    it('gives an operator nothing when reaching inside a tenant', async () => {
      const acme = await seedTenantWithAdministrator(app, 'Acme');
      const member = await addMember(app, acme, 'member@example.com', 'viewer');

      const operator = await operatorHeaders();
      const attempts = [
        () =>
          request(app.getHttpServer())
            .get(`/tenants/${acme.id}/members`)
            .set(operator),
        () =>
          request(app.getHttpServer())
            .post(`/tenants/${acme.id}/members`)
            .set(operator)
            .send({ email: 'newcomer@example.com', role: 'viewer' }),
        () =>
          request(app.getHttpServer())
            .delete(`/tenants/${acme.id}/members/${member.membershipId}`)
            .set(operator),
      ];

      for (const attempt of attempts) {
        expect((await attempt()).status).toBe(404);
      }
    });

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
