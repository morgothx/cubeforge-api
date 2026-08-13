import { DomainViolation } from '../../../domain/errors';
import type {
  EmailAddress,
  MembershipId,
  PersonId,
  TenantId,
} from '../../../domain/identifiers';
import type { Membership } from '../../../domain/membership/membership.entity';
import type { Person } from '../../../domain/person/person.entity';
import type { Tenant } from '../../../domain/tenant/tenant.entity';

/**
 * The rows, and the constraints the database would apply to them.
 *
 * Uniqueness is enforced here rather than by the repositories because that is
 * where PostgreSQL enforces it: a use case that checks for a duplicate and then
 * inserts must fail the same way in both, or its tests prove a safety it does
 * not have. Tenant scoping is *not* enforced here — that belongs to the
 * repositories, which is also true of the real adapter.
 */
export class InMemoryIdentityStore {
  readonly tenants = new Map<TenantId, Tenant>();
  readonly people = new Map<PersonId, Person>();
  readonly memberships = new Map<MembershipId, Membership>();

  insertTenant(tenant: Tenant): void {
    for (const existing of this.tenants.values()) {
      if (existing.name === tenant.name) {
        throw new DomainViolation({ kind: 'tenant-name-taken' });
      }
    }
    this.tenants.set(tenant.id, tenant);
  }

  insertMembership(membership: Membership): void {
    for (const existing of this.memberships.values()) {
      if (
        existing.tenantId === membership.tenantId &&
        existing.personId === membership.personId
      ) {
        throw new DomainViolation({ kind: 'already-a-member' });
      }
    }
    this.memberships.set(membership.id, membership);
  }

  /** Addresses are normalized on the way in, so an exact match is correct. */
  findPersonByEmail(email: EmailAddress): Person | undefined {
    for (const person of this.people.values()) {
      if (person.email === email) {
        return person;
      }
    }
    return undefined;
  }

  membershipsOf(tenantId: TenantId): Membership[] {
    return [...this.memberships.values()].filter(
      (membership) => membership.tenantId === tenantId,
    );
  }

  /**
   * A shallow copy of every table, used to undo a failed unit of work. Records
   * are immutable, so copying the maps is enough to restore the previous state.
   */
  snapshot(): IdentitySnapshot {
    return {
      tenants: new Map(this.tenants),
      people: new Map(this.people),
      memberships: new Map(this.memberships),
    };
  }

  restore(snapshot: IdentitySnapshot): void {
    replace(this.tenants, snapshot.tenants);
    replace(this.people, snapshot.people);
    replace(this.memberships, snapshot.memberships);
  }
}

export interface IdentitySnapshot {
  readonly tenants: Map<TenantId, Tenant>;
  readonly people: Map<PersonId, Person>;
  readonly memberships: Map<MembershipId, Membership>;
}

function replace<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) {
    target.set(key, value);
  }
}
