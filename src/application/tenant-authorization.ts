import { decideAccess } from '../domain/access/access-decision';
import { DomainViolation } from '../domain/errors';
import type { Membership } from '../domain/membership/membership.entity';
import type { Role } from '../domain/membership/role';
import type { Person } from '../domain/person/person.entity';
import type { Tenant } from '../domain/tenant/tenant.entity';
import type { TenantId } from '../domain/identifiers';
import type { ActorContext } from './actor-context';
import type { TenantScopedRepositories } from './ports/tenant-scoped-unit-of-work';

export interface AuthorizedActor {
  readonly tenant: Tenant;
  readonly person: Person;
  readonly membership: Membership;
  readonly role: Role;
}

/**
 * Resolves the acting person inside the tenant transaction and answers whether
 * they may act, using the one domain decision that owns that question.
 *
 * Refusals surface as `not-found`, never as `forbidden`. Requirement 9.2 is
 * explicit that telling the two apart would let a caller confirm an identifier
 * exists somewhere on the platform, which is a cross-tenant leak through the
 * error channel rather than through data. `forbidden` is reserved for an actor
 * who is genuinely a member here and simply lacks the role.
 *
 * This is a plain function, not a Guard, a decorator or a metadata convention:
 * the design puts reusable enforcement in feature 3, and building any of those
 * here would pre-commit a decision that belongs to that spec.
 */
export async function authorizeInTenant(
  repositories: TenantScopedRepositories,
  actor: ActorContext,
  permitted: readonly Role[],
): Promise<AuthorizedActor> {
  if (actor.kind !== 'tenant-member') {
    throw new DomainViolation({ kind: 'not-found' });
  }

  // Sequential, not `Promise.all`. These run inside one transaction, which is
  // one connection, and a connection executes one statement at a time — issuing
  // them together only queues them behind each other while `pg` warns that the
  // client is already busy. There is no concurrency to win here.
  const tenant = await repositories.tenants.findCurrent();
  const person = await repositories.people.findById(actor.personId);
  const membership = await repositories.memberships.findByPerson(
    actor.personId,
  );

  if (tenant === null || person === null) {
    throw new DomainViolation(
      { kind: 'not-found' },
      tenant === null ? 'no such tenant' : 'no such person',
    );
  }

  const decision = decideAccess({ tenant, person, membership });
  // A grant implies a membership; testing for it again is what lets the
  // compiler agree, and costs a comparison rather than a cast.
  if (!decision.granted || membership === null) {
    // `decideAccess` already worked out which of four things went wrong, and
    // discarding it left the log saying only "not-found". Requirement 5.3 of
    // the authorization feature wants the reason recorded, and this is the
    // reason.
    throw new DomainViolation(
      { kind: 'not-found' },
      decision.granted ? 'no membership' : decision.refusal.kind,
    );
  }

  if (!permitted.includes(decision.role)) {
    throw new DomainViolation(
      { kind: 'forbidden' },
      `this caller is a ${decision.role} here; the operation permits ${permitted.join(', ')}`,
    );
  }

  return { tenant, person, membership, role: decision.role };
}

/**
 * The tenant a request runs in, taken from the actor rather than from the
 * request body. Nothing can name a tenant the caller does not already act in,
 * so "administrator of tenant A operating on tenant B" never reaches a
 * repository — it is not expressible.
 *
 * An operator has no tenant, and asking for one on their behalf is a
 * programming error the caller must not be able to observe differently from an
 * absent record.
 */
export function tenantOf(actor: ActorContext): TenantId {
  if (actor.kind !== 'tenant-member') {
    throw new DomainViolation({ kind: 'not-found' });
  }
  return actor.tenantId;
}

/**
 * The tenant a request runs in, admitting a machine as well as a person.
 *
 * A sibling of `tenantOf` rather than a loosening of it, and the reason is
 * narrower than it first looks. Widening `tenantOf` would **not** have let
 * machines reach the routes that use it: the guard refuses a key on any route
 * that does not declare `machines`, and those use cases resolve a membership a
 * key does not have. Both would still refuse.
 *
 * What widening would do is delete one of those redundant refusals while
 * gaining nothing — and leave two helpers' worth of meaning inside one name.
 * `tenantOf` says "the tenant this person is a member of"; this says "the
 * tenant this caller acts in, whoever they are". Inventory is the first surface
 * built for machines, so it is the first caller of the second question.
 *
 * An operator still has no tenant, and asking for one on their behalf remains a
 * programming error the caller cannot observe.
 */
export function tenantActedIn(actor: ActorContext): TenantId {
  if (actor.kind !== 'tenant-member' && actor.kind !== 'machine') {
    throw new DomainViolation({ kind: 'not-found' });
  }
  return actor.tenantId;
}

/** Operator-only entry points share this check, and it is the whole of it. */
export function requirePlatformOperator(actor: ActorContext): void {
  if (actor.kind !== 'platform-operator') {
    throw new DomainViolation({ kind: 'forbidden' });
  }
}
