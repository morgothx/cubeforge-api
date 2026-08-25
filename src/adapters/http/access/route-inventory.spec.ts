import {
  Controller,
  Get,
  Post,
  SetMetadata,
  type INestApplication,
} from '@nestjs/common';
import {
  DiscoveryModule,
  DiscoveryService,
  MetadataScanner,
  ModulesContainer,
  Reflector,
} from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { Argon2PasswordHasher } from '../../crypto/argon2-password-hasher';
import { JwtAccessTokenIssuer } from '../../crypto/access-token-issuer';
import { createIdentityTestContext } from '../../testing/identity-test-context';
import { createInMemoryApplication } from '../../testing/in-memory-application';
import { ACCESS_DECLARATION, Access, assertUsable } from './access.decorator';
import { RouteInventory, type DeclaredRoute } from './route-inventory';

/**
 * The inventory is what makes an unprotected route detectable without anyone
 * remembering to look for it, so the only property that matters is that the
 * list comes from the framework rather than from a register someone maintains.
 * These tests never tell it what to expect — they add routes and check it found
 * them.
 */
describe('the route inventory', () => {
  @Controller('declared')
  class DeclaredController {
    @Get()
    @Access({ roles: ['admin', 'viewer'] })
    list(): void {}

    @Post('nested/:id')
    @Access({ operator: true })
    create(): void {}
  }

  @Controller('undeclared')
  class UndeclaredController {
    @Get()
    list(): void {}
  }

  @Access({ public: true })
  @Controller('inherited')
  class InheritedController {
    @Get()
    list(): void {}

    @Post()
    @Access({ roles: ['admin'] })
    create(): void {}
  }

  async function inventoryOf(
    ...controllers: readonly (new () => unknown)[]
  ): Promise<RouteInventory> {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      controllers: [...controllers],
      providers: [RouteInventory],
    }).compile();
    await moduleRef.init();
    return moduleRef.get(RouteInventory);
  }

  it('reports a handler with the declaration written on it', async () => {
    const inventory = await inventoryOf(DeclaredController);

    expect(inventory.all()).toEqual([
      {
        controller: 'DeclaredController',
        handler: 'list',
        method: 'GET',
        path: '/declared',
        declaration: { roles: ['admin', 'viewer'] },
      },
      {
        controller: 'DeclaredController',
        handler: 'create',
        method: 'POST',
        path: '/declared/nested/:id',
        declaration: { operator: true },
      },
    ]);
  });

  it('reports a handler that declares nothing as declaring nothing', async () => {
    const inventory = await inventoryOf(UndeclaredController);

    expect(inventory.all()).toEqual([
      {
        controller: 'UndeclaredController',
        handler: 'list',
        method: 'GET',
        path: '/undeclared',
        declaration: null,
      },
    ]);
  });

  it('lets a handler narrow what its controller declared', async () => {
    const inventory = await inventoryOf(InheritedController);
    const byHandler = Object.fromEntries(
      inventory.all().map((route) => [route.handler, route.declaration]),
    );

    // The controller's declaration is a default, and the handler's own wins.
    // Reading it any other way would let a class-wide `public` quietly outrank
    // a method that restricted itself.
    expect(byHandler).toEqual({
      list: { public: true },
      create: { roles: ['admin'] },
    });
  });

  it('reports a declaration that bypassed the decorator as unusable', async () => {
    @Controller('smuggled')
    class SmuggledController {
      // `SetMetadata` with the same key, skipping the validation `Access` runs.
      // A route declaring an empty role list permits nobody, which is a typo
      // wearing the costume of a decision.
      @Get()
      @SetMetadata(ACCESS_DECLARATION, { roles: [] })
      list(): void {}
    }

    const inventory = await inventoryOf(SmuggledController);
    const [route] = inventory.all();

    expect(route.declaration).toEqual({ roles: [] });
    expect(() => {
      assertUsable(route.declaration!);
    }).toThrow(/permits nobody/);
  });

  it('finds a controller nobody told it about', async () => {
    const before = await inventoryOf(DeclaredController);
    const after = await inventoryOf(DeclaredController, UndeclaredController);

    // The whole point: the list grows because a route was added, not because
    // the inventory was updated.
    expect(after.all()).toHaveLength(before.all().length + 1);
  });
});

