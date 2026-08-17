import {
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
  type NestMiddleware,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { ActorContext } from '../../../application/actor-context';
import {
  apiKeyId,
  personId,
  tenantId,
  type TenantId,
} from '../../../domain/identifiers';
import { TENANT_SCOPED_UNIT_OF_WORK } from '../../../application/ports/tenant-scoped-unit-of-work';
import { Argon2PasswordHasher } from '../../crypto/argon2-password-hasher';
import { JwtAccessTokenIssuer } from '../../crypto/access-token-issuer';
import {
  createIdentityTestContext,
  type IdentityTestContext,
} from '../../testing/identity-test-context';
import { createInMemoryApplication } from '../../testing/in-memory-application';
import { DomainErrorFilter } from '../domain-error.filter';
import { attachActor } from '../principal.middleware';
import { Access } from './access.decorator';
import { AccessGuard } from './access.guard';

/** Records whether the route behind the guard was ever reached. */
const entered = new Set<string>();

/**
 * Principals whose standing has been withdrawn since their credential was
 * issued. The header stays the same; what it resolves to does not.
 */
const withdrawn = new Set<string>();

@Controller('undeclared')
class UndeclaredController {
  @Get()
  list(): string {
    entered.add('undeclared');
    return 'reached';
  }
}

@Controller('open')
class PublicController {
  @Get()
  @Access({ public: true })
  list(): string {
    entered.add('open');
    return 'reached';
  }
}

@Controller('restricted')
class RestrictedController {
  @Get()
  @Access({ roles: ['admin'] })
  list(): string {
    entered.add('restricted');
    return 'reached';
  }
}

/**
 * The fixture route for machine admission. No shipped endpoint admits machines
 * (3.4) and inventing one would be feature 5's decision taken early, so the
 * mechanism is proven here instead.
 */
@Controller('integrations/:tenantId')
class MachineAdmittingController {
  @Get()
  @Access({ roles: ['editor'], machines: true })
  list(): string {
    entered.add('integrations');
    return 'reached';
  }
}

@Controller('operators')
class OperatorController {
  @Get()
  @Access({ operator: true })
  list(): string {
    entered.add('operators');
    return 'reached';
  }
}

/**
 * Stands in for the principal middleware, which resolves a credential this
 * suite has no interest in. The actor is chosen by a header **in this test
 * module only** — the real middleware is the one that refuses to believe
 * headers, and nothing here is registered outside these tests.
 */
@Injectable()
class ActorFromHeader implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const claimed = req.headers['x-test-actor'];
    if (
      typeof claimed === 'string' &&
      claimed in ACTORS &&
      !withdrawn.has(claimed)
    ) {
      attachActor(req, ACTORS[claimed]);
    }
    next();
  }
}

const ACTORS: Record<string, ActorContext> = {
  // Authenticated, acting in no tenant. No declaration admits this kind yet —
  // the shape that will is task 2.1 — so every route must refuse it.
  person: {
    kind: 'person',
    personId: personId('018f2c00-0000-7000-8000-00000000000e'),
  },
  operator: {
    kind: 'platform-operator',
    personId: personId('018f2c00-0000-7000-8000-00000000000a'),
  },
  member: {
    kind: 'tenant-member',
    personId: personId('018f2c00-0000-7000-8000-00000000000b'),
    tenantId: tenantId('018f2c00-0000-7000-8000-00000000000c'),
  },
  machine: {
    kind: 'machine',
    apiKeyId: apiKeyId('018f2c00-0000-7000-8000-00000000000d'),
    tenantId: tenantId('018f2c00-0000-7000-8000-00000000000c'),
    role: 'admin',
  },
};

@Module({
  controllers: [
    UndeclaredController,
    PublicController,
    RestrictedController,
    OperatorController,
    MachineAdmittingController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AccessGuard },
    // Present so the guard can be constructed; the suite that actually
    // resolves memberships overrides it with a seeded one.
    {
      provide: TENANT_SCOPED_UNIT_OF_WORK,
      useFactory: () => createIdentityTestContext().tenantScoped,
    },
  ],
})
class GuardedModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ActorFromHeader).forRoutes('*path');
  }
}

