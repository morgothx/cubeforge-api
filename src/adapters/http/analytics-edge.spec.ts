import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { InMemoryAnalytics } from '../analytics/in-memory-analytics';
import { Argon2PasswordHasher } from '../crypto/argon2-password-hasher';
import { JwtAccessTokenIssuer } from '../crypto/access-token-issuer';
import { day, LONGEST_PERIOD_DAYS } from '../../domain/analytics/period';
import {
  personId as toPersonId,
  type TenantId,
} from '../../domain/identifiers';
import type { Role } from '../../domain/membership/role';
import {
  createIdentityTestContext,
  type IdentityTestContext,
} from '../testing/identity-test-context';
import { createInMemoryApplication } from '../testing/in-memory-application';

const CARRIED_THROUGH = new Date('2026-08-29T03:00:00.000Z');

/**
 * The route, at the edge.
 *
 * The engine is not here: what a real question returns is the integration
 * suites' business, and a route test that reached an engine would be measuring
 * the engine. What only a request can show is the tenant arriving from the
 * path, the period being refused before anything is read, and the answer's
 * three states surviving serialisation.
 */
describe('asking for movement history over HTTP', () => {
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
  let analytics: InMemoryAnalytics;
  let acme: TenantId;
  let globex: TenantId;

  const bearer = async (person: string): Promise<Record<string, string>> => ({
    authorization: `Bearer ${await tokens.issue(toPersonId(person), context.clock.now())}`,
  });

  async function member(tenant: TenantId, role: Role): Promise<string> {
    return context.seedMember({
      tenantId: tenant,
      email: `${role}-${tenant.slice(0, 8)}@example.com`,
      role,
    });
  }

  const askFor = (tenant: string, from: string, to: string) =>
    request(app.getHttpServer()).get(
      `/tenants/${tenant}/analytics/movements?from=${from}&to=${to}`,
    );

  beforeEach(async () => {
    context = createIdentityTestContext();
    analytics = new InMemoryAnalytics();
    acme = await context.seedTenant('Acme');
    globex = await context.seedTenant('Globex');

    analytics.carried(acme, CARRIED_THROUGH, {
      movements: [
        { day: day('2026-08-03'), kind: 'receipt', quantity: 12 },
        { day: day('2026-08-04'), kind: 'issue', quantity: 4 },
      ],
    });
    analytics.carried(globex, CARRIED_THROUGH, {
      movements: [{ day: day('2026-08-03'), kind: 'receipt', quantity: 500 }],
    });

    app = await createInMemoryApplication({
      context,
      hasher,
      tokens,
      throttling: THROTTLING,
      analytics,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers a member of the tenant, with the period they named', async () => {
    const admin = await member(acme, 'admin');

    const response = await askFor(acme, '2026-08-01', '2026-08-31')
      .set(await bearer(admin))
      .expect(200);

    expect(response.body).toEqual({
      state: 'answered',
      completeThrough: CARRIED_THROUGH.toISOString(),
      entries: [
        { day: '2026-08-03', kind: 'receipt', quantity: 12 },
        { day: '2026-08-04', kind: 'issue', quantity: 4 },
      ],
    });
  });

  it('takes the tenant from the path, so one member never sees the other tenant', async () => {
    const admin = await member(acme, 'admin');

    const own = await askFor(acme, '2026-08-01', '2026-08-31')
      .set(await bearer(admin))
      .expect(200);
    const other = await askFor(globex, '2026-08-01', '2026-08-31').set(
      await bearer(admin),
    );

    expect(JSON.stringify(own.body)).toContain('12');
    expect(JSON.stringify(own.body)).not.toContain('500');
    // A member of nothing here is answered as for a tenant that is not there.
    expect(other.status).toBe(404);
  });

  it('admits an editor and a viewer as it admits an administrator', async () => {
    for (const role of ['admin', 'editor', 'viewer'] as const) {
      const person = await member(acme, role);

      await askFor(acme, '2026-08-01', '2026-08-31')
        .set(await bearer(person))
        .expect(200);
    }
  });

  it('says a tenant has never been carried rather than answering emptily', async () => {
    const quiet = await context.seedTenant('Initech');
    const admin = await member(quiet, 'admin');

    const response = await askFor(quiet, '2026-08-01', '2026-08-31')
      .set(await bearer(admin))
      .expect(200);

    expect(response.body).toEqual({ state: 'never-exported' });
  });

  it('answers a quiet period with no entries, not with a refusal', async () => {
    const admin = await member(acme, 'admin');

    const response = await askFor(acme, '2026-07-01', '2026-07-31')
      .set(await bearer(admin))
      .expect(200);

    expect(response.body).toEqual({
      state: 'answered',
      completeThrough: CARRIED_THROUGH.toISOString(),
      entries: [],
    });
  });

  describe('the period, refused before anything is read', () => {
    it('refuses a question naming no period at all', async () => {
      const admin = await member(acme, 'admin');

      await request(app.getHttpServer())
        .get(`/tenants/${acme}/analytics/movements`)
        .set(await bearer(admin))
        .expect(400);
    });

    it('refuses a day that is not written as a day', async () => {
      const admin = await member(acme, 'admin');

      await askFor(acme, 'last-tuesday', '2026-08-31')
        .set(await bearer(admin))
        .expect(400);
    });

    it('refuses a day that is not on the calendar', async () => {
      const admin = await member(acme, 'admin');

      await askFor(acme, '2026-02-30', '2026-03-31')
        .set(await bearer(admin))
        .expect(400);
    });

    it('refuses a period that ends before it starts', async () => {
      const admin = await member(acme, 'admin');

      await askFor(acme, '2026-08-31', '2026-08-01')
        .set(await bearer(admin))
        .expect(400);
    });

    it('refuses a period longer than the platform answers, and says how long that is', async () => {
      const admin = await member(acme, 'admin');

      const response = await askFor(acme, '2026-01-01', '2027-06-01')
        .set(await bearer(admin))
        .expect(400);

      expect(JSON.stringify(response.body)).toContain(
        String(LONGEST_PERIOD_DAYS),
      );
    });

    it('refuses a parameter nobody declared', async () => {
      const admin = await member(acme, 'admin');

      await request(app.getHttpServer())
        .get(
          `/tenants/${acme}/analytics/movements?from=2026-08-01&to=2026-08-31&tenantId=${globex}`,
        )
        .set(await bearer(admin))
        .expect(400);
    });
  });

  /**
   * 404, not 401, and it is the platform's rule rather than this route's: a
   * caller who could tell "you may not" from "there is no such tenant" could
   * confirm a tenant identifier exists, which is a cross-tenant disclosure
   * through the error channel. Analytics is not an exception to it.
   */
  it('answers a caller with no credential as for a tenant that is not there', async () => {
    await askFor(acme, '2026-08-01', '2026-08-31').expect(404);
  });
});
