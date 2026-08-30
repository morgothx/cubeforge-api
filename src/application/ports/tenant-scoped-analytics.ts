import type {
  AnalyticalAnswer,
  MovementsOnDayEntry,
  StockOnHandEntry,
} from '../../domain/analytics/answer';
import type { Period } from '../../domain/analytics/period';
import type { TenantId } from '../../domain/identifiers';

export const TENANT_SCOPED_ANALYTICS = Symbol('TENANT_SCOPED_ANALYTICS');

/**
 * The questions one tenant may ask of the exported data.
 *
 * **No method takes a tenant**, and that absence is the isolation. The tenant is
 * bound when the seam hands this object over, so a question naming a tenant is
 * not expressible rather than merely refused — the same shape as the
 * transactional seam, for the same reason.
 *
 * Two questions and no way to compose a third. A general query interface would
 * be another surface for the tenant to be lost on, and this is the one property
 * the feature cannot afford to weaken.
 */
export interface TenantAnalytics {
  /** How much of each product is on hand, named as the catalogue names it. */
  stockOnHand(): Promise<AnalyticalAnswer<StockOnHandEntry>>;

  /** How much moved on each day of the period. */
  movementsByDay(
    period: Period,
  ): Promise<AnalyticalAnswer<MovementsOnDayEntry>>;
}

/**
 * The only way to obtain a `TenantAnalytics`.
 *
 * Handed to a callback rather than injected, so there is no construction path
 * that skips the tenant — the same guarantee `TenantScopedUnitOfWork` gives, and
 * the same reason it is a callback rather than a parameter on every method.
 *
 * It is **not** a unit of work. There is no transaction here and nothing to roll
 * back: the analytical store is read-only to this feature, and modelling a
 * transaction would promise an atomicity that does not exist. It is also why
 * asking a question opens no database connection at all, which is what keeps
 * analysis off the transactional store.
 */
export interface TenantScopedAnalytics {
  askAs<T>(
    tenantId: TenantId,
    question: (analytics: TenantAnalytics) => Promise<T>,
  ): Promise<T>;
}
