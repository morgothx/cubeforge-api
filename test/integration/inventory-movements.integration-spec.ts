import { drizzle } from 'drizzle-orm/node-postgres';
import { PostgresMovementRepository } from '../../src/adapters/persistence/postgres/postgres-movement.repository';
import type { Transaction } from '../../src/adapters/persistence/postgres/postgres-tenant-scoped-unit-of-work';
import { tenantId } from '../../src/domain/identifiers';
import type { TenantId } from '../../src/domain/identifiers';
import {
  externalMovementId,
  locationCode,
  sku,
} from '../../src/domain/inventory/identifiers';
import type { SubmittedMovement } from '../../src/domain/inventory/movement';
import {
  asPersonInTenant,
  policyBypassingPool,
  runtimePool,
  seed,
} from './support/database';
import { seedTenant, useIntegrationDatabase } from './support/fixtures';

const occurredAt = new Date('2026-08-25T10:00:00.000Z');

/**
 * Waits until some statement is waiting on a lock.
 *
 * A fixed delay would make the overlap a guess about how fast this machine is.
 * Asking the database whether anything is blocked makes it a fact.
 */
async function waitForABlockedStatement(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const blocked = await seed(async (client) => {
      const result = await client.query<{ blocked: number }>(
        `SELECT count(*)::int AS blocked FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'`,
      );
      return result.rows[0]?.blocked ?? 0;
    });
    if (blocked > 0) return;
    await new Promise((resume) => setTimeout(resume, 10));
  }
  throw new Error('no statement ever blocked; the overlap did not happen');
}

function movement(
  externalId: string,
  overrides: Partial<SubmittedMovement> = {},
): SubmittedMovement {
  return {
    externalId: externalMovementId(externalId),
    sku: sku('ACME-001'),
    location: locationCode('WH-1'),
    kind: 'receipt',
    quantity: 5,
    occurredAt,
    ...overrides,
  };
}

/**
 * The movement stream against the real database.
 *
 * The double answers the same questions and cannot answer the one that matters
 * most: whether two submissions arriving at once both insert.
 */
