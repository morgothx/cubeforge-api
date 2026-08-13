import type { ActorContext } from '../../application/actor-context';
import {
  emailAddress,
  type PersonId,
  type TenantId,
} from '../../domain/identifiers';
import { createMembership } from '../../domain/membership/membership.entity';
import type { Role } from '../../domain/membership/role';
import { createTenant } from '../../domain/tenant/tenant.entity';
import { InMemoryIdentityStore } from '../persistence/in-memory/in-memory-identity-store';
import { InMemoryPlatformUnitOfWork } from '../persistence/in-memory/in-memory-platform-unit-of-work';
import { InMemoryTenantScopedUnitOfWork } from '../persistence/in-memory/in-memory-tenant-scoped-unit-of-work';
import { FixedClock } from './fixed-clock';
import { SequentialIdentifierGenerator } from './sequential-identifier-generator';

export const TEST_MOMENT = new Date('2026-01-01T00:00:00.000Z');

/**
 * Everything a use-case test needs, wired the way the running system will be,
 * with the database replaced and nothing else. Seeding goes through the same
 * units of work the use cases use, so a fixture cannot arrange a state the
 * system itself could not reach.
 */
export function createIdentityTestContext() {
  const store = new InMemoryIdentityStore();
  const tenantScoped = new InMemoryTenantScopedUnitOfWork(store);
  const platform = new InMemoryPlatformUnitOfWork(store);
  const clock = new FixedClock(TEST_MOMENT);
  const identifiers = new SequentialIdentifierGenerator();

  async function seedTenant(name: string): Promise<TenantId> {
    const id = identifiers.tenantId();
    await platform.runAsOperator(({ tenants }) =>
      tenants.insert(createTenant({ id, name, createdAt: clock.now() })),
    );
    return id;
  }

  async function seedMember(input: {
    readonly tenantId: TenantId;
    readonly email: string;
    readonly role: Role;
  }): Promise<PersonId> {
    return tenantScoped.runInTenant(
      input.tenantId,
      async ({ people, memberships }) => {
        const personId = await people.findOrCreateByEmail({
          candidateId: identifiers.personId(),
          email: emailAddress(input.email),
          createdAt: clock.now(),
        });
        await memberships.insert(
          createMembership({
            id: identifiers.membershipId(),
            tenantId: input.tenantId,
            personId,
            role: input.role,
            createdAt: clock.now(),
          }),
        );
        return personId;
      },
    );
  }

  function actingAs(tenantId: TenantId, personId: PersonId): ActorContext {
    return { kind: 'tenant-member', personId, tenantId };
  }

  const operator: ActorContext = { kind: 'platform-operator' };

  return {
    store,
    tenantScoped,
    platform,
    clock,
    identifiers,
    seedTenant,
    seedMember,
    actingAs,
    operator,
  };
}

export type IdentityTestContext = ReturnType<typeof createIdentityTestContext>;
