import type { PlatformPersonRepository } from './person.repository';
import type { TenantRepository } from './tenant.repository';

export const PLATFORM_UNIT_OF_WORK = Symbol('PLATFORM_UNIT_OF_WORK');

/**
 * Everything an operator can reach. There is no membership repository here, and
 * that omission is the enforcement of requirement 3.2: an operator cannot list a
 * tenant's members because the method to do so does not exist on any object they
 * can obtain. The database agrees independently — the operator identity holds no
 * grant on `memberships` at all.
 */
export interface PlatformRepositories {
  readonly tenants: TenantRepository;
  readonly people: PlatformPersonRepository;
}

export interface PlatformUnitOfWork {
  runAsOperator<T>(
    work: (repositories: PlatformRepositories) => Promise<T>,
  ): Promise<T>;
}
