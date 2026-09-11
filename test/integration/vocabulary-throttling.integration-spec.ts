import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { loadAnalyticsThrottlingConfig } from '../../src/adapters/http/analytics-throttling';
import { loadVocabularyThrottlingConfig } from '../../src/adapters/http/vocabulary-throttling';
import {
  addMember,
  bearerFor,
  createApplication,
  seedTenantWithAdministrator,
  type SeededTenant,
} from './support/application';
import { useIntegrationDatabase } from './support/fixtures';

const VOCABULARY = loadVocabularyThrottlingConfig(process.env);
const QUESTIONS = loadAnalyticsThrottlingConfig(process.env);

/**
 * A question the platform refuses before the model is ever consulted.
 *
 * Refused questions are counted all the same — the throttling guard runs before
 * anything reads the body — so spending the question allowance does not need a
 * semantic layer, an export or a catalogue. Nothing in this suite does: which
 * allowance a request spends is decided before any of them could matter.
 */
const A_REFUSED_QUESTION = {
  measures: ['a_measure_nobody_offers'],
  from: '2026-08-01',
  to: '2026-08-31',
};

jest.setTimeout(60_000);

/**
 * The vocabulary's allowance, spent for real.
 *
 * Its arrangement — registered, derived into every other route's skip list,
 * larger than the question allowance — is proven without a request. What only
 * requests can show is that the count is its own: that describing the
 * questions and asking them draw on two allowances, in both directions, and
 * that running out of one says how long to wait.
 */
describe('the vocabulary allowance', () => {
  useIntegrationDatabase();

  let app: INestApplication<App>;
  let acme: SeededTenant;

  const server = () => app.getHttpServer();

  const describeFor = (headers: Record<string, string>) =>
    request(server())
      .get(`/tenants/${acme.id}/analytics/vocabulary`)
      .set(headers);

  const askFor = (headers: Record<string, string>) =>
    request(server())
      .post(`/tenants/${acme.id}/analytics/questions`)
      .set(headers)
      .send(A_REFUSED_QUESTION);

  /** Every status, in order, of `times` requests. */
  async function statuses(
    send: () => request.Test,
    times: number,
  ): Promise<number[]> {
    const seen: number[] = [];
    for (let attempt = 0; attempt < times; attempt += 1) {
      seen.push((await send()).status);
    }
    return seen;
  }

  beforeAll(async () => {
    app = await createApplication();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    acme = await seedTenantWithAdministrator(app, `Acme-${randomUUID()}`);
  });

  it('answers the whole allowance, then refuses and says how long to wait', async () => {
    const answered = await statuses(
      () => describeFor(acme.headers),
      VOCABULARY.requestsPerCaller,
    );
    expect(new Set(answered)).toEqual(new Set([200]));

    const refused = await describeFor(acme.headers);
    expect(refused.status).toBe(429);
    // The plain header, which an ordinary client reads — not the library's
    // per-bucket one, which only a client knowing this platform's bucket names
    // could find.
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('does not refuse a question because the vocabulary allowance ran out', async () => {
    await statuses(
      () => describeFor(acme.headers),
      VOCABULARY.requestsPerCaller + 1,
    );

    const asked = await askFor(acme.headers);

    // Refused, but for naming a measure nobody offers — not for pace.
    expect(asked.status).not.toBe(429);
  });

  it('still describes the vocabulary once the question allowance has run out', async () => {
    const asked = await statuses(
      () => askFor(acme.headers),
      QUESTIONS.questionsPerCaller + 1,
    );
    // The question allowance really was spent, or the next assertion proves
    // nothing about independence.
    expect(asked.at(-1)).toBe(429);

    await describeFor(acme.headers).expect(200);
  });

  it('counts each person separately, even inside one tenant', async () => {
    const viewer = await addMember(
      app,
      acme,
      `viewer-${randomUUID()}@acme.example.com`,
      'viewer',
    );
    await statuses(
      () => describeFor(acme.headers),
      VOCABULARY.requestsPerCaller + 1,
    );

    await describeFor(await bearerFor(viewer.personId)).expect(200);
  });
});
