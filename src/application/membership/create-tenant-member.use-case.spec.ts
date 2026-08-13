import {
  createIdentityTestContext,
  type IdentityTestContext,
} from '../../adapters/testing/identity-test-context';
import { CreateTenantMemberUseCase } from './create-tenant-member.use-case';

describe('creating a member within a tenant', () => {
  let context: IdentityTestContext;
  let create: CreateTenantMemberUseCase;

  beforeEach(() => {
    context = createIdentityTestContext();
    create = new CreateTenantMemberUseCase(
      context.tenantScoped,
      context.clock,
      context.identifiers,
    );
  });

  it('creates the person and their membership when the address is new', async () => {
    const tenantId = await context.seedTenant('Acme');
    const admin = await context.seedMember({
      tenantId,
      email: 'admin@example.com',
      role: 'admin',
    });

    const result = await create.execute({
      actor: context.actingAs(tenantId, admin),
      email: 'newcomer@example.com',
      role: 'editor',
    });

    expect(result.role).toBe('editor');
    expect(context.store.people.size).toBe(2);
    expect(context.store.memberships.size).toBe(2);
  });

  /** Requirement 4.3, and the reason 4.2 exists at all. */
  it('produces an indistinguishable result whether or not the person existed', async () => {
    const acme = await context.seedTenant('Acme');
    const globex = await context.seedTenant('Globex');
    const acmeAdmin = await context.seedMember({
      tenantId: acme,
      email: 'admin@acme.example.com',
      role: 'admin',
    });
    await context.seedMember({
      tenantId: globex,
      email: 'known@example.com',
      role: 'viewer',
    });

    const knownElsewhere = await create.execute({
      actor: context.actingAs(acme, acmeAdmin),
      email: 'known@example.com',
      role: 'editor',
    });
    const brandNew = await create.execute({
      actor: context.actingAs(acme, acmeAdmin),
      email: 'unknown@example.com',
      role: 'editor',
    });

    expect(Object.keys(knownElsewhere).sort()).toEqual(
      Object.keys(brandNew).sort(),
    );
    expect(knownElsewhere.role).toBe(brandNew.role);
    // Two seeded plus one genuinely new: the known address created no second
    // person, which is what makes the two results the same shape.
    expect(context.store.people.size).toBe(3);
  });

  it('reuses the existing person rather than creating a duplicate', async () => {
    const acme = await context.seedTenant('Acme');
    const globex = await context.seedTenant('Globex');
    const acmeAdmin = await context.seedMember({
      tenantId: acme,
      email: 'admin@acme.example.com',
      role: 'admin',
    });
    const knownPerson = await context.seedMember({
      tenantId: globex,
      email: 'known@example.com',
      role: 'viewer',
    });

    const result = await create.execute({
      actor: context.actingAs(acme, acmeAdmin),
      email: 'KNOWN@example.com',
      role: 'editor',
    });

    expect(result.personId).toBe(knownPerson);
  });

  it('rejects a person who already holds a membership in this tenant', async () => {
    const tenantId = await context.seedTenant('Acme');
    const admin = await context.seedMember({
      tenantId,
      email: 'admin@example.com',
      role: 'admin',
    });
    await context.seedMember({
      tenantId,
      email: 'member@example.com',
      role: 'viewer',
    });

    const attempt = create.execute({
      actor: context.actingAs(tenantId, admin),
      email: 'member@example.com',
      role: 'editor',
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'already-a-member' },
    });
  });

  it('leaves nothing behind when the membership is rejected', async () => {
    const tenantId = await context.seedTenant('Acme');
    const admin = await context.seedMember({
      tenantId,
      email: 'admin@example.com',
      role: 'admin',
    });
    await context.seedMember({
      tenantId,
      email: 'member@example.com',
      role: 'viewer',
    });
    const peopleBefore = context.store.people.size;

    await expect(
      create.execute({
        actor: context.actingAs(tenantId, admin),
        email: 'member@example.com',
        role: 'editor',
      }),
    ).rejects.toBeDefined();

    expect(context.store.people.size).toBe(peopleBefore);
  });

  it('rejects a role outside the permitted set and reports them', async () => {
    const tenantId = await context.seedTenant('Acme');
    const admin = await context.seedMember({
      tenantId,
      email: 'admin@example.com',
      role: 'admin',
    });

    const attempt = create.execute({
      actor: context.actingAs(tenantId, admin),
      email: 'newcomer@example.com',
      role: 'superuser',
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'invalid-role', permitted: ['admin', 'editor', 'viewer'] },
    });
  });

  it('rejects a malformed email address, naming the attribute at fault', async () => {
    const tenantId = await context.seedTenant('Acme');
    const admin = await context.seedMember({
      tenantId,
      email: 'admin@example.com',
      role: 'admin',
    });

    const attempt = create.execute({
      actor: context.actingAs(tenantId, admin),
      email: 'not-an-address',
      role: 'viewer',
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'validation', field: 'email' },
    });
  });

  it('denies the operation to a member who is not an administrator', async () => {
    const tenantId = await context.seedTenant('Acme');
    await context.seedMember({
      tenantId,
      email: 'admin@example.com',
      role: 'admin',
    });
    const viewer = await context.seedMember({
      tenantId,
      email: 'viewer@example.com',
      role: 'viewer',
    });

    const attempt = create.execute({
      actor: context.actingAs(tenantId, viewer),
      email: 'newcomer@example.com',
      role: 'viewer',
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'forbidden' },
    });
  });

  /** Requirement 9.2: an outsider learns nothing, not even that they were refused. */
  it('reports absence, not refusal, to an administrator of another tenant', async () => {
    const acme = await context.seedTenant('Acme');
    const globex = await context.seedTenant('Globex');
    const globexAdmin = await context.seedMember({
      tenantId: globex,
      email: 'admin@globex.example.com',
      role: 'admin',
    });

    const attempt = create.execute({
      actor: { kind: 'tenant-member', personId: globexAdmin, tenantId: acme },
      email: 'newcomer@example.com',
      role: 'viewer',
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'not-found' },
    });
  });
});
