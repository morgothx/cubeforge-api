import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Logger, type INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { loadAnalyticsConfig } from '../../src/adapters/analytics/analytics-config';
import { AthenaAnalytics } from '../../src/adapters/analytics/athena-analytics';
import { TENANT_SCOPED_ANALYTICS } from '../../src/application/ports/tenant-scoped-analytics';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../../src/application/ports/tenant-scoped-unit-of-work';
import { day, periodFrom } from '../../src/domain/analytics/period';
import { tenantId } from '../../src/domain/identifiers';
import { useAnalyticalStore } from './support/analytics';
import {
  addMember,
  bearerFor,
  createApplication,
  seedTenantWithAdministrator,
  type SeededTenant,
} from './support/application';
import { useIntegrationDatabase } from './support/fixtures';

// One application built per describe below, each asking a polled engine.
jest.setTimeout(60_000);

const AUGUST = '?from=2026-08-01&to=2026-08-31';

/** A port nothing is listening on, which is what "unreachable" means here. */
const NOWHERE = 'http://localhost:4599';

/**
 * Volatile by design, and excluded from any comparison: a correlation
 * identifier differs per request precisely so two requests can be told apart in
 * the log, and the date moves on its own.
 */
const VOLATILE = new Set(['date', 'x-correlation-id', 'etag']);

function comparable(response: Response): unknown {
  return {
    status: response.status,
    body: response.body as unknown,
    headers: Object.fromEntries(
      Object.entries(response.headers as Record<string, string>).filter(
        ([name]) => !VOLATILE.has(name),
      ),
    ),
  };
}

/**
 * What the route does when the caller may not ask, or when nothing can answer.
 *
 * The adapter's own suites prove the statements. This one is about the edge:
 * who is admitted, what a refusal discloses, and — the assertion that took the
 * most arranging — that a question the analytical store cannot answer does not
 * quietly fall back to the transactional database instead.
 */
