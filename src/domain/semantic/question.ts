import { DomainViolation } from '../errors';
import type { Period } from '../analytics/period';
import {
  GROUPINGS,
  MEASURES,
  groupingsFrom,
  measuresFrom,
  type GroupingName,
  type MeasureName,
  type VocabularyResult,
} from './vocabulary';

/**
 * The most rows one modelled answer may carry.
 *
 * Enough for a year of daily rows across several groupings, and far short of a
 * history export — which is the line this number is drawn on. It is a constant
 * of this design and not a parameter: a bound the caller sets is a bound the
 * caller can raise, and then it is not bounding anything.
 */
export const MAX_ANSWER_ROWS = 5000;

/**
 * There is exactly one permitted value, so nothing else can be assigned.
 *
 * The type is what stops a later caller-supplied limit from reaching the model;
 * a plain `number` here would leave the field open and the intent in a comment.
 */
export type RowLimit = typeof MAX_ANSWER_ROWS;

/**
 * One question a caller composed, carrying its own bounds.
 *
 * **There is no tenant field.** A caller naming a tenant is prevented rather
 * than checked for: the type has nowhere to put one, so there is no value for
 * a later reader to forget to compare against the caller's standing. The
 * tenant arrives with the signed context, from the standing the platform has
 * already established, and from nowhere else.
 */
export interface ModelledQuestion {
  readonly measures: readonly MeasureName[];
  readonly groupings: readonly GroupingName[];
  readonly period: Period;
  readonly by: 'recorded' | 'occurred';
  readonly limit: RowLimit;
}

/**
 * The only way to compose one, and it refuses three things.
 *
 * Any measures with any groupings, with no definition written for the
 * combination — that freedom is the point of a model, and what pays for it is
 * that each part carries its own bound.
 *
 * The period is the platform's existing one, **imported with its refusals
 * intact rather than restated here**. `periodFrom` already has no constructor
 * for an unbounded span and none for one longer than the platform answers, and
 * it names the limit when it refuses. Restating either rule at this edge would
 * give the platform two answers to the same question, and the day they drift
 * the looser one wins.
 */
export function questionFrom(input: {
  measures: readonly string[];
  groupings: readonly string[];
  period: Period;
  by: 'recorded' | 'occurred';
}): ModelledQuestion {
  if (input.measures.length === 0) {
    throw new DomainViolation({
      kind: 'validation',
      field: 'measures',
      detail: 'must name at least one measure',
    });
  }

  const measures = measuresFrom(input.measures);
  const groupings = groupingsFrom(input.groupings);

  if (!measures.ok || !groupings.ok) {
    throw refuse(measures, groupings);
  }

  return {
    measures: measures.names,
    groupings: groupings.names,
    period: input.period,
    by: input.by,
    limit: MAX_ANSWER_ROWS,
  };
}

/**
 * One refusal for both lists, never one per list.
 *
 * A caller who mistyped a measure *and* a grouping would otherwise fix one,
 * ask again, and learn about the other — which is the same "one name per
 * attempt" the vocabulary refuses to do within a single list. `field` names
 * whichever sides were wrong, because the edge renders it and a caller reading
 * only `measures` would go looking in the wrong place.
 */
function refuse(
  measures: VocabularyResult<MeasureName>,
  groupings: VocabularyResult<GroupingName>,
): DomainViolation {
  const wrong = [
    measures.ok ? undefined : (['measures', measures.refusal] as const),
    groupings.ok ? undefined : (['groupings', groupings.refusal] as const),
  ].filter((side) => side !== undefined);

  const unknown = wrong.flatMap(([, refusal]) => refusal.unknown);

  return new DomainViolation({
    kind: 'validation',
    field: wrong.map(([field]) => field).join(' and '),
    detail: describeRefusal(unknown),
  });
}

/**
 * Both offered lists travel, whichever half the wrong name was in.
 *
 * Naming a measure where a grouping belongs is the likeliest mistake a caller
 * makes, and a refusal listing only the half they got wrong leaves them
 * re-reading the one list that was never the problem.
 */
function describeRefusal(unknown: readonly string[]): string {
  const named = unknown.map((name) => `"${name}"`).join(', ');

  return (
    `does not offer ${named}; ` +
    `measures are ${MEASURES.join(', ')} ` +
    `and groupings are ${GROUPINGS.join(', ')}`
  );
}
