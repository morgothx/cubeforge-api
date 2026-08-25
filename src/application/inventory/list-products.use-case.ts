import { Inject, Injectable } from '@nestjs/common';
import type { Sku } from '../../domain/inventory/identifiers';
import type { Role } from '../../domain/membership/role';
import type { ActorContext } from '../actor-context';
import type { ReferenceEntity } from '../ports/reference.repository';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../ports/tenant-scoped-unit-of-work';
import {
  authorizeCallerInTenant,
  tenantActedIn,
} from '../tenant-authorization';

export interface ListProductsQuery {
  readonly actor: ActorContext;
}

/**
 * What a tenant tracks. An integrator reads this to reconcile its own catalogue
 * against what the platform believes it declared.
 */
/** Reading the catalogue tells a caller nothing it did not send. */
export const LIST_PRODUCTS_ROLES = [
  'admin',
  'editor',
  'viewer',
] as const satisfies readonly Role[];

@Injectable()
export class ListProductsUseCase {
  constructor(
    @Inject(TENANT_SCOPED_UNIT_OF_WORK)
    private readonly tenants: TenantScopedUnitOfWork,
  ) {}

  async execute(
    query: ListProductsQuery,
  ): Promise<readonly ReferenceEntity<Sku>[]> {
    const tenantId = tenantActedIn(query.actor);

    return this.tenants.runInTenant(tenantId, async (repositories) => {
      await authorizeCallerInTenant(
        repositories,
        query.actor,
        LIST_PRODUCTS_ROLES,
      );

      return repositories.products.list();
    });
  }
}
