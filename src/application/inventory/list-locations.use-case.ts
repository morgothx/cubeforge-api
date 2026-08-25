import { Inject, Injectable } from '@nestjs/common';
import type { LocationCode } from '../../domain/inventory/identifiers';
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

export interface ListLocationsQuery {
  readonly actor: ActorContext;
}

/**
 * Where a tenant keeps stock. Read for the same reason as the catalogue: to
 * reconcile against what the platform believes was declared.
 */
/** As the catalogue. */
export const LIST_LOCATIONS_ROLES = [
  'admin',
  'editor',
  'viewer',
] as const satisfies readonly Role[];

@Injectable()
export class ListLocationsUseCase {
  constructor(
    @Inject(TENANT_SCOPED_UNIT_OF_WORK)
    private readonly tenants: TenantScopedUnitOfWork,
  ) {}

  async execute(
    query: ListLocationsQuery,
  ): Promise<readonly ReferenceEntity<LocationCode>[]> {
    const tenantId = tenantActedIn(query.actor);

    return this.tenants.runInTenant(tenantId, async (repositories) => {
      await authorizeCallerInTenant(
        repositories,
        query.actor,
        LIST_LOCATIONS_ROLES,
      );

      return repositories.locations.list();
    });
  }
}
