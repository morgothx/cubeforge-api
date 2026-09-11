import { CALENDAR, LONGEST_PERIOD_DAYS } from '../analytics/period';
import {
  GROUPINGS,
  GROUPING_SHAPES,
  MEASURES,
  MEASURE_TRAITS,
  READ_BY,
  type GroupingName,
  type GroupingShape,
  type MeasureName,
  type ReadBy,
} from './vocabulary';

/**
 * What may be asked, as a caller receives it.
 *
 * Everything a consumer needs to compose a question and read its rows, and
 * nothing it could use to learn about anybody: no tenant, no record, no count.
 * The row bound is deliberately absent — the refusal that enforces it names it,
 * and publishing it here too would give the platform two places to say one
 * number.
 */
export interface PublishedVocabulary {
  readonly measures: readonly {
    readonly name: MeasureName;
    readonly cumulative: boolean;
  }[];
  readonly groupings: readonly ({
    readonly name: GroupingName;
  } & GroupingShape)[];
  readonly readBy: readonly ReadBy[];
  readonly longestPeriodDays: number;
  readonly calendar: typeof CALENDAR;
}

/**
 * The declarations a question is built from, projected for a caller.
 *
 * **Nothing here is written, only read.** Each value is the declaration the
 * question path already consumes — the names a question accepts, the columns
 * its rows carry, the moments its body validates, the period it refuses past,
 * the zone the engine is asked in. So what this says and what a question does
 * cannot disagree: there is one of each, not two that agree.
 *
 * It takes no tenant because it has none to take. Every caller receives the
 * same value, and nothing about the one asking can reach it.
 */
export function describeVocabulary(): PublishedVocabulary {
  return {
    measures: MEASURES.map((name) => ({
      name,
      cumulative: MEASURE_TRAITS[name].cumulative,
    })),
    groupings: GROUPINGS.map((name) => ({ name, ...GROUPING_SHAPES[name] })),
    readBy: [...READ_BY],
    longestPeriodDays: LONGEST_PERIOD_DAYS,
    calendar: CALENDAR,
  };
}
