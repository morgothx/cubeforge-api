import { Logger, type INestApplication } from '@nestjs/common';
import {
  DiscoveryService,
  MetadataScanner,
  ModulesContainer,
  Reflector,
} from '@nestjs/core';
import request, { type Test } from 'supertest';
import type { App } from 'supertest/types';
import { RouteInventory } from '../../src/adapters/http/access/route-inventory';
import {
  addMember,
  bearerFor,
  body,
  createApplication,
  operatorHeaders,
  seedTenantWithAdministrator,
  type SeededTenant,
} from './support/application';
import { seed } from './support/database';
import { useIntegrationDatabase } from './support/fixtures';

type Headers = Record<string, string>;

/** Everyone a request can arrive as, on a route belonging to Acme. */
type Principal =
  'admin' | 'editor' | 'viewer' | 'stranger' | 'operator' | 'anonymous';

const EVERY_PRINCIPAL: readonly Principal[] = [
  'admin',
  'editor',
  'viewer',
  'stranger',
  'operator',
  'anonymous',
];

interface World {
  readonly acme: SeededTenant;
  readonly globex: SeededTenant;
  readonly headers: Readonly<Record<Principal, Headers>>;
  readonly membershipId: string;
  readonly personId: string;
  readonly apiKeyId: string;
}

interface RouteCase {
  /** `METHOD /path`, exactly as the inventory reports it. */
  readonly key: string;
  readonly admits: readonly Principal[];
  readonly call: (world: World, headers: Headers) => Test;
}

/**
 * Every role, on every route, in its own tenant and against another.
 *
 * The claim this feature exists to make, asserted where it is observable: the
 * assembled application, the real database, and every route the application
 * actually serves rather than a list someone wrote down. A route added later
 * cannot escape this suite, because the coverage test compares what is
 * exercised here against what the route inventory reports.
 *
 * **The principals are ones the platform can produce.** An actor's tenant comes
 * from the request path, so "an administrator of Globex carrying Globex while
 * addressing Acme" is not a state that exists. A stranger is a person whose
 * membership lives in another tenant reaching a path that names this one, and
 * the refusal comes from finding no membership here.
 */
