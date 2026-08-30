import { randomUUID } from 'node:crypto';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { ParquetExportSink } from '../../src/adapters/storage/parquet-export-sink';
import { readParquet } from '../../src/adapters/storage/parquet-runtime';
import { ExportTenantUseCase } from '../../src/application/export/export-tenant.use-case';
import { RunExportUseCase } from '../../src/application/export/run-export.use-case';
import { CLOCK, type Clock } from '../../src/application/ports/clock';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../../src/application/ports/tenant-scoped-unit-of-work';
import { CATALOGUE_COLUMNS } from '../../src/domain/export/exported-row';
import {
  catalogueKey,
  prefixFor,
  type ObjectKey,
} from '../../src/domain/export/partition';
import { ExportModule } from '../../src/export.module';
import { tenantId, type TenantId } from '../../src/domain/identifiers';
import { asPersonInTenant, seed } from './support/database';
import { seedTenant, useIntegrationDatabase } from './support/fixtures';
import {
  RefusingOn,
  exportDestination,
  useExportDestination,
} from './support/object-storage';

const config = exportDestination();

/** A day a movement was recorded on, and an earlier one it occurred on. */
const RECORDED_MORNING = new Date('2026-08-27T02:00:00.000Z');
const RECORDED_EVENING = new Date('2026-08-27T22:00:00.000Z');
const OCCURRED = new Date('2026-08-20T09:00:00.000Z');

const INSERT = `INSERT INTO stock_movements
    (id, tenant_id, external_id, sku, location_code, kind, quantity, occurred_at, recorded_at)
  VALUES ($1, $2, $3, 'ACME-001', 'WH-1', $4, $5, $6, $7)`;

/**
 * What an analytical reader actually meets.
 *
 * Every other export suite checks a decision — which window, which key, which
 * tenant. This one checks the artefact: that the objects exist where the layout
 * says, that their rows come back with their types intact, and that they come
 * back through **`hyparquet`, not the library that wrote them**. A file only its
 * own writer can read proves nothing about what Athena will make of it, which
 * is the entire point of exporting in a columnar format at all.
 */
