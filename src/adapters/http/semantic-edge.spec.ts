import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Argon2PasswordHasher } from '../crypto/argon2-password-hasher';
import { JwtAccessTokenIssuer } from '../crypto/access-token-issuer';
import { InMemoryModel } from '../semantic/in-memory-model';
import { LONGEST_PERIOD_DAYS } from '../../domain/analytics/period';
import {
  personId as toPersonId,
  type TenantId,
} from '../../domain/identifiers';
import type { Role } from '../../domain/membership/role';
import { GROUPINGS, MEASURES } from '../../domain/semantic/vocabulary';
import {
  createIdentityTestContext,
  type IdentityTestContext,
} from '../testing/identity-test-context';
import { createInMemoryApplication } from '../testing/in-memory-application';

const CARRIED_THROUGH = new Date('2026-08-29T03:00:00.000Z');

/**
 * The modelled route, at the edge.
 *
 * The model is not here: what a real question returns is the integration
 * suites' business, and a route test that reached a running Cube would be
 * measuring Cube. What only a request can show is the tenant arriving from the
 * path rather than from the body, the composition being refused before anything
 * is asked, the rate bucket being the analytical one, and the answer's states
 * surviving serialisation.
 */
describe('asking a composed question over HTTP', () => {
  const tokens = new JwtAccessTokenIssuer({
    secret: 'a-signing-secret-long-enough-for-the-rule',
    accessTokenLifetimeSeconds: 900,
  });
  const hasher = new Argon2PasswordHasher({
    memoryCostKiB: 8192,
    timeCost: 1,
    parallelism: 1,
  });
  const THROTTLING = {
    windowSeconds: 60,
    cooldownSeconds: 60,
    signInAttemptsPerAddress: 3,
    signInAttemptsPerOrigin: 8,
    redemptionsPerOrigin: 3,
  };

  let app: INestApplication<App>;
  let context: IdentityTestContext;
  let model: InMemoryModel;
  let acme: TenantId;
  let globex: TenantId;

  const bearer = async (person: string): Promise<Record<string, string>> => ({
    authorization: `Bearer ${await tokens.issue(toPersonId(person), context.clock.now())}`,
  });

  const member = (tenant: TenantId, role: Role): Promise<string> =>
    context.seedMember({
      tenantId: tenant,
      email: `${role}-${tenant.slice(0, 8)}@example.com`,
      role,
    });

  const aQuestion = (over: Record<string, unknown> = {}) => ({
    measures: ['net_quantity'],
    from: '2026-08-01',
    to: '2026-08-31',
    ...over,
  });

  const askFor = (tenant: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`/tenants/${tenant}/analytics/questions`)
      .send(body);

  beforeEach(async () => {
    context = createIdentityTestContext();
    model = new InMemoryModel();
    acme = await context.seedTenant('Acme');
    globex = await context.seedTenant('Globex');

    model.carried(acme, CARRIED_THROUGH, {
      rows: [
        { values: { recorded_day: '2026-08-03', net_quantity: 12 } },
        { values: { recorded_day: '2026-08-04', net_quantity: 4 } },
      ],
      servedFrom: 'prepared',
    });
    model.carried(globex, CARRIED_THROUGH, {
      rows: [{ values: { recorded_day: '2026-08-03', net_quantity: 500 } }],
    });

    app = await createInMemoryApplication({
      context,
      hasher,
      tokens,
      throttling: THROTTLING,
      model,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers a member of the tenant, saying where the rows came from', async () => {
    const admin = await member(acme, 'admin');

    const response = await askFor(acme, aQuestion())
      .set(await bearer(admin))
      .expect(200);

    expect(response.body).toEqual({
      state: 'answered',
      completeThrough: CARRIED_THROUGH.toISOString(),
      servedFrom: 'prepared',
      rows: [
        { recorded_day: '2026-08-03', net_quantity: 12 },
        { recorded_day: '2026-08-04', net_quantity: 4 },
      ],
    });
  });

  it('answers every one of the three tenant roles', async () => {
    for (const role of ['admin', 'editor', 'viewer'] as const) {
      const person = await member(acme, role);

      await askFor(acme, aQuestion())
        .set(await bearer(person))
        .expect(200);
    }
  });

  /**
   * The tenant comes from the path and the caller's standing, never from the
   * body. A body naming another tenant is refused outright, so there is no
   * reading of this request in which Globex's rows could arrive.
   */
  it('refuses a body that names a tenant instead of honouring it', async () => {
    const admin = await member(acme, 'admin');

    await askFor(acme, aQuestion({ tenantId: globex }))
      .set(await bearer(admin))
      .expect(400);
  });

  it('refuses an unknown measure, naming what the model does offer', async () => {
    const admin = await member(acme, 'admin');

    const response = await askFor(acme, aQuestion({ measures: ['revenue'] }))
      .set(await bearer(admin))
      .expect(400);

    const said = JSON.stringify(response.body);
    expect(said).toContain('revenue');
    for (const offered of [...MEASURES, ...GROUPINGS]) {
      expect(said).toContain(offered);
    }
  });

  it('refuses a period longer than the platform answers, naming the limit', async () => {
    const admin = await member(acme, 'admin');

    const response = await askFor(
      acme,
      aQuestion({ from: '2025-01-01', to: '2026-06-30' }),
    )
      .set(await bearer(admin))
      .expect(400);

    expect(JSON.stringify(response.body)).toContain(
      String(LONGEST_PERIOD_DAYS),
    );
  });

  it('refuses a question with no period at all', async () => {
    const admin = await member(acme, 'admin');

    await askFor(acme, { measures: ['net_quantity'] })
      .set(await bearer(admin))
      .expect(400);
  });

  it('answers a caller of another tenant as it answers an absent one', async () => {
    const stranger = await member(globex, 'admin');

    await askFor(acme, aQuestion())
      .set(await bearer(stranger))
      .expect(404);
  });

  /**
   * The rate bucket is not asserted here, and that is the codebase's own line.
   *
   * The in-memory application registers the credential buckets only, so the
   * analytical one this route shares does not count anything in this harness —
   * which is why the analytical route's own limit is proven in
   * `analytics-throttling.integration-spec.ts` rather than in its edge spec.
   * The modelled route shares that bucket by declaration; that it counts is the
   * HTTP integration suite's to show, against an application that registered it.
   */

  it('keeps a tenant nothing was carried for apart from an empty answer', async () => {
    const absent = await context.seedTenant('Initech');
    const admin = await member(absent, 'admin');

    const response = await askFor(absent, aQuestion())
      .set(await bearer(admin))
      .expect(200);

    expect(response.body).toEqual({ state: 'never-exported' });
  });
});
