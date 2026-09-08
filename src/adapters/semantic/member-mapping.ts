import type {
  GroupingName,
  MeasureName,
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

export const GROUPING_MEMBERS: Readonly<Record<GroupingName, MappedGrouping>> =
  {
    recorded_day: {
      timeDimension: 'movements.recorded_day',
      columns: [
        { platform: 'recorded_day', member: 'movements.recorded_day.day' },
      ],
    },
    occurred_day: {
      timeDimension: 'movements.occurred_day',
      columns: [
        { platform: 'occurred_day', member: 'movements.occurred_day.day' },
      ],
    },
    kind: {
      columns: [{ platform: 'kind', member: 'movements.kind' }],
    },
    // Two columns from one grouping: a code alone is not a label anybody reads,
    // and a name alone is not a thing anybody can look up.
    product: {
      columns: [
        { platform: 'product_code', member: 'products.code' },
        { platform: 'product_name', member: 'products.name' },
      ],
    },
    location: {
      columns: [
        { platform: 'location_code', member: 'locations.code' },
        { platform: 'location_name', member: 'locations.name' },
      ],
    },
  };

/** The day dimension a question is read by, which is not a grouping choice. */
export const READ_BY_MEMBER: Readonly<Record<'recorded' | 'occurred', string>> =
  {
    recorded: 'movements.recorded_day',
    occurred: 'movements.occurred_day',
  };

/** The one measure that answers how far a tenant has been carried. */
export const WATERMARK_MEMBER = 'watermarks.complete_through';
