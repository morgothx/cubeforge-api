import type { TenantId } from '../../domain/identifiers';
import type { MembershipRepository } from './membership.repository';
import type { PersonRepository } from './person.repository';
import type { TenantReadRepository } from './tenant.repository';

export const TENANT_SCOPED_UNIT_OF_WORK = Symbol('TENANT_SCOPED_UNIT_OF_WORK');

export interface TenantScopedRepositories {
  readonly tenants: TenantReadRepository;
  readonly people: PersonRepository;
  readonly memberships: MembershipRepository;
}

/**
 * The only way to obtain a tenant-scoped repository.
 *
 * Repositories are handed to the callback rather than injected, so there is no
 * construction path that skips the tenant. That is the structural half of the
 * guarantee: the adapter publishes the tenant for the transaction it opens, and
 * a caller cannot hold a repository outside one. Making the tenant a parameter
 * on every method instead would have left "forgot to pass it" available forever.
 */
export interface TenantScopedUnitOfWork {
  runInTenant<T>(
    tenantId: TenantId,
    work: (repositories: TenantScopedRepositories) => Promise<T>,
  ): Promise<T>;
}
