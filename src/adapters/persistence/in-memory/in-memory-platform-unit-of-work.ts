import type {
  PlatformRepositories,
  PlatformUnitOfWork,
} from '../../../application/ports/platform-unit-of-work';
import type { SetupTokenIssuingRepository } from '../../../application/ports/credential.repository';
import type { PlatformPersonRepository } from '../../../application/ports/person.repository';
import type { TenantRepository } from '../../../application/ports/tenant.repository';
import type { SecretDigest } from '../../../domain/credential/secrets';
import type { PersonId, TenantId } from '../../../domain/identifiers';
import type {
  Tenant,
  TenantStatus,
} from '../../../domain/tenant/tenant.entity';
import type { InMemoryCredentialStore } from './in-memory-credential-store';
import { InMemoryIdentityStore } from './in-memory-identity-store';

/**
 * The test double for the operator's unit of work. It offers tenants and person
 * status, and nothing else — the same shape the real one has, for the same
 * reason: requirement 3.2 is enforced by the absence of a method, not by a
 * check that could be forgotten.
 */
export class InMemoryPlatformUnitOfWork implements PlatformUnitOfWork {
  constructor(
    private readonly store: InMemoryIdentityStore,
    private readonly credentials: InMemoryCredentialStore,
  ) {}

  async runAsOperator<T>(
    work: (repositories: PlatformRepositories) => Promise<T>,
  ): Promise<T> {
    const snapshot = this.store.snapshot();
    try {
      return await work({
        tenants: new InMemoryTenantRepository(this.store),
        people: new InMemoryPlatformPersonRepository(this.store),
        setupTokens: new InMemorySetupTokenIssuingRepository(this.credentials),
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
  deactivate(personId: PersonId): Promise<void> {
    const person = this.store.people.get(personId);
    if (person) {
      this.store.people.set(personId, { ...person, status: 'deactivated' });
    }
    return Promise.resolve();
  }
}

class InMemorySetupTokenIssuingRepository implements SetupTokenIssuingRepository {
  constructor(private readonly store: InMemoryCredentialStore) {}

  insert(token: {
    readonly id: string;
    readonly personId: PersonId;
    readonly secretDigest: SecretDigest;
    readonly expiresAt: Date;
  }): Promise<void> {
    this.store.setupTokens.set(token.id, { ...token, redeemedAt: null });
    return Promise.resolve();
  }
}
