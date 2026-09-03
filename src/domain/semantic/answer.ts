/**
 * Where an answer's rows came from.
 *
 * This is 6.3, and 6.3 is what makes 6.2 a claim about the system rather than
 * about the test: read from what the semantic layer reports about which rollups
 * it used, never inferred from how long the answer took. A fast answer is
 * evidence of nothing — a warm cache, a small period and a quiet afternoon all
 * look the same from a stopwatch.
 */
export type ServedFrom = 'prepared' | 'exported-objects';

/**
 * One row of a modelled answer.
 *
 * Keyed by the platform's own names for what was asked, and deliberately
 * untyped beyond the three kinds a column can hold: the columns a row carries
 * are whatever the question composed, and a type that tried to say which ones
 * would have to be written per combination — the very thing the model exists
 * to avoid.
 */
export interface ModelledRow {
  readonly values: Readonly<Record<string, string | number | null>>;
}

/**
 * What one modelled question came back with.
 *
 * **Three states, not two**, for the reason `AnalyticalAnswer` gives: a period
 * with nothing in it and a tenant never carried out of the transactional store
 * are different facts, and collapsing them draws the same empty chart for a
 * tenant whose data has simply not arrived yet. The union forces the reader to
 * tell them apart, because `rows` cannot be reached without narrowing first.
 *
 * **A separate type from `AnalyticalAnswer<Entry>`, on purpose.** The states
 * are the same because the data underneath is the same, and reproducing a
 * union is a real cost. It is paid because this answer carries provenance the
 * closed port's answer has no reason to hold, and adding a field only this
 * feature sets to that feature's published type would push this spec's concern
 * into a contract that has already been settled.
 */
export type ModelledAnswer =
  | {
      readonly state: 'answered';
      /**
       * The moment through which this answer is complete.
       *
       * Not "when it was asked". A modelled answer is only as current as the
       * last export, and a number shown without its date is a number read with
       * more confidence than it has earned.
       */
      readonly completeThrough: Date;
      readonly servedFrom: ServedFrom;
      readonly rows: readonly ModelledRow[];
    }
  | { readonly state: 'never-exported' };

/**
 * An answer, and no rows is one of them.
 *
 * A period containing no records is answered rather than refused (5.4): the
 * question was well formed and the honest reply is that nothing happened.
 * Refusing would make "no movements last week" indistinguishable from a
 * malformed question.
 */
export function answeredFrom(
  servedFrom: ServedFrom,
  completeThrough: Date,
  rows: readonly ModelledRow[],
): ModelledAnswer {
  if (Number.isNaN(completeThrough.getTime())) {
    throw new Error('an answer must say what moment it is complete through');
  }

  return { state: 'answered', completeThrough, servedFrom, rows };
}

/**
 * Nothing has ever been carried out of the transactional store for this tenant.
 *
 * It carries no moment and no rows, because it has neither — there is no
 * export to be complete through. A reader who wants either must narrow to
 * `answered` first, which is the whole point of the state existing.
 */
export function neverExported(): ModelledAnswer {
  return { state: 'never-exported' };
}
