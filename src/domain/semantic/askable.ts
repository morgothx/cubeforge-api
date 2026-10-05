import {
  GROUPING_SHAPES,
  MEASURE_TRAITS,
  type GroupingName,
  type MeasureName,
} from './vocabulary';

/**
 * The combinations this platform knows it cannot compose.
 *
 * Every measure carries its own bound and every grouping carries its own shape,
 * and for a long time that was taken to mean any measure could meet any
 * grouping — `question.ts` said so in as many words. Measured against the
 * running platform on 2026-10-01, it is not true: a question combining a
 * cumulative measure with both days is refused by the engine, and a caller was
 * told the service could not be reached and offered a retry that could never
 * succeed.
 *
 * **This is a list, not a principle.** It states what the platform has been
 * shown to be unable to answer, and nothing more. A combination absent from it
 * is one the platform knows no reason to refuse — which is not a promise that
 * the engine will accept it, and is why a refusal the platform did not
 * anticipate still has an answer of its own.
 *
 * **It reads what the vocabulary already publishes.** Which measures count
 * movements from before the period, and which groupings are days, are
 * declarations that already exist; naming them again here would be a second
 * list to keep in step, and the day the two disagreed the platform would refuse
 * questions it answers or answer questions it cannot.
 *
 * The cost of putting this in the domain is recorded in the design: the rule's
 * origin is the query engine's capability rather than the business, and the
 * alternative — reading the engine's error text — fails silently the day a
 * library rephrases a message.
 */

/** Whether a measure counts movements recorded before the question's period. */
function countsEarlierMovements(measure: MeasureName): boolean {
  return MEASURE_TRAITS[measure].cumulative;
}

/** Whether a grouping counts in days. */
function isByDay(grouping: GroupingName): boolean {
  return GROUPING_SHAPES[grouping].shape === 'day';
}

/**
 * Why the platform knows it cannot compose this combination, as the sentence a
 * caller reads — or `null` when it knows of no reason.
 *
 * The sentence names the measure, both groupings and what to drop, because a
 * caller who can act on a refusal is the only kind that should be given one.
 */
export function whyUnaskable(
  measures: readonly MeasureName[],
  groupings: readonly GroupingName[],
): string | null {
  const earlier = measures.filter(countsEarlierMovements);
  const byDay = groupings.filter(isByDay);

  if (earlier.length === 0 || byDay.length < 2) {
    return null;
  }

  return (
    `${earlier.join(' and ')} counts movements recorded before the period, ` +
    `and cannot be grouped by ${byDay.join(' and ')} at once. ` +
    'Ask for one of them.'
  );
}
