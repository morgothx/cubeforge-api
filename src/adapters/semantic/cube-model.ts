import { AnalyticsUnavailable } from '../../application/analytics/analytics-failure';
import type {
  ModelQuestions,
  TenantScopedModel,
} from '../../application/ports/tenant-scoped-model';
import {
  requireWellFormedTenant,
  type TenantId,
} from '../../domain/identifiers';
import {
  answeredFrom,
  neverExported,
  type ModelledAnswer,
  type ModelledRow,
} from '../../domain/semantic/modelled-answer';
import type { ModelledQuestion } from '../../domain/semantic/question';
import type { CubeQuery, CubeResult, ModelTransport } from './cube-client';
import {
  GROUPING_MEMBERS,
  MEASURE_MEMBERS,
  READ_BY_MEMBER,
  WATERMARK_MEMBER,
  type MappedColumn,
} from './member-mapping';
import type { SecurityContextIssuer } from './security-context';

/**
 * The only file that composes a modelled question.
 *
 * That is what makes the whole surface a tenant could go missing from
 * reviewable at once — the same property the analytical adapter keeps by
 * holding every statement in one place. Nothing else here builds a query, and
 * nothing else translates a name.
 */
export class CubeModel implements TenantScopedModel {
  constructor(
    private readonly transport: ModelTransport,
    private readonly contexts: SecurityContextIssuer,
    private readonly now: () => Date,
  ) {}

  async askAs<T>(
    tenantId: TenantId,
    question: (model: ModelQuestions) => Promise<T>,
  ): Promise<T> {
    // Before anything is signed, and before anything is asked. Below here the
    // value becomes a claim in a token and a filter in a query.
    requireWellFormedTenant(tenantId, 'one a question may be asked for');

    return await question({
      ask: (asked) => this.answer(tenantId, asked),
    });
  }

  /**
   * How far the tenant is carried, then the question itself.
   *
   * **In that order, and the order is the point.** Reading the watermark
   * afterwards would let an export landing between the two make the label later
   * than the rows it labels, which is the one thing an answer must never claim.
   * Asked first, the label can only be older than the data — an answer
   * understating its own currency, which is safe.
   *
   * It also means a tenant nothing was ever carried for is answered without
   * paying for the expensive question, which is a saving rather than the reason.
   *
   * Two exchanges rather than one. The design expected both to travel in a
   * single load as two queries; measured, an array of queries is treated as
   * data blending and refused without a shared granularity that a watermark
   * question has no reason to have.
   */
  private async answer(
    tenantId: TenantId,
    asked: ModelledQuestion,
  ): Promise<ModelledAnswer> {
    const context = await this.contexts.for(tenantId, this.now());

    const carried = completeThroughIn(
      await this.transport.load({
        context,
        query: { measures: [WATERMARK_MEMBER] },
      }),
    );

    if (carried === null) {
      return neverExported();
    }

    const answer = await this.transport.load({
      context,
      query: loadFor(asked),
    });

    return answeredFrom(
      answer.servedFromStore ? 'prepared' : 'exported-objects',
      completeThrough(carried, answer.refreshedAt),
      answer.data.map((row) => rowFrom(row, asked)),
    );
  }
}

/**
 * How current the answer actually is: the earlier of the two things that bound
 * it.
 *
 * The watermark says how far the export carried this tenant. When the answer
 * came from what was prepared, the rows are as old as the last rebuild — and a
 * rollup rebuilds on its own schedule, so between an export finishing and that
 * rebuild landing the prepared rows are behind the watermark. Labelling them
 * with the watermark would report an answer as complete through a moment its
 * data does not reach, which is the one claim an answer is not allowed to make.
 *
 * Taking the earlier of the two makes the answer understate its own currency
 * instead, which is the safe direction to be wrong in. For an answer read from
 * the objects the refresh moment is later than the watermark, so this changes
 * nothing there — one rule rather than a branch on provenance, because a rule
 * that only runs sometimes is a rule with a case nobody tested.
 */
