import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PostgresTenantScopedUnitOfWork } from '../../src/adapters/persistence/postgres/postgres-tenant-scoped-unit-of-work';
import { PostgresExportCursorRepository } from '../../src/adapters/persistence/postgres/postgres-export-cursor.repository';
import { PostgresMovementExportRepository } from '../../src/adapters/persistence/postgres/postgres-movement-export.repository';
import type { Transaction } from '../../src/adapters/persistence/postgres/postgres-tenant-scoped-unit-of-work';
import { transactionId, windowFrom } from '../../src/domain/export/window';
import type { TransactionId } from '../../src/domain/export/window';
import { tenantId } from '../../src/domain/identifiers';
import type { TenantId } from '../../src/domain/identifiers';
import { asPersonInTenant, runtimePool, seed } from './support/database';
import { seedTenant, useIntegrationDatabase } from './support/fixtures';

/**
 * The two PostgreSQL adapters the export reads and remembers with.
 *
 * The double answers the same questions, and what only a real database can show
 * is the half it cannot model: what a transaction still in flight does to the
 * horizon. That is the entire reason this feature counts transactions instead
 * of moments, so it is asserted here, at the level where the answer is decided.
 */
describe('the export adapters, against PostgreSQL', () => {
  useIntegrationDatabase();

  async function tenantWithCatalogue(): Promise<TenantId> {
    const { id } = await seedTenant();
    await seed(async (client) => {
      await client.query(
        `INSERT INTO inventory_products (id, tenant_id, sku, name)
         VALUES (gen_random_uuid(), $1, 'ACME-001', 'A widget')`,
        [id],
      );
      await client.query(
        `INSERT INTO inventory_locations (id, tenant_id, code, name)
         VALUES (gen_random_uuid(), $1, 'WH-1', 'Main warehouse')`,
        [id],
      );
    });
    return tenantId(id);
  }

  const INSERT = `INSERT INTO stock_movements
      (id, tenant_id, external_id, sku, location_code, kind, quantity, occurred_at)
    VALUES ($1, $2, $3, 'ACME-001', 'WH-1', 'receipt', 5, $4)`;

  /** Records one movement in its own transaction, as the API would. */
  async function record(
    tenant: TenantId,
    externalId: string,
    occurredAt = new Date('2026-08-27T10:00:00.000Z'),
  ): Promise<void> {
    await asPersonInTenant(tenant, (client) =>
      client.query(INSERT, [randomUUID(), tenant, externalId, occurredAt]),
    );
  }

  async function readingAs<T>(
    tenant: TenantId,
    work: (repositories: {
      movements: PostgresMovementExportRepository;
      cursors: PostgresExportCursorRepository;
    }) => Promise<T>,
  ): Promise<T> {
    return asPersonInTenant(tenant, async (client) => {
      const tx = drizzle(client) as unknown as Transaction;
      return work({
        movements: new PostgresMovementExportRepository(tx, tenant),
        cursors: new PostgresExportCursorRepository(tx, tenant),
      });
    });
  }

  const horizonOf = (tenant: TenantId): Promise<TransactionId> =>
    readingAs(tenant, ({ movements }) => movements.horizon());

  const carriedIn = (
    tenant: TenantId,
    from: TransactionId,
    to: TransactionId,
  ) =>
    readingAs(tenant, ({ movements }) =>
      movements.inWindow(windowFrom(from, to)),
    );

  it('reads back a movement shaped as it will be exported', async () => {
    const tenant = await tenantWithCatalogue();
    await record(tenant, 'ERP-1');

    const rows = await carriedIn(
      tenant,
      transactionId(1n),
      await horizonOf(tenant),
    );

    expect(rows).toEqual([
      {
        external_id: 'ERP-1',
        sku: 'ACME-001',
        location_code: 'WH-1',
        kind: 'receipt',
        quantity: 5,
        occurred_at: new Date('2026-08-27T10:00:00.000Z'),
        recorded_at: expect.any(Date) as Date,
      },
    ]);
  });

  it('leaves out what the window does not cover', async () => {
    const tenant = await tenantWithCatalogue();
    await record(tenant, 'ERP-1');
    const afterFirst = await horizonOf(tenant);
    await record(tenant, 'ERP-2');

    const early = await carriedIn(tenant, transactionId(1n), afterFirst);

    expect(early.map((row) => row.external_id)).toEqual(['ERP-1']);
  });

  it('shows one tenant nothing of another', async () => {
    const mine = await tenantWithCatalogue();
    const theirs = await tenantWithCatalogue();
    await record(mine, 'ERP-MINE');
    await record(theirs, 'ERP-THEIRS');

    const rows = await carriedIn(
      mine,
      transactionId(1n),
      await horizonOf(mine),
    );

    expect(rows.map((row) => row.external_id)).toEqual(['ERP-MINE']);
  });

  it('holds the horizon back while a transaction is still in flight', async () => {
    // The experiment this whole design rests on, as a test.
    //
    // One transaction inserts and is held open. A second inserts and commits
    // while it is held — taking a *higher* identifier but committing first. A
    // cursor holding "the greatest moment exported" would carry the second and
    // move past the first, losing it for ever and silently.
    const tenant = await tenantWithCatalogue();
    const holder = await runtimePool('app').connect();
    let committed = false;

    try {
      await holder.query('BEGIN');
      await holder.query('SELECT set_config($1, $2, true)', [
        'app.current_tenant',
        tenant,
      ]);
      await holder.query(INSERT, [
        randomUUID(),
        tenant,
        'ERP-HELD',
        new Date('2026-08-27T09:00:00.000Z'),
      ]);

      // Committed while the first is still open, and therefore visible.
      await record(tenant, 'ERP-COMMITTED');

      const heldBack = await carriedIn(
        tenant,
        transactionId(1n),
        await horizonOf(tenant),
      );

      // Neither is carried: the visible one is above the horizon precisely
      // because the invisible one is below it and still open.
      expect(heldBack).toEqual([]);

      await holder.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) {
        await holder.query('ROLLBACK');
      }
      holder.release();
    }

    const both = await carriedIn(
      tenant,
      transactionId(1n),
      await horizonOf(tenant),
    );

    // And now both, each exactly once.
    expect(both.map((row) => row.external_id).sort()).toEqual([
      'ERP-COMMITTED',
      'ERP-HELD',
    ]);
  }, 30_000);

  it('carries a movement whose transaction committed late, in the next run', async () => {
    // The same property stated as a caller would meet it: a window taken while
    // a transaction is open, then a second window afterwards, must together
    // carry everything exactly once.
    const tenant = await tenantWithCatalogue();
    const holder = await runtimePool('app').connect();
    let committed = false;
    let first: readonly { external_id: string }[] = [];

    try {
      await holder.query('BEGIN');
      await holder.query('SELECT set_config($1, $2, true)', [
        'app.current_tenant',
        tenant,
      ]);
      await holder.query(INSERT, [
        randomUUID(),
        tenant,
        'ERP-HELD',
        new Date('2026-08-27T09:00:00.000Z'),
      ]);
      await record(tenant, 'ERP-COMMITTED');

      const horizon = await horizonOf(tenant);
      first = await carriedIn(tenant, transactionId(1n), horizon);
      await holder.query('COMMIT');
      committed = true;

      const second = await carriedIn(tenant, horizon, await horizonOf(tenant));

      expect(
        [...first, ...second].map((row) => row.external_id).sort(),
      ).toEqual(['ERP-COMMITTED', 'ERP-HELD']);
    } finally {
      if (!committed) {
        await holder.query('ROLLBACK');
      }
      holder.release();
    }
  }, 30_000);

  describe('the cursor', () => {
    it('starts having carried nothing', async () => {
      const tenant = await tenantWithCatalogue();

      await expect(
        readingAs(tenant, ({ cursors }) => cursors.read('movements')),
      ).resolves.toEqual({ state: 'never-carried' });
    });

    it('remembers a window a run started and did not finish', async () => {
      const tenant = await tenantWithCatalogue();
      const window = windowFrom(transactionId(100n), transactionId(200n));

      await readingAs(tenant, ({ cursors }) =>
        cursors.start('movements', window),
      );

      const cursor = await readingAs(tenant, ({ cursors }) =>
        cursors.read('movements'),
      );
      expect(cursor.state).toBe('started');
      expect(cursor.state === 'started' && cursor.window.from).toBe(100n);
      expect(cursor.state === 'started' && cursor.window.to).toBe(200n);
    });

    it('forgets the window once the run finishes, and remembers the point', async () => {
      const tenant = await tenantWithCatalogue();
      await readingAs(tenant, ({ cursors }) =>
        cursors.start(
          'movements',
          windowFrom(transactionId(100n), transactionId(200n)),
        ),
      );

      await readingAs(tenant, ({ cursors }) =>
        cursors.finish('movements', transactionId(200n)),
      );

      await expect(
        readingAs(tenant, ({ cursors }) => cursors.read('movements')),
      ).resolves.toEqual({ state: 'carried', through: 200n });
    });

    it('moves the same tenant forward twice without a second row', async () => {
      const tenant = await tenantWithCatalogue();

      await readingAs(tenant, ({ cursors }) =>
        cursors.finish('movements', transactionId(200n)),
      );
      await readingAs(tenant, ({ cursors }) =>
        cursors.finish('movements', transactionId(300n)),
      );

      const held = await seed(async (client) => {
        const { rows } = await client.query<{ tenant_id: string }>(
          'SELECT tenant_id FROM export_cursors WHERE tenant_id = $1',
          [tenant],
        );
        return rows;
      });
      // One row moved forward, not a second row added: the cursor is a position
      // per tenant and dataset, not a log of positions.
      expect(held).toHaveLength(1);
    });

    it('keeps one tenant position out of another tenant reach', async () => {
      const mine = await tenantWithCatalogue();
      const theirs = await tenantWithCatalogue();
      await readingAs(theirs, ({ cursors }) =>
        cursors.finish('movements', transactionId(900n)),
      );

      await expect(
        readingAs(mine, ({ cursors }) => cursors.read('movements')),
      ).resolves.toEqual({ state: 'never-carried' });
    });
  });
});

