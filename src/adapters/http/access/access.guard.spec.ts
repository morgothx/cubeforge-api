import {
  Controller,
  Get,
  Injectable,
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
import { apiKeyId, personId, tenantId } from '../../../domain/identifiers';
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
  providers: [{ provide: APP_GUARD, useClass: AccessGuard }],
})
class GuardedModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ActorFromHeader).forRoutes('*path');
  }
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
