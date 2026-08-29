import {
  CATALOGUE_COLUMNS,
  MOVEMENT_COLUMNS,
  type ExportedCatalogueRow,
  type ExportedMovementRow,
} from './exported-row';

/**
 * The columns an analytical reader meets.
 *
 * This is a published contract, not an internal shape: step 7 defines a table
 * over these names and step 8 defines metrics over that table. Renaming a
 * column here breaks a chart somewhere later, which is why the names are stated
 * once, in the domain, rather than assembled inside an adapter.
 */
describe('the exported columns', () => {
  it('keeps both moments a movement has', () => {
    const named = MOVEMENT_COLUMNS.map((column) => column.name);

    // `occurred_at` is when it happened, as the source system reports it, and
    // may be backdated. `recorded_at` is when this platform stored it. An
    // export that kept only one would make a question unanswerable later, and
    // adding the other means rewriting history that has already been read.
    expect(named).toContain('occurred_at');
    expect(named).toContain('recorded_at');
  });

  it('carries what a metric needs to be counted and named', () => {
    expect(MOVEMENT_COLUMNS.map((column) => column.name)).toEqual([
      'external_id',
      'sku',
      'location_code',
      'kind',
      'quantity',
      'occurred_at',
      'recorded_at',
    ]);
  });

  it('names the tenant nowhere, because the tenant is the partition', () => {
    // Carrying it as a column too would be a second answer to the same
    // question, and two answers eventually disagree.
    expect(MOVEMENT_COLUMNS.map((column) => column.name)).not.toContain(
      'tenant_id',
    );
  });

  it('types a quantity as a number and a moment as a moment', () => {
    const byName = new Map(
      MOVEMENT_COLUMNS.map((column) => [column.name, column.type]),
    );

    // The reason for a columnar format at all. A reader that has to parse every
    // value is reading a slow CSV.
    expect(byName.get('quantity')).toBe('INT32');
    expect(byName.get('occurred_at')).toBe('TIMESTAMP');
    expect(byName.get('recorded_at')).toBe('TIMESTAMP');
    expect(byName.get('sku')).toBe('STRING');
  });

  it('describes a catalogue entry by what a chart needs to label it', () => {
    expect(CATALOGUE_COLUMNS.map((column) => column.name)).toEqual([
      'code',
      'name',
      'category',
    ]);
  });

  it('accepts a row shaped as the columns say', () => {
    // A compile-time claim as much as a runtime one: a row that does not match
    // the columns should not type-check.
    const movement: ExportedMovementRow = {
      external_id: 'ERP-1',
      sku: 'ACME-001',
      location_code: 'WH-1',
      kind: 'receipt',
      quantity: 5,
      occurred_at: new Date('2026-08-27T10:00:00.000Z'),
      recorded_at: new Date('2026-08-28T02:00:00.000Z'),
    };
    const entry: ExportedCatalogueRow = {
      code: 'ACME-001',
      name: 'A widget',
      category: null,
    };

    expect(movement.quantity).toBe(5);
    expect(entry.category).toBeNull();
  });
});
