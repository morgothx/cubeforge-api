import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { loadInventoryThrottlingConfig } from '../../src/adapters/http/inventory-throttling';
import {
  addMember,
  bearerFor,
  body,
  createApplication,
  seedTenantWithAdministrator,
  type SeededTenant,
} from './support/application';
import { useIntegrationDatabase } from './support/fixtures';

const ALLOWANCE = loadInventoryThrottlingConfig(process.env);

/**
 * The allowance, and who it is counted against.
 *
 * Per credential rather than per tenant, so an integration that loops cannot
 * silence an unrelated one beside it — and per credential rather than per
 * origin, because a warehouse system and a point-of-sale can sit behind one
 * address and are not one caller.
 */
// Every test here spends a whole allowance: sixty real HTTP requests, and the
// sign-in one additionally pays for an Argon2 hash so that a missing account is
// not faster than a present one. That is seconds of honest work, and it sat just
// under Jest's five-second default only while the machine was quiet. Given the
// time it needs rather than made to look fast.
jest.setTimeout(60_000);

describe('the inventory allowance', () => {
  useIntegrationDatabase();

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
    acme = await seedTenantWithAdministrator(app, 'Acme');
  });

  const read = (headers: Record<string, string>) =>
    request(server())
      .get(`/tenants/${acme.id}/inventory/products`)
      .set(headers);

  async function exhaust(headers: Record<string, string>): Promise<number> {
    let status = 200;
    for (
      let attempt = 0;
      attempt <= ALLOWANCE.requestsPerCredential;
      attempt += 1
    ) {
      status = (await read(headers)).status;
      if (status === 429) return status;
    }
    return status;
  }

  it('lets a caller through until the allowance is spent', async () => {
    expect(await exhaust(acme.headers)).toBe(429);
  });

  it('tells a refused caller how long to wait', async () => {
    // The one thing a throttled integration has to be told. Without it a caller
    // cannot tell "slow down" from "broken", and will either give up or hammer.
    await exhaust(acme.headers);

    const refused = await read(acme.headers);
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBeDefined();
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  /** A second credential inside the same tenant. */
  async function anotherEditor(): Promise<Record<string, string>> {
    const editor = await addMember(
      app,
      acme,
      'second-editor@acme.example.com',
      'editor',
    );
    return bearerFor(editor.personId);
  }

  it('counts a second credential in the same tenant separately', async () => {
    // The reason the bucket is the credential and not the tenant. Two
    // integrations in one tenant are two callers, and one exhausting itself
    // must not look, to the other, like an outage.
    //
    // Two members of *one* tenant, deliberately: two tenants would differ in
    // both respects at once and could not tell per-credential from per-tenant
    // apart. This is the same suite's first draft, and it proved nothing.
    const second = await anotherEditor();
    await exhaust(acme.headers);

    const unaffected = await request(server())
      .get(`/tenants/${acme.id}/inventory/products`)
      .set(second);

    expect(unaffected.status).toBe(200);
    expect(body(unaffected)).toEqual([]);
  });

  it('records nothing for a request it refused', async () => {
    // A refused request must cost a caller nothing but time: retrying after the
    // stated wait has to lose no data.
    const observer = await anotherEditor();
    await exhaust(acme.headers);

    const refused = await request(server())
      .put(`/tenants/${acme.id}/inventory/products/ACME-002`)
      .set(acme.headers)
      .send({ name: 'Another widget' });
    expect(refused.status).toBe(429);

    // Read back through the other credential, which has its own allowance and
    // has spent none of it.
    const listed = await request(server())
      .get(`/tenants/${acme.id}/inventory/products`)
      .set(observer);
    expect(body(listed)).toEqual([]);
  });

  it('leaves signing in alone', async () => {
    // The buckets are global: without an explicit skip, an inventory limit
    // would count sign-in attempts too, and exhausting one would lock the
    // other. A caller who spent the inventory allowance can still authenticate.
    await exhaust(acme.headers);

    const signIn = await request(server())
      .post('/auth/sign-in')
      .send({ email: 'nobody@example.com', password: 'wrong-but-well-formed' });

    expect(signIn.status).not.toBe(429);
  });
});
