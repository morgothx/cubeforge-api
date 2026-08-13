import {
  createIdentityTestContext,
  type IdentityTestContext,
} from '../../adapters/testing/identity-test-context';
import { tenantId as toTenantId } from '../../domain/identifiers';
import { DeactivateTenantUseCase } from './deactivate-tenant.use-case';

describe('deactivating a tenant', () => {
  let context: IdentityTestContext;
  let deactivate: DeactivateTenantUseCase;

  beforeEach(() => {
    context = createIdentityTestContext();
    deactivate = new DeactivateTenantUseCase(context.platform);
  });

  it('marks the tenant inactive while retaining it and its members', async () => {
    const tenantId = await context.seedTenant('Acme');
    await context.seedMember({
      tenantId,
      email: 'admin@example.com',
      role: 'admin',
    });

    await deactivate.execute({ actor: context.operator, tenantId });

    expect(context.store.tenants.get(tenantId)?.status).toBe('inactive');
    expect(context.store.memberships.size).toBe(1);
    expect(context.store.people.size).toBe(1);
  });

  it('treats deactivating an already inactive tenant as success', async () => {
    const tenantId = await context.seedTenant('Acme');
    await deactivate.execute({ actor: context.operator, tenantId });
    const before = context.store.tenants.get(tenantId);

    await expect(
      deactivate.execute({ actor: context.operator, tenantId }),
    ).resolves.toBeUndefined();
    expect(context.store.tenants.get(tenantId)).toEqual(before);
  });

  it('reports an unknown tenant as absent', async () => {
    const attempt = deactivate.execute({
      actor: context.operator,
      tenantId: toTenantId('no-such-tenant'),
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'not-found' },
    });
  });

  it('denies deactivation to anyone who is not a platform operator', async () => {
    const tenantId = await context.seedTenant('Acme');
    const admin = await context.seedMember({
      tenantId,
      email: 'admin@example.com',
      role: 'admin',
    });

    const attempt = deactivate.execute({
      actor: context.actingAs(tenantId, admin),
      tenantId,
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'forbidden' },
    });
    expect(context.store.tenants.get(tenantId)?.status).toBe('active');
  });
});
