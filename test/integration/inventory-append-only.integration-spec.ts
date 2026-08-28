// First, and deliberately — see the note in `inventory-http`.
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
import { seed } from './support/database';
import { useIntegrationDatabase } from './support/fixtures';

interface Outcome {
  readonly status: string;
  readonly externalId: string | null;
}

interface Report {
  readonly outcomes: readonly Outcome[];
}

interface StockLevel {
  readonly sku: string;
  readonly location: string;
  readonly onHand: number;
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
 * A history that cannot be rewritten, said three ways.
 *
 * The schema suite already shows the database refusing an update and a delete.
 * That refusal comes from a missing grant, and a missing grant is the first
 * thing to answer — so the *policies* behind it are asserted here directly,
 * where the grant is not standing in front of them. The same shape as every
 * other layered refusal on this platform: whichever layer answers first hides
 * the other.
 *
 * The third way is the one a user would notice: a mistake is corrected by
 * another movement, and both stay visible.
 */
describe('the inventory history, once written', () => {
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

  const submit = (movements: unknown[]) =>
    request(server())
      .post(`/tenants/${acme.id}/inventory/movements/batch`)
      .set(acme.headers)
      .send({ movements });

  const stock = async (): Promise<StockLevel[]> =>
    body<StockLevel[]>(
      await request(server())
        .get(`/tenants/${acme.id}/inventory/stock`)
        .set(acme.headers),
    );

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

  it('grants the application nothing on movements but reading and appending', async () => {
    // Stated positively. Two tests asserting that an update and a delete are
    // refused would both stay green if a third privilege were added tomorrow;
    // this one names the whole set, so anything new has to be argued for here.
    const granted = await seed(async (client) => {
      const result = await client.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'cubeforge_app' AND table_name = 'stock_movements'`,
      );
      return result.rows.map((row) => row.privilege_type).sort();
    });

    expect(granted).toEqual(['INSERT', 'SELECT']);
  });

  it('has no policy that would permit a rewrite even if the grant returned', async () => {
    // The second layer, asserted where nothing stands in front of it. A grant
    // restored by accident — by a migration written by somebody who had not
    // read the first one — would make the schema suite's `permission denied`
    // disappear, and this is what would still refuse.
    const commands = await seed(async (client) => {
      const result = await client.query<{ cmd: string }>(
        `SELECT cmd FROM pg_policies
          WHERE tablename = 'stock_movements'
            AND 'cubeforge_app' = ANY (roles)`,
      );
      return result.rows.map((row) => row.cmd).sort();
    });

    expect(commands).toEqual(['INSERT', 'SELECT']);
    // In particular not `ALL`, which is how the two reference tables are
    // written and would have been the obvious thing to copy.
    expect(commands).not.toContain('ALL');
  });

  it('offers no route that changes or removes a movement', async () => {
    await submit([movement()]);

    // Nothing to guard, because there is nothing to reach. A route that existed
    // and refused would still be a route somebody could later relax.
    //
    // Built one at a time inside the loop, not collected into an array first:
    // supertest binds the server to an ephemeral port when a request is
    // created, and four created at once do not agree on which port that was.
    const attempts: [string, string][] = [
      ['delete', `/tenants/${acme.id}/inventory/movements/ERP-1`],
      ['patch', `/tenants/${acme.id}/inventory/movements/ERP-1`],
      ['delete', `/tenants/${acme.id}/inventory/products/ACME-001`],
      ['delete', `/tenants/${acme.id}/inventory/locations/WH-1`],
    ];

    for (const [method, path] of attempts) {
      const response = await (method === 'delete'
        ? request(server()).delete(path).set(acme.headers)
        : request(server())
            .patch(path)
            .set(acme.headers)
            .send({ quantity: 1 }));
      expect(response.status).toBe(404);
    }
  });

  it('corrects a mistake by offsetting it, keeping both movements', async () => {
    // Fifty received where five arrived, noticed the next day.
    await submit([movement({ externalId: 'ERP-WRONG', quantity: 50 })]);

    await submit([
      movement({
        externalId: 'ERP-CORRECTION',
        kind: 'adjustment',
        quantity: -45,
        occurredAt: '2026-01-02T09:00:00.000Z',
      }),
    ]);

    expect(await stock()).toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: 5 },
    ]);

    // Both still there, and the mistake still says fifty. Reported by the
    // platform rather than read out of the table, because what has to survive
    // is what a reader is told, not what a row happens to hold.
    const rows = await seed(async (client) => {
      const result = await client.query<{
        external_id: string;
        quantity: number;
      }>(
        `SELECT external_id, quantity FROM stock_movements
          WHERE tenant_id = $1 ORDER BY external_id`,
        [acme.id],
      );
      return result.rows;
    });

    expect(rows).toEqual([
      { external_id: 'ERP-CORRECTION', quantity: -45 },
      { external_id: 'ERP-WRONG', quantity: 50 },
    ]);
  });

  it('still knows the mistaken movement, so a retry cannot resurrect it', async () => {
    await submit([movement({ externalId: 'ERP-WRONG', quantity: 50 })]);
    await submit([
      movement({
        externalId: 'ERP-CORRECTION',
        kind: 'adjustment',
        quantity: -45,
        occurredAt: '2026-01-02T09:00:00.000Z',
      }),
    ]);

    // The source system, having noticed its own mistake, sends the original
    // again. It is a retry of something already recorded, not a new movement,
    // and adding fifty a second time would be the worst possible reading.
    const again = await submit([
      movement({ externalId: 'ERP-WRONG', quantity: 50 }),
    ]);

    expect(body<Report>(again).outcomes).toEqual([
      { status: 'already-recorded', externalId: 'ERP-WRONG' },
    ]);
    expect(await stock()).toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: 5 },
    ]);
  });
});
