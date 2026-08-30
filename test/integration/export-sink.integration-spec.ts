import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { ExportFailed } from '../../src/application/export/export-failure';
import { readParquet } from '../../src/adapters/storage/parquet-runtime';
import { ParquetExportSink } from '../../src/adapters/storage/parquet-export-sink';
import { loadObjectStorageConfig } from '../../src/adapters/storage/object-storage-config';
import {
  CATALOGUE_COLUMNS,
  MOVEMENT_COLUMNS,
} from '../../src/domain/export/exported-row';
import type { ObjectKey } from '../../src/domain/export/partition';
import { useExportDestination } from './support/object-storage';

const config = loadObjectStorageConfig(process.env);

/** The one tenant this suite writes under, so its cleanup can be its own. */
const SUITE_TENANT = '018f2c00-0000-7000-8000-00000000ac01';

const KEY =
  `movements/tenant_id=${SUITE_TENANT}/recorded_date=2026-08-28/1-2.parquet` as ObjectKey;

/**
 * Only what this suite writes.
 *
 * It used to empty the whole bucket between tests, which was harmless while the
 * export was the only thing writing to it. It is not any more — the analytics
 * suites write there too — and a suite reaching outside its own prefixes is how
 * a green test becomes an intermittent failure in whichever suite ran next.
 */
const OWNED = [`movements/tenant_id=${SUITE_TENANT}/`, 'products/tenant_id=x/'];

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
  useExportDestination();

  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true,
  });

  const sink = new ParquetExportSink(config);

  afterAll(async () => {
    client.destroy();
    await sink.close();
  });

  beforeEach(async () => {
    for (const prefix of OWNED) {
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix }),
      );
      for (const object of listed.Contents ?? []) {
        await client.send(
          new DeleteObjectCommand({ Bucket: config.bucket, Key: object.Key }),
        );
      }
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

    // Under this suite's own tenant, not under every tenant's movements: the
    // bucket is shared now, and asking about all of them would be asserting
    // something about whoever ran before.
    expect(await objectsUnder(`movements/tenant_id=${SUITE_TENANT}/`)).toEqual([
      KEY,
    ]);
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

  it('tells a refused credential from a destination that is not there', async () => {
    // The emulator accepts every credential — deliberately, it is a local
    // emulator — so a rejection cannot be produced against it at all. A three
    // line server that answers 403 can, and it is still local: nothing here
    // reaches, or may reach, a real account.
    const refusing = await serverAnswering(403);
    try {
      const rejected = new ParquetExportSink({
        ...config,
        endpoint: refusing.endpoint,
      });

      // Two different diagnoses, because an operator does one thing about a
      // wrong key and another about a destination that is not there.
      expect(await refusalOf(rejected)).toEqual(
        new ExportFailed('storage-rejected', expect.anything()),
      );
      await rejected.close();
    } finally {
      await refusing.close();
    }

    const missing = new ParquetExportSink({
      ...config,
      bucket: 'cubeforge-not-a-bucket',
    });
    expect(await refusalOf(missing)).toEqual(
      new ExportFailed('storage-unreachable', expect.anything()),
    );
    await missing.close();
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

/**
 * A local server that answers every request with one status.
 *
 * Bound to the loopback address on a port the operating system picks, so it is
 * as local as the emulator is and cannot outlive the test that started it.
 */
async function serverAnswering(
  status: number,
): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(status);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/**
 * What a sink threw when asked whether it could be reached.
 *
 * Returned rather than matched inline, so the assertion can name the type as
 * well as the reason: a plain object carrying a `reason` field would satisfy a
 * loose match and prove nothing about what a run will actually catch.
 */
async function refusalOf(sink: ParquetExportSink): Promise<unknown> {
  try {
    await sink.reachable();
  } catch (error) {
    return error;
  }
  throw new Error('the sink answered that it was reachable');
}
