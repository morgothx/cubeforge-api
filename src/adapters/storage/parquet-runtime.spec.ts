import { readParquet, writeParquet } from './parquet-runtime';

/**
 * The one assumption in this design that could not be settled by reading.
 *
 * The Parquet writer is published **only** as an ES module, and this codebase
 * is CommonJS. Node 22.12 and later can load an ES module from CommonJS, and
 * the repository compiles with `module: nodenext`, so the import should
 * survive — but "should" is not a thing to discover in task 4.3, with an
 * adapter, a use case and a run around it. It is settled here, on its own,
 * where a failure means one dependency was the wrong choice rather than a day
 * of work built on sand.
 *
 * The round trip is written and read by two different libraries: a writer that
 * can only be read back by itself has proven nothing about the file an
 * analytical engine will meet.
 */
describe('the columnar writer, loaded from a CommonJS build', () => {
  it('writes a file that an independent reader can read back', async () => {
    const rows = [
      { sku: 'ACME-001', quantity: 5 },
      { sku: 'ACME-002', quantity: -3 },
    ];

    const file = await writeParquet(rows, [
      { name: 'sku', type: 'STRING' },
      { name: 'quantity', type: 'INT32' },
    ]);

    await expect(readParquet(file)).resolves.toEqual(rows);
  });

  it('keeps a number a number, not a string of one', async () => {
    // The reason for a columnar format at all: a query engine that has to parse
    // every value is not reading a typed file, it is reading a slow CSV.
    const file = await writeParquet(
      [{ quantity: 42 }],
      [{ name: 'quantity', type: 'INT32' }],
    );

    const [row] = await readParquet(file);
    expect(typeof row?.quantity).toBe('number');
  });
});