describe('asking analytically when the answer will not come', () => {
  useIntegrationDatabase();
  useAnalyticalStore();

  let app: INestApplication<App>;
  let acme: SeededTenant;
  let globex: SeededTenant;

  beforeAll(async () => {
    app = await createApplication();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    acme = await seedTenantWithAdministrator(app, `Acme-${randomUUID()}`);
    globex = await seedTenantWithAdministrator(app, `Globex-${randomUUID()}`);
  });

  const ask = (tenant: string) =>
    request(app.getHttpServer()).get(
      `/tenants/${tenant}/analytics/movements${AUGUST}`,
    );

  describe('who may ask', () => {
    it('admits an administrator, an editor and a viewer alike', async () => {
      for (const role of ['editor', 'viewer'] as const) {
        const member = await addMember(
          app,
          acme,
          `${role}-${randomUUID()}@acme.example.com`,
          role,
        );

        await ask(acme.id)
          .set(await bearerFor(member.personId))
          .expect(200);
      }

      await ask(acme.id).set(acme.headers).expect(200);
    });

    /**
     * Three different causes, one response.
     *
     * A person with no standing here, a person whose membership was revoked,
     * and a tenant that does not exist. Telling them apart would let a caller
     * confirm that a tenant is real, or that they were once in it — the
     * cross-tenant leak the platform refuses to make through data, arriving
     * instead through the error channel.
     */
    it('answers no membership, a revoked one and no such tenant with the same bytes', async () => {
      const revoked = await addMember(
        app,
        acme,
        `leaver-${randomUUID()}@acme.example.com`,
        'viewer',
      );
      await request(app.getHttpServer())
        .delete(`/tenants/${acme.id}/members/${revoked.membershipId}`)
        .set(acme.headers)
        .expect(204);

      const noStanding = await ask(acme.id).set(
        await bearerFor(globex.administrator),
      );
      const wasAMember = await ask(acme.id).set(
        await bearerFor(revoked.personId),
      );
      const noSuchTenant = await ask(randomUUID()).set(acme.headers);

      expect(comparable(wasAMember)).toEqual(comparable(noStanding));
      expect(comparable(noSuchTenant)).toEqual(comparable(noStanding));
      expect(noStanding.status).toBe(404);
      expect(noStanding.body).toEqual({
        statusCode: 404,
        message: 'the requested record does not exist',
      });
    });

    it('names no tenant and no record when it refuses', async () => {
      const refused = await ask(acme.id).set(
        await bearerFor(globex.administrator),
      );

      const said = JSON.stringify([refused.body, refused.headers]);
      expect(said).not.toContain(acme.id);
      expect(said).not.toContain(globex.id);
      expect(said).not.toContain(globex.administrator);
    });
  });

  describe('when the store cannot be reached', () => {
    let unreachable: INestApplication<App>;
    let tenant: SeededTenant;

    beforeAll(async () => {
      // A real adapter pointed at a port nothing is listening on, rather than a
      // stub that throws. The classification being exercised reads the status
      // an actual refusal came back with, and a stub would be asserting that
      // this test can construct the error it expects.
      unreachable = await createApplication([
        {
          token: TENANT_SCOPED_ANALYTICS,
          value: new AthenaAnalytics(
            loadAnalyticsConfig({
              ...process.env,
              AWS_ENDPOINT_URL: NOWHERE,
            }),
          ),
        },
      ]);
    });

    afterAll(async () => {
      await unreachable.close();
    });

    beforeEach(async () => {
      tenant = await seedTenantWithAdministrator(
        unreachable,
        `Unreachable-${randomUUID()}`,
      );
    });

    const askThere = () =>
      request(unreachable.getHttpServer()).get(
        `/tenants/${tenant.id}/analytics/movements${AUGUST}`,
      );

    it('reports the answer unavailable rather than broken', async () => {
      const response = await askThere().set(tenant.headers).expect(503);

      expect(response.body).toEqual({
        statusCode: 503,
        message: 'the answer is unavailable',
        reason: 'store-unreachable',
      });
    });

    /**
     * The one this task exists for, asserted rather than reasoned about.
     *
     * A tenant transaction is the only way anything on this platform reaches
     * tenant-owned rows, so counting them counts consultations of the
     * transactional database exactly. Authorization opens one — resolving a
     * membership is what decides whether the caller may ask at all — and a
     * route that answers from PostgreSQL opens a second.
     *
     * An analytical request must open **only the first**, whether its question
     * succeeds or the store cannot be reached. The stock route below is the
     * positive control: without it, an instrument that counted nothing would
     * satisfy every assertion here for the same reason a broken thermometer
     * reports a steady temperature.
     */
    it('opens no tenant transaction beyond the one that authorizes the caller', async () => {
      const opened = await transactionsDuring(unreachable, () =>
        askThere().set(tenant.headers).expect(503),
      );

      expect(opened).toBe(1);
    });

    it('opens no more when the question succeeds', async () => {
      const opened = await transactionsDuring(app, () =>
        ask(acme.id).set(acme.headers).expect(200),
      );

      expect(opened).toBe(1);
    });

    it('counts the second one when a route does answer from the database', async () => {
      const opened = await transactionsDuring(app, () =>
        request(app.getHttpServer())
          .get(`/tenants/${acme.id}/inventory/stock`)
          .set(acme.headers)
          .expect(200),
      );

      // Authorization's, and the use case's. This is what the analytical route
      // must not have, and what proves the count above is a measurement.
      expect(opened).toBe(2);
    });

    it('discloses no statement, no location and no credential', async () => {
      const response = await askThere().set(tenant.headers).expect(503);

      // The list of forbidden strings first, and then the reason the list is
      // not enough on its own: a probe that appended the driver's wording to
      // the body passed every one of them, because "connect ECONNREFUSED
      // 127.0.0.1:4599" happens to contain none of these. Naming what may
      // appear is the assertion; naming what may not is a guess about which
      // words a library chose.
      const said = JSON.stringify([response.body, response.headers]);
      expect(said).not.toContain('SELECT');
      expect(said).not.toContain('movements');
      expect(said).not.toContain('s3://');
      expect(said).not.toContain(process.env.AWS_ACCESS_KEY_ID ?? 'test');
      expect(said).not.toContain(process.env.ANALYTICS_DATABASE ?? 'cubeforge');

      expect(Object.keys(response.body as object).sort()).toEqual([
        'message',
        'reason',
        'statusCode',
      ]);
      // And the one field that says anything is a word from a closed set this
      // repository wrote, which is what makes it safe to hand back at all.
      expect((response.body as { reason: string }).reason).toBe(
        'store-unreachable',
      );
    });

    it('files the failure against the correlation identifier of the request', async () => {
      const logged: string[] = [];
      const recorded = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((message: unknown) => {
          logged.push(String(message));
        });

      let correlation: string;
      try {
        const response = await askThere().set(tenant.headers).expect(503);
        correlation = String(response.headers['x-correlation-id']);
      } finally {
        recorded.mockRestore();
      }

      expect(correlation).not.toBe('undefined');
      expect(logged.some((line) => line.includes(correlation))).toBe(true);
      // The class of problem reaches the log too, because the response does not
      // carry the cause and an operator has to be able to find it.
      expect(logged.some((line) => line.includes('store-unreachable'))).toBe(
        true,
      );
    });
  });

  describe('when the question outlives its deadline', () => {
    /**
     * Proven at the adapter rather than through the route, because the route's
     * budget is fixed at thirty seconds and a suite is not going to wait for it.
     * The behaviour is the runner's either way: the deadline passes, the engine
     * is asked to stop, and the caller is told which of the two things happened.
     */
    it('stops waiting and says that is what it did', async () => {
      const impatient = new AthenaAnalytics(
        loadAnalyticsConfig(process.env),
        0,
      );
      const { id } = await seedTenantWithAdministrator(
        app,
        `Impatient-${randomUUID()}`,
      );

      const refusal = await impatient
        .askAs(tenantId(id), (q) =>
          q.movementsByDay(periodFrom(day('2026-08-01'), day('2026-08-31'))),
        )
        .then(() => null)
        .catch((error: unknown) => error as { reason?: string });
      impatient.close();

      expect(refusal?.reason).toBe('question-timed-out');
    });
  });
});

/**
 * How many tenant transactions the application opens while `work` runs.
 *
 * Counted on the real unit of work the running application holds, so nothing is
 * substituted and nothing is inferred from timing. An earlier version of this
 * read PostgreSQL's own scan counters instead and reported that a route whose
 * whole job is to sum `stock_movements` had not touched it — the statistics are
 * flushed per backend on a schedule that a request-shaped window does not see.
 * The positive control is what caught that, and it is why there is one.
 */
async function transactionsDuring(
  app: INestApplication<App>,
  work: () => Promise<unknown>,
): Promise<number> {
  const unitOfWork = app.get<TenantScopedUnitOfWork>(
    TENANT_SCOPED_UNIT_OF_WORK,
  );
  const opened = jest.spyOn(unitOfWork, 'runInTenant');

  try {
    await work();
    return opened.mock.calls.length;
  } finally {
    opened.mockRestore();
  }
}