describe('the role matrix', () => {
  useIntegrationDatabase();

  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createApplication();
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedWorld(): Promise<World> {
    const acme = await seedTenantWithAdministrator(app, 'Acme');
    const globex = await seedTenantWithAdministrator(app, 'Globex');
    const editor = await addMember(
      app,
      acme,
      'editor@acme.example.com',
      'editor',
    );
    const viewer = await addMember(
      app,
      acme,
      'viewer@acme.example.com',
      'viewer',
    );
    const target = await addMember(
      app,
      acme,
      'target@acme.example.com',
      'viewer',
    );

    const issued = await request(app.getHttpServer())
      .post(`/tenants/${acme.id}/api-keys`)
      .set(acme.headers)
      .send({ label: 'inventory sync', role: 'editor' });
    if (issued.status !== 201) {
      throw new Error(`issuing a key failed with ${issued.status}`);
    }

    return {
      acme,
      globex,
      membershipId: target.membershipId,
      personId: target.personId,
      apiKeyId: body<{ id: string }>(issued).id,
      headers: {
        admin: acme.headers,
        editor: await bearerFor(editor.personId),
        viewer: await bearerFor(viewer.personId),
        // A real person, whose only membership is in Globex, addressing Acme.
        stranger: await bearerFor(globex.administrator),
        operator: await operatorHeaders(),
        anonymous: {},
      },
    };
  }

  const server = () => app.getHttpServer();

  /**
   * The twelve routes whose status distinguishes admission from refusal.
   *
   * The four credential endpoints are not here: they are public, and every one
   * of their failures is a 404 too, so a status cannot tell a guard refusal
   * from a use case refusing an unknown token. They are covered below, by the
   * one of them whose success is observable.
   */
  const ROUTES: readonly RouteCase[] = [
    {
      key: 'POST /tenants',
      admits: ['operator'],
      call: (_, headers) =>
        request(server())
          .post('/tenants')
          .set(headers)
          .send({ name: 'Initech', administratorEmail: 'admin@initech.test' }),
    },
    {
      key: 'GET /tenants',
      admits: ['operator'],
      call: (_, headers) => request(server()).get('/tenants').set(headers),
    },
    {
      key: 'DELETE /platform/people/:personId',
      admits: ['operator'],
      call: (world, headers) =>
        request(server())
          .delete(`/platform/people/${world.personId}`)
          .set(headers),
    },
    {
      key: 'POST /platform/people/:personId/setup-tokens',
      admits: ['operator'],
      call: (world, headers) =>
        request(server())
          .post(`/platform/people/${world.personId}/setup-tokens`)
          .set(headers),
    },
    {
      key: 'GET /tenants/:tenantId/members',
      admits: ['admin', 'editor', 'viewer'],
      call: (world, headers) =>
        request(server()).get(`/tenants/${world.acme.id}/members`).set(headers),
    },
    {
      key: 'POST /tenants/:tenantId/members',
      admits: ['admin'],
      call: (world, headers) =>
        request(server())
          .post(`/tenants/${world.acme.id}/members`)
          .set(headers)
          .send({ email: 'newcomer@acme.example.com', role: 'viewer' }),
    },
    {
      key: 'PATCH /tenants/:tenantId/members/:membershipId',
      admits: ['admin'],
      call: (world, headers) =>
        request(server())
          .patch(`/tenants/${world.acme.id}/members/${world.membershipId}`)
          .set(headers)
          .send({ role: 'editor' }),
    },
    {
      key: 'DELETE /tenants/:tenantId/members/:membershipId',
      admits: ['admin'],
      call: (world, headers) =>
        request(server())
          .delete(`/tenants/${world.acme.id}/members/${world.membershipId}`)
          .set(headers),
    },
    {
      key: 'POST /tenants/:tenantId/api-keys',
      admits: ['admin'],
      call: (world, headers) =>
        request(server())
          .post(`/tenants/${world.acme.id}/api-keys`)
          .set(headers)
          .send({ label: 'another', role: 'viewer' }),
    },
    {
      key: 'GET /tenants/:tenantId/api-keys',
      admits: ['admin'],
      call: (world, headers) =>
        request(server())
          .get(`/tenants/${world.acme.id}/api-keys`)
          .set(headers),
    },
    {
      key: 'DELETE /tenants/:tenantId/api-keys/:apiKeyId',
      admits: ['admin'],
      call: (world, headers) =>
        request(server())
          .delete(`/tenants/${world.acme.id}/api-keys/${world.apiKeyId}`)
          .set(headers),
    },
    // Last in the list because it deactivates the tenant every other case
    // depends on. Each test seeds its own world, so this only matters within
    // the one test that exercises it.
    {
      key: 'DELETE /tenants/:tenantId',
      admits: ['operator'],
      call: (world, headers) =>
        request(server()).delete(`/tenants/${world.acme.id}`).set(headers),
    },
  ];

  const PUBLIC_ROUTES = [
    'POST /auth/sign-in',
    'POST /auth/refresh',
    'POST /auth/sign-out',
    'POST /auth/credentials',
  ];

  describe.each(ROUTES.map((route) => [route.key, route] as const))(
    '%s',
    (_key, route) => {
      it('admits exactly the principals it declares', async () => {
        const world = await seedWorld();

        // Refusals first. A refused request changes nothing, so the admitted
        // one can safely be last even when it mutates.
        const refused = EVERY_PRINCIPAL.filter(
          (principal) => !route.admits.includes(principal),
        );

        for (const principal of refused) {
          const response = await route.call(world, world.headers[principal]);
          expect({ principal, status: response.status }).toEqual({
            principal,
            status: 404,
          });
          expect(response.body).toEqual({
            statusCode: 404,
            message: 'the requested record does not exist',
          });
        }

        for (const principal of route.admits) {
          const response = await route.call(world, world.headers[principal]);
          expect({ principal, status: response.status }).not.toEqual({
            principal,
            status: 404,
          });
          expect(response.status).toBeLessThan(400);
        }
      });
    },
  );

  describe('the credential endpoints, which declare themselves public', () => {
    it('lets a caller with no principal reach one whose success is observable', async () => {
      // Every failure of the other three is also a 404, so a status cannot
      // separate "the guard refused" from "the use case refused an unknown
      // token". Signing out succeeds whatever it is given, which makes it the
      // one that proves the guard let the caller through.
      const response = await request(server())
        .post('/auth/sign-out')
        .send({ refreshToken: 'a-token-that-was-never-issued' });

      expect(response.status).toBe(204);
    });
  });

  describe('the boundaries that do not depend on a role', () => {
    it('judges the same person by the tenant the path names', async () => {
      const world = await seedWorld();
      // Administrator in Acme, and added to Globex as a viewer. One person, one
      // credential, two answers.
      await request(server())
        .post(`/tenants/${world.globex.id}/members`)
        .set(world.globex.headers)
        .send({ email: 'admin-Acme@example.com', role: 'viewer' });
      const asThemselves = await bearerFor(world.acme.administrator);

      const inAcme = await request(server())
        .post(`/tenants/${world.acme.id}/api-keys`)
        .set(asThemselves)
        .send({ label: 'theirs', role: 'viewer' });
      const inGlobex = await request(server())
        .post(`/tenants/${world.globex.id}/api-keys`)
        .set(asThemselves)
        .send({ label: 'theirs', role: 'viewer' });

      expect(inAcme.status).toBe(201);
      expect(inGlobex.status).toBe(404);
    });

    it('refuses an operator the moment their status is withdrawn', async () => {
      const world = await seedWorld();
      const asOperator = world.headers.operator;
      expect(
        (await request(server()).get('/tenants').set(asOperator)).status,
      ).toBe(200);

      await seed((client) => client.query('DELETE FROM platform_operators'));

      // The same credential. Operator status lives in storage and is read per
      // request, so nothing has to expire for this to take effect.
      expect(
        (await request(server()).get('/tenants').set(asOperator)).status,
      ).toBe(404);
    });

    it('refuses every member of a tenant that has been deactivated', async () => {
      const world = await seedWorld();
      const deactivated = await request(server())
        .delete(`/tenants/${world.acme.id}`)
        .set(world.headers.operator);
      expect(deactivated.status).toBe(204);

      for (const principal of ['admin', 'editor', 'viewer'] as const) {
        const response = await request(server())
          .get(`/tenants/${world.acme.id}/members`)
          .set(world.headers[principal]);
        expect({ principal, status: response.status }).toEqual({
          principal,
          status: 404,
        });
      }
    });

    it('refuses a person who has been deactivated platform-wide', async () => {
      const world = await seedWorld();
      const viewer = world.headers.viewer;
      expect(
        (
          await request(server())
            .get(`/tenants/${world.acme.id}/members`)
            .set(viewer)
        ).status,
      ).toBe(200);

      await seed((client) =>
        client.query(
          "UPDATE people SET status = 'deactivated' WHERE email = 'viewer@acme.example.com'",
        ),
      );

      expect(
        (
          await request(server())
            .get(`/tenants/${world.acme.id}/members`)
            .set(viewer)
        ).status,
      ).toBe(404);
    });
  });

  /**
   * The matrix above passes with the guard unregistered.
   *
   * That is not a defect in it — it is the two layers being genuinely
   * independent: the use case behind each route refuses the same principals
   * with the same response, so no status can tell which layer answered. It does
   * mean the matrix proves a claim about the system rather than about the
   * guard, and something has to prove the guard is the one in front.
   *
   * The log is where the design put that distinction, so the log is what this
   * asks. Unregister the guard and this fails while everything above stays
   * green.
   */
  it('is the guard that refuses, not only the use case behind it', async () => {
    const world = await seedWorld();
    const logged: string[] = [];
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });

    try {
      // A tenant member on an operator route. The path names no tenant, so the
      // caller resolves to a person acting in none — and the guard is what
      // turns the wrong kind of principal into a refusal before the controller
      // asks.
      const refused = await request(server())
        .get('/tenants')
        .set(world.headers.viewer);
      expect(refused.status).toBe(404);
    } finally {
      warn.mockRestore();
    }

    // A reason only the guard produces. Without it the controller's own
    // `actorOf` admits the principal and the use case refuses instead — same
    // 404 to the caller, different line in the log.
    //
    // Re-aimed in `caller-identity` task 1.2, which is the test doing its job:
    // this caller used to resolve to no principal at all, so the line to look
    // for was the guard's "needs a principal and none was resolved". Now they
    // resolve to a person, and the guard refuses them for being the wrong kind.
    // Both lines belong to the guard alone, which is all this asks.
    expect(logged.join('\n')).toContain(
      'this route is for operators; this caller is a person',
    );
  });

  it('covers every route the application serves', () => {
    // The assertion that keeps this suite honest as the application grows: a
    // route added later is reported by the inventory and, until it appears
    // above, fails here by name.
    const covered = [...ROUTES.map((route) => route.key), ...PUBLIC_ROUTES];
    const served = new RouteInventory(
      new DiscoveryService(app.get(ModulesContainer)),
      new MetadataScanner(),
      new Reflector(),
    )
      .all()
      .map((route) => `${route.method} ${route.path}`);

    expect(covered.sort()).toEqual(served.sort());
  });
});
