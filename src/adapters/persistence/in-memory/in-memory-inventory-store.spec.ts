import type { ProductAttributes } from '../../../application/ports/product.repository';
import { tenantId } from '../../../domain/identifiers';
import { InMemoryApiKeyStore } from './in-memory-api-key-store';
import { InMemoryIdentityStore } from './in-memory-identity-store';
import { InMemoryTenantScopedUnitOfWork } from './in-memory-tenant-scoped-unit-of-work';
import {
  externalMovementId,
  locationCode,
  sku,
} from '../../../domain/inventory/identifiers';
import type { Sku } from '../../../domain/inventory/identifiers';
import type { SubmittedMovement } from '../../../domain/inventory/movement';
import {
  InMemoryInventoryStore,
  InMemoryMovementRepository,
  InMemoryReferenceRepository,
} from './in-memory-inventory-store';

const acme = tenantId('018f2c00-0000-7000-8000-000000000001');
const globex = tenantId('018f2c00-0000-7000-8000-000000000002');

describe('the catalogue double', () => {
  let store: InMemoryInventoryStore;
  let clock: Date;

  const catalogueOf = (tenant: typeof acme) =>
    new InMemoryReferenceRepository<Sku, ProductAttributes>(
      store.products,
      tenant,
      () => clock,
    );

  beforeEach(() => {
    store = new InMemoryInventoryStore();
    clock = new Date('2026-08-25T10:00:00.000Z');
  });

  const widget: ProductAttributes = { name: 'A widget', category: 'tools' };

  it('records a product that was not there', async () => {
    await expect(
      catalogueOf(acme).declare(sku('ACME-001'), widget),
    ).resolves.toBe('created');
  });

  it('replaces one that was, rather than keeping two', async () => {
    const catalogue = catalogueOf(acme);
    await catalogue.declare(sku('ACME-001'), widget);

    await expect(
      catalogue.declare(sku('ACME-001'), {
        name: 'A better widget',
        category: null,
      }),
    ).resolves.toBe('updated');

    const listed = await catalogue.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('A better widget');
  });

  it('keeps the moment it was first declared when replacing it', async () => {
    const catalogue = catalogueOf(acme);
    await catalogue.declare(sku('ACME-001'), widget);

    clock = new Date('2026-08-26T10:00:00.000Z');
    await catalogue.declare(sku('ACME-001'), widget);

    const [product] = await catalogue.list();
    expect(product?.createdAt).toEqual(new Date('2026-08-25T10:00:00.000Z'));
    expect(product?.updatedAt).toEqual(new Date('2026-08-26T10:00:00.000Z'));
  });

  it('lets two tenants hold the same SKU, meaning different things', async () => {
    await catalogueOf(acme).declare(sku('ACME-001'), widget);
    await catalogueOf(globex).declare(sku('ACME-001'), {
      name: 'Something else entirely',
      category: null,
    });

    const [mine] = await catalogueOf(acme).list();
    const [theirs] = await catalogueOf(globex).list();
    expect(mine?.name).toBe('A widget');
    expect(theirs?.name).toBe('Something else entirely');
  });

  it('shows one tenant nothing of another', async () => {
    // The double is keyed by tenant and code, never code alone, so a use case
    // that forgets its scope fails here exactly as it would fail against the
    // database. A more permissive double lets through the bug it exists to
    // catch.
    await catalogueOf(globex).declare(sku('GLOBEX-9'), widget);

    await expect(catalogueOf(acme).list()).resolves.toEqual([]);
    await expect(
      catalogueOf(acme).declared([sku('GLOBEX-9')]),
    ).resolves.toEqual(new Set());
  });

  it('answers membership for exactly the codes asked about', async () => {
    const catalogue = catalogueOf(acme);
    await catalogue.declare(sku('ACME-001'), widget);
    await catalogue.declare(sku('ACME-002'), widget);

    await expect(
      catalogue.declared([sku('ACME-002'), sku('ACME-404')]),
    ).resolves.toEqual(new Set([sku('ACME-002')]));
  });

  it('asks nothing when asked about nothing', async () => {
    await expect(catalogueOf(acme).declared([])).resolves.toEqual(new Set());
  });

  it('offers no way to delete', () => {
    // Movements point at these rows, and the database grants no deletion
    // either. Two absences, so restoring one by accident is not enough.
    expect('delete' in catalogueOf(acme)).toBe(false);
  });
});

