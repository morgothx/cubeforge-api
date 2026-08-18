import type { CallerStandingRecord } from '../../application/ports/standing.repository';
import type { PersonId, TenantId } from '../../domain/identifiers';
import type { Role } from '../../domain/membership/role';

/**
 * The arrangements the contract needs, in whichever world is under test.
 *
 * Seeding is the harness's job because the two worlds arrange rows completely
 * differently — one writes to maps, the other to PostgreSQL as the superuser,
 * since forced row-level security leaves no runtime identity able to insert a
 * membership. What must not differ is the answer, and that is all the contract
 * asserts.
 */
export interface StandingContractWorld {
  seedPerson(input: {
    readonly email: string;
    readonly deactivated?: boolean;
  }): Promise<PersonId>;
  seedTenant(input: {
    readonly name: string;
    readonly inactive?: boolean;
  }): Promise<TenantId>;
  seedMembership(input: {
    readonly tenantId: TenantId;
    readonly personId: PersonId;
    readonly role: Role;
    readonly revoked?: boolean;
  }): Promise<void>;
  recordOperator(personId: PersonId): Promise<void>;
  /** A well-formed identifier belonging to no person. Seeds nothing. */
  anUnknownPerson(): PersonId;
  /** Opens a transaction with this person published and reads their standing. */
  describeCaller(personId: PersonId): Promise<CallerStandingRecord | null>;
}

/**
 * One suite, run against both implementations of `StandingRepository`.
 *
 * A shared contract rather than two suites because the in-memory one exists
 * solely to stand in for the real one in use-case tests: if the two answer
 * differently, every test that trusts the double is proving something about a
 * system that will not ship. The fixtures are therefore described in terms of
 * what is seeded, never of how.
 *
 * `world` is a function so each test reaches the harness after whatever
 * `beforeEach` the caller installed has run.
 */
export function describesCallerStanding(
  world: () => StandingContractWorld,
): void {
  function held(standing: CallerStandingRecord | null): {
    tenant: string;
    role: Role;
  }[] {
    return (standing?.memberships ?? [])
      .map((one) => ({ tenant: one.tenant.name, role: one.membership.role }))
      .sort((a, b) => a.tenant.localeCompare(b.tenant));
  }

  it('describes a person who belongs nowhere', async () => {
    const arranged = world();
    const caller = await arranged.seedPerson({ email: 'nobody@example.com' });

    const standing = await arranged.describeCaller(caller);

    // An ordinary answer, not a refusal. Requirement 1.4 asks for the same
    // shape whether the caller has three tenants or none, so an absence of
    // memberships must not be reported as an absence of a person.
    expect(standing).not.toBeNull();
    expect(standing?.person.id).toBe(caller);
    expect(standing?.person.email).toBe('nobody@example.com');
    expect(standing?.isOperator).toBe(false);
    expect(standing?.memberships).toEqual([]);
  });

  it('describes every tenant the caller belongs to, with the role held in each', async () => {
    const arranged = world();
    const caller = await arranged.seedPerson({ email: 'caller@example.com' });
    const acme = await arranged.seedTenant({ name: 'Acme' });
    const globex = await arranged.seedTenant({ name: 'Globex' });
    await arranged.seedMembership({
      tenantId: acme,
      personId: caller,
      role: 'admin',
    });
    await arranged.seedMembership({
      tenantId: globex,
      personId: caller,
      role: 'viewer',
    });

    const standing = await arranged.describeCaller(caller);

    // The capability the tenant-scoped identity does not have: two tenants in
    // one read, with no tenant published anywhere.
    expect(held(standing)).toEqual([
      { tenant: 'Acme', role: 'admin' },
      { tenant: 'Globex', role: 'viewer' },
    ]);
  });

  it('describes no membership belonging to anyone else', async () => {
    const arranged = world();
    const caller = await arranged.seedPerson({ email: 'caller@example.com' });
    const other = await arranged.seedPerson({ email: 'other@example.com' });
    const acme = await arranged.seedTenant({ name: 'Acme' });
    // The same tenant on purpose: a read confined by tenant rather than by
    // person would satisfy every other assertion here and fail this one.
    await arranged.seedMembership({
      tenantId: acme,
      personId: caller,
      role: 'admin',
    });
    await arranged.seedMembership({
      tenantId: acme,
      personId: other,
      role: 'editor',
    });

    const standing = await arranged.describeCaller(caller);

    expect(held(standing)).toEqual([{ tenant: 'Acme', role: 'admin' }]);
  });

  it('reports the operator record the platform holds', async () => {
    const arranged = world();
    const caller = await arranged.seedPerson({ email: 'founder@example.com' });
    await arranged.recordOperator(caller);

    const standing = await arranged.describeCaller(caller);

    expect(standing?.isOperator).toBe(true);
    // Being an operator makes nobody a member of anything.
    expect(standing?.memberships).toEqual([]);
  });

  it('keeps a revoked membership and an inactive tenant in the answer', async () => {
    const arranged = world();
    const caller = await arranged.seedPerson({ email: 'caller@example.com' });
    const acme = await arranged.seedTenant({ name: 'Acme' });
    const retired = await arranged.seedTenant({
      name: 'Retired',
      inactive: true,
    });
    await arranged.seedMembership({
      tenantId: acme,
      personId: caller,
      role: 'admin',
      revoked: true,
    });
    await arranged.seedMembership({
      tenantId: retired,
      personId: caller,
      role: 'viewer',
    });

    const standing = await arranged.describeCaller(caller);

    // Dropping these is the use case's job, using the domain's own access rule.
    // A repository that filtered would be a second copy of that rule, and the
    // two would eventually disagree — so what this asserts is that the facts
    // arrive intact, statuses included.
    expect(standing?.memberships).toHaveLength(2);
    const byTenant = new Map(
      (standing?.memberships ?? []).map((one) => [one.tenant.name, one]),
    );
    expect(byTenant.get('Acme')?.membership.status).toBe('revoked');
    expect(byTenant.get('Acme')?.tenant.status).toBe('active');
    expect(byTenant.get('Retired')?.membership.status).toBe('active');
    expect(byTenant.get('Retired')?.tenant.status).toBe('inactive');
  });

  it('reports the caller their own status, deactivated or not', async () => {
    const arranged = world();
    const caller = await arranged.seedPerson({
      email: 'gone@example.com',
      deactivated: true,
    });

    const standing = await arranged.describeCaller(caller);

    // Nothing here refuses a deactivated person: the resolver already did, well
    // before a transaction was opened. The status travels so the use case never
    // has to assume that happened.
    expect(standing?.person.status).toBe('deactivated');
  });

  it('reports no operator record for a person who was deactivated', async () => {
    const arranged = world();
    const caller = await arranged.seedPerson({
      email: 'former@example.com',
      deactivated: true,
    });
    // Deactivating a person does not delete the operator record, so if the
    // record alone decided, deactivating a compromised operator would be the
    // one act that changed nothing. Feature 2 settled that `isOperator` means
    // "recorded, and still active"; a second answer to the same word here
    // would put the escalation back.
    await arranged.recordOperator(caller);

    const standing = await arranged.describeCaller(caller);

    expect(standing?.isOperator).toBe(false);
  });

  it('describes nobody for a person the platform does not know', async () => {
    const arranged = world();
    await arranged.seedPerson({ email: 'known@example.com' });

    expect(
      await arranged.describeCaller(arranged.anUnknownPerson()),
    ).toBeNull();
  });
}
