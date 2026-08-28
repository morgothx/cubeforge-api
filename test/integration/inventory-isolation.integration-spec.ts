// First, and deliberately — see the note in `inventory-http`: importing a
// DTO module directly rather than through Nest is what leaves the shim unloaded.
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  body,
  createApplication,
  seedTenantWithAdministrator,
  type SeededTenant,
} from './support/application';
import { useIntegrationDatabase } from './support/fixtures';

interface CatalogueEntry {
  readonly code: string;
  readonly name: string;
}

interface StockLevel {
  readonly sku: string;
  readonly location: string;
  readonly onHand: number;
}

interface Outcome {
  readonly status: string;
  readonly externalId: string | null;
  readonly reason?: string;
}

interface Report {
  readonly recorded: number;
  readonly alreadyRecorded: number;
  readonly rejected: number;
  readonly outcomes: readonly Outcome[];
}

function movement(overrides: Record<string, unknown> = {}) {
  return {
    externalId: 'ERP-1',
    sku: 'ACME-001',
    location: 'WH-1',
    kind: 'receipt',
    quantity: 5,
    occurredAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * What one tenant can perceive of another: nothing, including the fact that
 * there is another.
 *
 * Isolation is asserted elsewhere for the tables and for the guard. What only
 * this feature can put under test is the shape isolation takes when two tenants
 * legitimately use the *same* words — the same SKU, the same source-system
 * identifier — because that is where a leak stops looking like a leak and
 * starts looking like a sensible uniqueness rule.
 */
describe('one tenant perceiving another', () => {
  useIntegrationDatabase();

  let app: INestApplication<App>;
  let acme: SeededTenant;
  let rival: SeededTenant;

  beforeAll(async () => {
    app = await createApplication();
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  const declareProduct = (
    tenant: SeededTenant,
    sku: string,
    name: string,
  ): Promise<unknown> =>
    request(server())
      .put(`/tenants/${tenant.id}/inventory/products/${sku}`)
      .set(tenant.headers)
      .send({ name })
      .expect(200);

  const declareLocation = (
    tenant: SeededTenant,
    code: string,
    name: string,
  ): Promise<unknown> =>
    request(server())
      .put(`/tenants/${tenant.id}/inventory/locations/${code}`)
      .set(tenant.headers)
      .send({ name })
      .expect(200);

  const submit = (tenant: SeededTenant, movements: unknown[]) =>
    request(server())
      .post(`/tenants/${tenant.id}/inventory/movements/batch`)
      .set(tenant.headers)
      .send({ movements });

  beforeEach(async () => {
    acme = await seedTenantWithAdministrator(app, 'Acme');
    rival = await seedTenantWithAdministrator(app, 'Rival');

    // The same SKU and the same place code in both tenants, standing for
    // unrelated things. Requirement 1.3 in the only form that can fail.
    await declareProduct(acme, 'ACME-001', 'A widget');
    await declareProduct(rival, 'ACME-001', 'A completely different widget');
    await declareLocation(acme, 'WH-1', 'Acme main warehouse');
    await declareLocation(rival, 'WH-1', 'Rival main warehouse');
  });

  it('gives each tenant its own meaning for the same SKU', async () => {
    const mine = await request(server())
      .get(`/tenants/${acme.id}/inventory/products`)
      .set(acme.headers);
    const theirs = await request(server())
      .get(`/tenants/${rival.id}/inventory/products`)
      .set(rival.headers);

    expect(body<CatalogueEntry[]>(mine)).toHaveLength(1);
    expect(body<CatalogueEntry[]>(theirs)).toHaveLength(1);
    expect(body<CatalogueEntry[]>(mine)[0]?.name).toBe('A widget');
    expect(body<CatalogueEntry[]>(theirs)[0]?.name).toBe(
      'A completely different widget',
    );
  });

  it('adds up each tenant’s movements without the other’s', async () => {
    await submit(acme, [
      movement({ externalId: 'ACME-IN', quantity: 10 }),
      movement({ externalId: 'ACME-OUT', kind: 'sale', quantity: -4 }),
    ]);
    await submit(rival, [movement({ externalId: 'RIVAL-IN', quantity: 999 })]);

    const mine = await request(server())
      .get(`/tenants/${acme.id}/inventory/stock`)
      .set(acme.headers);

    // Same SKU, same location code, and the totals must not have met.
    expect(body<StockLevel[]>(mine)).toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: 6 },
    ]);
  });

  it('answers for someone else’s product exactly as for one that exists nowhere', async () => {
    await declareProduct(rival, 'RIVAL-ONLY', 'Theirs alone');

    const response = await submit(acme, [
      movement({ externalId: 'ERP-ELSEWHERE', sku: 'RIVAL-ONLY' }),
      movement({ externalId: 'ERP-NOWHERE', sku: 'NOWHERE-AT-ALL' }),
    ]);

    const [elsewhere, nowhere] = body<Report>(response).outcomes;
    // Compared to *each other*, not to an expected string. An assertion against
    // a literal stays green when both answers change together; this one is the
    // property itself, and it fails the moment the two paths diverge — which is
    // exactly how the disclosure would appear.
    expect({ ...elsewhere, externalId: null }).toEqual({
      ...nowhere,
      externalId: null,
    });
    expect(elsewhere?.status).toBe('rejected');
  });

  it('answers for someone else’s location exactly as for one that exists nowhere', async () => {
    await declareLocation(rival, 'RIVAL-DOCK', 'Theirs alone');

    const response = await submit(acme, [
      movement({ externalId: 'ERP-ELSEWHERE', location: 'RIVAL-DOCK' }),
      movement({ externalId: 'ERP-NOWHERE', location: 'NOWHERE-AT-ALL' }),
    ]);

    const [elsewhere, nowhere] = body<Report>(response).outcomes;
    expect({ ...elsewhere, externalId: null }).toEqual({
      ...nowhere,
      externalId: null,
    });
    expect(elsewhere?.status).toBe('rejected');
  });

  it('leaves another tenant’s catalogue unchanged when a reference is refused', async () => {
    await submit(acme, [movement({ sku: 'RIVAL-ONLY' })]);

    // A refusal must not have been a lookup that created anything, in either
    // direction: Acme gained no product, and Rival's catalogue is untouched.
    const mine = await request(server())
      .get(`/tenants/${acme.id}/inventory/products`)
      .set(acme.headers);
    const theirs = await request(server())
      .get(`/tenants/${rival.id}/inventory/products`)
      .set(rival.headers);

    expect(body<CatalogueEntry[]>(mine).map((entry) => entry.code)).toEqual([
      'ACME-001',
    ]);
    expect(body<CatalogueEntry[]>(theirs).map((entry) => entry.code)).toEqual([
      'ACME-001',
    ]);
  });

  it('records a movement whose source identifier another tenant already used', async () => {
    const theirs = await submit(rival, [movement({ externalId: 'ERP-77' })]);
    expect(body<Report>(theirs).recorded).toBe(1);

    const mine = await submit(acme, [movement({ externalId: 'ERP-77' })]);

    // Not `already-recorded`, and not a rejection. Uniqueness is a property
    // within a tenant; answering anything else here would tell Acme that
    // somebody, somewhere, has already used that identifier — which is the
    // whole of what requirement 7.6 forbids.
    expect(body<Report>(mine).outcomes).toEqual([
      { status: 'recorded', externalId: 'ERP-77' },
    ]);
  });

  it('still tells a tenant apart from itself on a genuine retry', async () => {
    // The guard against fixing 7.6 by never reporting `already-recorded` at
    // all: within one tenant the second submission must still be recognised.
    await submit(acme, [movement({ externalId: 'ERP-77' })]);

    const again = await submit(acme, [movement({ externalId: 'ERP-77' })]);

    expect(body<Report>(again).outcomes).toEqual([
      { status: 'already-recorded', externalId: 'ERP-77' },
    ]);
  });
});
