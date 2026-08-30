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

/** How long one question may take before it is stopped. */
const LONGEST_QUESTION_MILLISECONDS = 30_000;

const MOVEMENTS_BY_DAY: readonly AnswerColumn[] = [
  { name: 'recorded_date', kind: 'day' },
  { name: 'kind', kind: 'text' },
  { name: 'quantity', kind: 'whole-number' },
];

const STOCK_ON_HAND: readonly AnswerColumn[] = [
  { name: 'sku', kind: 'text' },
  { name: 'name', kind: 'text' },
  { name: 'on_hand', kind: 'whole-number' },
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
 * Both questions live here, which is the reason for the constraint above: two
 * statements in one place can be read against each other, and the second one
 * joins a second table — two places a tenant could be lost rather than one.
 */
export class AthenaAnalytics implements TenantScopedAnalytics {
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
    question: (analytics: TenantAnalytics) => Promise<T>,
  ): Promise<T> {
    requireWellFormedTenant(tenantId, 'one a question may be asked for');
    return question(this.boundTo(tenantId));
  }

  close(): void {
    this.engine.close();
  }

  private boundTo(tenant: TenantId): TenantAnalytics {
    return {
      stockOnHand: () => this.stockOnHand(tenant),
      movementsByDay: (period) => this.movementsByDay(tenant, period),
    };
  }

  /**
   * What is on hand, named as the catalogue names it.
   *
   * The join is why the catalogue is exported at all: a chart resolving its own
   * labels would put that work back on the transactional database, which is the
   * one thing this pipeline exists to avoid.
   *
   * **Both tables carry the tenant, and both are constrained.** Joining on it
   * alone would be one condition where the layout wants two — and with the
   * tenant projected as an injected column, an engine will refuse a question
   * that leaves either table unconstrained.
   *
   * An inner join, deliberately: a movement whose product is not in the
   * catalogue would vanish. That cannot happen, because the transactional API
   * refuses a movement naming a product nobody declared — and if it ever could,
   * a missing label would be the smaller half of the problem.
   */
  private async stockOnHand(
    tenant: TenantId,
  ): Promise<AnalyticalAnswer<StockOnHandEntry>> {
    const completeThrough = await this.completeThrough(tenant);
    if (completeThrough === null) {
      return neverExported();
    }

    const rows = await this.ask(
      `SELECT m.sku AS sku, p.name AS name, sum(m.quantity) AS on_hand
         FROM movements m
         JOIN products p ON p.code = m.sku
        WHERE ${tenantIs(tenant, 'm')}
          AND ${tenantIs(tenant, 'p')}
        GROUP BY m.sku, p.name
        ORDER BY m.sku`,
      STOCK_ON_HAND,
    );

    return answered(
      completeThrough,
      rows.map((row) => ({
        sku: String(row.get('sku')),
        name: String(row.get('name')),
        onHand: Number(row.get('on_hand')),
      })),
    );
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
const tenantIs = (tenant: TenantId, of?: string): string =>
  `${of === undefined ? '' : `${of}.`}tenant_id = '${tenant}'`;
