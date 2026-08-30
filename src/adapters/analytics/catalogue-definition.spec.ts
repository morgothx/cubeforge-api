import {
  MOVEMENT_COLUMNS,
  WATERMARK_COLUMNS,
} from '../../domain/export/exported-row';
import { catalogueTables } from './catalogue-definition';

const BUCKET = 'cubeforge-exports';
const tables = catalogueTables(BUCKET);
const named = (name: string) => tables.find((table) => table.name === name)!;

/**
 * What the command will send, asserted as values.
 *
 * **Not as engine behaviour, and that distinction is the whole of this file.**
 * The local engine infers partitions from the key path and needs none of this;
 * it answers whether the arrangement below is right or wrong. So the only thing
 * a test here can honestly check is that the right thing is being *sent* — and
 * `design.md` says as much under what no local test settles.
 */
describe('what the engine is told about the exported layout', () => {
  it('describes each dataset the export writes, and nothing else', () => {
    expect(tables.map((table) => table.name).sort()).toEqual([
      'locations',
      'movements',
      'products',
      'watermarks',
    ]);
  });

  it('points each table at the prefix the export writes that dataset under', () => {
    expect(named('movements').location).toBe(`s3://${BUCKET}/movements/`);
    expect(named('watermarks').location).toBe(`s3://${BUCKET}/watermarks/`);
  });

  it('takes its columns from what the export publishes, unrenamed', () => {
    // Derived rather than restated. A column added upstream cannot drift from
    // the one an engine is told about, because there is only one list.
    expect(named('movements').columns.map((column) => column.name)).toEqual(
      MOVEMENT_COLUMNS.map((column) => column.name),
    );
    expect(named('watermarks').columns.map((column) => column.name)).toEqual(
      WATERMARK_COLUMNS.map((column) => column.name),
    );
  });

  it('translates each published type into one the engine knows', () => {
    const columns = named('movements').columns;

    expect(columns.find((c) => c.name === 'quantity')?.type).toBe('int');
    expect(columns.find((c) => c.name === 'recorded_at')?.type).toBe(
      'timestamp',
    );
    expect(columns.find((c) => c.name === 'sku')?.type).toBe('string');
  });

  it('keeps the partition keys out of the columns', () => {
    // The tenant and the day are read from the path. Carried as columns as
    // well, they would be two answers to one question, and two answers
    // eventually disagree.
    const columns = named('movements').columns.map((column) => column.name);

    expect(columns).not.toContain('tenant_id');
    expect(columns).not.toContain('recorded_date');
    expect(named('movements').partitions.map((p) => p.name)).toEqual([
      'tenant_id',
      'recorded_date',
    ]);
    expect(named('products').partitions.map((p) => p.name)).toEqual([
      'tenant_id',
    ]);
  });

  it('projects its partitions rather than asking for them to be registered', () => {
    const properties = named('movements').properties;

    expect(properties['projection.enabled']).toBe('true');
    expect(properties['projection.recorded_date.type']).toBe('date');
    expect(properties['projection.recorded_date.format']).toBe('yyyy-MM-dd');
    expect(properties['storage.location.template']).toBe(
      `s3://${BUCKET}/movements/tenant_id=\${tenant_id}/recorded_date=\${recorded_date}/`,
    );
  });

  it('injects the tenant, so a question that names none fails at the engine', () => {
    // The second isolation layer, and the reason it is worth having: the
    // adapter binds the tenant, and a question that somehow did not would be
    // refused by the engine rather than answered across every tenant. It has
    // no local probe — the emulator ignores all of this — so it is belt over
    // braces and never the reason isolation holds.
    for (const table of tables) {
      expect(table.properties['projection.tenant_id.type']).toBe('injected');
    }
  });
});
