import type {
  MembershipRepository,
  MembershipWithPerson,
} from '../../../application/ports/membership.repository';
import type { PersonRepository } from '../../../application/ports/person.repository';
import type {
  TenantScopedRepositories,
  TenantScopedUnitOfWork,
} from '../../../application/ports/tenant-scoped-unit-of-work';
import type { TenantReadRepository } from '../../../application/ports/tenant.repository';
import type {
  EmailAddress,
  MembershipId,
  PersonId,
  TenantId,
} from '../../../domain/identifiers';
import type {
  Membership,
  MembershipStatus,
} from '../../../domain/membership/membership.entity';
import type { Role } from '../../../domain/membership/role';
import { createPerson } from '../../../domain/person/person.entity';
import type { Person } from '../../../domain/person/person.entity';
import type { Tenant } from '../../../domain/tenant/tenant.entity';
import type { ProductAttributes } from '../../../application/ports/product.repository';
import type { LocationAttributes } from '../../../application/ports/location.repository';
import type { LocationCode, Sku } from '../../../domain/inventory/identifiers';
import type { InMemoryApiKeyStore } from './in-memory-api-key-store';
import {
  InMemoryExportCursorRepository,
  InMemoryMovementExportRepository,
} from './in-memory-export-store';
import {
  InMemoryInventoryStore,
  InMemoryMovementRepository,
  InMemoryReferenceRepository,
} from './in-memory-inventory-store';
import { InMemoryIdentityStore } from './in-memory-identity-store';

/**
 * The test double for the tenant-scoped unit of work.
 *
 * It mirrors the two properties of the real one that use cases depend on:
 * repositories exist only inside `runInTenant`, and every one of them is bound
 * to that tenant. Failure discards the work, because a use case that rejects a
 * request must leave nothing behind and a double that kept the writes would let
 * that bug through.
 */
export class InMemoryTenantScopedUnitOfWork implements TenantScopedUnitOfWork {
  constructor(
    private readonly store: InMemoryIdentityStore,
    private readonly keys: InMemoryApiKeyStore,
    /**
     * Defaulted, so every existing test that builds this with two stores keeps
     * working. A test that never touches inventory still gets a real one rather
     * than a hole, because a use case reaching for `movements` in a context
     * that forgot to pass a store should fail on what it did, not on `undefined`.
     */
    private readonly inventory: InMemoryInventoryStore = new InMemoryInventoryStore(),
  ) {}

  async runInTenant<T>(
    tenantId: TenantId,
    work: (repositories: TenantScopedRepositories) => Promise<T>,
  ): Promise<T> {
    const snapshot = this.store.snapshot();
    const inventorySnapshot = this.inventory.snapshot();
    try {
      return await work({
        tenants: new InMemoryTenantReadRepository(this.store, tenantId),
        people: new InMemoryPersonRepository(this.store, tenantId),
        memberships: new InMemoryMembershipRepository(this.store, tenantId),
        apiKeys: this.keys.scopedTo(tenantId),
        products: new InMemoryReferenceRepository<Sku, ProductAttributes>(
          this.inventory.products,
          tenantId,
          () => new Date(),
        ),
        locations: new InMemoryReferenceRepository<
          LocationCode,
          LocationAttributes
        >(this.inventory.locations, tenantId, () => new Date()),
        movements: new InMemoryMovementRepository(this.inventory, tenantId),
        movementExport: new InMemoryMovementExportRepository(
          this.inventory,
          tenantId,
        ),
        exportCursors: new InMemoryExportCursorRepository(
          this.inventory,
          tenantId,
        ),
      });
    } catch (error) {
      // Both stores, or a use case that rejects after writing inventory would
      // leave it behind — which is the bug this rollback exists to catch.
      this.store.restore(snapshot);
      this.inventory.restore(inventorySnapshot);
      throw error;
    }
  }
}

class InMemoryTenantReadRepository implements TenantReadRepository {
  constructor(
    private readonly store: InMemoryIdentityStore,
    private readonly tenantId: TenantId,
  ) {}

