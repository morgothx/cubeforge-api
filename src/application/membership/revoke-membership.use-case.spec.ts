import {
  createIdentityTestContext,
  type IdentityTestContext,
} from '../../adapters/testing/identity-test-context';
import type {
  MembershipId,
  PersonId,
  TenantId,
} from '../../domain/identifiers';
import { RevokeMembershipUseCase } from './revoke-membership.use-case';

describe('revoking a membership', () => {
  let context: IdentityTestContext;
  let revoke: RevokeMembershipUseCase;

  beforeEach(() => {
    context = createIdentityTestContext();
    revoke = new RevokeMembershipUseCase(context.tenantScoped);
  });

  function membershipOf(tenantId: TenantId, personId: PersonId): MembershipId {
    const membership = [...context.store.memberships.values()].find(
      (candidate) =>
        candidate.tenantId === tenantId && candidate.personId === personId,
    );
    if (!membership) {
      throw new Error('no membership was seeded for this person');
    }
    return membership.id;
  }

  it('revokes here and leaves the same person active elsewhere', async () => {
    const acme = await context.seedTenant('Acme');
    const globex = await context.seedTenant('Globex');
    const admin = await context.seedMember({
      tenantId: acme,
      email: 'admin@example.com',
      role: 'admin',
    });
    const member = await context.seedMember({
      tenantId: acme,
      email: 'shared@example.com',
      role: 'viewer',
    });
    await context.seedMember({
      tenantId: globex,
      email: 'shared@example.com',
      role: 'editor',
    });

    await revoke.execute({
      actor: context.actingAs(acme, admin),
      membershipId: membershipOf(acme, member),
    });

    expect(
      context.store.memberships.get(membershipOf(acme, member))?.status,
    ).toBe('revoked');
    expect(
      context.store.memberships.get(membershipOf(globex, member))?.status,
    ).toBe('active');
  });

  it('refuses to revoke the last active administrator', async () => {
    const acme = await context.seedTenant('Acme');
    const admin = await context.seedMember({
      tenantId: acme,
      email: 'admin@example.com',
      role: 'admin',
    });

    const attempt = revoke.execute({
      actor: context.actingAs(acme, admin),
      membershipId: membershipOf(acme, admin),
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'last-administrator' },
    });
    expect(
      context.store.memberships.get(membershipOf(acme, admin))?.status,
    ).toBe('active');
  });

  it('permits revoking an administrator once another remains', async () => {
    const acme = await context.seedTenant('Acme');
    const admin = await context.seedMember({
      tenantId: acme,
      email: 'admin@example.com',
      role: 'admin',
    });
    const second = await context.seedMember({
      tenantId: acme,
      email: 'second@example.com',
      role: 'admin',
    });

    await revoke.execute({
      actor: context.actingAs(acme, admin),
      membershipId: membershipOf(acme, second),
    });

    expect(
      context.store.memberships.get(membershipOf(acme, second))?.status,
    ).toBe('revoked');
  });

  it('treats revoking an already revoked membership as success', async () => {
    const acme = await context.seedTenant('Acme');
    const admin = await context.seedMember({
      tenantId: acme,
      email: 'admin@example.com',
      role: 'admin',
    });
    const member = await context.seedMember({
      tenantId: acme,
      email: 'member@example.com',
      role: 'viewer',
    });
    const actor = context.actingAs(acme, admin);
    const membershipId = membershipOf(acme, member);

    await revoke.execute({ actor, membershipId });

    await expect(
      revoke.execute({ actor, membershipId }),
    ).resolves.toBeUndefined();
    expect(context.store.memberships.get(membershipId)?.status).toBe('revoked');
  });

  it('reports a membership in a tenant the actor does not administer as absent', async () => {
    const acme = await context.seedTenant('Acme');
    const globex = await context.seedTenant('Globex');
    const acmeAdmin = await context.seedMember({
      tenantId: acme,
      email: 'admin@acme.example.com',
      role: 'admin',
    });
    const outsider = await context.seedMember({
      tenantId: globex,
      email: 'outsider@example.com',
      role: 'viewer',
    });

    const attempt = revoke.execute({
      actor: context.actingAs(acme, acmeAdmin),
      membershipId: membershipOf(globex, outsider),
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'not-found' },
    });
    expect(
      context.store.memberships.get(membershipOf(globex, outsider))?.status,
    ).toBe('active');
  });

  it('denies revocation to a member who is not an administrator', async () => {
    const acme = await context.seedTenant('Acme');
    const admin = await context.seedMember({
      tenantId: acme,
      email: 'admin@example.com',
      role: 'admin',
    });
    const viewer = await context.seedMember({
      tenantId: acme,
      email: 'viewer@example.com',
      role: 'viewer',
    });

    const attempt = revoke.execute({
      actor: context.actingAs(acme, viewer),
      membershipId: membershipOf(acme, admin),
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'forbidden' },
    });
  });
});