describe('the movement stream, against PostgreSQL', () => {
  useIntegrationDatabase();

  async function withCatalogue(): Promise<TenantId> {
    const tenant = tenantId((await seedTenant()).id);
    await seed(async (client) => {
      await client.query(
        `INSERT INTO inventory_products (id, tenant_id, sku, name)
         VALUES (gen_random_uuid(), $1, 'ACME-001', 'A widget')`,
        [tenant],
      );
      for (const code of ['WH-1', 'WH-2']) {
        await client.query(
          `INSERT INTO inventory_locations (id, tenant_id, code, name)
           VALUES (gen_random_uuid(), $1, $2, $2)`,
          [tenant, code],
        );
      }
    });
    return tenant;
  }

  async function inTenant<T>(
    tenant: TenantId,
    work: (movements: PostgresMovementRepository) => Promise<T>,
  ): Promise<T> {
    return asPersonInTenant(tenant, async (client) =>
      work(
        new PostgresMovementRepository(
          drizzle(client) as unknown as Transaction,
          tenant,
        ),
      ),
    );
  }

  it('reports back only what it newly recorded', async () => {
    const tenant = await withCatalogue();

    await expect(
      inTenant(tenant, (movements) =>
        movements.record([movement('ERP-1'), movement('ERP-2')]),
      ),
    ).resolves.toEqual(new Set(['ERP-1', 'ERP-2']));
  });

  it('records nothing the second time, and says so', async () => {
    const tenant = await withCatalogue();
    await inTenant(tenant, (movements) =>
      movements.record([movement('ERP-1')]),
    );

    await expect(
      inTenant(tenant, (movements) => movements.record([movement('ERP-1')])),
    ).resolves.toEqual(new Set());
    await expect(
      inTenant(tenant, (movements) => movements.stockOnHand()),
    ).resolves.toEqual([{ sku: 'ACME-001', location: 'WH-1', onHand: 5 }]);
  });

  it('records only the part of a resubmitted batch that is new', async () => {
    const tenant = await withCatalogue();
    await inTenant(tenant, (movements) =>
      movements.record([movement('ERP-1')]),
    );

    await expect(
      inTenant(tenant, (movements) =>
        movements.record([movement('ERP-1'), movement('ERP-2')]),
      ),
    ).resolves.toEqual(new Set(['ERP-2']));
  });

  it('records a movement once when two submissions overlap in time', async () => {
    // The test the double cannot run, and the reason `record` is one statement.
    //
    // Two claims here, and the second is the one that took two attempts to
    // state. "No duplicates" is satisfied by a read-then-write implementation
    // too — the unique constraint kills the loser with an error. What separates
    // them is that **both submissions succeed**: `on conflict do nothing` waits
    // for the other transaction and then skips, while reading first aborts. A
    // caller retrying a timed-out batch must get an answer, not an error about
    // a movement it already sent.
    //
    // The overlap is arranged rather than hoped for. Running both through
    // `Promise.allSettled` and trusting the scheduler is not a concurrency
    // test: the first can finish entirely before the second begins, and then
    // the wrong implementation passes. Here the first transaction is held open
    // until the second is demonstrably blocked on it.
    const tenant = await withCatalogue();
    const batch = [movement('ERP-1'), movement('ERP-2'), movement('ERP-3')];
    const pool = runtimePool('app');
    const first = await pool.connect();
    const second = await pool.connect();

    const streamOn = (client: typeof first) =>
      new PostgresMovementRepository(
        drizzle(client) as unknown as Transaction,
        tenant,
      );

    try {
      for (const client of [first, second]) {
        await client.query('BEGIN');
        await client.query('SELECT set_config($1, $2, true)', [
          'app.current_tenant',
          tenant,
        ]);
      }

      expect([...(await streamOn(first).record(batch))].sort()).toEqual([
        'ERP-1',
        'ERP-2',
        'ERP-3',
      ]);

      // Started, deliberately not awaited: it must still be in flight, blocked
      // on the uncommitted rows, when the first transaction commits.
      const overlapping = streamOn(second).record(batch);
      await waitForABlockedStatement();
      await first.query('COMMIT');

      await expect(overlapping).resolves.toEqual(new Set());
      await second.query('COMMIT');
    } finally {
      first.release();
      second.release();
    }

    const stock = await inTenant(tenant, (movements) =>
      movements.stockOnHand(),
    );
    expect(stock).toEqual([{ sku: 'ACME-001', location: 'WH-1', onHand: 15 }]);
  });

  it('lets a different tenant use the same identifier', async () => {
    const acme = await withCatalogue();
    const globex = await withCatalogue();
    await inTenant(acme, (movements) => movements.record([movement('ERP-1')]));

    await expect(
      inTenant(globex, (movements) => movements.record([movement('ERP-1')])),
    ).resolves.toEqual(new Set(['ERP-1']));
  });

  it('sums per product and place, keeping a pairing that cancels out', async () => {
    const tenant = await withCatalogue();
    await inTenant(tenant, (movements) =>
      movements.record([
        movement('ERP-1', { kind: 'receipt', quantity: 5 }),
        movement('ERP-2', { kind: 'sale', quantity: -5 }),
        movement('ERP-3', { location: locationCode('WH-2'), quantity: 3 }),
      ]),
    );

    await expect(
      inTenant(tenant, (movements) => movements.stockOnHand()),
    ).resolves.toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: 0 },
      { sku: 'ACME-001', location: 'WH-2', onHand: 3 },
    ]);
  });

  it('lets a total go negative', async () => {
    const tenant = await withCatalogue();
    await inTenant(tenant, (movements) =>
      movements.record([movement('ERP-1', { kind: 'sale', quantity: -9 })]),
    );

    await expect(
      inTenant(tenant, (movements) => movements.stockOnHand()),
    ).resolves.toEqual([{ sku: 'ACME-001', location: 'WH-1', onHand: -9 }]);
  });

  it('shows one tenant nothing of another', async () => {
    const acme = await withCatalogue();
    const globex = await withCatalogue();
    await inTenant(globex, (movements) =>
      movements.record([movement('ERP-1')]),
    );

    await expect(
      inTenant(acme, (movements) => movements.stockOnHand()),
    ).resolves.toEqual([]);
  });

  it('asks the database nothing when given no movements', async () => {
    const tenant = await withCatalogue();

    await expect(
      inTenant(tenant, (movements) => movements.record([])),
    ).resolves.toEqual(new Set());
  });
});

/**
 * The stream's own tenant predicate, with the database's protection removed.
 *
 * With policies in force, deleting the `where` clause from the sum breaks
 * nothing observable and every test above still passes. Connecting as a
 * superuser leaves only the predicate, so neither layer can be credited for the
 * other's work.
 */
describe('the movement predicate, with policies bypassed', () => {
  useIntegrationDatabase();

  const bypassing = () => drizzle(policyBypassingPool());

  async function streamOf<T>(
    tenant: TenantId,
    work: (movements: PostgresMovementRepository) => Promise<T>,
  ): Promise<T> {
    return bypassing().transaction(async (tx) =>
      work(new PostgresMovementRepository(tx, tenant)),
    );
  }

  async function catalogueFor(tenant: TenantId): Promise<void> {
    await seed(async (client) => {
      await client.query(
        `INSERT INTO inventory_products (id, tenant_id, sku, name)
         VALUES (gen_random_uuid(), $1, 'ACME-001', 'A widget')`,
        [tenant],
      );
      await client.query(
        `INSERT INTO inventory_locations (id, tenant_id, code, name)
         VALUES (gen_random_uuid(), $1, 'WH-1', 'Main')`,
        [tenant],
      );
    });
  }

  it('sums only its own tenant, unaided', async () => {
    const acme = tenantId((await seedTenant()).id);
    const globex = tenantId((await seedTenant()).id);
    await catalogueFor(acme);
    await catalogueFor(globex);

    await streamOf(globex, (movements) =>
      movements.record([movement('ERP-THEIRS', { quantity: 100 })]),
    );
    await streamOf(acme, (movements) =>
      movements.record([movement('ERP-MINE', { quantity: 7 })]),
    );

    await expect(
      streamOf(acme, (movements) => movements.stockOnHand()),
    ).resolves.toEqual([{ sku: 'ACME-001', location: 'WH-1', onHand: 7 }]);
  });
});
