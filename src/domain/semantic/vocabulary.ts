/**
 * What a caller may name, declared once.
 *
 * These are the platform's words, not the model's. The model calls the same
 * measure `movements.net_quantity`; the mapping between the two lives in one
 * adapter file. The cost is a name to keep in step — paid because the
 * dashboard's contract would otherwise *be* the model's internal naming, so
 * renaming a cube would break a chart months later. That is the coupling
 * `exported-row.ts` exists to prevent one layer down, and this is the same
 * layer up.
 *
 * Declared as a list rather than only as a union, for the reason the permitted
 * roles are: the refusal has to say what is on offer, and a union cannot be
 * read at runtime.
 */
export const MEASURES = [
  /** The net quantity moved: movements are signed, so they sum. */
  'net_quantity',
  /** How many movements were recorded. */
  'movement_count',
  /**
   * What is on hand — the sum of everything that ever moved.
   *
   * Ignores the period the rest of the question is bounded by, because on hand
   * is an all-time sum by definition. How that is arranged belongs to the
   * model; that it is offered belongs here.
   */
  'on_hand_quantity',
] as const;

export const GROUPINGS = [
  /** The day this platform stored the movement. Only moves forward. */
  'recorded_day',
  /** The day the movement happened, as the source reports it. May be backdated. */
  'occurred_day',
  'kind',
  /** The product a movement names, labelled by its code and its current name. */
  'product',
  /** The location a movement names, labelled the same way. */
  'location',
] as const;

export type MeasureName = (typeof MEASURES)[number];
export type GroupingName = (typeof GROUPINGS)[number];

/**
 * Why a name was not accepted, and what would have been.
 *
 * Carries **every** unrecognised name, for the reason the configuration
 * loaders report every missing key together: a question fixed one name per
 * attempt is a question fixed one attempt per afternoon.
 *
 * Both offered lists travel, whichever half the wrong name was in. A measure
 * typed where a grouping belongs is the likeliest mistake a caller makes, and
 * a refusal listing only the half they got wrong tells them nothing about it.
 */
export interface VocabularyRefusal {
  readonly unknown: readonly string[];
  readonly measures: readonly MeasureName[];
  readonly groupings: readonly GroupingName[];
}

export type VocabularyResult<T> =
  | { readonly ok: true; readonly names: readonly T[] }
  | { readonly ok: false; readonly refusal: VocabularyRefusal };

export function measuresFrom(
  names: readonly string[],
): VocabularyResult<MeasureName> {
  return recognise(names, MEASURES);
}

export function groupingsFrom(
  names: readonly string[],
): VocabularyResult<GroupingName> {
  return recognise(names, GROUPINGS);
}

/**
 * Matched exactly, with no trimming and no case folding.
 *
 * A name that is nearly right is refused and quoted back beside the list it
 * missed, which is more useful than a guess: `netQuantity` accepted silently
 * as `net_quantity` teaches a caller a spelling that will stop working the day
 * someone tightens this.
 */
function recognise<T extends string>(
  names: readonly string[],
  offered: readonly T[],
): VocabularyResult<T> {
  const unknown = names.filter(
    (name) => !(offered as readonly string[]).includes(name),
  );

  if (unknown.length > 0) {
    return {
      ok: false,
      refusal: { unknown, measures: MEASURES, groupings: GROUPINGS },
    };
  }

  return { ok: true, names: names as readonly T[] };
}