/**
 * The same inventory against the application that actually ships.
 *
 * Built by hand from the running application's module container rather than
 * injected, because nothing provides it yet — registering it belongs to the
 * task that turns the guard on. What matters here is only that it sees the real
 * routes, so the suites that later assert every one of them is declared have
 * something truthful to walk.
 */
describe('the route inventory, against the real application', () => {
  const tokens = new JwtAccessTokenIssuer({
    secret: 'a-signing-secret-long-enough-for-the-rule',
    accessTokenLifetimeSeconds: 900,
  });
  const hasher = new Argon2PasswordHasher({
    memoryCostKiB: 8192,
    timeCost: 1,
    parallelism: 1,
  });

  let app: INestApplication<App>;
  let routes: readonly DeclaredRoute[];

  beforeAll(async () => {
    app = await createInMemoryApplication({
      context: createIdentityTestContext(),
      hasher,
      tokens,
      throttling: {
        windowSeconds: 60,
        cooldownSeconds: 60,
        signInAttemptsPerAddress: 3,
        signInAttemptsPerOrigin: 8,
        redemptionsPerOrigin: 3,
      },
    });
    routes = new RouteInventory(
      new DiscoveryService(app.get(ModulesContainer)),
      new MetadataScanner(),
      new Reflector(),
    ).all();
  });

  afterAll(async () => {
    await app.close();
  });

  it('finds every route the application serves', () => {
    // Spelled out rather than counted, so adding a route fails this with the
    // route named instead of with a number nobody can act on.
    expect(
      routes.map((route) => `${route.method} ${route.path}`).sort(),
    ).toEqual([
      'DELETE /platform/people/:personId',
      'DELETE /tenants/:tenantId',
      'DELETE /tenants/:tenantId/api-keys/:apiKeyId',
      'DELETE /tenants/:tenantId/members/:membershipId',
      'GET /me',
      'GET /tenants',
      'GET /tenants/:tenantId/api-keys',
      'GET /tenants/:tenantId/inventory/locations',
      'GET /tenants/:tenantId/inventory/products',
      'GET /tenants/:tenantId/members',
      'PATCH /tenants/:tenantId/members/:membershipId',
      'POST /auth/credentials',
      'POST /auth/refresh',
      'POST /auth/sign-in',
      'POST /auth/sign-out',
      'POST /platform/people/:personId/setup-tokens',
      'POST /tenants',
      'POST /tenants/:tenantId/api-keys',
      'POST /tenants/:tenantId/inventory/movements',
      'POST /tenants/:tenantId/inventory/movements/batch',
      'POST /tenants/:tenantId/members',
      'PUT /tenants/:tenantId/inventory/locations/:code',
      'PUT /tenants/:tenantId/inventory/products/:sku',
    ]);
  });

  it('reports what each of them declares', () => {
    // The design's declaration table, restated where a machine checks it. 5.1
    // adds the stronger claim — that *no* route is undeclared, whatever the
    // table says — but this is what pins each route to the access it was
    // designed to have.
    expect(
      Object.fromEntries(
        routes.map((route) => [
          `${route.method} ${route.path}`,
          route.declaration,
        ]),
      ),
    ).toEqual({
      'POST /auth/sign-in': { public: true },
      'POST /auth/refresh': { public: true },
      'POST /auth/sign-out': { public: true },
      'POST /auth/credentials': { public: true },
      'GET /me': { person: true },
      'POST /tenants': { operator: true },
      'GET /tenants': { operator: true },
      'DELETE /tenants/:tenantId': { operator: true },
      'DELETE /platform/people/:personId': { operator: true },
      'POST /platform/people/:personId/setup-tokens': { operator: true },
      'GET /tenants/:tenantId/members': {
        roles: ['admin', 'editor', 'viewer'],
      },
      'POST /tenants/:tenantId/members': { roles: ['admin'] },
      'PATCH /tenants/:tenantId/members/:membershipId': { roles: ['admin'] },
      'DELETE /tenants/:tenantId/members/:membershipId': { roles: ['admin'] },
      'POST /tenants/:tenantId/api-keys': { roles: ['admin'] },
      'GET /tenants/:tenantId/api-keys': { roles: ['admin'] },
      'GET /tenants/:tenantId/inventory/locations': {
        roles: ['admin', 'editor', 'viewer'],
        machines: true,
      },
      'GET /tenants/:tenantId/inventory/products': {
        roles: ['admin', 'editor', 'viewer'],
        machines: true,
      },
      'POST /tenants/:tenantId/inventory/movements': {
        roles: ['admin', 'editor'],
        machines: true,
      },
      'POST /tenants/:tenantId/inventory/movements/batch': {
        roles: ['admin', 'editor'],
        machines: true,
      },
      'PUT /tenants/:tenantId/inventory/locations/:code': {
        roles: ['admin', 'editor'],
        machines: true,
      },
      'PUT /tenants/:tenantId/inventory/products/:sku': {
        roles: ['admin', 'editor'],
        machines: true,
      },
      'DELETE /tenants/:tenantId/api-keys/:apiKeyId': { roles: ['admin'] },
    });
  });

  /**
   * The claim that survives the table above.
   *
   * That table lists every route by name, so today the two say the same thing.
   * They stop saying the same thing the moment somebody adds a route: the table
   * would have to be updated by hand, and this would not. This is the one that
   * catches the route nobody thought about.
   */
  it('leaves no route undeclared', () => {
    const undeclared = routes
      .filter((route) => route.declaration === null)
      .map(
        (route) =>
          `${route.method} ${route.path} — ${route.controller}.${route.handler}`,
      );

    expect(undeclared).toEqual([]);
  });

  /**
   * The narrow case this catches, stated precisely: `Access` validates when the
   * module is imported, so a declaration it rejects crashes startup and no test
   * ever runs. What remains reachable is metadata attached *without* going
   * through `Access` — `SetMetadata` with the same key, which is exactly what a
   * well-meaning developer reaches for. The test below this one proves the
   * check has teeth against that case.
   */
  it('carries no declaration that could not mean anything', () => {
    const unusable = routes.flatMap((route) => {
      if (route.declaration === null) {
        return [];
      }
      try {
        assertUsable(route.declaration);
        return [];
      } catch (error) {
        return [
          `${route.method} ${route.path}: ${error instanceof Error ? error.message : String(error)}`,
        ];
      }
    });

    expect(unusable).toEqual([]);
  });

  it('admits machine callers only where a feature decided to', () => {
    // Requirement 3.4 of the authorization feature. Until inventory there was
    // no such route at all, and this test asserted the empty set; the mechanism
    // was proven by a fixture alone. Inventory is the surface built for
    // machines, so it is the answer, and listing it here means the next route
    // to admit a key does so by editing this line rather than by nobody
    // noticing.
    const admitting = routes
      .filter(
        (route) =>
          route.declaration !== null && 'machines' in route.declaration,
      )
      .map((route) => route.path);

    expect([...new Set(admitting)].sort()).toEqual([
      '/tenants/:tenantId/inventory/locations',
      '/tenants/:tenantId/inventory/locations/:code',
      '/tenants/:tenantId/inventory/movements',
      '/tenants/:tenantId/inventory/movements/batch',
      '/tenants/:tenantId/inventory/products',
      '/tenants/:tenantId/inventory/products/:sku',
    ]);
  });

  it('names a tenant in the path of every route that admits a machine', () => {
    // Not cosmetic. A person's tenant is read from the path; a machine's comes
    // from its key, and the guard refuses a key wherever there is no path
    // tenant to confine it against. A machine route that named no tenant would
    // be unreachable by the only caller it exists for — silently, and with a
    // refusal indistinguishable from an absent record.
    const unconfinable = routes.filter(
      (route) =>
        route.declaration !== null &&
        'machines' in route.declaration &&
        !route.path.includes(':tenantId'),
    );

    expect(unconfinable).toEqual([]);
  });
});
