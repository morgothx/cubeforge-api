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
 * Which of a movement's two days decides whether it falls in a question's
 * period: the day this platform stored it, or the day it happened.
 *
 * A list for the reason the names are one: the request body validates against
 * it and the vocabulary publishes it, and a union cannot be read at runtime.
 * Before this existed the same two words were written out twice, once as a
 * type and once as a validator's list, and nothing held the two together.
 */
export const READ_BY = ['recorded', 'occurred'] as const;

export type ReadBy = (typeof READ_BY)[number];

export interface MeasureTraits {
  /**
   * Counts movements recorded before a question's period as well as within
   * it.
   *
   * The model decides how a measure behaves; this states what it decided, so
   * a caller can say so beside the figure. A figure that silently includes
   * last year reads as this month's.
   */
  readonly cumulative: boolean;
}

/**
 * Every measure's traits, keyed by the measure.
 *
 * A mapped type over the names rather than a loose object: a measure added to
 * `MEASURES` without a trait here fails the build, which is the only moment
 * anybody is still thinking about what the new measure means.
 */
export const MEASURE_TRAITS: { readonly [M in MeasureName]: MeasureTraits } = {
  net_quantity: { cumulative: false },
  movement_count: { cumulative: false },
  // The one sum over all time. How the model arranges that is the model's
  // business (a trailing, unbounded window); that it does is this line's.
  on_hand_quantity: { cumulative: true },
};

/**
 * What kind of thing a grouping is, and the columns it fills in an answer's
 * rows.
 *
 * Three shapes, because a consumer draws them three ways: a day belongs on a
 * calendar axis, a category is a plain label, and an entity is labelled by a
 * code somebody can look up *and* a name somebody can read. For the last, the
 * two columns are named by role, because which one is the code is exactly
 * what a consumer cannot guess.
 */
export type GroupingShape =
  | { readonly shape: 'day'; readonly column: string }
  | { readonly shape: 'category'; readonly column: string }
  | {
      readonly shape: 'labelled';
      readonly codeColumn: string;
      readonly nameColumn: string;
    };

/**
 * Every grouping's shape, keyed by the grouping.
 *
 * The column names are platform names, not the model's, which is why they
 * live here rather than beside the model's members: the answer's contract is
 * written in them.
 *
 * `as const satisfies` rather than a type annotation, on purpose. The
 * annotation would widen every entry to the union and lose which shape each
 * grouping has; kept literal, a consumer can be typed per shape, and a
 * labelled grouping handed one column fails to compile there.
 */
export const GROUPING_SHAPES = {
  recorded_day: { shape: 'day', column: 'recorded_day' },
  occurred_day: { shape: 'day', column: 'occurred_day' },
  kind: { shape: 'category', column: 'kind' },
  product: {
    shape: 'labelled',
    codeColumn: 'product_code',
    nameColumn: 'product_name',
  },
  location: {
    shape: 'labelled',
    codeColumn: 'location_code',
    nameColumn: 'location_name',
  },
} as const satisfies { readonly [G in GroupingName]: GroupingShape };

/** The row keys a grouping fills, code before name. */
export function rowColumnsOf(shape: GroupingShape): readonly string[] {
  switch (shape.shape) {
    case 'day':
    case 'category':
      return [shape.column];
    case 'labelled':
      return [shape.codeColumn, shape.nameColumn];
  }
}

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
