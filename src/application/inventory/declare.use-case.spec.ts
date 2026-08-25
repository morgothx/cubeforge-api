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
import { ListProductsUseCase } from './list-products.use-case';

/**
 * Built on the real test context rather than on bare stores.
 *
 * The first draft of this suite wired the unit of work by hand and used actors
 * naming tenants that had never been provisioned. Every test passed, because
 * nothing then resolved a tenant or a role — which is exactly what those tests
 * were failing to cover.
 */
describe('declaring what a tenant tracks', () => {
  let context: IdentityTestContext;
  let acme: TenantId;
  let globex: TenantId;
  let products: DeclareProductUseCase;
  let locations: DeclareLocationUseCase;
  let catalogue: ListProductsUseCase;

  const machineIn = (
    tenant: TenantId,
    role: Role = 'editor',
  ): ActorContext => ({
    kind: 'machine',
    apiKeyId: context.identifiers.apiKeyId(),
    tenantId: tenant,
    role,
  });

  async function personIn(tenant: TenantId, role: Role): Promise<ActorContext> {
    const personId = await context.seedMember({
      tenantId: tenant,
      role,
      email: `${role}-${tenant.slice(0, 8)}@example.com`,
    });
    return context.actingAs(tenant, personId);
  }

  beforeEach(async () => {
    context = createIdentityTestContext();
    acme = await context.seedTenant('Acme');
    globex = await context.seedTenant('Globex');
    products = new DeclareProductUseCase(context.tenantScoped);
    locations = new DeclareLocationUseCase(context.tenantScoped);
    catalogue = new ListProductsUseCase(context.tenantScoped);
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

    await expect(
      catalogue.execute({ actor: machineIn(acme) }),
    ).resolves.toEqual([
      expect.objectContaining({ code: 'ACME-001', name: 'A better widget' }),
    ]);
  });

  it('admits an editor who is a person as readily as one that is a key', async () => {
    await expect(
      products.execute({ actor: await personIn(acme, 'editor'), ...widget }),
    ).resolves.toBe('created');
  });

  describe('roles, enforced here and not only at the edge', () => {
    it('refuses a viewer who is a person', async () => {
      await expect(
        products.execute({ actor: await personIn(acme, 'viewer'), ...widget }),
      ).rejects.toMatchObject({ error: { kind: 'forbidden' } });
    });

    it('refuses a key carrying viewer', async () => {
      // A key's role is a claim its credential carries rather than a membership
      // to resolve, so it needs its own comparison — and it gets one, or a
      // read-only integration could write.
      await expect(
        products.execute({ actor: machineIn(acme, 'viewer'), ...widget }),
      ).rejects.toMatchObject({ error: { kind: 'forbidden' } });
    });

    it('admits an administrator', async () => {
      await expect(
        products.execute({ actor: machineIn(acme, 'admin'), ...widget }),
      ).resolves.toBe('created');
    });
  });

  it('refuses a key whose tenant has since been deactivated', async () => {
    // A credential outliving the thing it was issued for. The membership path
    // already refuses this for people; a key has no membership, so the tenant
    // has to be checked on its own.
    const doomed = await context.seedTenant('Doomed');
    await context.platform.runAsOperator(async ({ tenants }) => {
      const tenant = await tenants.findById(doomed);
      await tenants.updateStatus(doomed, 'inactive');
      expect(tenant).not.toBeNull();
    });

    await expect(
      products.execute({ actor: machineIn(doomed), ...widget }),
    ).rejects.toMatchObject({ error: { kind: 'not-found' } });
  });

  it('declares into the caller tenant, never one the payload names', async () => {
    // The command carries no tenant at all, so "a caller in Acme declaring into
    // Globex" is not expressible rather than merely refused.
    await products.execute({ actor: machineIn(acme), ...widget });

    await expect(
      catalogue.execute({ actor: machineIn(globex) }),
    ).resolves.toEqual([]);
  });

  it('refuses an operator, who acts in no tenant', async () => {
    await expect(
      products.execute({ actor: context.operator, ...widget }),
    ).rejects.toMatchObject({ error: { kind: 'not-found' } });
  });

  it('refuses a person acting in no tenant', async () => {
    await expect(
      products.execute({ actor: context.person, ...widget }),
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
