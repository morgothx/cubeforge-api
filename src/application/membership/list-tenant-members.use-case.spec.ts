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
    // `active`, not the raw membership status: the listing publishes whether a
    // person may act here, which is what requirement 10.1 asks for and what the
    // route has always answered with.
    expect(
      everyone.find((entry) => entry.email === 'member@example.com')?.active,
    ).toBe(false);
  });

  describe('who may read it, and how much of it', () => {
    async function aTenantOfThree(): Promise<{
      tenantId: Awaited<ReturnType<typeof context.seedTenant>>;
      admin: Awaited<ReturnType<typeof context.seedMember>>;
      editor: Awaited<ReturnType<typeof context.seedMember>>;
      viewer: Awaited<ReturnType<typeof context.seedMember>>;
    }> {
      const tenantId = await context.seedTenant('Acme');
      return {
        tenantId,
        admin: await context.seedMember({
          tenantId,
          email: 'admin@example.com',
          role: 'admin',
        }),
        editor: await context.seedMember({
          tenantId,
          email: 'editor@example.com',
          role: 'editor',
        }),
        viewer: await context.seedMember({
          tenantId,
          email: 'viewer@example.com',
          role: 'viewer',
        }),
      };
    }

    it('answers an administrator with every address', async () => {
      const { tenantId, admin } = await aTenantOfThree();

      const members = await list.execute({
        actor: context.actingAs(tenantId, admin),
        includeInactive: false,
      });

      expect(members.map((member) => member.email).sort()).toEqual([
        'admin@example.com',
        'editor@example.com',
        'viewer@example.com',
      ]);
    });

    /**
     * Requirement 2.1.1. Widening who may call this route must not widen what
     * the route discloses: requirement 10.3 of the identity feature reserves a
     * person's address to administrators of a tenant they belong to, and that
     * rule survives this feature rather than being quietly relaxed by it.
     */
    it.each(['editor', 'viewer'] as const)(
      'answers a %s with the same people and no addresses',
      async (role) => {
        const tenant = await aTenantOfThree();

        const members = await list.execute({
          actor: context.actingAs(tenant.tenantId, tenant[role]),
          includeInactive: false,
        });

        expect(members).toHaveLength(3);
        expect(members.every((member) => member.email === null)).toBe(true);
        // The listing is still useful: who is here, in what role, and whether
        // they are active. Only the address is withheld.
        expect(members.map((member) => member.role).sort()).toEqual([
          'admin',
          'editor',
          'viewer',
        ]);
      },
    );
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
