import {
  AnalyticsUnavailable,
  type AnalyticsFailureReason,
} from '../../application/analytics/analytics-failure';
import type {
  TenantAnalytics,
  TenantScopedAnalytics,
} from '../../application/ports/tenant-scoped-analytics';
import {
  answered,
  neverExported,
  type AnalyticalAnswer,
  type MovementsOnDayEntry,
  type StockOnHandEntry,
} from '../../domain/analytics/answer';
import type { Period } from '../../domain/analytics/period';
import {
  requireWellFormedTenant,
  type TenantId,
} from '../../domain/identifiers';

/** What a tenant has been carried, as a test arranges it. */
interface Carried {
  readonly completeThrough: Date;
  readonly stock: readonly StockOnHandEntry[];
  readonly movements: readonly MovementsOnDayEntry[];
}

/**
 * The seam a use-case test runs against.
 *
 * It models the three properties the real one has that a use case can observe,
 * because a double looser than the thing it stands for hides exactly the bug it
 * exists to catch — a lesson this feature's predecessor paid for four separate
 * times:
 *
 * - The tenant is **bound by the seam** and refused unless it is well formed.
 *   A double that accepted anything would let the real seam's one defence go
 *   untested from above.
 * - A tenant nothing has been carried for answers `never-exported`, not an
 *   empty answer. Collapsing the two is the bug the union exists to prevent.
 * - A period **filters**. A double ignoring it would let a use case pass while
 *   asking the engine for a tenant's whole history.
 */
export class InMemoryAnalytics implements TenantScopedAnalytics {
  private readonly carriedFor = new Map<string, Carried>();
  private refusal: AnalyticsFailureReason | null = null;

  /** Arranges what a tenant has been carried, and how far. */
  carried(
    tenant: TenantId,
    completeThrough: Date,
    what: {
      stock?: readonly StockOnHandEntry[];
      movements?: readonly MovementsOnDayEntry[];
    },
  ): void {
    this.carriedFor.set(tenant, {
      completeThrough,
      stock: what.stock ?? [],
      movements: what.movements ?? [],
    });
  }

  /** Makes every question fail, with the diagnosis the real one would give. */
  fails(reason: AnalyticsFailureReason): void {
    this.refusal = reason;
  }

  /**
   * `async`, so a refused tenant arrives as a rejection rather than as a
   * synchronous throw. The port promises one shape of failure and a caller
   * reaching for `.catch` without awaiting would miss the other — and the real
   * seam refuses the same identifier at the same point, so the two have to agree
   * on *how* they refuse and not only on whether.
   */
  async askAs<T>(
    tenantId: TenantId,
    question: (analytics: TenantAnalytics) => Promise<T>,
  ): Promise<T> {
    requireWellFormedTenant(tenantId, 'one a question may be asked for');

    if (this.refusal !== null) {
      throw new AnalyticsUnavailable(
        this.refusal,
        new Error('arranged to fail'),
      );
    }

    return question(this.boundTo(this.carriedFor.get(tenantId)));
  }

  private boundTo(carried: Carried | undefined): TenantAnalytics {
    return {
      stockOnHand: () =>
        Promise.resolve(answerOf(carried, (held) => held.stock)),
      movementsByDay: (period: Period) =>
        Promise.resolve(
          answerOf(carried, (held) =>
            held.movements.filter((entry) => period.covers(entry.day)),
          ),
        ),
    };
  }
}

function answerOf<Entry>(
  carried: Carried | undefined,
  entriesOf: (held: Carried) => readonly Entry[],
): AnalyticalAnswer<Entry> {
  return carried === undefined
    ? neverExported()
    : answered(carried.completeThrough, entriesOf(carried));
}
