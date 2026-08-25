import { randomUUID } from 'node:crypto';
import { asAppWithoutTenant, asPersonInTenant, seed } from './support/database';
import { useIntegrationDatabase } from './support/fixtures';
import { seedTenant } from './support/fixtures';

/**
 * What the inventory tables refuse on their own.
 *
 * Every assertion here goes through the seeding connection, which bypasses
 * row-level security — deliberately, and only because these are *constraints*
 * rather than policies. A check, a unique index and a foreign key hold against
 * every connection, including one no policy would restrain, which is precisely
 * the claim being made: these rules cannot be skipped by reaching the database
 * a different way. Isolation is a separate layer with its own suite.
 */
describe('the inventory tables', () => {
  useIntegrationDatabase();

  /**
   * A tenant with one product and one place.
   *
   * The codes are distinct per tenant by default. They were shared in the first
   * draft, and the cross-tenant foreign-key test passed for the wrong reason —
   * the movement resolved against the *other* tenant's identically named
   * product. Pass `codes` explicitly where a test needs two tenants to collide.
   */
  async function tenantWithCatalogue(codes?: {
    sku: string;
    location: string;
  }): Promise<{ tenantId: string; sku: string; location: string }> {
    const { id: tenantId } = await seedTenant();
    const sku = codes?.sku ?? `SKU-${randomUUID().slice(0, 8)}`;
    const location = codes?.location ?? `WH-${randomUUID().slice(0, 8)}`;
    await seed(async (client) => {
      await client.query(
        'INSERT INTO inventory_products (id, tenant_id, sku, name) VALUES ($1, $2, $3, $4)',
        [randomUUID(), tenantId, sku, 'A widget'],
      );
      await client.query(
        'INSERT INTO inventory_locations (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)',
        [randomUUID(), tenantId, location, 'Main warehouse'],
      );
    });
    return { tenantId, sku, location };
  }

  async function insertMovement(attributes: {
    tenantId: string;
    sku: string;
    location: string;
    externalId?: string;
    kind?: string;
    quantity?: number;
  }): Promise<void> {
    await seed((client) =>
      client.query(
        `INSERT INTO stock_movements
           (id, tenant_id, external_id, sku, location_code, kind, quantity, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [
          randomUUID(),
          attributes.tenantId,
          attributes.externalId ?? `ERP-${randomUUID()}`,
          attributes.sku,
          attributes.location,
          attributes.kind ?? 'receipt',
          attributes.quantity ?? 5,
        ],
      ),
    );
  }

  it('lets two tenants track the same SKU', async () => {
    // The reason uniqueness is `(tenant_id, sku)` and never `sku`. A tenant's
    // catalogue is its own, and a SKU means nothing across the platform.
    const acme = await seedTenant();
    const globex = await seedTenant();

    await seed(async (client) => {
      for (const tenant of [acme, globex]) {
        await client.query(
          'INSERT INTO inventory_products (id, tenant_id, sku, name) VALUES ($1, $2, $3, $4)',
          [randomUUID(), tenant.id, 'ACME-001', 'Unrelated things'],
        );
      }
    });

    const { rows } = await seed((client) =>
      client.query('SELECT tenant_id FROM inventory_products WHERE sku = $1', [
        'ACME-001',
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it('refuses a second product with the same SKU in one tenant', async () => {
    const { tenantId, sku } = await tenantWithCatalogue();

    await expect(
      seed((client) =>
        client.query(
          'INSERT INTO inventory_products (id, tenant_id, sku, name) VALUES ($1, $2, $3, $4)',
          [randomUUID(), tenantId, sku, 'A different widget'],
        ),
      ),
    ).rejects.toThrow(/inventory_products_tenant_sku_unique/);
  });

  it('refuses a second place with the same code in one tenant', async () => {
    const { tenantId, location } = await tenantWithCatalogue();

    await expect(
      seed((client) =>
        client.query(
          'INSERT INTO inventory_locations (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)',
          [randomUUID(), tenantId, location, 'Somewhere else'],
        ),
      ),
    ).rejects.toThrow(/inventory_locations_tenant_code_unique/);
  });

  it('refuses a movement replaying an identifier already recorded in its tenant', async () => {
    // The constraint every retry rests on. `ON CONFLICT DO NOTHING` observes
    // this; without it, two concurrent retries both insert.
    const { tenantId, sku, location } = await tenantWithCatalogue();
    await insertMovement({ tenantId, sku, location, externalId: 'ERP-88412' });

    await expect(
      insertMovement({ tenantId, sku, location, externalId: 'ERP-88412' }),
    ).rejects.toThrow(/stock_movements_tenant_external_unique/);
  });

  it('accepts the same identifier from a different tenant', async () => {
    // Uniqueness is a property within a tenant. Refusing here would tell the
    // caller that another tenant had used the number, which is a cross-tenant
    // leak through the error channel.
    const acme = await tenantWithCatalogue();
    const globex = await tenantWithCatalogue();

    await insertMovement({ ...acme, externalId: 'ERP-88412' });

    await expect(
      insertMovement({ ...globex, externalId: 'ERP-88412' }),
    ).resolves.not.toThrow();
  });

  it('refuses a movement naming a product from another tenant', async () => {
    // The composite foreign key. A reference to the SKU alone would have made
    // this a policy question; carrying the tenant makes it unrepresentable.
    const acme = await tenantWithCatalogue();
    const globex = await tenantWithCatalogue();

    await expect(
      insertMovement({
        tenantId: globex.tenantId,
        sku: acme.sku,
        // Globex's *own* place, so the product reference is the only foreign
        // thing in the row. Naming Acme's place too made this pass on the
        // location key instead, which is a different claim.
        location: globex.location,
      }),
    ).rejects.toThrow(/stock_movements_product_fk/);
  });

  it('refuses a movement naming an undeclared place', async () => {
    const { tenantId, sku } = await tenantWithCatalogue();

    await expect(
      insertMovement({ tenantId, sku, location: 'WH-DOES-NOT-EXIST' }),
    ).rejects.toThrow(/stock_movements_location_fk/);
  });

  it('refuses a movement of nothing', async () => {
    const { tenantId, sku, location } = await tenantWithCatalogue();

    await expect(
      insertMovement({ tenantId, sku, location, quantity: 0 }),
    ).rejects.toThrow(/stock_movements_quantity_check/);
  });

  it('refuses a kind it does not recognise', async () => {
    // Including `transfer`, which is the one somebody will reach for. A
    // transfer is two movements; the absence of the kind is the mechanism.
    const { tenantId, sku, location } = await tenantWithCatalogue();

    await expect(
      insertMovement({ tenantId, sku, location, kind: 'transfer' }),
    ).rejects.toThrow(/stock_movements_kind_check/);
  });

  it('stamps when it recorded a movement, separately from when it happened', async () => {
    // Two timestamps because a later incremental export keys on the monotonic
    // one. A backdated movement must not move a partition that was already
    // written.
    const { tenantId, sku, location } = await tenantWithCatalogue();
    const lastYear = new Date('2025-08-25T10:00:00.000Z');

    await seed((client) =>
      client.query(
        `INSERT INTO stock_movements
           (id, tenant_id, external_id, sku, location_code, kind, quantity, occurred_at)
         VALUES ($1, $2, $3, $4, $5, 'receipt', 5, $6)`,
        [randomUUID(), tenantId, 'ERP-OLD', sku, location, lastYear],
      ),
    );

    const { rows } = await seed((client) =>
      client.query<{ occurred_at: Date; recorded_at: Date }>(
        'SELECT occurred_at, recorded_at FROM stock_movements WHERE external_id = $1',
        ['ERP-OLD'],
      ),
    );

    expect(rows[0]?.occurred_at).toEqual(lastYear);
    expect(rows[0]?.recorded_at.getTime()).toBeGreaterThan(lastYear.getTime());
  });
});

/**
 * What the inventory tables refuse to the identity that actually serves
 * requests.
 *
 * The tests above bypass row-level security on purpose, because a constraint
 * holds against every connection. These do the opposite: they run as
 * `cubeforge_app` with a tenant published exactly the way the unit of work will
 * publish it, so what they observe is the policy and the grant rather than the
 * schema.
 */
describe('the inventory tables, reached by the application identity', () => {
  useIntegrationDatabase();

  async function tenantWithOneMovement(): Promise<{
    tenantId: string;
    externalId: string;
  }> {
    const { id: tenantId } = await seedTenant();
    const externalId = `ERP-${randomUUID().slice(0, 8)}`;
    await seed(async (client) => {
      await client.query(
        'INSERT INTO inventory_products (id, tenant_id, sku, name) VALUES ($1, $2, $3, $4)',
        [randomUUID(), tenantId, 'SKU-1', 'A widget'],
      );
      await client.query(
        'INSERT INTO inventory_locations (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)',
        [randomUUID(), tenantId, 'WH-1', 'Main warehouse'],
      );
      await client.query(
        `INSERT INTO stock_movements
           (id, tenant_id, external_id, sku, location_code, kind, quantity, occurred_at)
         VALUES ($1, $2, $3, 'SKU-1', 'WH-1', 'receipt', 5, now())`,
        [randomUUID(), tenantId, externalId],
      );
    });
    return { tenantId, externalId };
  }

  it('refuses to let the application change a movement', async () => {
    // Append-only, enforced by the absence of a grant. A repository can grow an
    // update method later; a privilege cannot be forgotten into existence.
    const { tenantId } = await tenantWithOneMovement();

    await expect(
      asPersonInTenant(tenantId, (client) =>
        client.query('UPDATE stock_movements SET quantity = 99'),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses to let the application delete a movement', async () => {
    const { tenantId } = await tenantWithOneMovement();

    await expect(
      asPersonInTenant(tenantId, (client) =>
        client.query('DELETE FROM stock_movements'),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses to let the application delete a product or a place', async () => {
    const { tenantId } = await tenantWithOneMovement();

    for (const table of ['inventory_products', 'inventory_locations']) {
      await expect(
        asPersonInTenant(tenantId, (client) =>
          client.query(`DELETE FROM ${table}`),
        ),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it('shows one tenant nothing of another, to a query that forgot its predicate', async () => {
    // No WHERE at all, which is what a repository with its scoping removed
    // would issue. What answers is the policy alone.
    const acme = await tenantWithOneMovement();
    await tenantWithOneMovement();

    const rows = await asPersonInTenant(acme.tenantId, async (client) => {
      const result = await client.query<{ external_id: string }>(
        'SELECT external_id FROM stock_movements',
      );
      return result.rows;
    });

    expect(rows.map((row) => row.external_id)).toEqual([acme.externalId]);
  });

  it('shows nothing at all to a query that escaped the unit of work', async () => {
    await tenantWithOneMovement();

    const counts = await asAppWithoutTenant(async (client) => {
      const result = await client.query<{ movements: string }>(
        `SELECT (SELECT count(*) FROM stock_movements)::text AS movements`,
      );
      return result.rows[0]?.movements;
    });

    expect(counts).toBe('0');
  });
});
