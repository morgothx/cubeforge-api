import { InMemoryApiKeyStore } from '../../adapters/persistence/in-memory/in-memory-api-key-store';
import { InMemoryIdentityStore } from '../../adapters/persistence/in-memory/in-memory-identity-store';
import { InMemoryInventoryStore } from '../../adapters/persistence/in-memory/in-memory-inventory-store';
import { InMemoryTenantScopedUnitOfWork } from '../../adapters/persistence/in-memory/in-memory-tenant-scoped-unit-of-work';
import { FixedClock } from '../../adapters/testing/fixed-clock';
import { apiKeyId, personId, tenantId } from '../../domain/identifiers';
import { locationCode, sku } from '../../domain/inventory/identifiers';
import type { ActorContext } from '../actor-context';
import { DeclareLocationUseCase } from './declare-location.use-case';
import { DeclareProductUseCase } from './declare-product.use-case';
import { ReadStockOnHandUseCase } from './read-stock-on-hand.use-case';
import {
  RecordMovementsUseCase,
  type SubmittedRow,
} from './record-movements.use-case';

const acme = tenantId('018f2c00-0000-7000-8000-000000000001');
const globex = tenantId('018f2c00-0000-7000-8000-000000000002');
const NOW = new Date('2026-08-25T12:00:00.000Z');

const machineIn = (tenant: typeof acme): ActorContext => ({
  kind: 'machine',
  apiKeyId: apiKeyId('018f2c00-0000-7000-8000-00000000000a'),
  tenantId: tenant,
  role: 'editor',
});

const viewerIn = (tenant: typeof acme): ActorContext => ({
  kind: 'tenant-member',
  personId: personId('018f2c00-0000-7000-8000-00000000000b'),
  tenantId: tenant,
});

function row(overrides: Partial<SubmittedRow> = {}): SubmittedRow {
  return {
    externalId: `ERP-${Math.random()}`,
    sku: 'ACME-001',
    location: 'WH-1',
    kind: 'receipt',
    quantity: 5,
    occurredAt: '2026-08-25T10:00:00.000Z',
    ...overrides,
  };
}

describe('reading what is on hand', () => {
  let unitOfWork: InMemoryTenantScopedUnitOfWork;
  let record: RecordMovementsUseCase;
  let stock: ReadStockOnHandUseCase;

  async function catalogueFor(tenant: typeof acme): Promise<void> {
    await new DeclareProductUseCase(unitOfWork).execute({
      actor: machineIn(tenant),
      sku: sku('ACME-001'),
      name: 'A widget',
      category: null,
    });
    for (const code of ['WH-1', 'WH-2']) {
      await new DeclareLocationUseCase(unitOfWork).execute({
        actor: machineIn(tenant),
        code: locationCode(code),
        name: code,
      });
    }
  }

  beforeEach(async () => {
    unitOfWork = new InMemoryTenantScopedUnitOfWork(
      new InMemoryIdentityStore(),
      new InMemoryApiKeyStore(),
      new InMemoryInventoryStore(),
    );
    record = new RecordMovementsUseCase(unitOfWork, new FixedClock(NOW));
    stock = new ReadStockOnHandUseCase(unitOfWork);
    await catalogueFor(acme);
  });

  const submit = (rows: readonly SubmittedRow[], tenant = acme) =>
    record.execute({ actor: machineIn(tenant), movements: rows });

  it('sums what arrived and what left', async () => {
    await submit([
      row({ kind: 'receipt', quantity: 10 }),
      row({ kind: 'sale', quantity: -3 }),
    ]);

    await expect(stock.execute({ actor: machineIn(acme) })).resolves.toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: 7 },
    ]);
  });

  it('reports a pairing that cancels out as zero, rather than omitting it', async () => {
    // Zero is a fact about a product that moved. Omitting it would make "we
    // sold everything" indistinguishable from "we never stocked it".
    await submit([
      row({ kind: 'receipt', quantity: 5 }),
      row({ kind: 'sale', quantity: -5 }),
    ]);

    await expect(stock.execute({ actor: machineIn(acme) })).resolves.toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: 0 },
    ]);
  });

  it('lets a total go below zero', async () => {
    // The platform records what a source system reports. Deciding what is
    // possible in that system's warehouse is not its job, and refusing the sale
    // would mean the platform silently disagreeing with the books it mirrors.
    await submit([
      row({ kind: 'receipt', quantity: 2 }),
      row({ kind: 'sale', quantity: -9 }),
    ]);

    await expect(stock.execute({ actor: machineIn(acme) })).resolves.toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: -7 },
    ]);
  });

  it('keeps places apart', async () => {
    await submit([
      row({ quantity: 4 }),
      row({ location: 'WH-2', quantity: 6 }),
    ]);

    await expect(stock.execute({ actor: machineIn(acme) })).resolves.toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: 4 },
      { sku: 'ACME-001', location: 'WH-2', onHand: 6 },
    ]);
  });

  it('says nothing about a product that never moved', async () => {
    // A declared product with no movements has no place to be counted at, so it
    // yields no row. Named here because a dashboard may later want the
    // catalogue with zeroes, and that is a join this feature does not do.
    await expect(stock.execute({ actor: machineIn(acme) })).resolves.toEqual(
      [],
    );
  });

  it('answers a person as readily as a machine', async () => {
    await submit([row({ quantity: 4 })]);

    await expect(stock.execute({ actor: viewerIn(acme) })).resolves.toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: 4 },
    ]);
  });

  it('shows one tenant nothing of another', async () => {
    await catalogueFor(globex);
    await submit([row({ quantity: 99 })], globex);

    await expect(stock.execute({ actor: machineIn(acme) })).resolves.toEqual(
      [],
    );
  });

  it('refuses a caller who acts in no tenant', async () => {
    await expect(
      stock.execute({
        actor: {
          kind: 'platform-operator',
          personId: personId('018f2c00-0000-7000-8000-00000000000f'),
        },
      }),
    ).rejects.toMatchObject({ error: { kind: 'not-found' } });
  });
});
