import { randomUUID } from 'node:crypto';
import { asPersonInTenant, seed } from './support/database';
import { seedTenant, useIntegrationDatabase } from './support/fixtures';

/**
 * The ground the export cursor stands on.
 *
 * A cursor that remembers "the greatest moment exported" is wrong under
 * concurrency, and wrong silently: `recorded_at` is the moment a transaction
 * *began*, and two transactions commit in whatever order they finish. A
 * movement whose transaction started earlier and committed later would be
 * skipped for ever by a moment-based cursor.
 *
 * So a movement carries the transaction that recorded it, and the cursor
 * compares those. These tests are about the column existing and behaving; the
 * concurrency property it exists to serve is proven in the export suites.
 */
describe('what a movement carries for the export', () => {
  useIntegrationDatabase();

  async function tenantWithCatalogue(): Promise<string> {
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
    return id;
  }

  /** Records one movement in its own transaction, and reports its identifier. */
  async function recordMovement(
    tenantId: string,
    externalId: string,
  ): Promise<bigint> {
    return asPersonInTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ recorded_xid: string }>(
        `INSERT INTO stock_movements
           (id, tenant_id, external_id, sku, location_code, kind, quantity, occurred_at)
         VALUES ($1, $2, $3, 'ACME-001', 'WH-1', 'receipt', 5, now())
         RETURNING recorded_xid`,
        [randomUUID(), tenantId, externalId],
      );
      return BigInt(rows[0]?.recorded_xid ?? '0');
    });
  }

  it('stamps every movement with the transaction that recorded it', async () => {
    const tenant = await tenantWithCatalogue();

    const first = await recordMovement(tenant, 'ERP-1');
    const second = await recordMovement(tenant, 'ERP-2');

    expect(first).toBeGreaterThan(0n);
    // Strictly increasing across transactions. This is the ordering the cursor
    // compares against, and a column that repeated a value would make two runs
    // disagree about which side of the window a movement falls on.
    expect(second).toBeGreaterThan(first);
  });

  it('fills the identifier itself, so no writer can forget it', async () => {
    const column = await seed(async (client) => {
      const { rows } = await client.query<{
        is_nullable: string;
        column_default: string | null;
        data_type: string;
      }>(
        `SELECT is_nullable, column_default, data_type
           FROM information_schema.columns
          WHERE table_name = 'stock_movements' AND column_name = 'recorded_xid'`,
      );
      return rows[0];
    });

    // Not nullable and defaulted: the value comes from the database, never from
    // an insert that remembered to supply it. A writer that could supply it
    // could supply a wrong one, and the export would believe it.
    expect(column?.is_nullable).toBe('NO');
    expect(column?.column_default).toBe('pg_current_xact_id()');
    expect(column?.data_type).toBe('xid8');
  });

  it('leaves the movement stream append-only, exactly as it was', async () => {
    // A regression guard on the migration rather than a new claim: adding a
    // column must not have touched the grants that make the history immutable.
    const granted = await seed(async (client) => {
      const { rows } = await client.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'cubeforge_app' AND table_name = 'stock_movements'`,
      );
      return rows.map((row) => row.privilege_type).sort();
    });

    expect(granted).toEqual(['INSERT', 'SELECT']);
  });
});

/**
 * Where a tenant's position is kept.
 *
 * Two phases, not one. A run records the window it is *about to* carry before
 * it writes anything, and confirms it afterwards. A run that dies in between
 * therefore leaves the window recorded rather than lost, and the next run
 * finishes that window instead of computing a new one — which is what makes the
 * objects it writes the same objects, under the same keys.
 */
describe('where the export keeps its place', () => {
  useIntegrationDatabase();

  it('is protected exactly as every other tenant-owned table', async () => {
    const protection = await seed(async (client) => {
      const { rows } = await client.query<{
        enabled: boolean;
        forced: boolean;
        policies: number;
      }>(
        `SELECT c.relrowsecurity AS enabled,
                c.relforcerowsecurity AS forced,
                (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'export_cursors'`,
      );
      return rows[0];
    });

    // Forced as well as enabled: without FORCE the owner bypasses the policy,
    // and the platform's coverage test would pass while the protection was
    // decorative.
    expect(protection).toMatchObject({ enabled: true, forced: true });
    expect(protection?.policies).toBeGreaterThan(0);
  });

  it('grants the application no way to forget where a tenant reached', async () => {
    // Stated as a set. Two tests asserting a delete is refused would both stay
    // green if a fourth privilege appeared tomorrow.
    const granted = await seed(async (client) => {
      const { rows } = await client.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'cubeforge_app' AND table_name = 'export_cursors'`,
      );
      return rows.map((row) => row.privilege_type).sort();
    });

    expect(granted).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });

  it('refuses the application a delete, from the database', async () => {
    const { id } = await seedTenant();

    await expect(
      asPersonInTenant(id, (client) =>
        client.query('DELETE FROM export_cursors'),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('keeps one position per tenant and dataset', async () => {
    const { id } = await seedTenant();

    await asPersonInTenant(id, (client) =>
      client.query(
        `INSERT INTO export_cursors (tenant_id, dataset) VALUES ($1, 'movements')`,
        [id],
      ),
    );

    await expect(
      asPersonInTenant(id, (client) =>
        client.query(
          `INSERT INTO export_cursors (tenant_id, dataset) VALUES ($1, 'movements')`,
          [id],
        ),
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('shows one tenant nothing of another position', async () => {
    const mine = await seedTenant();
    const theirs = await seedTenant();
    for (const tenant of [mine, theirs]) {
      await asPersonInTenant(tenant.id, (client) =>
        client.query(
          `INSERT INTO export_cursors (tenant_id, dataset) VALUES ($1, 'movements')`,
          [tenant.id],
        ),
      );
    }

    // No predicate at all, which is what a repository with its scoping removed
    // would issue. What answers is the policy alone.
    const seen = await asPersonInTenant(mine.id, async (client) => {
      const { rows } = await client.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM export_cursors',
      );
      return rows.map((row) => row.tenant_id);
    });

    expect(seen).toEqual([mine.id]);
  });

  it('refuses a position written into another tenant', async () => {
    const mine = await seedTenant();
    const theirs = await seedTenant();

    await expect(
      asPersonInTenant(mine.id, (client) =>
        client.query(
          `INSERT INTO export_cursors (tenant_id, dataset) VALUES ($1, 'movements')`,
          [theirs.id],
        ),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it('holds a window part-way through, or none at all', async () => {
    const { id } = await seedTenant();

    await asPersonInTenant(id, (client) =>
      client.query(
        `INSERT INTO export_cursors (tenant_id, dataset, pending_from, pending_to)
         VALUES ($1, 'movements', '100'::xid8, '200'::xid8)`,
        [id],
      ),
    );

    // Half a window is not a window. A row carrying a start and no end would be
    // a run nobody can finish, and the next run could not tell whether it was
    // meant to replay or to start fresh.
    await expect(
      asPersonInTenant(id, (client) =>
        client.query(
          `UPDATE export_cursors SET pending_to = NULL WHERE tenant_id = $1`,
          [id],
        ),
      ),
    ).rejects.toThrow(/check constraint|violates/i);
  });
});
