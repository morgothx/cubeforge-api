import { drizzle } from 'drizzle-orm/node-postgres';
import { PostgresPlatformUnitOfWork } from '../../src/adapters/persistence/postgres/postgres-platform-unit-of-work';
import { PostgresTenantScopedUnitOfWork } from '../../src/adapters/persistence/postgres/postgres-tenant-scoped-unit-of-work';
import { UuidIdentifierGenerator } from '../../src/adapters/system/uuid-identifier-generator';
import { FixedClock } from '../../src/adapters/testing/fixed-clock';
import { CreateTenantMemberUseCase } from '../../src/application/membership/create-tenant-member.use-case';
import { ListTenantMembersUseCase } from '../../src/application/membership/list-tenant-members.use-case';
import { RevokeMembershipUseCase } from '../../src/application/membership/revoke-membership.use-case';
import { DeactivatePersonUseCase } from '../../src/application/person/deactivate-person.use-case';
import { DeactivateTenantUseCase } from '../../src/application/tenant/deactivate-tenant.use-case';
import { ProvisionTenantUseCase } from '../../src/application/tenant/provision-tenant.use-case';
import type { ActorContext } from '../../src/application/actor-context';
import { type PersonId, type TenantId } from '../../src/domain/identifiers';
import { runtimePool } from './support/database';
import { useIntegrationDatabase } from './support/fixtures';

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

/**
 * The use cases from section 4, running against PostgreSQL instead of the
 * in-memory doubles. Nothing about them changes — that is the claim being
 * tested, and it is also what makes the isolation assertions below meaningful:
 * they exercise the code that will actually serve requests.
 */
