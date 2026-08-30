import { Inject, Injectable } from '@nestjs/common';
import type {
  AnalyticalAnswer,
  MovementsOnDayEntry,
} from '../../domain/analytics/answer';
import type { Period } from '../../domain/analytics/period';
import type { Role } from '../../domain/membership/role';
import type { ActorContext } from '../actor-context';
import {
  TENANT_SCOPED_ANALYTICS,
  type TenantScopedAnalytics,
} from '../ports/tenant-scoped-analytics';
import { tenantOf } from '../tenant-authorization';

export interface MovementHistoryQuery {
  readonly actor: ActorContext;
  /**
   * Required, and a `Period` rather than two days.
   *
   * A question with no bound would read a tenant's whole history, and the way
   * that is prevented is that the caller cannot express it: there is no
   * constructor for an unbounded period and none for an over-long one, so a
   * refused period never becomes a query and therefore never reaches the engine
   * (1.4, 1.5).
   */
  readonly period: Period;
}

/** Reading exported data is reading; every member of the tenant may. */
export const READ_MOVEMENT_HISTORY_ROLES = [
  'admin',
  'editor',
  'viewer',
] as const satisfies readonly Role[];

/**
 * What moved on each day of a period, answered from the exported objects.
 *
 * A period with nothing in it is an answer with no entries, not a refusal (4.2)
 * — a chart asking about a quiet month wants an empty chart, and an error there
 * would make "nothing happened" indistinguishable from "something broke". A
 * tenant that has never been carried is the third state, and the answer union
 * is what keeps a reader from confusing it with the second.
 *
 * As with the on-hand question, **no database transaction is opened** (3.4).
 */
@Injectable()
export class ReadMovementHistoryUseCase {
  constructor(
    @Inject(TENANT_SCOPED_ANALYTICS)
    private readonly analytics: TenantScopedAnalytics,
  ) {}

  async execute(
    query: MovementHistoryQuery,
  ): Promise<AnalyticalAnswer<MovementsOnDayEntry>> {
    const tenantId = tenantOf(query.actor);

    return await this.analytics.askAs(tenantId, (tenant) =>
      tenant.movementsByDay(query.period),
    );
  }
}