/** Lets a test name a principal the fixed map above does not carry. */
function register(name: string, actor: ActorContext): string {
  ACTORS[name] = actor;
  return name;
}

/**
 * What the guard refuses, and the little it admits so far.
 *
 * Anything whose declaration it has not yet learned to evaluate is refused
 * rather than admitted. Failing closed is what lets this be built in passes at
 * all — a half-built guard that let through what it could not judge would be
 * worse than none, because it would look like protection.
 */
describe('the access guard', () => {
  let app: INestApplication<App>;

  const ABSENCE = {
    statusCode: 404,
    message: 'the requested record does not exist',
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GuardedModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    app.useGlobalFilters(new DomainErrorFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    entered.clear();
    withdrawn.clear();
  });

  describe('a route that declares nothing', () => {
    it.each(['operator', 'member', 'machine', 'person'])(
      'refuses a %s, who might have satisfied any declaration it could have had',
      async (actor) => {
        const response = await request(app.getHttpServer())
          .get('/undeclared')
          .set({ 'x-test-actor': actor });

        expect(response.status).toBe(404);
        expect(response.body).toEqual(ABSENCE);
      },
    );

    it('refuses a caller presenting nothing at all', async () => {
      const response = await request(app.getHttpServer()).get('/undeclared');

      expect(response.status).toBe(404);
      expect(response.body).toEqual(ABSENCE);
    });

    it('never lets the handler run', async () => {
      await request(app.getHttpServer())
        .get('/undeclared')
        .set({ 'x-test-actor': 'operator' });

      // The whole claim of a guard: not "the response was 404" but "the code
      // behind it did not execute". A route that ran and then failed to answer
      // would pass the assertions above and have already done its work.
      expect(entered.has('undeclared')).toBe(false);
    });
  });

  describe('a route that declares itself public', () => {
    it('admits a caller with no principal', async () => {
      const response = await request(app.getHttpServer()).get('/open');

      expect(response.status).toBe(200);
      expect(entered.has('open')).toBe(true);
    });

    it('admits a caller who does hold one, since public is not a demand to be anonymous', async () => {
      const response = await request(app.getHttpServer())
        .get('/open')
        .set({ 'x-test-actor': 'member' });

      expect(response.status).toBe(200);
      expect(entered.has('open')).toBe(true);
    });
  });

  describe('a route that declares an operator', () => {
    it('admits a platform operator', async () => {
      const response = await request(app.getHttpServer())
        .get('/operators')
        .set({ 'x-test-actor': 'operator' });

      expect(response.status).toBe(200);
      expect(entered.has('operators')).toBe(true);
    });

    it.each(['member', 'machine'])(
      'refuses a %s as an absence',
      async (actor) => {
        const response = await request(app.getHttpServer())
          .get('/operators')
          .set({ 'x-test-actor': actor });

        expect(response.status).toBe(404);
        expect(response.body).toEqual(ABSENCE);
        expect(entered.size).toBe(0);
      },
    );

    it('refuses the same caller the moment their standing is withdrawn', async () => {
      const asOperator = () =>
        request(app.getHttpServer())
          .get('/operators')
          .set({ 'x-test-actor': 'operator' });

      expect((await asOperator()).status).toBe(200);

      // Nothing about the request changes; what it resolves to does. Operator
      // status lives in storage and the resolver reads it per request, so a
      // withdrawal takes effect on the next call rather than when a token
      // expires. Whether the *resolver* re-reads is feature 2's claim and is
      // proven end to end in `operator-boundary.integration-spec.ts`; what this
      // asserts is that the guard adds no memory of its own in front of it.
      withdrawn.add('operator');

      expect((await asOperator()).status).toBe(404);
    });

    it('judges each caller on its own, having just admitted another', async () => {
      const admitted = await request(app.getHttpServer())
        .get('/operators')
        .set({ 'x-test-actor': 'operator' });
      expect(admitted.status).toBe(200);

      // The discriminating pair, in one test rather than across two that happen
      // to run in this order: a guard that cached the route's first verdict
      // would answer 200 here, and the withdrawal test above would not catch it
      // because a withdrawn operator resolves to no principal at all.
      const refused = await request(app.getHttpServer())
        .get('/operators')
        .set({ 'x-test-actor': 'member' });

      expect(refused.status).toBe(404);
      expect(refused.body).toEqual(ABSENCE);
    });
  });

  describe('the two kinds of principal, refused in both directions', () => {
    it('refuses an operator on a route that declares tenant roles', async () => {
      // Refused today by the branch that has not learned to judge roles yet;
      // 2.3 must keep this failing for the right reason rather than by
      // accident, which is why it is asserted before that pass rather than
      // after.
      const response = await request(app.getHttpServer())
        .get('/restricted')
        .set({ 'x-test-actor': 'operator' });

      expect(response.status).toBe(404);
      expect(entered.size).toBe(0);
    });

    it('refuses a tenant member on a route that declares an operator', async () => {
      const response = await request(app.getHttpServer())
        .get('/operators')
        .set({ 'x-test-actor': 'member' });

      expect(response.status).toBe(404);
      expect(entered.size).toBe(0);
    });
  });

  describe('a route that requires somebody', () => {
    it.each(['/restricted', '/operators'])(
      'refuses %s to a caller presenting nothing, exactly as it answers an absent record',
      async (path) => {
        const response = await request(app.getHttpServer()).get(path);

        expect(response.status).toBe(404);
        expect(response.body).toEqual(ABSENCE);
        expect(entered.size).toBe(0);
      },
    );
  });
});

