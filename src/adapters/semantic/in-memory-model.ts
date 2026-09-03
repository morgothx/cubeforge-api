import {
  AnalyticsUnavailable,
  type AnalyticsFailureReason,
} from '../../application/analytics/analytics-failure';
import type {
  ModelQuestions,
  TenantScopedModel,
} from '../../application/ports/tenant-scoped-model';
import type { Day } from '../../domain/analytics/period';
import {
  requireWellFormedTenant,
  type TenantId,
} from '../../domain/identifiers';
import {
  answeredFrom,
  neverExported,
  type ModelledAnswer,
  type ModelledRow,
  type ServedFrom,
} from '../../domain/semantic/modelled-answer';
import type { ModelledQuestion } from '../../domain/semantic/question';

/** What a tenant has been carried, as a test arranges it. */
interface Carried {
  readonly completeThrough: Date;
  readonly rows: readonly ModelledRow[];
  readonly servedFrom: ServedFrom;
}

/**
 * The seam a use-case test runs against.
 *
 * It models the properties the real one has that a use case can observe,
 * because a double looser than the thing it stands for hides exactly the bug it
 * exists to catch — a lesson the analytical feature paid for four separate
 * times, and its own double carries the same list one shape up:
 *
 * - The tenant is **bound by the seam** and refused unless well formed, as a
 *   rejection rather than a synchronous throw. The real seam refuses the same
 *   identifier at the same point, so the two have to agree on *how* they refuse
 *   and not only on whether.
 * - A tenant nothing was carried for answers `never-exported`, not an empty
 *   answer. Collapsing the two is the bug the union exists to prevent.
 * - A period **filters**, and by the moment the question says to read by. A
 *   double ignoring either would let a use case pass while asking the model for
 *   a tenant's whole history, or for the wrong one of two days that differ only
 *   when data is backdated.
 * - It **does not trim to the row bound**. Truncating here would make the
 *   caller's over-bound refusal untestable and permanently green — a check that
 *   cannot fail is not a check.
 * - Provenance is arranged rather than invented, so a test asserting an answer
 *   came from what was prepared is asserting something the real seam also
 *   reports.
 */
export class InMemoryModel implements TenantScopedModel {
  private readonly carriedFor = new Map<string, Carried>();
  private refusal: AnalyticsFailureReason | null = null;

  /** Arranges what a tenant has been carried, and how far. */
  carried(
    tenant: TenantId,
    completeThrough: Date,
    what: {
      rows?: readonly ModelledRow[];
      servedFrom?: ServedFrom;
    },
  ): void {
    this.carriedFor.set(tenant, {
      completeThrough,
      rows: what.rows ?? [],
      servedFrom: what.servedFrom ?? 'exported-objects',
    });
  }

  /** Makes every question fail, with the diagnosis the real one would give. */
  fails(reason: AnalyticsFailureReason): void {
    this.refusal = reason;
  }

  async askAs<T>(
    tenantId: TenantId,
    question: (model: ModelQuestions) => Promise<T>,
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

  private boundTo(carried: Carried | undefined): ModelQuestions {
    return {
      ask: (asked: ModelledQuestion) =>
        Promise.resolve(answerOf(carried, asked)),
    };
  }
}

function answerOf(
  carried: Carried | undefined,
  asked: ModelledQuestion,
): ModelledAnswer {
  if (carried === undefined) {
    return neverExported();
  }

  const column = asked.by === 'recorded' ? 'recorded_day' : 'occurred_day';

  return answeredFrom(
    carried.servedFrom,
    carried.completeThrough,
    carried.rows.filter((row) => withinPeriod(row, column, asked)),
  );
}

/**
 * A row carrying no day at all is kept.
 *
 * A question grouped only by kind has no day to filter on, and dropping those
 * rows would make the double answer nothing for a question the real model
 * answers fully. Absent is not "outside the period" — it is nothing to compare.
 */
function withinPeriod(
  row: ModelledRow,
  column: string,
  asked: ModelledQuestion,
): boolean {
  const value = row.values[column];

  return typeof value === 'string' ? asked.period.covers(value as Day) : true;
}
