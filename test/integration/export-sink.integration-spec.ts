import {
  CreateBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { readParquet } from '../../src/adapters/storage/parquet-runtime';
import { ParquetExportSink } from '../../src/adapters/storage/parquet-export-sink';
import { loadObjectStorageConfig } from '../../src/adapters/storage/object-storage-config';
import {
  CATALOGUE_COLUMNS,
  MOVEMENT_COLUMNS,
} from '../../src/domain/export/exported-row';
import type { ObjectKey } from '../../src/domain/export/partition';

const config = loadObjectStorageConfig(process.env);

const KEY =
  'movements/tenant_id=018f2c00-0000-7000-8000-00000000ac01/recorded_date=2026-08-28/1-2.parquet' as ObjectKey;

const movements = [
  {
    external_id: 'ERP-1',
    sku: 'ACME-001',
    location_code: 'WH-1',
    kind: 'receipt',
    quantity: 5,
    occurred_at: new Date('2026-08-27T10:00:00.000Z'),
    recorded_at: new Date('2026-08-28T02:00:00.000Z'),
  },
  {
    external_id: 'ERP-2',
    sku: 'ACME-001',
    location_code: 'WH-1',
    kind: 'sale',
    quantity: -3,
    occurred_at: new Date('2026-08-27T11:00:00.000Z'),
    recorded_at: new Date('2026-08-28T02:00:00.000Z'),
  },
];

/**
 * The sink against the real emulator.
 *
 * What the double cannot show: that the bytes are a Parquet file an independent
 * reader understands, that types survive the trip, and that a repeated key
 * leaves one object rather than two. The reader is `hyparquet`, a different
 * library from the writer — a file only its own writer can read proves nothing
 * about what an analytical engine will meet.
 */
describe('the export sink, against the emulator', () => {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true,
  });

  const sink = new ParquetExportSink(config);

  beforeAll(async () => {
    try {
      await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
    } catch {
      // Already there from a previous run, which is the ordinary case.
    }
  });

  afterAll(async () => {
    client.destroy();
    await sink.close();
  });

  beforeEach(async () => {
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: config.bucket }),
    );
    for (const object of listed.Contents ?? []) {
      await client.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: object.Key }),
      );
    }
  });

  const objectsUnder = async (prefix: string): Promise<string[]> => {
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix }),
    );
    return (listed.Contents ?? []).map((object) => object.Key ?? '');
  };

  it('writes rows an independent reader gets back', async () => {
    await sink.put({ key: KEY, columns: MOVEMENT_COLUMNS, rows: movements });

    const [row] = await readParquet(await sink.read(KEY));

    expect(row).toMatchObject({
      external_id: 'ERP-1',
      sku: 'ACME-001',
      location_code: 'WH-1',
      kind: 'receipt',
      quantity: 5,
    });
  });

  it('keeps a number a number and a moment a moment', async () => {
    await sink.put({ key: KEY, columns: MOVEMENT_COLUMNS, rows: movements });

    const rows = await readParquet(await sink.read(KEY));
    const [first] = rows;

    // The whole reason for a columnar format. A reader that has to parse every
    // value is reading a slow CSV with extra steps.
    expect(typeof first?.quantity).toBe('number');

    // Stated as "not text" first, deliberately. A moment written as a string
    // still parses back to the right instant, so an assertion that only parsed
    // it would pass against a file whose timestamps are text — which is exactly
    // the file this feature exists not to write.
    expect(typeof first?.occurred_at).not.toBe('string');
    const moment = first?.occurred_at;
    expect(moment instanceof Date ? moment : new Date(Number(moment))).toEqual(
      new Date('2026-08-27T10:00:00.000Z'),
    );
  });

  it('carries a negative quantity, because a sale is one', async () => {
    await sink.put({ key: KEY, columns: MOVEMENT_COLUMNS, rows: movements });

    const rows = await readParquet(await sink.read(KEY));

    expect(rows.map((row) => row.quantity)).toEqual([5, -3]);
  });

  it('leaves one object when the same key is written twice', async () => {
    // What makes a replayed window safe: the same window produces the same key,
    // and writing it again overwrites rather than adding a second copy.
    await sink.put({ key: KEY, columns: MOVEMENT_COLUMNS, rows: movements });
    await sink.put({
      key: KEY,
      columns: MOVEMENT_COLUMNS,
      rows: [movements[0]],
    });

    expect(await objectsUnder('movements/')).toEqual([KEY]);
    expect(await readParquet(await sink.read(KEY))).toHaveLength(1);
  });

  it('writes an empty object for a tenant with nothing to say', async () => {
    // A catalogue with no entries is still an answer, and a reader that finds
    // no object cannot tell "no products" from "never exported".
    const empty = 'products/tenant_id=x/products.parquet' as ObjectKey;

    await sink.put({ key: empty, columns: CATALOGUE_COLUMNS, rows: [] });

    expect(await readParquet(await sink.read(empty))).toEqual([]);
  });

  it('answers that a configured destination is reachable', async () => {
    await expect(sink.reachable()).resolves.toBeUndefined();
  });

  it('refuses a destination that does not exist, before writing anything', async () => {
    // 8.1 and 8.2 as a caller meets them: a bad destination costs a run
    // nothing, because it is discovered before the first tenant is touched.
    const missing = new ParquetExportSink({
      ...config,
      bucket: 'cubeforge-not-a-bucket',
    });

    await expect(missing.reachable()).rejects.toThrow();
    await missing.close();
  });
});
