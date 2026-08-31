import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { loadAnalyticsThrottlingConfig } from '../../src/adapters/http/analytics-throttling';
import { useAnalyticalStore } from './support/analytics';
import {
  addMember,
  bearerFor,
  createApplication,
  seedTenantWithAdministrator,
  type SeededTenant,
} from './support/application';
import { useIntegrationDatabase } from './support/fixtures';

const ALLOWANCE = loadAnalyticsThrottlingConfig(process.env);

const AUGUST = '?from=2026-08-01&to=2026-08-31';

// Every test here spends a whole allowance against a polled engine, and the
// suite arranges a store before any of them run.
jest.setTimeout(60_000);

/**
 * How often one caller may ask (5.5).
 *
 * The registry proves the *arrangement* — that the bucket is registered, that
 * this controller skips every other one, that the limit is read from the
 * environment. None of that is the requirement. The requirement is that an
 * eleventh question in a minute is refused, and until this suite existed
 * nothing on the platform had ever asked twice.
 *
 * The tenants here are never exported, so each question is answered
 * `never-exported` — a real answer, arrived at through the whole route, and the
 * cheapest one the engine can give. What is being counted is questions asked,
 * not rows returned.
 */
describe('the analytical allowance', () => {
  useIntegrationDatabase();
  // The prefixes have to hold something before the engine will answer anything
  // at all; see the fixture for the gap that makes this necessary.
  useAnalyticalStore();

  let app: INestApplication<App>;
  let acme: SeededTenant;

  beforeAll(async () => {
    app = await createApplication();
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  beforeEach(async () => {
    acme = await seedTenantWithAdministrator(app, `Acme-${randomUUID()}`);
  });

  const ask = (headers: Record<string, string>) =>
    request(server())
      .get(`/tenants/${acme.id}/analytics/movements${AUGUST}`)
      .set(headers);

  /** Asks until refused, or until one more than the allowance has gone by. */
  async function exhaust(headers: Record<string, string>): Promise<number> {
    let status = 200;
    for (
      let attempt = 0;
      attempt <= ALLOWANCE.questionsPerCaller;
      attempt += 1
    ) {
      status = (await ask(headers)).status;
      if (status === 429) return status;
    }
    return status;
  }

  it('answers a caller until the allowance is spent', async () => {
    expect(await exhaust(acme.headers)).toBe(429);
  });

  it('tells a refused caller how long to wait', async () => {
    // The library emits `Retry-After-analytics-caller` for a named bucket, and
    // no client in the world honours that. The plain header is the one a
    // dashboard's retry logic already understands, and without it a caller
    // cannot tell "slow down" from "broken".
    await exhaust(acme.headers);

    const refused = await ask(acme.headers);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts a second person in the same tenant separately', async () => {
    // The reason the bucket is the caller and not the tenant. Two people
    // watching one dashboard are two callers, and an eager one must not look,
    // to their colleague, like an outage.
    //
    // Two members of *one* tenant deliberately: two tenants would differ in
    // both respects at once and could not tell per-caller from per-tenant
    // apart.
    const viewer = await addMember(
      app,
      acme,
      `viewer-${randomUUID()}@acme.example.com`,
      'viewer',
    );
    await exhaust(acme.headers);

    const unaffected = await ask(await bearerFor(viewer.personId));

    expect(unaffected.status).toBe(200);
  });
});
