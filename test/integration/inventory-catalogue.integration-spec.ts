import { drizzle } from 'drizzle-orm/node-postgres';
import { PostgresLocationRepository } from '../../src/adapters/persistence/postgres/postgres-location.repository';
import { PostgresProductRepository } from '../../src/adapters/persistence/postgres/postgres-product.repository';
import type { Transaction } from '../../src/adapters/persistence/postgres/postgres-tenant-scoped-unit-of-work';
import { tenantId } from '../../src/domain/identifiers';
import type { TenantId } from '../../src/domain/identifiers';
import { locationCode, sku } from '../../src/domain/inventory/identifiers';
import { asPersonInTenant } from './support/database';
import { seedTenant, useIntegrationDatabase } from './support/fixtures';

/**
 * The catalogue and the places against the real database.
 *
 * The in-memory double answers the same questions, and the point of running
 * them again here is the half a double cannot model: the upsert is one
 * statement, the tenant predicate meets an independent policy, and the grants
 * decide what is even possible.
 */
describe('the catalogue, against PostgreSQL', () => {
  useIntegrationDatabase();

  /** Runs work as the application identity, with the tenant published. */
  async function inTenant<T>(
    tenant: TenantId,
    work: (repositories: {
      products: PostgresProductRepository;
      locations: PostgresLocationRepository;
    }) => Promise<T>,
  ): Promise<T> {
    return asPersonInTenant(tenant, async (client) => {
      const tx = drizzle(client) as unknown as Transaction;
      return work({
        products: new PostgresProductRepository(tx, tenant),
        locations: new PostgresLocationRepository(tx, tenant),
      });
    });
  }

  it('records a product, then replaces it rather than keeping two', async () => {
    const tenant = tenantId((await seedTenant()).id);

    const outcomes = await inTenant(tenant, async ({ products }) => [
      await products.declare(sku('ACME-001'), {
        name: 'A widget',
        category: 'tools',
      }),
      await products.declare(sku('ACME-001'), {
        name: 'A better widget',
        category: null,
      }),
    ]);

    expect(outcomes).toEqual(['created', 'updated']);

    const listed = await inTenant(tenant, ({ products }) => products.list());
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('A better widget');
  });

  it('moves `updated_at` forward and leaves `created_at` alone', async () => {
    const tenant = tenantId((await seedTenant()).id);
    await inTenant(tenant, ({ products }) =>
      products.declare(sku('ACME-001'), { name: 'A widget', category: null }),
    );
    const [first] = await inTenant(tenant, ({ products }) => products.list());

    await inTenant(tenant, ({ products }) =>
      products.declare(sku('ACME-001'), { name: 'Renamed', category: null }),
    );
    const [second] = await inTenant(tenant, ({ products }) => products.list());

    expect(second?.createdAt).toEqual(first?.createdAt);
    expect(second?.updatedAt.getTime()).toBeGreaterThan(
      first?.updatedAt.getTime() ?? 0,
    );
  });

  it('lets two tenants hold the same SKU', async () => {
    const acme = tenantId((await seedTenant()).id);
    const globex = tenantId((await seedTenant()).id);

    await inTenant(acme, ({ products }) =>
      products.declare(sku('ACME-001'), { name: 'Mine', category: null }),
    );
    await expect(
      inTenant(globex, ({ products }) =>
        products.declare(sku('ACME-001'), { name: 'Theirs', category: null }),
      ),
    ).resolves.toBe('created');

    const mine = await inTenant(acme, ({ products }) => products.list());
    expect(mine.map((product) => product.name)).toEqual(['Mine']);
  });

  it('shows one tenant nothing of another, and admits nothing of theirs exists', async () => {
    const acme = tenantId((await seedTenant()).id);
    const globex = tenantId((await seedTenant()).id);
    await inTenant(globex, ({ products }) =>
      products.declare(sku('GLOBEX-9'), { name: 'Theirs', category: null }),
    );

    const seen = await inTenant(acme, ({ products }) => products.list());
    const known = await inTenant(acme, ({ products }) =>
      products.declared([sku('GLOBEX-9')]),
    );

    expect(seen).toEqual([]);
    // The same answer a SKU that exists nowhere would get. Membership is the
    // only thing this method reports, so there is no channel for it to say
    // more.
    expect(known).toEqual(new Set());
  });

  it('answers membership for exactly the codes asked about', async () => {
    const tenant = tenantId((await seedTenant()).id);
    await inTenant(tenant, async ({ products }) => {
      await products.declare(sku('A-1'), { name: 'One', category: null });
      await products.declare(sku('A-2'), { name: 'Two', category: null });
    });

    const known = await inTenant(tenant, ({ products }) =>
      products.declared([sku('A-2'), sku('A-404')]),
    );
    expect(known).toEqual(new Set(['A-2']));
  });

  it('asks the database nothing when asked about no codes', async () => {
    const tenant = tenantId((await seedTenant()).id);
    await expect(
      inTenant(tenant, ({ products }) => products.declared([])),
    ).resolves.toEqual(new Set());
  });

  it('keeps places by the same rules', async () => {
    const tenant = tenantId((await seedTenant()).id);

    const outcomes = await inTenant(tenant, async ({ locations }) => [
      await locations.declare(locationCode('WH-1'), { name: 'Main' }),
      await locations.declare(locationCode('WH-1'), { name: 'Main warehouse' }),
    ]);

    expect(outcomes).toEqual(['created', 'updated']);
    const listed = await inTenant(tenant, ({ locations }) => locations.list());
    expect(listed).toEqual([
      expect.objectContaining({ code: 'WH-1', name: 'Main warehouse' }),
    ]);
  });
});