/**
 * The seam, carrying the export.
 *
 * The point of asserting this separately: an export that reached the database
 * by any other route would be the first reader on this platform not covered by
 * row-level security. Reading through `runInTenant` is what makes the isolation
 * inherited rather than re-argued, and the only way to be sure it is inherited
 * is to read a second tenant's rows through it and get nothing.
 */
describe('the export through the tenant-scoped seam', () => {
  useIntegrationDatabase();

  async function tenantWithMovement(externalId: string): Promise<TenantId> {
    const { id } = await seedTenant();
    await seed(async (client) => {
      await client.query(
        `INSERT INTO inventory_products (id, tenant_id, sku, name)
         VALUES (gen_random_uuid(), $1, 'ACME-001', 'A widget')`,
        [id],
      );
      await client.query(
        `INSERT INTO inventory_locations (id, tenant_id, code, name)
         VALUES (gen_random_uuid(), $1, 'WH-1', 'Main warehouse')`,
        [id],
      );
    });
    const tenant = tenantId(id);
    await asPersonInTenant(tenant, (client) =>
      client.query(
        `INSERT INTO stock_movements
           (id, tenant_id, external_id, sku, location_code, kind, quantity, occurred_at)
         VALUES ($1, $2, $3, 'ACME-001', 'WH-1', 'receipt', 5, now())`,
        [randomUUID(), tenant, externalId],
      ),
    );
    return tenant;
  }

  const seamFor = (): PostgresTenantScopedUnitOfWork =>
    new PostgresTenantScopedUnitOfWork(drizzle(runtimePool('app')));

  it('hands out the export repositories inside the transaction', async () => {
    const tenant = await tenantWithMovement('ERP-1');

    const rows = await seamFor().runInTenant(tenant, async (repositories) => {
      const horizon = await repositories.movementExport.horizon();
      return repositories.movementExport.inWindow(
        windowFrom(transactionId(1n), horizon),
      );
    });

    expect(rows.map((row) => row.external_id)).toEqual(['ERP-1']);
  });

  it('shows the export nothing of another tenant, by policy', async () => {
    const mine = await tenantWithMovement('ERP-MINE');
    await tenantWithMovement('ERP-THEIRS');

    const rows = await seamFor().runInTenant(mine, async (repositories) => {
      const horizon = await repositories.movementExport.horizon();
      return repositories.movementExport.inWindow(
        windowFrom(transactionId(1n), horizon),
      );
    });

    // Row-level security is what answers here: the export asked for a window,
    // not for a tenant, and the policy decided which rows the window could
    // possibly contain.
    expect(rows.map((row) => row.external_id)).toEqual(['ERP-MINE']);
  });

  it('carries the cursor through the same seam', async () => {
    const tenant = await tenantWithMovement('ERP-1');

    await seamFor().runInTenant(tenant, (repositories) =>
      repositories.exportCursors.finish('movements', transactionId(400n)),
    );

    await expect(
      seamFor().runInTenant(tenant, (repositories) =>
        repositories.exportCursors.read('movements'),
      ),
    ).resolves.toEqual({ state: 'carried', through: 400n });
  });

  it('rolls the cursor back with everything else when the work fails', async () => {
    // The seam opens one transaction. A run that dies after moving the cursor
    // and before finishing its writes must leave neither behind, and this is
    // the property that makes "the cursor moved but the objects did not" a
    // state the database cannot hold.
    const tenant = await tenantWithMovement('ERP-1');

    await expect(
      seamFor().runInTenant(tenant, async (repositories) => {
        await repositories.exportCursors.finish(
          'movements',
          transactionId(400n),
        );
        throw new Error('the run died here');
      }),
    ).rejects.toThrow('the run died here');

    await expect(
      seamFor().runInTenant(tenant, (repositories) =>
        repositories.exportCursors.read('movements'),
      ),
    ).resolves.toEqual({ state: 'never-carried' });
  });
});
