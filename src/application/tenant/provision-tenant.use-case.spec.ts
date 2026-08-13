import {
  createIdentityTestContext,
  TEST_MOMENT,
  type IdentityTestContext,
} from '../../adapters/testing/identity-test-context';
import { DomainViolation } from '../../domain/errors';
import { ListTenantsUseCase } from './list-tenants.use-case';
import { ProvisionTenantUseCase } from './provision-tenant.use-case';

describe('provisioning and listing tenants', () => {
  let context: IdentityTestContext;
  let provision: ProvisionTenantUseCase;
  let list: ListTenantsUseCase;

  beforeEach(() => {
    context = createIdentityTestContext();
    provision = new ProvisionTenantUseCase(
      context.platform,
      context.clock,
      context.identifiers,
    );
    list = new ListTenantsUseCase(context.platform);
  });

  it('creates an active tenant and records when it was created', async () => {
    const tenant = await provision.execute({
      actor: context.operator,
      name: 'Acme',
    });

    expect(tenant).toMatchObject({
      name: 'Acme',
      status: 'active',
      createdAt: TEST_MOMENT,
    });
    expect(tenant.id).toBeDefined();
  });

  it('rejects a name already in use', async () => {
    await provision.execute({ actor: context.operator, name: 'Acme' });

    const attempt = provision.execute({
      actor: context.operator,
      name: 'Acme',
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'tenant-name-taken' },
    });
  });

  it('rejects a blank name, naming the attribute at fault', async () => {
    const attempt = provision.execute({ actor: context.operator, name: '   ' });

    await expect(attempt).rejects.toThrow(DomainViolation);
    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'validation', field: 'name' },
    });
  });

  it('denies tenant creation to anyone who is not a platform operator', async () => {
    const tenantId = await context.seedTenant('Acme');
    const admin = await context.seedMember({
      tenantId,
      email: 'admin@example.com',
      role: 'admin',
    });

    const attempt = provision.execute({
      actor: context.actingAs(tenantId, admin),
      name: 'Globex',
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'forbidden' },
    });
    expect(context.store.tenants.size).toBe(1);
  });

  it('lists tenants for an operator without disclosing who belongs to them', async () => {
    const tenantId = await context.seedTenant('Acme');
    await context.seedMember({
      tenantId,
      email: 'admin@example.com',
      role: 'admin',
    });
    await context.seedTenant('Globex');

    const tenants = await list.execute({ actor: context.operator });

    expect(tenants.map((tenant) => tenant.name).sort()).toEqual([
      'Acme',
      'Globex',
    ]);
    // Requirement 3.3: nothing in a listing may indicate tenant participation.
    const disclosed = JSON.stringify(tenants);
    expect(disclosed).not.toContain('admin@example.com');
    expect(disclosed).not.toContain('membership');
  });

  it('denies listing to anyone who is not a platform operator', async () => {
    const tenantId = await context.seedTenant('Acme');
    const admin = await context.seedMember({
      tenantId,
      email: 'admin@example.com',
      role: 'admin',
    });

    await expect(
      list.execute({ actor: context.actingAs(tenantId, admin) }),
    ).rejects.toMatchObject({ error: { kind: 'forbidden' } });
  });
});
