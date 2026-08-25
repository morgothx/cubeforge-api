// First, and deliberately. `class-transformer`'s `@Type` calls
// `Reflect.getMetadata` while the DTO module is being evaluated, and this file
// imports that module directly rather than reaching it through Nest — which is
// what loads the shim in the running application.
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { LONGEST_BATCH } from '../../src/adapters/http/dto/inventory-movements.dto';
import {
  body,
  createApplication,
  seedTenantWithAdministrator,
  type SeededTenant,
} from './support/application';
import { useIntegrationDatabase } from './support/fixtures';

interface Report {
  readonly recorded: number;
  readonly alreadyRecorded: number;
  readonly rejected: number;
  readonly outcomes: readonly {
    readonly status: string;
    readonly externalId: string | null;
    readonly reason?: string;
  }[];
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
 * What a caller actually receives.
 *
 * The use case is tested with doubles and answers all of this already. What
 * only a real request can show is that the report survives the edge intact —
 * that a rejected row arrives as a row rather than as a failed request, which
 * is the single distinction this whole feature is built around.
 */
describe('recording movements over HTTP', () => {
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
    await request(server())
      .put(`/tenants/${acme.id}/inventory/products/ACME-001`)
      .set(acme.headers)
      .send({ name: 'A widget' })
      .expect(200);
    await request(server())
      .put(`/tenants/${acme.id}/inventory/locations/WH-1`)
      .set(acme.headers)
      .send({ name: 'Main warehouse' })
      .expect(200);
  });

  const submit = (movements: unknown[]) =>
    request(server())
      .post(`/tenants/${acme.id}/inventory/movements/batch`)
      .set(acme.headers)
      .send({ movements });

  it('answers a clean batch with one outcome per row', async () => {
    const response = await submit([
      movement({ externalId: 'ERP-1' }),
      movement({ externalId: 'ERP-2' }),
    ]);

    expect(response.status).toBe(200);
    expect(body<Report>(response)).toEqual({
      recorded: 2,
      alreadyRecorded: 0,
      rejected: 0,
      outcomes: [
        { status: 'recorded', externalId: 'ERP-1' },
        { status: 'recorded', externalId: 'ERP-2' },
      ],
    });
  });

  it('answers a partly bad batch with 200 and the rejections in the body', async () => {
    // The distinction the feature exists for. A rejected row is a row, not a
    // failed request, and a caller that only looked at the status would see
    // success — which is why the response cannot be shorter than what was sent.
    const response = await submit([
      movement({ externalId: 'ERP-1' }),
      movement({ externalId: 'ERP-2', sku: 'NOT-DECLARED' }),
      movement({ externalId: 'ERP-3', quantity: 0 }),
    ]);

    expect(response.status).toBe(200);
    expect(body<Report>(response).outcomes).toEqual([
      { status: 'recorded', externalId: 'ERP-1' },
      { status: 'rejected', externalId: 'ERP-2', reason: 'unknown-sku' },
      { status: 'rejected', externalId: 'ERP-3', reason: 'quantity-zero' },
    ]);
  });

  it('tells a retry apart from a first submission', async () => {
    await submit([movement({ externalId: 'ERP-1' })]);

    const again = await submit([movement({ externalId: 'ERP-1' })]);

    expect(body<Report>(again)).toMatchObject({
      recorded: 0,
      alreadyRecorded: 1,
      outcomes: [{ status: 'already-recorded', externalId: 'ERP-1' }],
    });
  });

  it('refuses a batch that is too large, whole', async () => {
    // Not five hundred and one rejections. A size refusal is fixed by sending
    // fewer rows and a data problem by fixing rows, and a caller must not have
    // to work out which it was.
    const response = await submit(
      Array.from({ length: LONGEST_BATCH + 1 }, (_, at) =>
        movement({ externalId: `ERP-${at}` }),
      ),
    );

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('500');
  });

