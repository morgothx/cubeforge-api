import { Inject, Injectable } from '@nestjs/common';
import type {
  AnalyticalAnswer,
  StockOnHandEntry,
} from '../../domain/analytics/answer';
import type { Role } from '../../domain/membership/role';
import type { ActorContext } from '../actor-context';
import {
  TENANT_SCOPED_ANALYTICS,
  type TenantScopedAnalytics,
} from '../ports/tenant-scoped-analytics';
import { tenantOf } from '../tenant-authorization';

export interface ExportedStockQuery {
  readonly actor: ActorContext;
}

/**
 * Reading exported data is reading; every member of the tenant may.
 *
 * Machines are not on this list and cannot reach the use case at all — an
 * analytical question is expensive, and a list that admitted keys would let an
 * automated client decide how often that cost is paid. `tenantOf` refuses them
 * before the roles are ever consulted.
 */
export const READ_EXPORTED_STOCK_ROLES = [
  'admin',
  'editor',
  'viewer',
] as const satisfies readonly Role[];

/**
 * What is on hand, answered from the exported objects rather than by summing
 * movements in the transactional database.
 *
 * The same question `ReadStockOnHandUseCase` answers, and deliberately a second
 * use case rather than a branch inside that one. They read different stores,
 * reach different eras of the data and fail in different ways: this one can say
 * "never carried" and can be as much as a day behind, and folding that into the
 * transactional answer would hand every existing caller a state it has no
 * reason to handle.
 *
 * **Nothing here opens a database transaction** (3.4). There is no
 * `runInTenant` and no repository, which is the whole point of the feature:
 * drawing a chart must cost the transactional store nothing.
 *
 * The role check therefore lives at the edge alone. Every other tenant-scoped
 * use case re-checks it from inside its transaction as a second layer, and that
 * layer is unavailable here by construction — a membership lives in PostgreSQL.
 * What this use case still refuses on its own is the *kind* of caller, which is
 * the part of the rule that needs no records to enforce.
 */
@Injectable()
export class ReadExportedStockUseCase {
  constructor(
    @Inject(TENANT_SCOPED_ANALYTICS)
    private readonly analytics: TenantScopedAnalytics,
  ) {}

  async execute(
    query: ExportedStockQuery,
  ): Promise<AnalyticalAnswer<StockOnHandEntry>> {
    // Taken from the actor, never from the question. There is no field on
    // `ExportedStockQuery` naming a tenant, so "ask as somebody else" is not
    // expressible rather than refused.
    // `async`, so a refused caller arrives as a rejection. `tenantOf` throws
    // synchronously, and a use case that let that escape would promise one
    // shape of failure and deliver two — the same rule the port's double had
    // to be corrected for.
    const tenantId = tenantOf(query.actor);

    return await this.analytics.askAs(tenantId, (tenant) =>
      tenant.stockOnHand(),
    );
  }
}
