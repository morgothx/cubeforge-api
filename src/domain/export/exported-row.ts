/**
 * What an analytical reader meets.
 *
 * A published contract rather than an internal shape: roadmap step 7 defines a
 * table over these column names and step 8 defines metrics over that table.
 * Renaming one here breaks a chart months later, so the names live in the
 * domain, stated once, rather than being assembled inside whichever adapter
 * happens to write the file.
 *
 * The columnar type is part of the contract too. A reader that has to parse
 * every value is reading a slow CSV, which is the thing this whole feature
 * exists to stop doing.
 */
export type ColumnarType =
  'STRING' | 'INT32' | 'INT64' | 'TIMESTAMP' | 'BOOLEAN';

export interface ExportedColumn {
  readonly name: string;
  readonly type: ColumnarType;
}

/**
 * A movement, as exported.
 *
 * **No `tenant_id`.** The tenant is the partition the object sits in; carrying
 * it as a column as well would be a second answer to the same question, and two
 * answers eventually disagree.
 *
 * **Both moments, deliberately.** `occurred_at` is when the movement happened
 * as the source system reports it, and may be backdated; `recorded_at` is when
 * this platform stored it and only moves forward. Exporting one and not the
 * other makes a question unanswerable later, and adding the missing one means
 * rewriting history somebody has already read.
 */
export type ExportedMovementRow = {
  readonly external_id: string;
  readonly sku: string;
  readonly location_code: string;
  readonly kind: string;
  readonly quantity: number;
  readonly occurred_at: Date;
  readonly recorded_at: Date;
};

/** A product or a place, as exported: enough to label a number in a chart. */
export type ExportedCatalogueRow = {
  readonly code: string;
  readonly name: string;
  readonly category: string | null;
};

/**
 * Any exported row.
 *
 * Written as type aliases rather than interfaces on purpose: an interface has
 * no implicit index signature, so it cannot be handed to an encoder that takes
 * a record of columns without a cast. The cast would be the kind that is right
 * until somebody adds a field.
 */
export type ExportedRow = ExportedMovementRow | ExportedCatalogueRow;

export const MOVEMENT_COLUMNS: readonly ExportedColumn[] = [
  { name: 'external_id', type: 'STRING' },
  { name: 'sku', type: 'STRING' },
  { name: 'location_code', type: 'STRING' },
  { name: 'kind', type: 'STRING' },
  // A signed count. A sale is negative, and a stock level is their sum.
  { name: 'quantity', type: 'INT32' },
  { name: 'occurred_at', type: 'TIMESTAMP' },
  { name: 'recorded_at', type: 'TIMESTAMP' },
];

export const CATALOGUE_COLUMNS: readonly ExportedColumn[] = [
  { name: 'code', type: 'STRING' },
  { name: 'name', type: 'STRING' },
  // Free text on a product today, and the one attribute a later feature will
  // want to group by. Named here so step 8 is not surprised by it.
  { name: 'category', type: 'STRING' },
];
