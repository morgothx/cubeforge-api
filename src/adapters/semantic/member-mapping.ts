import {
  GROUPING_SHAPES,
  type GroupingName,
  type GroupingShape,
  type MeasureName,
  type ReadBy,
} from '../../domain/semantic/vocabulary';

/**
 * One value, under both of its names.
 *
 * `platform` is what a caller asked for and what comes back in a row;
 * `member` is what the model answers it under.
 */
export interface MappedColumn {
  readonly platform: string;
  readonly member: string;
}

export interface MappedGrouping {
  readonly columns: readonly MappedColumn[];
  /**
   * Set when the grouping is a day, which the model groups by granularity
   * rather than as a plain dimension.
   */
  readonly timeDimension?: string;
}

/**
 * The platform's names, mapped to the model's, here and nowhere else.
 *
 * Two names for the same thing, deliberately. The cost is a name to keep in
 * step; the reason is that the dashboard's contract would otherwise *be* the
 * model's internal naming, so renaming a cube would break a chart months later.
 * Confined to this table, a rename breaks one entry.
 *
 * Written as a `Record` over the vocabulary's own unions rather than as a loose
 * object: a name added to the vocabulary and not to this table fails the build
 * here, which is a stronger guard than a test and arrives sooner. What it
 * cannot check is the other direction — a member the model defines and the
 * vocabulary does not offer — and that is what the vocabulary integration suite
 * reads the model's metadata for.
 */
export const MEASURE_MEMBERS: Readonly<Record<MeasureName, string>> = {
  net_quantity: 'movements.net_quantity',
  movement_count: 'movements.movement_count',
  on_hand_quantity: 'movements.on_hand_quantity',
};

/**
 * A grouping's platform half, as the vocabulary declares it for one shape.
 *
 * Pulled out of the union so each builder below accepts only its own shape:
 * handing a labelled grouping to the builder for one column is a type error,
 * not a row with half its label missing.
 */
type ShapeOf<S extends GroupingShape['shape']> = Extract<
  GroupingShape,
  { readonly shape: S }
>;

/** A day, grouped by granularity, whose one column is the day itself. */
function day(
  declared: ShapeOf<'day'>,
  members: { readonly timeDimension: string; readonly day: string },
): MappedGrouping {
  return {
    timeDimension: members.timeDimension,
    columns: [{ platform: declared.column, member: members.day }],
  };
}

/** A plain label, one column. */
function category(
  declared: ShapeOf<'category'>,
  member: string,
): MappedGrouping {
  return { columns: [{ platform: declared.column, member }] };
}

/**
 * An entity, labelled twice: a code is not a label anybody reads, and a name
 * is not a thing anybody can look up. Code first, as the vocabulary orders
 * them.
 */
function labelled(
  declared: ShapeOf<'labelled'>,
  members: { readonly code: string; readonly name: string },
): MappedGrouping {
  return {
    columns: [
      { platform: declared.codeColumn, member: members.code },
      { platform: declared.nameColumn, member: members.name },
    ],
  };
}

/**
 * Every grouping, paired with the model's members — and only the members.
 *
 * The platform's column names are the vocabulary's, read from its declared
 * shapes, so this table holds no platform name of its own. The vocabulary
 * publishes those same declarations; that is what makes the row names it
 * publishes the row names an answer carries, rather than a second list that
 * agrees with this one by coincidence.
 */
export const GROUPING_MEMBERS: {
  readonly [G in GroupingName]: MappedGrouping;
} = {
  recorded_day: day(GROUPING_SHAPES.recorded_day, {
    timeDimension: 'movements.recorded_day',
    day: 'movements.recorded_day.day',
  }),
  occurred_day: day(GROUPING_SHAPES.occurred_day, {
    timeDimension: 'movements.occurred_day',
    day: 'movements.occurred_day.day',
  }),
  kind: category(GROUPING_SHAPES.kind, 'movements.kind'),
  product: labelled(GROUPING_SHAPES.product, {
    code: 'products.code',
    name: 'products.name',
  }),
  location: labelled(GROUPING_SHAPES.location, {
    code: 'locations.code',
    name: 'locations.name',
  }),
};

/** The day dimension a question is read by, which is not a grouping choice. */
export const READ_BY_MEMBER: { readonly [R in ReadBy]: string } = {
  recorded: 'movements.recorded_day',
  occurred: 'movements.occurred_day',
};

/** The one measure that answers how far a tenant has been carried. */
export const WATERMARK_MEMBER = 'watermarks.complete_through';
