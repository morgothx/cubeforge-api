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
      context.tenantScoped,
      context.clock,
      context.identifiers,
    );
    list = new ListTenantsUseCase(context.platform);
  });

  it('creates an active tenant and records when it was created', async () => {
    const { tenant, administratorPersonId } = await provision.execute({
      actor: context.operator,
      name: 'Acme',
      administratorEmail: 'founder@example.com',
    });

    expect(tenant).toMatchObject({
      name: 'Acme',
      status: 'active',
      createdAt: TEST_MOMENT,
    });
    expect(tenant.id).toBeDefined();
    // Returned so the operator can issue this administrator a setup token.
    // Without it a freshly provisioned tenant has nobody able to sign in to it.
    expect(context.store.people.get(administratorPersonId)?.email).toBe(
      'founder@example.com',
    );
  });

  it('rejects a name already in use', async () => {
    await provision.execute({
      actor: context.operator,
      name: 'Acme',
      administratorEmail: 'founder@example.com',
    });

    const attempt = provision.execute({
      actor: context.operator,
      name: 'Acme',
      administratorEmail: 'founder@example.com',
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'tenant-name-taken' },
    });
  });

  it('rejects a blank name, naming the attribute at fault', async () => {
    const attempt = provision.execute({
      actor: context.operator,
      name: '   ',
      administratorEmail: 'founder@example.com',
    });

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
      administratorEmail: 'founder@example.com',
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

describe('provisioning a tenant with its first administrator', () => {
  let context: IdentityTestContext;
  let provision: ProvisionTenantUseCase;

  beforeEach(() => {
    context = createIdentityTestContext();
    provision = new ProvisionTenantUseCase(
      context.platform,
      context.tenantScoped,
      context.clock,
      context.identifiers,
    );
  });

  it('grants the named person an active administrator membership', async () => {
    const { tenant } = await provision.execute({
      actor: context.operator,
      name: 'Acme',
      administratorEmail: 'founder@example.com',
    });

    const membership = [...context.store.memberships.values()];
    expect(membership).toHaveLength(1);
    expect(membership[0]).toMatchObject({
      tenantId: tenant.id,
      role: 'admin',
      status: 'active',
    });
    const person = context.store.people.get(membership[0].personId);
    expect(person?.email).toBe('founder@example.com');
  });

  /** Requirement 8.3, inherited from the identity feature's 4.3. */
  it('answers identically whether or not the address was already known', async () => {
    const existing = await provision.execute({
      actor: context.operator,
      name: 'Globex',
      administratorEmail: 'shared@example.com',
    });

    const known = await provision.execute({
      actor: context.operator,
      name: 'Acme',
      administratorEmail: 'shared@example.com',
    });
    const unknown = await provision.execute({
      actor: context.operator,
      name: 'Initech',
      administratorEmail: 'brand-new@example.com',
    });

    // The shape, not the values: the administrator's identifier necessarily
    // differs between a person who already existed and one just created, and
    // the operator typed both addresses themselves, so it tells them nothing
    // the request did not already say.
    expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
    expect(existing.tenant.id).not.toBe(known.tenant.id);
    // The known address created no second person, and nothing in the response
    // says so.
    expect(context.store.people.size).toBe(2);
  });

  it('creates neither tenant nor membership when the name is taken', async () => {
    await provision.execute({
      actor: context.operator,
      name: 'Acme',
      administratorEmail: 'founder@example.com',
    });
    const before = context.store.memberships.size;

    await expect(
      provision.execute({
        actor: context.operator,
        name: 'Acme',
        administratorEmail: 'someone-else@example.com',
      }),
    ).rejects.toMatchObject({ error: { kind: 'tenant-name-taken' } });

    expect(context.store.tenants.size).toBe(1);
    expect(context.store.memberships.size).toBe(before);
  });

  it('rejects a malformed administrator address before creating anything', async () => {
    await expect(
      provision.execute({
        actor: context.operator,
        name: 'Acme',
        administratorEmail: 'not-an-address',
      }),
    ).rejects.toMatchObject({
      error: { kind: 'validation', field: 'administratorEmail' },
    });

    expect(context.store.tenants.size).toBe(0);
  });

  it('establishes no credential', async () => {
    await provision.execute({
      actor: context.operator,
      name: 'Acme',
      administratorEmail: 'founder@example.com',
    });

    expect(context.credentials.passwords.size).toBe(0);
    expect(context.credentials.setupTokens.size).toBe(0);
  });
});
