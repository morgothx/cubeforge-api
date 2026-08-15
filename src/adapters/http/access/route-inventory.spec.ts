import { Controller, Get, Post, type INestApplication } from '@nestjs/common';
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
import { Access } from './access.decorator';
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
      'GET /tenants',
      'GET /tenants/:tenantId/api-keys',
      'GET /tenants/:tenantId/members',
      'PATCH /tenants/:tenantId/members/:membershipId',
      'POST /auth/credentials',
      'POST /auth/refresh',
      'POST /auth/sign-in',
      'POST /auth/sign-out',
      'POST /platform/people/:personId/setup-tokens',
      'POST /tenants',
      'POST /tenants/:tenantId/api-keys',
      'POST /tenants/:tenantId/members',
    ]);
  });

  it('reports every one of them as declaring nothing, for now', () => {
    // True until section 4 declares them. When that lands this assertion
    // inverts, and 5.1 is where it lives afterwards.
    expect(routes.filter((route) => route.declaration !== null)).toEqual([]);
  });
});
