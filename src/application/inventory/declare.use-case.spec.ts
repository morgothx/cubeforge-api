import { apiKeyId, personId, tenantId } from '../../domain/identifiers';
import { locationCode, sku } from '../../domain/inventory/identifiers';
import { InMemoryApiKeyStore } from '../../adapters/persistence/in-memory/in-memory-api-key-store';
import { InMemoryIdentityStore } from '../../adapters/persistence/in-memory/in-memory-identity-store';
import { InMemoryInventoryStore } from '../../adapters/persistence/in-memory/in-memory-inventory-store';
import { InMemoryTenantScopedUnitOfWork } from '../../adapters/persistence/in-memory/in-memory-tenant-scoped-unit-of-work';
import type { ActorContext } from '../actor-context';
import { DeclareLocationUseCase } from './declare-location.use-case';
import { DeclareProductUseCase } from './declare-product.use-case';

const acme = tenantId('018f2c00-0000-7000-8000-000000000001');
const globex = tenantId('018f2c00-0000-7000-8000-000000000002');

const machineIn = (tenant: typeof acme): ActorContext => ({
  kind: 'machine',
  apiKeyId: apiKeyId('018f2c00-0000-7000-8000-00000000000a'),
  tenantId: tenant,
  role: 'editor',
});

const personIn = (tenant: typeof acme): ActorContext => ({
  kind: 'tenant-member',
  personId: personId('018f2c00-0000-7000-8000-00000000000b'),
  tenantId: tenant,
});

describe('declaring what a tenant tracks', () => {
  let unitOfWork: InMemoryTenantScopedUnitOfWork;
  let products: DeclareProductUseCase;
  let locations: DeclareLocationUseCase;
  let inventory: InMemoryInventoryStore;

  beforeEach(() => {
    inventory = new InMemoryInventoryStore();
    unitOfWork = new InMemoryTenantScopedUnitOfWork(
      new InMemoryIdentityStore(),
      new InMemoryApiKeyStore(),
      inventory,
    );
    products = new DeclareProductUseCase(unitOfWork);
    locations = new DeclareLocationUseCase(unitOfWork);
  });

  const widget = { sku: sku('ACME-001'), name: 'A widget', category: 'tools' };

  it('records a product a tenant has not declared', async () => {
    await expect(
      products.execute({ actor: machineIn(acme), ...widget }),
    ).resolves.toBe('created');
  });

  it('replaces one it has, rather than refusing', async () => {
    // An upstream system synchronises its whole catalogue every night and sends
    // every product every time. A conflict on the second night would mean the
    // integration works once.
    await products.execute({ actor: machineIn(acme), ...widget });

    await expect(
      products.execute({
        actor: machineIn(acme),
        sku: sku('ACME-001'),
        name: 'A better widget',
        category: null,
      }),
    ).resolves.toBe('updated');

    const listed = await unitOfWork.runInTenant(acme, ({ products: all }) =>
      all.list(),
    );
    expect(listed).toEqual([
      expect.objectContaining({ code: 'ACME-001', name: 'A better widget' }),
    ]);
  });

  it('admits a person as readily as a machine', async () => {
    // Both reach these routes. The difference between them is which roles they
    // may hold, and that is decided before a use case runs.
    await expect(
      products.execute({ actor: personIn(acme), ...widget }),
    ).resolves.toBe('created');
  });

  it('declares into the caller tenant, never one the payload names', async () => {
    // The command carries no tenant at all, so "a caller in Acme declaring into
    // Globex" is not expressible rather than merely refused.
    await products.execute({ actor: machineIn(acme), ...widget });

    const inGlobex = await unitOfWork.runInTenant(globex, ({ products: all }) =>
      all.list(),
    );
    expect(inGlobex).toEqual([]);
  });

  it('refuses an operator, who acts in no tenant', async () => {
    await expect(
      products.execute({
        actor: {
          kind: 'platform-operator',
          personId: personId('018f2c00-0000-7000-8000-00000000000c'),
        },
        ...widget,
      }),
    ).rejects.toMatchObject({ error: { kind: 'not-found' } });
  });

  it('refuses a person acting in no tenant', async () => {
    await expect(
      products.execute({
        actor: {
          kind: 'person',
          personId: personId('018f2c00-0000-7000-8000-00000000000d'),
        },
        ...widget,
      }),
    ).rejects.toMatchObject({ error: { kind: 'not-found' } });
  });

  it('keeps places by the same rules', async () => {
    const command = {
      actor: machineIn(acme),
      code: locationCode('WH-1'),
      name: 'Main',
    };

    await expect(locations.execute(command)).resolves.toBe('created');
    await expect(
      locations.execute({ ...command, name: 'Main warehouse' }),
    ).resolves.toBe('updated');
  });
});