describe('the objects the export leaves behind', () => {
  useIntegrationDatabase();
  useExportDestination();

  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true,
  });
  const reader = new ParquetExportSink(config);

  let context: INestApplicationContext;

  beforeAll(async () => {
    context = await NestFactory.createApplicationContext(ExportModule, {
      logger: false,
    });
  });

  afterAll(async () => {
    await context.close();
    await reader.close();
    client.destroy();
  });

  async function tenantWithCatalogue(
    productName = 'A widget',
  ): Promise<TenantId> {
    const { id } = await seedTenant();
    await seed(async (database) => {
      await database.query(
        `INSERT INTO inventory_products (id, tenant_id, sku, name, category)
         VALUES (gen_random_uuid(), $1, 'ACME-001', $2, 'hardware')`,
        [id, productName],
      );
      await database.query(
        `INSERT INTO inventory_locations (id, tenant_id, code, name)
         VALUES (gen_random_uuid(), $1, 'WH-1', 'Main warehouse')`,
        [id],
      );
    });
    return tenantId(id);
  }

  /** One movement, in its own transaction, recorded at a chosen moment. */
  function record(
    tenant: TenantId,
    externalId: string,
    recordedAt: Date,
    movement: { kind: string; quantity: number } = {
      kind: 'receipt',
      quantity: 5,
    },
  ): Promise<unknown> {
    return asPersonInTenant(tenant, (database) =>
      database.query(INSERT, [
        randomUUID(),
        tenant,
        externalId,
        movement.kind,
        movement.quantity,
        OCCURRED,
        recordedAt,
      ]),
    );
  }

  const runFor = (tenant: TenantId) =>
    context
      .get(RunExportUseCase)
      .execute({ correlationId: randomUUID(), onlyTenant: tenant });

  interface StoredObject {
    readonly key: ObjectKey;
    readonly etag: string;
  }

  async function objectsUnder(prefix: string): Promise<StoredObject[]> {
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix }),
    );
    return (listed.Contents ?? [])
      .map((object) => ({
        key: object.Key as ObjectKey,
        etag: object.ETag ?? '',
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  /** Read back with the other library, which is the whole point. */
  const rowsAt = async (key: ObjectKey): Promise<Record<string, unknown>[]> =>
    readParquet(await reader.read(key));

  it('writes a readable object under a key naming the tenant and the day recorded', async () => {
    const tenant = await tenantWithCatalogue();
    await record(tenant, 'ERP-1', RECORDED_MORNING);

    await runFor(tenant);

    const [object] = await objectsUnder(prefixFor('movements', tenant));
    // The day it was **recorded**, not the day it occurred — a backdated
    // movement belongs to the day this platform stored it, which is the day no
    // later run has to reopen.
    expect(object?.key).toContain(
      `movements/tenant_id=${tenant}/recorded_date=2026-08-27/`,
    );
    expect(object?.key).not.toContain('2026-08-20');

    const [row] = await rowsAt(object.key);
    expect(row).toMatchObject({
      external_id: 'ERP-1',
      sku: 'ACME-001',
      location_code: 'WH-1',
      kind: 'receipt',
    });

    // Types, through a reader that is not the writer. Stated as "not text"
    // first: a moment written as a string still parses back to the right
    // instant, so an assertion that only parsed it would pass against exactly
    // the file this feature exists not to write.
    expect(typeof row?.quantity).toBe('number');
    expect(typeof row?.occurred_at).not.toBe('string');
    expect(typeof row?.recorded_at).not.toBe('string');
    expect(momentOf(row?.occurred_at)).toEqual(OCCURRED);
    expect(momentOf(row?.recorded_at)).toEqual(RECORDED_MORNING);

    // The tenant is the partition and never a column: two answers to one
    // question eventually disagree.
    expect(row).not.toHaveProperty('tenant_id');
  });

  it('adds a file to a day already written, leaving the earlier one untouched', async () => {
    const tenant = await tenantWithCatalogue();
    await record(tenant, 'ERP-1', RECORDED_MORNING);

    await runFor(tenant);
    const [first] = await objectsUnder(prefixFor('movements', tenant));

    // A second movement recorded on the *same* day, after that day's file was
    // already written. This is the case `recorded_at` was added for: the export
    // must never have to rewrite a day it has closed.
    await record(tenant, 'ERP-2', RECORDED_EVENING, {
      kind: 'sale',
      quantity: -3,
    });
    await runFor(tenant);

    const after = await objectsUnder(
      `${prefixFor('movements', tenant)}recorded_date=2026-08-27/`,
    );
    expect(after).toHaveLength(2);

    // The earlier file is the same object, byte for byte, and still holds
    // exactly what it held. A run that rewrote the day would pass a count and
    // fail this.
    const survivor = after.find((object) => object.key === first?.key);
    expect(survivor?.etag).toBe(first?.etag);
    expect((await rowsAt(first.key)).map((row) => row.external_id)).toEqual([
      'ERP-1',
    ]);

    const added = after.find((object) => object.key !== first?.key);
    expect((await rowsAt(added!.key)).map((row) => row.external_id)).toEqual([
      'ERP-2',
    ]);
  });

  it('presents a renamed product once, and currently', async () => {
    const tenant = await tenantWithCatalogue('A widget');
    await record(tenant, 'ERP-1', RECORDED_MORNING);
    await runFor(tenant);

    await seed((database) =>
      database.query(
        `UPDATE inventory_products SET name = $2 WHERE tenant_id = $1`,
        [tenant, 'A better widget'],
      ),
    );
    await record(tenant, 'ERP-2', RECORDED_EVENING);
    await runFor(tenant);

    // One row, not two, and the current name. The catalogue replaces its
    // predecessor rather than accumulating versions a reader would have to
    // choose between.
    expect(await rowsAt(catalogueKey(tenant, 'products'))).toEqual([
      { code: 'ACME-001', name: 'A better widget', category: 'hardware' },
    ]);
    expect(await rowsAt(catalogueKey(tenant, 'locations'))).toEqual([
      { code: 'WH-1', name: 'Main warehouse', category: null },
    ]);
  });

  it('presents no catalogue entries for a tenant that declared none', async () => {
    const { id } = await seedTenant();
    const tenant = tenantId(id);

    await runFor(tenant);

    // An object with no rows, not a missing object: a reader that finds nothing
    // cannot tell "no products" from "never exported".
    expect(await objectsUnder(prefixFor('products', tenant))).toHaveLength(1);
    expect(await rowsAt(catalogueKey(tenant, 'products'))).toEqual([]);
    expect(await rowsAt(catalogueKey(tenant, 'locations'))).toEqual([]);
  });

  it('leaves the previous catalogue readable when the new one cannot be written', async () => {
    const tenant = await tenantWithCatalogue('A widget');
    await record(tenant, 'ERP-1', RECORDED_MORNING);
    await runFor(tenant);

    await seed((database) =>
      database.query(
        `UPDATE inventory_products SET name = $2 WHERE tenant_id = $1`,
        [tenant, 'A better widget'],
      ),
    );
    await record(tenant, 'ERP-2', RECORDED_EVENING);

    // The real sink, refusing one key. The failure has to happen at the write
    // rather than be simulated above it, because what this asserts is what
    // survives *in storage*.
    const refusing = new RefusingOn(
      new ParquetExportSink(config),
      catalogueKey(tenant, 'products'),
    );
    const attempt = new ExportTenantUseCase(
      context.get<TenantScopedUnitOfWork>(TENANT_SCOPED_UNIT_OF_WORK),
      refusing,
      context.get<Clock>(CLOCK),
    );

    await expect(attempt.execute({ tenantId: tenant })).rejects.toThrow();

    // Not emptied, not half-written: the previous catalogue, whole, and still
    // the one a reader gets. A replace that truncated first would fail here.
    expect(await rowsAt(catalogueKey(tenant, 'products'))).toEqual([
      { code: 'ACME-001', name: 'A widget', category: 'hardware' },
    ]);
  });
  it('leaves the previous catalogue readable when the write itself fails', async () => {
    const tenant = await tenantWithCatalogue('A widget');
    await record(tenant, 'ERP-1', RECORDED_MORNING);
    await runFor(tenant);

    // The other failure mode, and the one that decides how `put` may be built:
    // the sink is asked to replace the object and fails **while writing it**.
    // The payload is contrived on purpose — its only job is to fail at a real
    // point in a real write. A sink that cleared the key before writing would
    // lose the tenant's catalogue here and pass every other test in this file.
    const sink = new ParquetExportSink(config);
    const unencodable = [
      { code: {}, name: 'A widget', category: null },
    ] as unknown as Parameters<typeof sink.put>[0]['rows'];

    await expect(
      sink.put({
        key: catalogueKey(tenant, 'products'),
        columns: CATALOGUE_COLUMNS,
        rows: unencodable,
      }),
    ).rejects.toThrow();
    await sink.close();

    expect(await rowsAt(catalogueKey(tenant, 'products'))).toEqual([
      { code: 'ACME-001', name: 'A widget', category: 'hardware' },
    ]);
  });
});

/** hyparquet may hand a moment back as a `Date` or as epoch milliseconds. */
function momentOf(value: unknown): Date {
  return value instanceof Date ? value : new Date(Number(value));
}
