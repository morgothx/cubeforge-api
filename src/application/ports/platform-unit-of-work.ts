import type { SetupTokenIssuingRepository } from './credential.repository';
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
  /**
   * Issuing a credential setup token is an operator act, and issuing is all it
   * is: the operator cannot read a token back or redeem one. The database says
   * the same independently — an INSERT grant and nothing else.
   */
  readonly setupTokens: SetupTokenIssuingRepository;
}

export interface PlatformUnitOfWork {
  runAsOperator<T>(
    work: (repositories: PlatformRepositories) => Promise<T>,
  ): Promise<T>;
}
