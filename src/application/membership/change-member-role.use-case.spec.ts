import {
  createIdentityTestContext,
  type IdentityTestContext,
} from '../../adapters/testing/identity-test-context';
import { membershipId as toMembershipId } from '../../domain/identifiers';
import type {
  MembershipId,
  PersonId,
  TenantId,
} from '../../domain/identifiers';
import { ChangeMemberRoleUseCase } from './change-member-role.use-case';

describe('changing a member role', () => {
  let context: IdentityTestContext;
  let change: ChangeMemberRoleUseCase;

  beforeEach(() => {
    context = createIdentityTestContext();
    change = new ChangeMemberRoleUseCase(context.tenantScoped);
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

  it('applies the new role to that membership only', async () => {
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
      role: 'viewer',
    });

    await change.execute({
      actor: context.actingAs(acme, admin),
      membershipId: membershipOf(acme, member),
      role: 'editor',
    });

    expect(
      context.store.memberships.get(membershipOf(acme, member))?.role,
    ).toBe('editor');
    expect(
      context.store.memberships.get(membershipOf(globex, member))?.role,
    ).toBe('viewer');
  });

  it('refuses to demote the last active administrator', async () => {
    const acme = await context.seedTenant('Acme');
    const admin = await context.seedMember({
      tenantId: acme,
      email: 'admin@example.com',
      role: 'admin',
    });

    const attempt = change.execute({
      actor: context.actingAs(acme, admin),
      membershipId: membershipOf(acme, admin),
      role: 'viewer',
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'last-administrator' },
    });
    expect(context.store.memberships.get(membershipOf(acme, admin))?.role).toBe(
      'admin',
    );
  });

  it('permits the demotion once another administrator remains', async () => {
    const acme = await context.seedTenant('Acme');
    const admin = await context.seedMember({
      tenantId: acme,
      email: 'admin@example.com',
      role: 'admin',
    });
    await context.seedMember({
      tenantId: acme,
      email: 'second@example.com',
      role: 'admin',
    });

    await change.execute({
      actor: context.actingAs(acme, admin),
      membershipId: membershipOf(acme, admin),
      role: 'viewer',
    });

    expect(context.store.memberships.get(membershipOf(acme, admin))?.role).toBe(
      'viewer',
    );
  });

  it('rejects a role outside the permitted set', async () => {
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

    const attempt = change.execute({
      actor: context.actingAs(acme, admin),
      membershipId: membershipOf(acme, member),
      role: 'owner',
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'invalid-role', permitted: ['admin', 'editor', 'viewer'] },
    });
  });

  it('reports a membership from another tenant as absent', async () => {
    const acme = await context.seedTenant('Acme');
    const globex = await context.seedTenant('Globex');
    const admin = await context.seedMember({
      tenantId: acme,
      email: 'admin@example.com',
      role: 'admin',
    });
    const outsider = await context.seedMember({
      tenantId: globex,
      email: 'outsider@example.com',
      role: 'viewer',
    });

    const attempt = change.execute({
      actor: context.actingAs(acme, admin),
      membershipId: membershipOf(globex, outsider),
      role: 'editor',
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'not-found' },
    });
    expect(
      context.store.memberships.get(membershipOf(globex, outsider))?.role,
    ).toBe('viewer');
  });

  it('reports an unknown membership as absent', async () => {
    const acme = await context.seedTenant('Acme');
    const admin = await context.seedMember({
      tenantId: acme,
      email: 'admin@example.com',
      role: 'admin',
    });

    const attempt = change.execute({
      actor: context.actingAs(acme, admin),
      membershipId: toMembershipId('no-such-membership'),
      role: 'editor',
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'not-found' },
    });
  });

  it('denies the change to a member who is not an administrator', async () => {
    const acme = await context.seedTenant('Acme');
    await context.seedMember({
      tenantId: acme,
      email: 'admin@example.com',
      role: 'admin',
    });
    const editor = await context.seedMember({
      tenantId: acme,
      email: 'editor@example.com',
      role: 'editor',
    });

    const attempt = change.execute({
      actor: context.actingAs(acme, editor),
      membershipId: membershipOf(acme, editor),
      role: 'admin',
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'forbidden' },
    });
  });
});
