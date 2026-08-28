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
import { runtimePool, waitForABlockedStatement } from './support/database';
import { useIntegrationDatabase } from './support/fixtures';

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

interface StockLevel {
  readonly sku: string;
  readonly location: string;
  readonly onHand: number;
}

const OCCURRED_AT = '2026-01-01T10:00:00.000Z';

function movement(externalId: string) {
  return {
    externalId,
    sku: 'ACME-001',
    location: 'WH-1',
    kind: 'receipt',
    quantity: 5,
    occurredAt: OCCURRED_AT,
  };
}

const BATCH = ['ERP-1', 'ERP-2', 'ERP-3'].map(movement);

/**
 * The same batch arriving twice at the same time.
 *
 * An upstream system that timed out waiting for us retries, and its retry can
 * land while the first attempt is still in flight — that is the whole reason a
 * synchronisation API needs an idempotency key at all. The repository suite
 * already shows `record` surviving this; what only the running application can
 * show is that the *caller* is answered rather than handed an error about a
 * movement it has every right to send again.
 */
describe('the same batch submitted twice at once', () => {
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

  it('answers both submissions, recording each movement once', async () => {
    const [first, second] = await Promise.all([submit(BATCH), submit(BATCH)]);

    // Both answered. This is the claim that separates the implementation we
    // have from one that reads before writing: under a read-then-write the
    // loser aborts on the unique constraint and its caller gets a 500 for a
    // retry that was entirely legitimate.
    expect([first.status, second.status]).toEqual([200, 200]);

    const outcomes = [
      ...body<Report>(first).outcomes,
      ...body<Report>(second).outcomes,
    ];
    // Six rows in, three recorded, three recognised — whichever request won.
    expect(outcomes.filter((row) => row.status === 'recorded')).toHaveLength(3);
    expect(
      outcomes.filter((row) => row.status === 'already-recorded'),
    ).toHaveLength(3);
    expect(
      new Set(
        outcomes
          .filter((row) => row.status === 'recorded')
          .map((row) => row.externalId),
      ),
    ).toEqual(new Set(['ERP-1', 'ERP-2', 'ERP-3']));

    expect(await stock()).toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: 15 },
    ]);
  });

  it('answers a submission that had to wait for another transaction', async () => {
    // The overlap arranged rather than hoped for. Two requests fired together
    // may still run one after the other, and then a wrong implementation
    // passes; here the batch is made to block on rows it cannot yet see, and
    // the test fails loudly if it never blocks.
    const holder = await runtimePool('app').connect();
    let inFlight: Promise<request.Response> | null = null;
    let committed = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT set_config($1, $2, true)', [
        'app.current_tenant',
        acme.id,
      ]);
      await holder.query(
        `INSERT INTO stock_movements
           (id, tenant_id, external_id, sku, location_code, kind, quantity, occurred_at)
         VALUES (gen_random_uuid(), $1, 'ERP-2', 'ACME-001', 'WH-1', 'receipt', 5, $2)`,
        [acme.id, OCCURRED_AT],
      );

      // `.then` rather than a bare call: supertest does not dispatch until the
      // request is subscribed to, so `inFlight = submit(BATCH)` would have sent
      // nothing and the overlap would never have happened. It said so — the
      // wait for a blocked statement fails loudly rather than passing quietly,
      // which is the reason it is written as a wait and not as a delay.
      inFlight = submit(BATCH).then((response) => response);
      await waitForABlockedStatement();
      await holder.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) {
        await holder.query('ROLLBACK');
      }
      holder.release();
    }

    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(body<Report>(response).outcomes).toEqual([
      { status: 'recorded', externalId: 'ERP-1' },
      // Waited on the uncommitted row, then found it committed and skipped it.
      // Reported as a retry, which is what it is.
      { status: 'already-recorded', externalId: 'ERP-2' },
      { status: 'recorded', externalId: 'ERP-3' },
    ]);

    // Fifteen, not twenty: `ERP-2` is in the sum once, from the transaction
    // that got there first.
    expect(await stock()).toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: 15 },
    ]);
    // Longer than the default: the request under test spends part of it
    // deliberately blocked, and the wait for that block is a poll.
  }, 30_000);

  it('keeps the whole batch idempotent across repeated retries', async () => {
    await submit(BATCH);
    await Promise.all([submit(BATCH), submit(BATCH), submit(BATCH)]);

    const answered = await submit(BATCH);
    expect(body<Report>(answered)).toMatchObject({
      recorded: 0,
      alreadyRecorded: 3,
      rejected: 0,
    });
    expect(await stock()).toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: 15 },
    ]);
  });
});
