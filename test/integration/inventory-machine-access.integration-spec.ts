import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  body,
  createApplication,
  seedTenantWithAdministrator,
  type Role,
  type SeededTenant,
} from './support/application';
import { useIntegrationDatabase } from './support/fixtures';

interface IssuedKey {
  readonly id: string;
  readonly secret: string;
}

/**
 * The machine path, travelled for the first time.
 *
 * `machines: true` was designed, built, unit-tested and never used: the
 * declaration model has carried it since the authorization feature, and until
 * inventory no shipped route set it. **An untravelled path is an untested one
 * however green its unit tests are**, so every inventory route is exercised
 * here with a real key rather than with a person's token.
 *
 * The refusals are all 404. That is deliberate platform-wide — refusal must be
 * indistinguishable from absence — and it means a status can rarely say *why*
 * something was refused. Where the reason matters, it is established by what
 * did or did not change rather than by the code.
 */
describe('inventory, reached by a machine', () => {
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

  async function issueKey(
    tenant: SeededTenant,
    role: Role = 'editor',
  ): Promise<IssuedKey> {
    const issued = await request(server())
      .post(`/tenants/${tenant.id}/api-keys`)
      .set(tenant.headers)
      .send({ label: `sync-${role}`, role });
    if (issued.status !== 201) {
      throw new Error(`issuing a key failed with ${issued.status}`);
    }
    return body<IssuedKey>(issued);
  }

  const asKey = (key: IssuedKey) => ({ 'x-api-key': key.secret });

  const movement = (overrides: Record<string, unknown> = {}) => ({
    externalId: 'ERP-1',
    sku: 'ACME-001',
    location: 'WH-1',
    kind: 'receipt',
    quantity: 5,
    occurredAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  });

  /** Every route, as one caller would reach them. */
  function surface(tenantId: string, headers: Record<string, string>) {
    const base = `/tenants/${tenantId}/inventory`;
    return {
      declareProduct: () =>
        request(server())
          .put(`${base}/products/ACME-001`)
          .set(headers)
          .send({ name: 'A widget' }),
      listProducts: () =>
        request(server()).get(`${base}/products`).set(headers),
      declareLocation: () =>
        request(server())
          .put(`${base}/locations/WH-1`)
          .set(headers)
          .send({ name: 'Main warehouse' }),
      listLocations: () =>
        request(server()).get(`${base}/locations`).set(headers),
      recordOne: () =>
        request(server())
          .post(`${base}/movements`)
          .set(headers)
          .send(movement()),
      recordMany: () =>
        request(server())
          .post(`${base}/movements/batch`)
          .set(headers)
          .send({ movements: [movement({ externalId: 'ERP-BATCH' })] }),
      readStock: () => request(server()).get(`${base}/stock`).set(headers),
    };
  }

  beforeEach(async () => {
    acme = await seedTenantWithAdministrator(app, 'Acme');
  });

  it('lets an editor key reach every route', async () => {
    const key = await issueKey(acme, 'editor');
    const routes = surface(acme.id, asKey(key));

    expect((await routes.declareProduct()).status).toBe(200);
    expect((await routes.declareLocation()).status).toBe(200);
    expect((await routes.recordOne()).status).toBe(200);
    expect((await routes.recordMany()).status).toBe(200);
    expect((await routes.listProducts()).status).toBe(200);
    expect((await routes.listLocations()).status).toBe(200);
    expect((await routes.readStock()).status).toBe(200);
  });

  it('synchronises end to end and derives the stock from it', async () => {
    // The whole point of the feature, done the way the integration it was built
    // for would do it: declare, push, read back.
    const key = await issueKey(acme, 'editor');
    const routes = surface(acme.id, asKey(key));
    await routes.declareProduct();
    await routes.declareLocation();

    const pushed = await request(server())
      .post(`/tenants/${acme.id}/inventory/movements/batch`)
      .set(asKey(key))
      .send({
        movements: [
          movement({ externalId: 'ERP-1', kind: 'receipt', quantity: 10 }),
          movement({ externalId: 'ERP-2', kind: 'sale', quantity: -4 }),
        ],
      });
    expect(body<{ recorded: number }>(pushed).recorded).toBe(2);

    const stock = await routes.readStock();
    expect(body(stock)).toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: 6 },
    ]);
  });

  it('refuses a viewer key every write and grants it every read', async () => {
    // Refused by the **guard**, from the route's declaration. The use cases
    // enforce their own roles as well, and that second layer cannot be seen
    // from here — a request refused at the edge never reaches it. Widening a
    // use case's roles leaves every assertion in this file green, and turns the
    // application-tier suite red instead. Same shape as a repository predicate
    // behind a row-level security policy: whichever layer answers first hides
    // the other.
    const viewer = await issueKey(acme, 'viewer');
    const editor = await issueKey(acme, 'editor');
    await surface(acme.id, asKey(editor)).declareProduct();
    await surface(acme.id, asKey(editor)).declareLocation();
    const routes = surface(acme.id, asKey(viewer));

    expect((await routes.declareProduct()).status).toBe(404);
    expect((await routes.declareLocation()).status).toBe(404);
    expect((await routes.recordOne()).status).toBe(404);
    expect((await routes.recordMany()).status).toBe(404);

    expect((await routes.listProducts()).status).toBe(200);
    expect((await routes.listLocations()).status).toBe(200);
    expect((await routes.readStock()).status).toBe(200);
  });

  it('leaves nothing behind when it refuses a viewer key a write', async () => {
    // The refusal has to be a refusal, not a write reported as one. A 404 alone
    // cannot say which, so the catalogue answers instead.
    const editor = await issueKey(acme, 'editor');
    const viewer = await issueKey(acme, 'viewer');

    await request(server())
      .put(`/tenants/${acme.id}/inventory/products/SNEAKY`)
      .set(asKey(viewer))
      .send({ name: 'Should not exist' });

    const listed = await surface(acme.id, asKey(editor)).listProducts();
    expect(body(listed)).toEqual([]);
  });

  it("gains nothing by presenting a key against another tenant's inventory", async () => {
    const globex = await seedTenantWithAdministrator(app, 'Globex');
    const key = await issueKey(acme, 'editor');

    const trespass = await surface(globex.id, asKey(key)).declareProduct();

    expect(trespass.status).toBe(404);
    // Not merely refused: nothing was written into Globex, and the answer is
    // the same one an unrecognised key would get.
    const listed = await request(server())
      .get(`/tenants/${globex.id}/inventory/products`)
      .set(globex.headers);
    expect(body(listed)).toEqual([]);
  });

  it('refuses a caller presenting no credential at all', async () => {
    const routes = surface(acme.id, {});

    for (const call of Object.values(routes)) {
      expect((await call()).status).toBe(404);
    }
  });

  it('refuses a key that was revoked', async () => {
    const key = await issueKey(acme, 'editor');
    expect((await surface(acme.id, asKey(key)).listProducts()).status).toBe(
      200,
    );

    await request(server())
      .delete(`/tenants/${acme.id}/api-keys/${key.id}`)
      .set(acme.headers)
      .expect(204);

    expect((await surface(acme.id, asKey(key)).listProducts()).status).toBe(
      404,
    );
  });
});
