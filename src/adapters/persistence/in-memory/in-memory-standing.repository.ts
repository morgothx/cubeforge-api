import type {
  CallerStandingRecord,
  StandingRepository,
} from '../../../application/ports/standing.repository';
import type {
  MembershipId,
  PersonId,
  TenantId,
} from '../../../domain/identifiers';
import type { Membership } from '../../../domain/membership/membership.entity';
import type { Person } from '../../../domain/person/person.entity';
import { isPersonActive } from '../../../domain/person/person.entity';
import type { Tenant } from '../../../domain/tenant/tenant.entity';

/**
 * The rows a standing read needs, as `InMemoryIdentityStore` already holds
 * them.
 *
 * Read-only, and structural rather than a class: the double must not be able to
 * write through it, and nothing else about the identity store is any of this
 * repository's business.
 */
export interface InMemoryDirectory {
  readonly tenants: ReadonlyMap<TenantId, Tenant>;
  readonly people: ReadonlyMap<PersonId, Person>;
  readonly memberships: ReadonlyMap<MembershipId, Membership>;
}

/**
 * The double for the standing read, confined to one person by construction.
 *
 * PostgreSQL confines the real one with a policy over a published person. Here
 * the person is the constructor argument and there is no other way in, which is
 * the closest a map can come to the same guarantee: a query that forgot its
 * predicate is not expressible, because there is no query.
 */
export class InMemoryStandingRepository implements StandingRepository {
  constructor(
    private readonly personId: PersonId,
    private readonly directory: InMemoryDirectory,
    private readonly operators: ReadonlySet<PersonId>,
  ) {}

  describeCaller(): Promise<CallerStandingRecord | null> {
    const person = this.directory.people.get(this.personId);
    if (person === undefined) {
      return Promise.resolve(null);
    }

    const memberships = [...this.directory.memberships.values()]
      .filter((membership) => membership.personId === this.personId)
      .flatMap((membership) => {
        const tenant = this.directory.tenants.get(membership.tenantId);
        // A membership pointing at no tenant cannot exist in the database — the
        // foreign key sees to it — so dropping it here keeps the double from
        // answering for a state the real one could not reach.
        return tenant === undefined ? [] : [{ tenant, membership }];
      });

    return Promise.resolve({
      person,
      // "Recorded, and still an active person": the same meaning
      // `OperatorStatusRepository.isOperator` carries, so the two cannot
      // disagree about a word this platform uses everywhere.
      isOperator: this.operators.has(person.id) && isPersonActive(person),
      memberships,
    });
  }
}
