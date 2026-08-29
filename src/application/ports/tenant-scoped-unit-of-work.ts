import type { TenantId } from '../../domain/identifiers';
import type { ApiKeyRepository } from './api-key.repository';
import type { ExportCursorRepository } from './export-cursor.repository';
import type { MovementExportRepository } from './movement-export.repository';
import type { LocationRepository } from './location.repository';
import type { MovementRepository } from './movement.repository';
import type { MembershipRepository } from './membership.repository';
import type { PersonRepository } from './person.repository';
import type { ProductRepository } from './product.repository';
import type { TenantReadRepository } from './tenant.repository';

export const TENANT_SCOPED_UNIT_OF_WORK = Symbol('TENANT_SCOPED_UNIT_OF_WORK');

export interface TenantScopedRepositories {
  readonly tenants: TenantReadRepository;
  readonly people: PersonRepository;
  readonly memberships: MembershipRepository;
  /**
   * Managing a tenant's API keys is tenant-owned work, under the same predicate
   * as everything else here. Resolving one during authentication is a different
   * question with a different contract, because at that point the tenant is
   * what the answer will say.
   */
  readonly apiKeys: ApiKeyRepository;

  /**
   * A tenant's inventory. Here rather than behind a second unit of work for the
   * reason the comment above gives: one construction path that cannot skip the
   * tenant is worth exactly as much as the number of ways around it.
   */
  readonly products: ProductRepository;
  readonly locations: LocationRepository;
  readonly movements: MovementRepository;

  /**
   * Reading the movement stream for export, and remembering how far it has been
   * read.
   *
   * Here rather than behind a seam of their own, for the reason the comments
   * above give: one construction path that cannot skip the tenant is worth
   * exactly as much as the number of ways around it. An export that reached the
   * database by any other route would be the first reader on this platform not
   * covered by row-level security — and it reads history, which is the last
   * thing that should be the exception.
   */
  readonly movementExport: MovementExportRepository;
  readonly exportCursors: ExportCursorRepository;
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