/**
 * The guard against real membership records, held in memory.
 *
 * Everything above judges a principal by its kind alone. This is where the
 * guard has to go and look: the role a person holds is a fact in storage, in
 * one tenant, and the request names which one.
 */
describe('the access guard, resolving a membership', () => {
  let app: INestApplication<App>;
  let context: IdentityTestContext;
  let logged: string[];

  const ABSENCE = {
    statusCode: 404,
    message: 'the requested record does not exist',
  };

  let acme: TenantId;

  beforeAll(async () => {
    context = createIdentityTestContext();

    const acmeId = await context.seedTenant('Acme');
    const globexId = await context.seedTenant('Globex');
    acme = acmeId;

    const asMember = async (
      tenant: typeof acmeId,
      email: string,
      role: 'admin' | 'editor' | 'viewer',
      name: string,
    ): Promise<string> =>
      register(name, {
        kind: 'tenant-member',
        personId: await context.seedMember({ tenantId: tenant, email, role }),
        tenantId: tenant,
      });

    // The handles are the names, and the tests below use those names as
    // literals, so nothing is kept: these calls exist for the seeding and the
    // registration they perform.
    await asMember(acmeId, 'admin@acme.example.com', 'admin', 'acme-admin');
    await asMember(acmeId, 'editor@acme.example.com', 'editor', 'acme-editor');
    await asMember(acmeId, 'viewer@acme.example.com', 'viewer', 'acme-viewer');
    // Registered against **Acme**, though their only membership is in Globex.
    // That is what a stranger actually looks like: the tenant on the actor
    // comes from the request path, so it always matches the path and never the
    // caller's wishes. An actor naming a tenant it belongs to but did not
    // address is not a case the system can produce.
    const globexAdmin = await context.seedMember({
      tenantId: globexId,
      email: 'admin@globex.example.com',
      role: 'admin',
    });
    register('stranger-in-acme', {
      kind: 'tenant-member',
      personId: globexAdmin,
      tenantId: acmeId,
    });
    register('globex-admin', {
      kind: 'tenant-member',
      personId: globexAdmin,
      tenantId: globexId,
    });

    // The same person, an administrator here and a viewer there. Which one they
    // are depends entirely on the tenant the request names.
    const dual = await context.seedMember({
      tenantId: acmeId,
      email: 'dual@example.com',
      role: 'admin',
    });
    // No person is named here, and none can be: the fixture resolves one from
    // the address, which is what makes this the same person in both tenants.
    await context.seedMember({
      tenantId: globexId,
      email: 'dual@example.com',
      role: 'viewer',
    });
    register('dual-in-acme', {
      kind: 'tenant-member',
      personId: dual,
      tenantId: acmeId,
    });
    register('dual-in-globex', {
      kind: 'tenant-member',
      personId: dual,
      tenantId: globexId,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [GuardedModule],
    })
      .overrideProvider(TENANT_SCOPED_UNIT_OF_WORK)
      .useValue(context.tenantScoped)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    app.useGlobalFilters(new DomainErrorFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    entered.clear();
    withdrawn.clear();
    logged = [];
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const restricted = (actor: string) =>
    request(app.getHttpServer())
      .get('/restricted')
      .set({ 'x-test-actor': actor });

  it('admits a member whose role the route names', async () => {
    const response = await restricted('acme-admin');

    expect(response.status).toBe(200);
    expect(entered.has('restricted')).toBe(true);
  });

  it.each(['acme-editor', 'acme-viewer'])(
    'refuses %s, who belongs here and holds the wrong role',
    async (actor) => {
      const response = await restricted(actor);

      expect(response.status).toBe(404);
      expect(response.body).toEqual(ABSENCE);
      expect(entered.size).toBe(0);
    },
  );

  it('refuses a stranger, who holds an administrator role somewhere else', async () => {
    // The same person is an administrator in Globex and reaches Acme's route
    // with Acme on the actor, because the path put it there.
    expect((await restricted('globex-admin')).status).toBe(200);

    const response = await restricted('stranger-in-acme');

    expect(response.status).toBe(404);
    expect(response.body).toEqual(ABSENCE);
  });

  it('answers the wrong role and no standing at all with the same bytes', async () => {
    const wrongRole = await restricted('acme-viewer');
    const noStanding = await restricted('stranger-in-acme');

    // Requirement 5.1 and 5.2 together: a caller must not be able to tell "you
    // are here but may not" from "you are not here", because the difference
    // confirms that a tenant, and their place in it, exists.
    expect(wrongRole.status).toBe(noStanding.status);
    expect(wrongRole.body).toEqual(noStanding.body);
  });

  it('tells the two apart in the log, where only operators read', async () => {
    await restricted('acme-viewer');
    const denial = logged.join('\n');
    logged = [];
    await restricted('stranger-in-acme');
    const absence = logged.join('\n');

    expect(denial).toContain('forbidden');
    expect(absence).toContain('not-found');
    expect(denial).not.toEqual(absence);
  });

  it('judges the same person by the tenant the request names', async () => {
    // Administrator in Acme, viewer in Globex. Nothing about the person
    // changes between these two requests; only the path does.
    expect((await restricted('dual-in-acme')).status).toBe(200);
    expect((await restricted('dual-in-globex')).status).toBe(404);
  });

  it('refuses a member of a tenant that has been deactivated', async () => {
    await context.platform.runAsOperator(({ tenants }) =>
      tenants.updateStatus(acme, 'inactive'),
    );

    const response = await restricted('acme-admin');

    expect(response.status).toBe(404);
    expect(response.body).toEqual(ABSENCE);

    await context.platform.runAsOperator(({ tenants }) =>
      tenants.updateStatus(acme, 'active'),
    );
  });
});

/**
 * Machines are admitted by a separate statement, never by holding a role.
 *
 * An API key carries a role of its own, which is what makes this worth writing
 * down: without a deliberate admission, a key carrying `admin` would otherwise
 * look exactly like an administrator to a route that only asked for one.
 */
describe('the access guard, and machine callers', () => {
  let app: INestApplication<App>;
  let context: IdentityTestContext;

  const ABSENCE = {
    statusCode: 404,
    message: 'the requested record does not exist',
  };

  let acme: TenantId;
  let globex: TenantId;

  beforeAll(async () => {
    context = createIdentityTestContext();
    acme = await context.seedTenant('Acme');
    globex = await context.seedTenant('Globex');

    register('acme-editor-key', {
      kind: 'machine',
      apiKeyId: apiKeyId('018f2c00-0000-7000-8000-0000000000e1'),
      tenantId: acme,
      role: 'editor',
    });
    register('acme-viewer-key', {
      kind: 'machine',
      apiKeyId: apiKeyId('018f2c00-0000-7000-8000-0000000000e2'),
      tenantId: acme,
      role: 'viewer',
    });
    register('acme-admin-key', {
      kind: 'machine',
      apiKeyId: apiKeyId('018f2c00-0000-7000-8000-0000000000e3'),
      tenantId: acme,
      role: 'admin',
    });
    register('acme-member', {
      kind: 'tenant-member',
      personId: await context.seedMember({
        tenantId: acme,
        email: 'editor@acme.example.com',
        role: 'editor',
      }),
      tenantId: acme,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [GuardedModule],
    })
      .overrideProvider(TENANT_SCOPED_UNIT_OF_WORK)
      .useValue(context.tenantScoped)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    app.useGlobalFilters(new DomainErrorFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    entered.clear();
    withdrawn.clear();
  });

  const integrations = (tenant: TenantId, actor: string) =>
    request(app.getHttpServer())
      .get(`/integrations/${tenant}`)
      .set({ 'x-test-actor': actor });

  it('refuses a key on a route that does not admit machines, whatever it carries', async () => {
    // The key carries `admin`, which is exactly what the route asks of a
    // person. Holding the role is not the question.
    const response = await request(app.getHttpServer())
      .get('/restricted')
      .set({ 'x-test-actor': 'acme-admin-key' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual(ABSENCE);
    expect(entered.size).toBe(0);
  });

  it('admits a key carrying a permitted role on the tenant it belongs to', async () => {
    const response = await integrations(acme, 'acme-editor-key');

    expect(response.status).toBe(200);
    expect(entered.has('integrations')).toBe(true);
  });

  it('refuses the same key when the path names another tenant', async () => {
    // Unlike a person, a machine's tenant comes from its credential rather than
    // from the path, so the two can disagree and the guard has to compare them.
    const response = await integrations(globex, 'acme-editor-key');

    expect(response.status).toBe(404);
    expect(response.body).toEqual(ABSENCE);
    expect(entered.size).toBe(0);
  });

  it('refuses a key whose role the route does not name', async () => {
    const response = await integrations(acme, 'acme-viewer-key');

    expect(response.status).toBe(404);
    expect(entered.size).toBe(0);
  });

  it('still judges a person by their membership on a route that admits machines', async () => {
    // `machines` widens who may reach a route; it does not turn the role check
    // off for the people who were already reaching it.
    const response = await integrations(acme, 'acme-member');

    expect(response.status).toBe(200);
    expect(entered.has('integrations')).toBe(true);
  });
});

/**
 * The guard as the application actually registers it.
 *
 * Everything above builds a module of its own, which proves the guard's
 * decisions and nothing about whether the real application uses it. This mounts
 * a route the application does not ship, declaring nothing, and expects it to
 * be refused — which can only happen if the guard is registered for routes
 * nobody thought about.
 */
describe('the access guard, as the application registers it', () => {
  const tokens = new JwtAccessTokenIssuer({
    secret: 'a-signing-secret-long-enough-for-the-rule',
    accessTokenLifetimeSeconds: 900,
  });
  const hasher = new Argon2PasswordHasher({
    memoryCostKiB: 8192,
    timeCost: 1,
    parallelism: 1,
  });

  @Controller('a-route-nobody-declared')
  class UndeclaredProbeController {
    @Get()
    list(): string {
      entered.add('probe');
      return 'reached';
    }
  }

  let app: INestApplication<App>;

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
      controllers: [UndeclaredProbeController],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    entered.clear();
  });

  it('refuses a route the application never declared', async () => {
    const response = await request(app.getHttpServer()).get(
      '/a-route-nobody-declared',
    );

    expect(response.status).toBe(404);
    expect(entered.has('probe')).toBe(false);
  });

  it('still admits the routes that declared themselves public', async () => {
    // Registration must not turn the credential endpoints off. A guard that
    // refused everything would satisfy the assertion above and lock the door
    // on the way in.
    const response = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: 'nobody@example.com', password: 'not the password' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      statusCode: 404,
      message: 'the requested record does not exist',
    });
  });
});
