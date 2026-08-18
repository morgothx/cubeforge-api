import { InMemoryApiKeyStore } from '../../adapters/persistence/in-memory/in-memory-api-key-store';
import { InMemoryAuthenticatorUnitOfWork } from '../../adapters/persistence/in-memory/in-memory-authenticator-unit-of-work';
import {
  createIdentityTestContext,
  type IdentityTestContext,
} from '../../adapters/testing/identity-test-context';
import {
  apiKeyId,
  emailAddress,
  personId,
  tenantId,
  type PersonId,
  type TenantId,
} from '../../domain/identifiers';
import { revokeMembership } from '../../domain/membership/membership.entity';
import { deactivateTenant } from '../../domain/tenant/tenant.entity';
import type { ActorContext } from '../actor-context';
import { DescribeCallerUseCase } from './describe-caller.use-case';

/**
 * What a caller learns about themselves, and the rule that decides which of
 * their memberships is worth telling them about.
 *
 * The repository hands over every membership the person holds, statuses
 * intact, so everything asserted here is the use case's own decision. It asks
 * `decideAccess` — the same rule the guard and the tenant-scoped use cases ask
 * — which is what makes a tenant named in this answer a tenant the caller can
 * actually reach.
 */
describe('describing a caller their own standing', () => {
  let context: IdentityTestContext;
  let useCase: DescribeCallerUseCase;

  beforeEach(() => {
    context = createIdentityTestContext();
    useCase = new DescribeCallerUseCase(
      new InMemoryAuthenticatorUnitOfWork(
        context.credentials,
        new InMemoryApiKeyStore(),
        context.store,
      ),
    );
  });

  function asPerson(id: PersonId): ActorContext {
    return { kind: 'person', personId: id };
  }

  /**
   * Revoking through the store rather than through the use case that does it:
   * this suite is about what a revoked membership means to the answer, and
   * routing through a tenant-scoped command would drag an administrator, a
   * tenant transaction and an authorization check into a fixture.
   */
  function revokeEveryMembershipOf(person: PersonId): void {
    for (const [id, membership] of context.store.memberships) {
      if (membership.personId === person) {
        context.store.memberships.set(id, revokeMembership(membership));
      }
    }
  }

  function retire(tenant: TenantId): void {
    const found = context.store.tenants.get(tenant);
    if (found === undefined) {
      throw new Error('the fixture did not seed this tenant');
    }
    context.store.tenants.set(tenant, deactivateTenant(found));
  }

  it('reports who the caller is, and every tenant they can reach', async () => {
    const acme = await context.seedTenant('Acme');
    const globex = await context.seedTenant('Globex');
    const caller = await context.seedMember({
      tenantId: acme,
      email: 'caller@example.com',
      role: 'admin',
    });
    await context.seedMember({
      tenantId: globex,
      email: 'caller@example.com',
      role: 'viewer',
    });

    const standing = await useCase.execute({ actor: asPerson(caller) });

    expect(standing.personId).toBe(caller);
    expect(standing.email).toBe(emailAddress('caller@example.com'));
    expect(standing.isOperator).toBe(false);
    expect(standing.memberships).toEqual([
      { tenantId: acme, tenantName: 'Acme', role: 'admin' },
      { tenantId: globex, tenantName: 'Globex', role: 'viewer' },
    ]);
  });

  it('reports the operator flag, and still only the tenants they belong to', async () => {
    const acme = await context.seedTenant('Acme');
    await context.seedTenant('Globex');
    const founder = context.seedOperator(
      personId('founder'),
      'founder@example.com',
    );
    await context.seedMember({
      tenantId: acme,
      email: 'founder@example.com',
      role: 'editor',
    });

    const standing = await useCase.execute({ actor: asPerson(founder) });

    // Requirement 1.4: being an operator is a fact about the platform, not a
    // membership in everything on it. Globex exists, and is absent.
    expect(standing.isOperator).toBe(true);
    expect(standing.memberships).toEqual([
      { tenantId: acme, tenantName: 'Acme', role: 'editor' },
    ]);
  });

  it('omits a membership that was revoked', async () => {
    const acme = await context.seedTenant('Acme');
    const caller = await context.seedMember({
      tenantId: acme,
      email: 'caller@example.com',
      role: 'admin',
    });
    revokeEveryMembershipOf(caller);

    const standing = await useCase.execute({ actor: asPerson(caller) });

    // Requirement 1.3: nothing reported may name a place the caller would then
    // be refused, and a revoked member is refused.
    expect(standing.memberships).toEqual([]);
  });

  it('omits a membership held in a tenant that is no longer active', async () => {
    const retired = await context.seedTenant('Retired');
    const caller = await context.seedMember({
      tenantId: retired,
      email: 'caller@example.com',
      role: 'admin',
    });
    retire(retired);

    const standing = await useCase.execute({ actor: asPerson(caller) });

    // The membership is untouched; the tenant is what changed. Both reach the
    // caller as the same absence, which is the point of asking one rule.
    expect(standing.memberships).toEqual([]);
  });

  it('answers a caller who belongs nowhere with the shape everyone else gets', async () => {
    const stranger = context.seedOperator(
      personId('stranger'),
      'stranger@example.com',
    );

    const standing = await useCase.execute({ actor: asPerson(stranger) });

    // Requirement 2.4: an empty list, not a refusal and not a different shape.
    // A client renders the same view either way, and learns nothing about the
    // platform from the emptiness.
    expect(standing).toEqual({
      personId: stranger,
      email: emailAddress('stranger@example.com'),
      isOperator: true,
      memberships: [],
    });
  });

  it('reports the caller their own role, not the tenant`s', async () => {
    const acme = await context.seedTenant('Acme');
    const caller = await context.seedMember({
      tenantId: acme,
      email: 'caller@example.com',
      role: 'viewer',
    });
    await context.seedMember({
      tenantId: acme,
      email: 'other@example.com',
      role: 'admin',
    });

    const standing = await useCase.execute({ actor: asPerson(caller) });

    expect(standing.memberships).toEqual([
      { tenantId: acme, tenantName: 'Acme', role: 'viewer' },
    ]);
  });

  it('answers as an absence when the caller resolves to nobody', async () => {
    // The resolver read this person moments ago, so reaching here means they
    // were removed in between. An absence rather than a crash, and the same
    // absence every other refusal produces.
    await expect(
      useCase.execute({ actor: asPerson(personId('vanished')) }),
    ).rejects.toMatchObject({ error: { kind: 'not-found' } });
  });

  it('admits an operator asking as themselves', async () => {
    const founder = context.seedOperator(
      personId('founder'),
      'founder@example.com',
    );

    const standing = await useCase.execute({
      actor: { kind: 'platform-operator', personId: founder },
    });

    expect(standing.personId).toBe(founder);
  });

  it('refuses a machine, which names a credential rather than a person', async () => {
    await expect(
      useCase.execute({
        actor: {
          kind: 'machine',
          apiKeyId: apiKeyId('key'),
          tenantId: tenantId('tenant-elsewhere'),
          role: 'admin',
        },
      }),
    ).rejects.toMatchObject({ error: { kind: 'forbidden' } });
  });

  it('refuses a tenant member, whose request named a tenant', async () => {
    const acme = await context.seedTenant('Acme');
    // A real person with a real membership, so the refusal cannot come from
    // the caller simply not existing. The first version of this test used an
    // invented identifier and passed against a use case that admitted every
    // kind but a machine — the person was absent, so it refused for the wrong
    // reason. Hence a seeded caller, and an assertion on which refusal it is.
    const member = await context.seedMember({
      tenantId: acme,
      email: 'member@example.com',
      role: 'admin',
    });

    await expect(
      useCase.execute({
        actor: { kind: 'tenant-member', personId: member, tenantId: acme },
      }),
    ).rejects.toMatchObject({ error: { kind: 'forbidden' } });
  });
});
