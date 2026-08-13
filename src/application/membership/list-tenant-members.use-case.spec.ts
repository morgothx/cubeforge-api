import {
  createIdentityTestContext,
  type IdentityTestContext,
} from '../../adapters/testing/identity-test-context';
import { apiKeyId } from '../../domain/identifiers';
import { ListTenantMembersUseCase } from './list-tenant-members.use-case';
import { RevokeMembershipUseCase } from './revoke-membership.use-case';

describe('listing the members of a tenant', () => {
  let context: IdentityTestContext;
  let list: ListTenantMembersUseCase;
  let revoke: RevokeMembershipUseCase;

  beforeEach(() => {
    context = createIdentityTestContext();
    list = new ListTenantMembersUseCase(context.tenantScoped);
    revoke = new RevokeMembershipUseCase(context.tenantScoped);
  });

  it('returns only the people who belong to the acting tenant', async () => {
    const acme = await context.seedTenant('Acme');
    const globex = await context.seedTenant('Globex');
    const admin = await context.seedMember({
      tenantId: acme,
      email: 'admin@example.com',
      role: 'admin',
    });
    await context.seedMember({
      tenantId: acme,
      email: 'member@example.com',
      role: 'viewer',
    });
    await context.seedMember({
      tenantId: globex,
      email: 'outsider@example.com',
      role: 'admin',
    });

    const members = await list.execute({
      actor: context.actingAs(acme, admin),
      includeInactive: false,
    });

    expect(members.map((member) => member.email).sort()).toEqual([
      'admin@example.com',
      'member@example.com',
    ]);
  });

  it('hides revoked memberships unless they are asked for', async () => {
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
    const membership = [...context.store.memberships.values()].find(
      (candidate) => candidate.personId === member,
    );
    await revoke.execute({
      actor: context.actingAs(acme, admin),
      membershipId: membership!.id,
    });

    const active = await list.execute({
      actor: context.actingAs(acme, admin),
      includeInactive: false,
    });
    const everyone = await list.execute({
      actor: context.actingAs(acme, admin),
      includeInactive: true,
    });

    expect(active.map((entry) => entry.email)).toEqual(['admin@example.com']);
    expect(everyone).toHaveLength(2);
    expect(
      everyone.find((entry) => entry.email === 'member@example.com')?.membership
        .status,
    ).toBe('revoked');
  });

  /** Requirement 10.3: the email is for administrators of this tenant only. */
  it('denies the listing to a member who is not an administrator', async () => {
    const acme = await context.seedTenant('Acme');
    await context.seedMember({
      tenantId: acme,
      email: 'admin@example.com',
      role: 'admin',
    });
    const viewer = await context.seedMember({
      tenantId: acme,
      email: 'viewer@example.com',
      role: 'viewer',
    });

    const attempt = list.execute({
      actor: context.actingAs(acme, viewer),
      includeInactive: false,
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'forbidden' },
    });
  });

  it('reports absence to an administrator of another tenant', async () => {
    const acme = await context.seedTenant('Acme');
    const globex = await context.seedTenant('Globex');
    const globexAdmin = await context.seedMember({
      tenantId: globex,
      email: 'admin@globex.example.com',
      role: 'admin',
    });

    const attempt = list.execute({
      actor: { kind: 'tenant-member', personId: globexAdmin, tenantId: acme },
      includeInactive: false,
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'not-found' },
    });
  });

  /**
   * A machine principal holds an API key, not a membership. These routes serve
   * people, so it is answered as an absence rather than being handled — and
   * nothing had to be added to make that true.
   */
  it('denies the listing to a machine principal', async () => {
    const acme = await context.seedTenant('Acme');

    const attempt = list.execute({
      actor: {
        kind: 'machine',
        apiKeyId: apiKeyId('a-key'),
        tenantId: acme,
        role: 'admin',
      },
      includeInactive: false,
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'not-found' },
    });
  });

  it('denies the listing to a platform operator', async () => {
    await context.seedTenant('Acme');

    const attempt = list.execute({
      actor: context.operator,
      includeInactive: false,
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'not-found' },
    });
  });
});