describe('the movement stream double', () => {
  let store: InMemoryInventoryStore;

  const streamOf = (tenant: typeof acme) =>
    new InMemoryMovementRepository(store, tenant);

  beforeEach(() => {
    store = new InMemoryInventoryStore();
  });

  const movement = (
    externalId: string,
    overrides: Partial<SubmittedMovement> = {},
  ): SubmittedMovement => ({
    externalId: externalMovementId(externalId),
    sku: sku('ACME-001'),
    location: locationCode('WH-1'),
    kind: 'receipt',
    quantity: 5,
    occurredAt: new Date('2026-08-25T10:00:00.000Z'),
    ...overrides,
  });

  it('reports back only what it newly recorded', async () => {
    await expect(
      streamOf(acme).record([movement('ERP-1'), movement('ERP-2')]),
    ).resolves.toEqual(new Set(['ERP-1', 'ERP-2']));
  });

  it('records nothing the second time, and says so', async () => {
    // The distinction the whole retry story rests on. A double that returned
    // everything submitted would make every replay test pass against a broken
    // implementation.
    const stream = streamOf(acme);
    await stream.record([movement('ERP-1')]);

    await expect(stream.record([movement('ERP-1')])).resolves.toEqual(
      new Set(),
    );
    await expect(stream.stockOnHand()).resolves.toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: 5 },
    ]);
  });

  it('records only the part of a resubmitted batch that is new', async () => {
    const stream = streamOf(acme);
    await stream.record([movement('ERP-1')]);

    await expect(
      stream.record([movement('ERP-1'), movement('ERP-2')]),
    ).resolves.toEqual(new Set(['ERP-2']));
  });

  it('lets a different tenant use the same identifier', async () => {
    await streamOf(acme).record([movement('ERP-1')]);

    await expect(streamOf(globex).record([movement('ERP-1')])).resolves.toEqual(
      new Set(['ERP-1']),
    );
  });

  it('sums per product and place, keeping a pairing that cancels out', async () => {
    await streamOf(acme).record([
      movement('ERP-1', { kind: 'receipt', quantity: 5 }),
      movement('ERP-2', { kind: 'sale', quantity: -5 }),
      movement('ERP-3', { location: locationCode('WH-2'), quantity: 3 }),
    ]);

    await expect(streamOf(acme).stockOnHand()).resolves.toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: 0 },
      { sku: 'ACME-001', location: 'WH-2', onHand: 3 },
    ]);
  });

  it('lets a total go negative', async () => {
    // The platform records what a source system reports. Deciding what is
    // possible in that system's warehouse is not its job.
    await streamOf(acme).record([
      movement('ERP-1', { kind: 'sale', quantity: -9 }),
    ]);

    await expect(streamOf(acme).stockOnHand()).resolves.toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: -9 },
    ]);
  });

  it('shows one tenant nothing of another', async () => {
    await streamOf(globex).record([movement('ERP-1')]);

    await expect(streamOf(acme).stockOnHand()).resolves.toEqual([]);
  });
});

describe('the tenant-scoped seam, carrying inventory', () => {
  const acmeId = tenantId('018f2c00-0000-7000-8000-000000000001');

  function seam(): InMemoryTenantScopedUnitOfWork {
    return new InMemoryTenantScopedUnitOfWork(
      new InMemoryIdentityStore(),
      new InMemoryApiKeyStore(),
      new InMemoryInventoryStore(),
    );
  }

  it('hands out all three inside a tenant', async () => {
    const named = await seam().runInTenant(acmeId, (repositories) =>
      Promise.resolve(Object.keys(repositories)),
    );

    expect(named).toEqual(
      expect.arrayContaining(['products', 'locations', 'movements']),
    );
  });

  it('leaves nothing behind when the work rejects', async () => {
    // A use case that refuses a request must leave the tenant as it found it.
    // Inventory is a second store, and restoring only the first would let
    // exactly that bug through — the reason the rollback names both.
    const unitOfWork = seam();

    await expect(
      unitOfWork.runInTenant(acmeId, async ({ products, movements }) => {
        await products.declare(sku('ACME-001'), {
          name: 'A widget',
          category: null,
        });
        await movements.record([
          {
            externalId: externalMovementId('ERP-1'),
            sku: sku('ACME-001'),
            location: locationCode('WH-1'),
            kind: 'receipt',
            quantity: 5,
            occurredAt: new Date('2026-08-25T10:00:00.000Z'),
          },
        ]);
        throw new Error('the use case refused');
      }),
    ).rejects.toThrow('the use case refused');

    const after = await unitOfWork.runInTenant(
      acmeId,
      async ({ products, movements }) => ({
        products: await products.list(),
        stock: await movements.stockOnHand(),
      }),
    );

    expect(after).toEqual({ products: [], stock: [] });
  });
});