  findCurrent(): Promise<Tenant | null> {
    return Promise.resolve(this.store.tenants.get(this.tenantId) ?? null);
  }
}

class InMemoryPersonRepository implements PersonRepository {
  constructor(
    private readonly store: InMemoryIdentityStore,
    private readonly tenantId: TenantId,
  ) {}

  /**
   * Visible only through a membership in this tenant — the same rule the
   * `people_app_read` policy applies in PostgreSQL.
   */
  findById(personId: PersonId): Promise<Person | null> {
    const belongsHere = this.store
      .membershipsOf(this.tenantId)
      .some((membership) => membership.personId === personId);
    if (!belongsHere) {
      return Promise.resolve(null);
    }
    return Promise.resolve(this.store.people.get(personId) ?? null);
  }

  /**
   * Searches every person on the platform, not only this tenant's. That is the
   * whole point of the operation: in PostgreSQL it runs as a SECURITY DEFINER
   * function for exactly this reason, and a double that searched only the
   * current tenant would create a second person for an address already taken —
   * failing here in a way production never would.
   */
  findOrCreateByEmail(input: {
    readonly candidateId: PersonId;
    readonly email: EmailAddress;
    readonly createdAt: Date;
  }): Promise<PersonId> {
    const existing = this.store.findPersonByEmail(input.email);
    if (existing) {
      return Promise.resolve(existing.id);
    }

    const person = createPerson({
      id: input.candidateId,
      email: input.email,
      createdAt: input.createdAt,
    });
    this.store.people.set(person.id, person);
    return Promise.resolve(person.id);
  }
}

class InMemoryMembershipRepository implements MembershipRepository {
  constructor(
    private readonly store: InMemoryIdentityStore,
    private readonly tenantId: TenantId,
  ) {}

  private scoped(): Membership[] {
    return this.store.membershipsOf(this.tenantId);
  }

  findById(membershipId: MembershipId): Promise<Membership | null> {
    return Promise.resolve(
      this.scoped().find((membership) => membership.id === membershipId) ??
        null,
    );
  }

  findByPerson(personId: PersonId): Promise<Membership | null> {
    return Promise.resolve(
      this.scoped().find((membership) => membership.personId === personId) ??
        null,
    );
  }

  countActiveAdministrators(): Promise<number> {
    return Promise.resolve(
      this.scoped().filter(
        (membership) =>
          membership.role === 'admin' && membership.status === 'active',
      ).length,
    );
  }

  listMembers(options: {
    readonly includeInactive: boolean;
  }): Promise<MembershipWithPerson[]> {
    const members = this.scoped()
      .filter(
        (membership) =>
          options.includeInactive || membership.status === 'active',
      )
      .map((membership) => {
        const person = this.store.people.get(membership.personId);
        if (!person) {
          throw new Error(
            `membership ${membership.id} refers to a person that does not exist`,
          );
        }
        return {
          membership,
          email: person.email,
          personStatus: person.status,
        };
      });
    return Promise.resolve(members);
  }

  insert(membership: Membership): Promise<void> {
    this.store.insertMembership(membership);
    return Promise.resolve();
  }

  updateStatus(
    membershipId: MembershipId,
    status: MembershipStatus,
  ): Promise<void> {
    return this.update(membershipId, (membership) => ({
      ...membership,
      status,
    }));
  }

  updateRole(membershipId: MembershipId, role: Role): Promise<void> {
    return this.update(membershipId, (membership) => ({ ...membership, role }));
  }

  /**
   * Silently ignores a membership outside this tenant, matching what the RLS
   * policy does to an update whose predicate excludes the row: no rows change,
   * no error. A use case must therefore not infer existence from a successful
   * update.
   */
  private update(
    membershipId: MembershipId,
    change: (membership: Membership) => Membership,
  ): Promise<void> {
    const membership = this.scoped().find(
      (candidate) => candidate.id === membershipId,
    );
    if (membership) {
      this.store.memberships.set(membership.id, change(membership));
    }
    return Promise.resolve();
  }
}
