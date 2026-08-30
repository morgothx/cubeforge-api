import type { TenantAnalytics } from '../../application/ports/tenant-scoped-analytics';
import {
  answered,
  neverExported,
  type AnalyticalAnswer,
  type MovementsOnDayEntry,
} from '../../domain/analytics/answer';
import {
  decodeRows,
  type AnswerColumn,
  type DecodedRow,
} from '../../domain/analytics/answer-shape';
import type { Day, Period } from '../../domain/analytics/period';
import {
  requireWellFormedTenant,
  type TenantId,
} from '../../domain/identifiers';
import type { AnalyticsConfig } from './analytics-config';
import { AthenaEngine } from './athena-engine';
import { QueryRunner } from './athena-query-runner';

/**
 * The half of the port this file answers today.
 *
 * Task 4.4 widens it to the whole of `TenantAnalytics`. Naming the subset keeps
 * the gap in the type system, where the compiler is watching, instead of in a
 * method that would compile and then throw.
 */
type AnsweredSoFar = Pick<TenantAnalytics, 'movementsByDay'>;

/** How long one question may take before it is stopped. */
const LONGEST_QUESTION_MILLISECONDS = 30_000;

const MOVEMENTS_BY_DAY: readonly AnswerColumn[] = [
  { name: 'recorded_date', kind: 'day' },
  { name: 'kind', kind: 'text' },
  { name: 'quantity', kind: 'whole-number' },
];

const WATERMARK: readonly AnswerColumn[] = [
  { name: 'complete_through', kind: 'moment' },
];

/**
 * The seam, and the only file on this platform holding a statement.
 *
 * One file on purpose: what runs here is written for one engine and exercised
 * against another, so the whole dialect surface has to be reviewable in one
 * place. Every statement is restricted to what both accept — `SELECT`, `JOIN`,
 * `GROUP BY`, `SUM`, comparison, `ORDER BY` — and nothing engine-specific.
 *
 * `stockOnHand` is not here yet. Task 4.4 adds it beside `movementsByDay`, and
 * only then does this class declare `implements TenantScopedAnalytics` and hand
 * out the whole port. Until it can answer both, it says so in its types rather
 * than shipping a method that throws when called.
 */
export class AthenaAnalytics {
  private readonly engine: AthenaEngine;
  private readonly runner: QueryRunner;

  constructor(
    config: AnalyticsConfig,
    private readonly budget = LONGEST_QUESTION_MILLISECONDS,
  ) {
    this.engine = new AthenaEngine(config);
    this.runner = new QueryRunner(this.engine);
  }

  /**
   * Binds the tenant, and refuses one that is not well formed.
   *
   * This is where a tenant identifier stops being a value and becomes part of a
   * statement, which makes it the one place on this path where a malformed one
   * could reach somewhere that is not its own with every query being correct.
   * The same check the export applies before a tenant becomes a path segment.
   */
  async askAs<T>(
    tenantId: TenantId,
    question: (analytics: AnsweredSoFar) => Promise<T>,
  ): Promise<T> {
    requireWellFormedTenant(tenantId, 'one a question may be asked for');
    return question(this.boundTo(tenantId));
  }

  close(): void {
    this.engine.close();
  }

  private boundTo(tenant: TenantId): AnsweredSoFar {
    return {
      movementsByDay: (period) => this.movementsByDay(tenant, period),
    };
  }

  private async movementsByDay(
    tenant: TenantId,
    period: Period,
  ): Promise<AnalyticalAnswer<MovementsOnDayEntry>> {
    const completeThrough = await this.completeThrough(tenant);
    if (completeThrough === null) {
      return neverExported();
    }

    const rows = await this.ask(
      `SELECT recorded_date, kind, sum(quantity) AS quantity
         FROM movements
        WHERE ${tenantIs(tenant)}
          AND recorded_date >= '${period.from}'
          AND recorded_date <= '${period.to}'
        GROUP BY recorded_date, kind
        ORDER BY recorded_date, kind`,
      MOVEMENTS_BY_DAY,
    );

    return answered(
      completeThrough,
      rows.map((row) => ({
        day: row.get('recorded_date') as Day,
        kind: String(row.get('kind')),
        quantity: Number(row.get('quantity')),
      })),
    );
  }

  /**
   * How far this tenant has been carried, or nothing at all.
   *
   * Read for every answer, and read from the exported data rather than from the
   * transactional database — which is the point: an answer that had to ask the
   * store this pipeline exists to keep out of the way would be answering with
   * one hand while defeating itself with the other.
   *
   * No mark means this tenant has never been carried, which is a different
   * answer from having nothing to say.
   */
  private async completeThrough(tenant: TenantId): Promise<Date | null> {
    const rows = await this.ask(
      `SELECT complete_through FROM watermarks WHERE ${tenantIs(tenant)}`,
      WATERMARK,
    );

    const moment = rows[0]?.get('complete_through');
    return moment instanceof Date ? moment : null;
  }

  private async ask(
    statement: string,
    columns: readonly AnswerColumn[],
  ): Promise<readonly DecodedRow[]> {
    const result = await this.runner.run(
      statement,
      new Date(Date.now() + this.budget),
    );
    return decodeRows(columns, result.header, result.rows);
  }
}

/**
 * The tenant, in a statement.
 *
 * Interpolated rather than bound as a parameter, and that is a decision with a
 * reason: the emulator drops parameters entirely, so a bound one could not be
 * exercised by any local test. What can be exercised is the refusal above,
 * which is why the identifier is checked before it ever reaches here.
 */
const tenantIs = (tenant: TenantId): string => `tenant_id = '${tenant}'`;
