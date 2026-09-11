import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { TenantScopedModel } from '../../application/ports/tenant-scoped-model';
import { DescribeVocabularyUseCase } from '../../application/semantic/describe-vocabulary.use-case';
import {
  personId,
  personId as toPersonId,
  tenantId,
  type TenantId,
} from '../../domain/identifiers';
import { describeVocabulary } from '../../domain/semantic/published-vocabulary';
import { JwtAccessTokenIssuer } from '../crypto/access-token-issuer';
import { Argon2PasswordHasher } from '../crypto/argon2-password-hasher';
import {
  createIdentityTestContext,
  type IdentityTestContext,
} from '../testing/identity-test-context';
import { createInMemoryApplication } from '../testing/in-memory-application';
import { AnalyticsVocabularyController } from './analytics-vocabulary.controller';
import { attachActor } from './principal.middleware';

const ACME = tenantId('11111111-1111-4111-8111-111111111111');
const ASKER = personId('22222222-2222-4222-8222-222222222222');

describe('describing what may be asked, at the controller', () => {
  it('answers with the published vocabulary, as it is', () => {
    const asking = {} as Request;
    attachActor(asking, {
      kind: 'tenant-member',
      personId: ASKER,
      tenantId: ACME,
    });

    expect(
      new AnalyticsVocabularyController(
        new DescribeVocabularyUseCase(),
      ).describe(asking),
    ).toEqual(describeVocabulary());
  });
});

/**
 * The route, over HTTP, with the semantic layer as broken as it can be.
 *
 * Every question would fail against this model. Learning what to ask must not:
 * that is the whole difference between describing the questions and asking
 * them, and a route that reached for the model "just to check" would make the
 * dashboard's explorer as fragile as its answers.
 */
describe('describing what may be asked over HTTP', () => {
  const tokens = new JwtAccessTokenIssuer({
    secret: 'a-signing-secret-long-enough-for-the-rule',
    accessTokenLifetimeSeconds: 900,
  });
  const hasher = new Argon2PasswordHasher({
    memoryCostKiB: 8192,
    timeCost: 1,
    parallelism: 1,
  });

  /** A semantic layer that answers nothing, ever. */
  const unreachable: TenantScopedModel = {
    askAs: () => Promise.reject(new Error('the semantic layer is down')),
  };

  let app: INestApplication<App>;
  let context: IdentityTestContext;
  let acme: TenantId;

  beforeEach(async () => {
    context = createIdentityTestContext();
    acme = await context.seedTenant('Acme');
    app = await createInMemoryApplication({
      context,
      hasher,
      tokens,
      throttling: {
        windowSeconds: 60,
        cooldownSeconds: 60,
        signInAttemptsPerAddress: 3,
        signInAttemptsPerOrigin: 8,
        redemptionsPerOrigin: 3,
      },
      model: unreachable,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers a member while the semantic layer cannot be reached', async () => {
    const viewer = await context.seedMember({
      tenantId: acme,
      email: 'viewer@example.com',
      role: 'viewer',
    });

    const response = await request(app.getHttpServer())
      .get(`/tenants/${acme}/analytics/vocabulary`)
      .set({
        authorization: `Bearer ${await tokens.issue(toPersonId(viewer), context.clock.now())}`,
      })
      .expect(200);

    expect(response.body).toEqual(describeVocabulary());
  });
});
