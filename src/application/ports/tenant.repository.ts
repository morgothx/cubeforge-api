import type { TenantId } from '../../domain/identifiers';
import type { Tenant, TenantStatus } from '../../domain/tenant/tenant.entity';

/**
 * Reading the tenant a request is acting in. There is no `findById`, because
 * inside a tenant transaction exactly one tenant is reachable and asking for
 * another one is a question the caller should not be able to phrase.
 */
export interface TenantReadRepository {
  findCurrent(): Promise<Tenant | null>;
}

/**
 * Tenant administration, available to platform operators only. Renaming is
 * absent because the requirements defer it; the only mutation is the status
 * transition behind deactivation.
 */
export interface TenantRepository {
  findById(id: TenantId): Promise<Tenant | null>;
  list(): Promise<Tenant[]>;

  /**
   * Throws `DomainViolation({ kind: 'tenant-name-taken' })` when the name is
   * already in use. The uniqueness check belongs to the store rather than to a
   * prior read, so two concurrent requests for the same name cannot both pass
   * it. Every adapter owes the same behaviour, or use-case tests would prove
   * something production does not do.
   */
  insert(tenant: Tenant): Promise<void>;
  updateStatus(id: TenantId, status: TenantStatus): Promise<void>;
}
