import { MOVEMENT_COLUMNS } from '../../domain/export/exported-row';
import type { ObjectKey } from '../../domain/export/partition';
import { InMemoryExportSink } from './in-memory-export-sink';

const KEY =
  'movements/tenant_id=t/recorded_date=2026-08-28/1-2.parquet' as ObjectKey;

const file = (key: ObjectKey, external: string) => ({
  key,
  columns: MOVEMENT_COLUMNS,
  rows: [
    {
      external_id: external,
      sku: 'ACME-001',
      location_code: 'WH-1',
      kind: 'receipt',
      quantity: 5,
      occurred_at: new Date('2026-08-27T10:00:00.000Z'),
      recorded_at: new Date('2026-08-28T02:00:00.000Z'),
    },
  ],
});

describe('the export sink double', () => {
  it('keeps what was written, under the key it was written at', async () => {
    const sink = new InMemoryExportSink();

    await sink.put(file(KEY, 'ERP-1'));

    expect(sink.keys()).toEqual([KEY]);
    expect(sink.rowsAt(KEY)).toHaveLength(1);
  });

  it('replaces rather than accumulating, as object storage does', async () => {
    const sink = new InMemoryExportSink();

    await sink.put(file(KEY, 'ERP-1'));
    await sink.put(file(KEY, 'ERP-2'));

    // One object, holding the second write. A double that appended would make
    // every replay test pass against an implementation that duplicates rows.
    expect(sink.keys()).toEqual([KEY]);
    expect(sink.rowsAt(KEY)).toEqual([
      expect.objectContaining({ external_id: 'ERP-2' }),
    ]);
  });

  it('can be told to fail on one key, and writes nothing for it', async () => {
    // "The run died half-way" is the case this whole design exists for, so the
    // double has to be able to produce it on demand.
    const sink = new InMemoryExportSink();
    sink.failOn(KEY);

    await expect(sink.put(file(KEY, 'ERP-1'))).rejects.toThrow();
    expect(sink.keys()).toEqual([]);
  });

  it('can be told the destination is unreachable', async () => {
    const sink = new InMemoryExportSink();
    sink.unreachable();

    await expect(sink.reachable()).rejects.toThrow();
  });

  it('is reachable by default, and says so without writing anything', async () => {
    const sink = new InMemoryExportSink();

    await expect(sink.reachable()).resolves.toBeUndefined();
    expect(sink.keys()).toEqual([]);
  });
});
