import { Inject, Injectable } from '@nestjs/common';
import type { Role } from '../../domain/membership/role';
import type { ActorContext } from '../actor-context';
import type { StockLevel } from '../ports/movement.repository';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../ports/tenant-scoped-unit-of-work';
import {
  authorizeCallerInTenant,
  tenantActedIn,
} from '../tenant-authorization';

export interface ReadStockOnHandQuery {
  readonly actor: ActorContext;
}

/**
 * What is on hand, derived by summing movements rather than read from a column
 * somebody keeps correct.
 *
 * There is no caching and no pre-aggregation here on purpose. Summing is the
 * right answer at this feature's scale, and pre-aggregation is precisely what
 * the semantic layer of a later feature exists to do — building it here would
 * build that feature twice, in the place with the least information about how
 * the numbers are actually asked for.
 */
/** Reading stock is reading; every member may. */
export const READ_STOCK_ROLES = [
  'admin',
  'editor',
  'viewer',
] as const satisfies readonly Role[];

@Injectable()
export class ReadStockOnHandUseCase {
  constructor(
    @Inject(TENANT_SCOPED_UNIT_OF_WORK)
    private readonly tenants: TenantScopedUnitOfWork,
  ) {}

  async execute(query: ReadStockOnHandQuery): Promise<readonly StockLevel[]> {
    const tenantId = tenantActedIn(query.actor);

    return this.tenants.runInTenant(tenantId, async (repositories) => {
      await authorizeCallerInTenant(
        repositories,
        query.actor,
        READ_STOCK_ROLES,
      );

      return repositories.movements.stockOnHand();
    });
  }
}
