import type { Day } from './period';

/**
 * What one question came back with.
 *
 * **Three states, not two.** A period with nothing in it and a tenant that has
 * never been carried out of the transactional database are different facts, and
 * collapsing them draws an empty chart for a tenant whose data has simply not
 * arrived yet. The union is what forces a reader to tell them apart: entries
 * cannot be reached without narrowing first.
 */
export type AnalyticalAnswer<Entry> =
  | {
      readonly state: 'answered';
      /**
       * The moment through which this answer is complete.
       *
       * Not "when it was asked". An analytical answer is only as current as the
       * last export, and a number shown without its date is a number read with
       * more confidence than it has earned.
       */
      readonly completeThrough: Date;
      readonly entries: readonly Entry[];
    }
  | { readonly state: 'never-exported' };

export const answered = <Entry>(
  completeThrough: Date,
  entries: readonly Entry[],
): AnalyticalAnswer<Entry> => ({
  state: 'answered',
  completeThrough,
  entries,
});

export const neverExported = <Entry>(): AnalyticalAnswer<Entry> => ({
  state: 'never-exported',
});

/**
 * How much of a product is on hand, and what it is called.
 *
 * The name comes from the exported catalogue rather than from the transactional
 * database, which is the whole reason the catalogue is exported: a chart that
 * had to resolve its own labels would put that load back on the store this
 * pipeline exists to keep out of the way.
 */
export interface StockOnHandEntry {
  readonly sku: string;
  readonly name: string;
  readonly onHand: number;
}

/** How much moved on one day, of one kind. */
export interface MovementsOnDayEntry {
  readonly day: Day;
  readonly kind: string;
  readonly quantity: number;
}