function completeThrough(carried: Date, refreshedAt: Date | null): Date {
  if (refreshedAt === null) {
    return carried;
  }

  return refreshedAt.getTime() < carried.getTime() ? refreshedAt : carried;
}

/**
 * The moment a tenant is complete through, or nothing — and those are the only
 * two honest outcomes.
 *
 * An aggregate with no grouping always returns a row, and the engine's result
 * format cannot tell an empty string from a null, so a tenant nothing was
 * carried for arrives as an **empty value** rather than as no rows. That is
 * absence, and absence is `never-exported`.
 *
 * A value that is present and unreadable is neither. It means the engine said
 * something this cannot parse, and answering `never-exported` there would
 * report a tenant as having no data because a *watermark* was garbled — hiding
 * rows behind a failure of the label. It is refused instead, loudly.
 */
function completeThroughIn(result: CubeResult): Date | null {
  const reported = result.data[0]?.[WATERMARK_MEMBER];

  if (reported === null || reported === undefined) {
    return null;
  }

  if (typeof reported !== 'string') {
    throw new AnalyticsUnavailable(
      'model-rejected',
      new Error(`the watermark came back as a ${typeof reported}`),
    );
  }

  if (reported.trim().length === 0) {
    return null;
  }

  const moment = new Date(`${reported.replace(' ', 'T')}Z`);
  if (Number.isNaN(moment.getTime())) {
    throw new AnalyticsUnavailable(
      'model-rejected',
      new Error(`the watermark is not a moment: "${reported}"`),
    );
  }

  return moment;
}

function loadFor(asked: ModelledQuestion): CubeQuery {
  const groupings = asked.groupings.map(
    (grouping) => GROUPING_MEMBERS[grouping],
  );

  return {
    measures: asked.measures.map((measure) => MEASURE_MEMBERS[measure]),
    dimensions: groupings
      .filter((grouping) => grouping.timeDimension === undefined)
      .flatMap((grouping) => grouping.columns.map((column) => column.member)),
    timeDimensions: [
      // The period is carried on the moment the question reads by, whether or
      // not the caller also grouped by that day. The two are separate choices:
      // "the days I want to see" and "which of the two dates decides".
      {
        dimension: READ_BY_MEMBER[asked.by],
        dateRange: [asked.period.from, asked.period.to] as const,
      },
      ...groupings
        .filter((grouping) => grouping.timeDimension !== undefined)
        .map((grouping) => ({
          dimension: grouping.timeDimension as string,
          granularity: 'day',
        })),
    ],
    // One more than the answer may carry, so the caller above can tell a full
    // answer from a truncated one. Asking for exactly the bound would make an
    // over-bound answer indistinguishable from one that happened to fit.
    limit: asked.limit + 1,
  };
}

function rowFrom(
  row: Readonly<Record<string, unknown>>,
  asked: ModelledQuestion,
): ModelledRow {
  const columns: MappedColumn[] = [
    ...asked.measures.map((measure) => ({
      platform: measure,
      member: MEASURE_MEMBERS[measure],
    })),
    ...asked.groupings.flatMap((grouping) => [
      ...GROUPING_MEMBERS[grouping].columns,
    ]),
  ];

  return {
    values: Object.fromEntries(
      columns.map((column) => [column.platform, valueOf(row[column.member])]),
    ),
  };
}

/**
 * Whatever the engine sent, narrowed to what a row may hold — with absence
 * spelled one way.
 *
 * The engine's result format cannot express null: a measure with nothing to
 * sum and a dimension with no value both arrive as the empty string. Passing
 * that on would hand a chart a value that is neither a number nor an absence,
 * and `Number("")` is `0`, which is the wrong answer wearing the right shape.
 *
 * So an empty value is absence, the same reading the watermark gets one level
 * up. A genuinely empty label loses nothing by being called absent.
 */
function valueOf(value: unknown): string | number | null {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return value.length === 0 ? null : value;
  }

  return null;
}