  it('records nothing at all when the batch was refused for its size', async () => {
    await submit(
      Array.from({ length: LONGEST_BATCH + 1 }, (_, at) =>
        movement({ externalId: `ERP-${at}` }),
      ),
    );

    // Proven by what happens next: `ERP-0` was in the refused batch, and it
    // records as new. Had the batch been partly applied, it would come back
    // `already-recorded` instead.
    const after = await submit([movement({ externalId: 'ERP-0' })]);
    expect(body<Report>(after).outcomes).toEqual([
      { status: 'recorded', externalId: 'ERP-0' },
    ]);
  });

  it('refuses a payload that is not one, without partial anything', async () => {
    const response = await request(server())
      .post(`/tenants/${acme.id}/inventory/movements/batch`)
      .set(acme.headers)
      .send({ movements: [{ externalId: 'ERP-1', quantity: 'five' }] });

    expect(response.status).toBe(400);
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    const response = await request(server())
      .post(`/tenants/${acme.id}/inventory/movements/batch`)
      .set(acme.headers)
      .send({ movements: [movement({ cost: 12 })] });

    expect(response.status).toBe(400);
  });

  it('records one movement on the single route, reporting the same shapes', async () => {
    const first = await request(server())
      .post(`/tenants/${acme.id}/inventory/movements`)
      .set(acme.headers)
      .send(movement({ externalId: 'ERP-SINGLE' }));

    expect(first.status).toBe(200);
    expect(body(first)).toEqual({
      status: 'recorded',
      externalId: 'ERP-SINGLE',
    });

    const again = await request(server())
      .post(`/tenants/${acme.id}/inventory/movements`)
      .set(acme.headers)
      .send(movement({ externalId: 'ERP-SINGLE' }));

    expect(body(again)).toEqual({
      status: 'already-recorded',
      externalId: 'ERP-SINGLE',
    });
  });

  it('rejects one movement on the single route with a named reason', async () => {
    const response = await request(server())
      .post(`/tenants/${acme.id}/inventory/movements`)
      .set(acme.headers)
      .send(movement({ kind: 'transfer' }));

    // Still 200: the request was understood and answered. What failed is the
    // movement, and it says so.
    expect(response.status).toBe(200);
    expect(body(response)).toEqual({
      status: 'rejected',
      externalId: 'ERP-1',
      reason: 'unknown-kind',
    });
  });

  it('names no record in any rejection', async () => {
    const response = await submit([
      movement({ externalId: 'ERP-1', sku: 'SOMEBODY-ELSES' }),
    ]);

    const [outcome] = body<Report>(response).outcomes;
    expect(outcome?.reason).toBe('unknown-sku');
    // The reason is a member of a closed set and mentions nothing about where
    // the SKU might exist.
    expect(JSON.stringify(outcome)).not.toContain('tenant');
  });

  it('reports the stock that the recorded movements add up to', async () => {
    await submit([
      movement({ externalId: 'ERP-IN', kind: 'receipt', quantity: 10 }),
      movement({ externalId: 'ERP-OUT', kind: 'sale', quantity: -4 }),
      // Rejected, and therefore absent from the total. A row that was refused
      // must not reach the sum, which is the one way a partial batch could
      // still corrupt the answer.
      movement({ externalId: 'ERP-BAD', sku: 'NOT-DECLARED', quantity: 999 }),
    ]);

    const response = await request(server())
      .get(`/tenants/${acme.id}/inventory/stock`)
      .set(acme.headers);

    expect(response.status).toBe(200);
    expect(body(response)).toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: 6 },
    ]);
  });

  it('reports nothing for a tenant that has recorded nothing', async () => {
    const empty = await seedTenantWithAdministrator(app, 'Empty');

    const response = await request(server())
      .get(`/tenants/${empty.id}/inventory/stock`)
      .set(empty.headers);

    expect(response.status).toBe(200);
    expect(body(response)).toEqual([]);
  });
});
