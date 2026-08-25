import {
  createIdentityTestContext,
  type IdentityTestContext,
} from '../../adapters/testing/identity-test-context';
import type { TenantId } from '../../domain/identifiers';
import { locationCode, sku } from '../../domain/inventory/identifiers';
import type { Role } from '../../domain/membership/role';
import type { ActorContext } from '../actor-context';
import { DeclareLocationUseCase } from './declare-location.use-case';
import { DeclareProductUseCase } from './declare-product.use-case';
import { ReadStockOnHandUseCase } from './read-stock-on-hand.use-case';
import {
  RecordMovementsUseCase,
  type SubmittedRow,
} from './record-movements.use-case';

function row(overrides: Partial<SubmittedRow> = {}): SubmittedRow {
  return {
    externalId: `ERP-${Math.random()}`,
    sku: 'ACME-001',
    location: 'WH-1',
    kind: 'receipt',
    quantity: 5,
    occurredAt: '2025-12-25T10:00:00.000Z',
    ...overrides,
  };
}

describe('reading what is on hand', () => {
  let context: IdentityTestContext;
  let acme: TenantId;
  let globex: TenantId;
  let record: RecordMovementsUseCase;
  let stock: ReadStockOnHandUseCase;

  const machineIn = (
    tenant: TenantId,
    role: Role = 'editor',
  ): ActorContext => ({
    kind: 'machine',
    apiKeyId: context.identifiers.apiKeyId(),
    tenantId: tenant,
    role,
  });

  async function catalogueFor(tenant: TenantId): Promise<void> {
    await new DeclareProductUseCase(context.tenantScoped).execute({
      actor: machineIn(tenant),
      sku: sku('ACME-001'),
      name: 'A widget',
      category: null,
    });
    for (const code of ['WH-1', 'WH-2']) {
      await new DeclareLocationUseCase(context.tenantScoped).execute({
        actor: machineIn(tenant),
        code: locationCode(code),
        name: code,
      });
    }
  }

  beforeEach(async () => {
    context = createIdentityTestContext();
    acme = await context.seedTenant('Acme');
    globex = await context.seedTenant('Globex');
    record = new RecordMovementsUseCase(context.tenantScoped, context.clock);
    stock = new ReadStockOnHandUseCase(context.tenantScoped);
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

  it('answers a viewer, who may read but not record', async () => {
    await submit([row({ quantity: 4 })]);
    const viewer = context.actingAs(
      acme,
      await context.seedMember({
        tenantId: acme,
        role: 'viewer',
        email: 'viewer@example.com',
      }),
    );

    await expect(stock.execute({ actor: viewer })).resolves.toEqual([
      { sku: 'ACME-001', location: 'WH-1', onHand: 4 },
    ]);
    await expect(
      record.execute({ actor: viewer, movements: [row()] }),
    ).rejects.toMatchObject({ error: { kind: 'forbidden' } });
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
      stock.execute({ actor: context.operator }),
    ).rejects.toMatchObject({ error: { kind: 'not-found' } });
  });
});
