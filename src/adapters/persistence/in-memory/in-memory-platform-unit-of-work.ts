import type {
  PlatformRepositories,
  PlatformUnitOfWork,
} from '../../../application/ports/platform-unit-of-work';
import type { PlatformPersonRepository } from '../../../application/ports/person.repository';
import type { TenantRepository } from '../../../application/ports/tenant.repository';
import type { PersonId, TenantId } from '../../../domain/identifiers';
import type { PersonStatus } from '../../../domain/person/person.entity';
import type {
  Tenant,
  TenantStatus,
} from '../../../domain/tenant/tenant.entity';
import { InMemoryIdentityStore } from './in-memory-identity-store';

/**
 * The test double for the operator's unit of work. It offers tenants and person
 * status, and nothing else — the same shape the real one has, for the same
 * reason: requirement 3.2 is enforced by the absence of a method, not by a
 * check that could be forgotten.
 */
export class InMemoryPlatformUnitOfWork implements PlatformUnitOfWork {
  constructor(private readonly store: InMemoryIdentityStore) {}

  async runAsOperator<T>(
    work: (repositories: PlatformRepositories) => Promise<T>,
  ): Promise<T> {
    const snapshot = this.store.snapshot();
    try {
      return await work({
        tenants: new InMemoryTenantRepository(this.store),
        people: new InMemoryPlatformPersonRepository(this.store),
      });
    } catch (error) {
      this.store.restore(snapshot);
      throw error;
    }
  }
}

class InMemoryTenantRepository implements TenantRepository {
  constructor(private readonly store: InMemoryIdentityStore) {}

  findById(id: TenantId): Promise<Tenant | null> {
    return Promise.resolve(this.store.tenants.get(id) ?? null);
  }

  findByName(name: string): Promise<Tenant | null> {
    const found = [...this.store.tenants.values()].find(
      (tenant) => tenant.name === name,
    );
    return Promise.resolve(found ?? null);
  }

  list(): Promise<Tenant[]> {
    return Promise.resolve([...this.store.tenants.values()]);
  }

  insert(tenant: Tenant): Promise<void> {
    this.store.insertTenant(tenant);
    return Promise.resolve();
  }

  updateStatus(id: TenantId, status: TenantStatus): Promise<void> {
    const tenant = this.store.tenants.get(id);
    if (tenant) {
      this.store.tenants.set(id, { ...tenant, status });
    }
    return Promise.resolve();
  }
}

class InMemoryPlatformPersonRepository implements PlatformPersonRepository {
  constructor(private readonly store: InMemoryIdentityStore) {}

  /**
   * An unknown identifier changes nothing and reports success. The operator
   * holds no read grant on people in PostgreSQL, so this is not a choice the
   * adapter could make differently even if it wanted to — and reporting
   * not-found would answer whether the person exists, which requirement 3.3
   * forbids.
   */
  updateStatus(personId: PersonId, status: PersonStatus): Promise<void> {
    const person = this.store.people.get(personId);
    if (person) {
      this.store.people.set(personId, { ...person, status });
    }
    return Promise.resolve();
  }
}