describe('the identity use cases against PostgreSQL', () => {
  useIntegrationDatabase();

  const clock = new FixedClock(CREATED_AT);
  const identifiers = new UuidIdentifierGenerator();
  const operator: ActorContext = {
    kind: 'platform-operator',
    personId: identifiers.personId(),
  };

  let provisionTenant: ProvisionTenantUseCase;
  let deactivateTenant: DeactivateTenantUseCase;
  let deactivatePerson: DeactivatePersonUseCase;
  let createMember: CreateTenantMemberUseCase;
  let revokeMembership: RevokeMembershipUseCase;
  let listMembers: ListTenantMembersUseCase;

  beforeAll(() => {
    const tenantScoped = new PostgresTenantScopedUnitOfWork(
      drizzle(runtimePool('app')),
    );
    const platform = new PostgresPlatformUnitOfWork(
      drizzle(runtimePool('operator')),
    );

    provisionTenant = new ProvisionTenantUseCase(
      platform,
      tenantScoped,
      clock,
      identifiers,
    );
    deactivateTenant = new DeactivateTenantUseCase(platform);
    deactivatePerson = new DeactivatePersonUseCase(platform);
    createMember = new CreateTenantMemberUseCase(
      tenantScoped,
      clock,
      identifiers,
    );
    revokeMembership = new RevokeMembershipUseCase(tenantScoped);
    listMembers = new ListTenantMembersUseCase(tenantScoped);
  });

  /**
   * Bootstrapping a tenant needs its first administrator, and creating a member
   * requires an administrator to already exist. Provisioning names them and
   * reports who they are, so every step here goes through the use cases.
   */
  async function tenantWithAdministrator(name: string): Promise<{
    tenantId: TenantId;
    admin: ActorContext;
  }> {
    const { tenant, administratorPersonId } = await provisionTenant.execute({
      actor: operator,
      name,
      administratorEmail: `admin-${name}@example.com`,
    });
    return {
      tenantId: tenant.id,
      admin: {
        kind: 'tenant-member',
        personId: administratorPersonId,
        tenantId: tenant.id,
      },
    };
  }

  it('provisions a tenant and rejects a duplicate name at the database', async () => {
    await provisionTenant.execute({
      actor: operator,
      name: 'Acme',
      administratorEmail: 'founder@example.com',
    });

    await expect(
      provisionTenant.execute({
        actor: operator,
        name: 'Acme',
        administratorEmail: 'founder@example.com',
      }),
    ).rejects.toMatchObject({ error: { kind: 'tenant-name-taken' } });
  });

  it('creates a member whose address is unknown to the platform', async () => {
    const acme = await tenantWithAdministrator('Acme');

    const result = await createMember.execute({
      actor: acme.admin,
      email: 'newcomer@example.com',
      role: 'editor',
    });

    expect(result.role).toBe('editor');
    const members = await listMembers.execute({
      actor: acme.admin,
      includeInactive: false,
    });
    expect(members.map((member) => member.email).sort()).toEqual([
      'admin-acme@example.com',
      'newcomer@example.com',
    ]);
  });

  /**
   * The case that made the SECURITY DEFINER function necessary. Without it this
   * raises a duplicate-key error, which both blocks requirement 4.2 and reveals
   * that the address is registered in some other tenant.
   */
  it('creates a member whose address is registered only in another tenant', async () => {
    const acme = await tenantWithAdministrator('Acme');
    const globex = await tenantWithAdministrator('Globex');
    const known = await createMember.execute({
      actor: globex.admin,
      email: 'shared@example.com',
      role: 'viewer',
    });

    const here = await createMember.execute({
      actor: acme.admin,
      email: 'shared@example.com',
      role: 'editor',
    });

    expect(here.personId).toBe(known.personId);
    expect(Object.keys(here).sort()).toEqual([
      'membershipId',
      'personId',
      'role',
    ]);
  });

  it('gives the same person a different role in each tenant', async () => {
    const acme = await tenantWithAdministrator('Acme');
    const globex = await tenantWithAdministrator('Globex');
    await createMember.execute({
      actor: acme.admin,
      email: 'shared@example.com',
      role: 'editor',
    });
    await createMember.execute({
      actor: globex.admin,
      email: 'shared@example.com',
      role: 'viewer',
    });

    const roleIn = async (actor: ActorContext) => {
      const members = await listMembers.execute({
        actor,
        includeInactive: false,
      });
      return members.find((member) => member.email === 'shared@example.com')
        ?.role;
    };

    expect(await roleIn(acme.admin)).toBe('editor');
    expect(await roleIn(globex.admin)).toBe('viewer');
  });

  it('rejects a second membership for the same person in the same tenant', async () => {
    const acme = await tenantWithAdministrator('Acme');
    await createMember.execute({
      actor: acme.admin,
      email: 'member@example.com',
      role: 'viewer',
    });

    await expect(
      createMember.execute({
        actor: acme.admin,
        email: 'member@example.com',
        role: 'editor',
      }),
    ).rejects.toMatchObject({ error: { kind: 'already-a-member' } });
  });

  it('never lists a member of another tenant', async () => {
    const acme = await tenantWithAdministrator('Acme');
    const globex = await tenantWithAdministrator('Globex');
    await createMember.execute({
      actor: globex.admin,
      email: 'outsider@example.com',
      role: 'admin',
    });

    const members = await listMembers.execute({
      actor: acme.admin,
      includeInactive: true,
    });

    expect(members.map((member) => member.email)).toEqual([
      'admin-acme@example.com',
    ]);
  });

  it('reports absence when an administrator acts in a tenant they do not belong to', async () => {
    const acme = await tenantWithAdministrator('Acme');
    const globex = await tenantWithAdministrator('Globex');

    const trespass = createMember.execute({
      actor: {
        kind: 'tenant-member',
        personId: (globex.admin as { personId: PersonId }).personId,
        tenantId: acme.tenantId,
      },
      email: 'newcomer@example.com',
      role: 'viewer',
    });

    await expect(trespass).rejects.toMatchObject({
      error: { kind: 'not-found' },
    });
  });

  it('denies every request in a tenant once it is deactivated', async () => {
    const acme = await tenantWithAdministrator('Acme');

    await deactivateTenant.execute({
      actor: operator,
      tenantId: acme.tenantId,
    });

    await expect(
      listMembers.execute({ actor: acme.admin, includeInactive: false }),
    ).rejects.toMatchObject({ error: { kind: 'not-found' } });
  });

  it('denies a person in every tenant at once when deactivated platform-wide', async () => {
    const acme = await tenantWithAdministrator('Acme');
    const globex = await tenantWithAdministrator('Globex');
    const shared = await createMember.execute({
      actor: acme.admin,
      email: 'shared@example.com',
      role: 'admin',
    });
    await createMember.execute({
      actor: globex.admin,
      email: 'shared@example.com',
      role: 'admin',
    });
    const actingInAcme: ActorContext = {
      kind: 'tenant-member',
      personId: shared.personId,
      tenantId: acme.tenantId,
    };
    const actingInGlobex: ActorContext = {
      kind: 'tenant-member',
      personId: shared.personId,
      tenantId: globex.tenantId,
    };
    // Both memberships work before the deactivation, so the assertions below
    // cannot pass for some unrelated reason.
    await expect(
      listMembers.execute({ actor: actingInAcme, includeInactive: false }),
    ).resolves.toHaveLength(2);

    await deactivatePerson.execute({
      actor: operator,
      personId: shared.personId,
    });

    await expect(
      listMembers.execute({ actor: actingInAcme, includeInactive: false }),
    ).rejects.toMatchObject({ error: { kind: 'not-found' } });
    await expect(
      listMembers.execute({ actor: actingInGlobex, includeInactive: false }),
    ).rejects.toMatchObject({ error: { kind: 'not-found' } });
  });

  it('hides a revoked membership from the default listing and denies its holder', async () => {
    const acme = await tenantWithAdministrator('Acme');
    const member = await createMember.execute({
      actor: acme.admin,
      email: 'member@example.com',
      role: 'viewer',
    });

    await revokeMembership.execute({
      actor: acme.admin,
      membershipId: member.membershipId,
    });

    const active = await listMembers.execute({
      actor: acme.admin,
      includeInactive: false,
    });
    const everyone = await listMembers.execute({
      actor: acme.admin,
      includeInactive: true,
    });

    expect(active.map((entry) => entry.email)).toEqual([
      'admin-acme@example.com',
    ]);
    expect(everyone).toHaveLength(2);
  });

  it('refuses to revoke the last administrator', async () => {
    const acme = await tenantWithAdministrator('Acme');
    const members = await listMembers.execute({
      actor: acme.admin,
      includeInactive: false,
    });

    await expect(
      revokeMembership.execute({
        actor: acme.admin,
        membershipId: members[0].membershipId,
      }),
    ).rejects.toMatchObject({ error: { kind: 'last-administrator' } });
  });

  /**
   * Requirement 5.1's real hazard. If the tenant were published at session level
   * instead of transaction level, it would survive the connection's return to
   * the pool and scope the next request to the previous request's tenant.
   */
  it('leaves no tenant context on the connection after the transaction closes', async () => {
    const acme = await tenantWithAdministrator('Acme');
    await listMembers.execute({ actor: acme.admin, includeInactive: false });

    const pool = runtimePool('app');
    const leaked = await pool.query<{ tenant: string | null }>(
      "SELECT nullif(current_setting('app.current_tenant', true), '') AS tenant",
    );

    expect(leaked.rows[0].tenant).toBeNull();
  });
});
