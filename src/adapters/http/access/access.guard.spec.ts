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
import {
  createIdentityTestContext,
  type IdentityTestContext,
} from '../../testing/identity-test-context';
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
    it.each(['operator', 'member', 'machine'])(
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

    administrator = await asMember(
      acmeId,
      'admin@acme.example.com',
      'admin',
      'acme-admin',
    );
    editor = await asMember(
      acmeId,
      'editor@acme.example.com',
      'editor',
      'acme-editor',
    );
    viewer = await asMember(
      acmeId,
      'viewer@acme.example.com',
      'viewer',
      'acme-viewer',
    );
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
    await context.seedMember({
      tenantId: globexId,
      email: 'dual@example.com',
      personId: dual,
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
