import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { loadObjectStorageConfig } from '../../src/adapters/storage/object-storage-config';
import { ParquetExportSink } from '../../src/adapters/storage/parquet-export-sink';
import { readParquet } from '../../src/adapters/storage/parquet-runtime';
import { RunExportUseCase } from '../../src/application/export/run-export.use-case';
import { prefixFor, type ObjectKey } from '../../src/domain/export/partition';
import { ExportModule } from '../../src/export.module';
import { tenantId, type TenantId } from '../../src/domain/identifiers';
import { runtimePool, seed } from './support/database';
import { seedTenant, useIntegrationDatabase } from './support/fixtures';

const config = loadObjectStorageConfig(process.env);

const INSERT = `INSERT INTO stock_movements
    (id, tenant_id, external_id, sku, location_code, kind, quantity, occurred_at)
  VALUES ($1, $2, $3, 'ACME-001', 'WH-1', 'receipt', 5, '2026-08-27T10:00:00Z')`;

/**
 * The experiment the whole cursor design came from, as a test.
 *
 * Two movements, inserted in that order, committed in the opposite one. A
 * cursor holding the greatest *moment* exported — or the greatest identifier
 * seen — carries the second and then never sees the first again, because by the
 * time the first becomes visible it sits below the point already reached. The
 * movement is not late; it is lost.
 *
 * Without this test the design is a claim. `research.md` §1 records the session
 * where it was settled before any code was written; this is that session,
 * automated, and it is the only test in the feature whose failure would mean
 * the design itself is wrong rather than an implementation of it.
 */
describe('a movement that commits after a later one', () => {
  useIntegrationDatabase();

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

  async function tenantWithCatalogue(): Promise<TenantId> {
    const { id } = await seedTenant();
    await seed(async (database) => {
      await database.query(
        `INSERT INTO inventory_products (id, tenant_id, sku, name)
         VALUES (gen_random_uuid(), $1, 'ACME-001', 'A widget')`,
        [id],
      );
      await database.query(
        `INSERT INTO inventory_locations (id, tenant_id, code, name)
         VALUES (gen_random_uuid(), $1, 'WH-1', 'Main warehouse')`,
        [id],
      );
    });
    return tenantId(id);
  }

  /** The movement identifiers a reader would find under this tenant's prefix. */
  async function exportedMovements(tenant: TenantId): Promise<string[]> {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefixFor('movements', tenant),
      }),
    );

    const found: string[] = [];
    for (const object of listed.Contents ?? []) {
      const rows = await readParquet(
        await reader.read(object.Key as ObjectKey),
      );
      found.push(...rows.map((row) => String(row.external_id)));
    }
    return found.sort();
  }

  async function removeMovementsOf(tenant: TenantId): Promise<void> {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefixFor('movements', tenant),
      }),
    );
    for (const object of listed.Contents ?? []) {
      await client.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: object.Key }),
      );
    }
  }

  const runFor = (tenant: TenantId) =>
    context
      .get(RunExportUseCase)
      .execute({ correlationId: randomUUID(), onlyTenant: tenant });

  it('is carried by a later run, and never skipped', async () => {
    const tenant = await tenantWithCatalogue();
    await removeMovementsOf(tenant);

    // EARLIER is inserted first and committed last. Its transaction identifier
    // is the lower of the two; its commit is the later of the two.
    const holder = await runtimePool('app').connect();
    let committed = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT set_config($1, $2, true)', [
        'app.current_tenant',
        tenant,
      ]);
      await holder.query(INSERT, [randomUUID(), tenant, 'EARLIER']);

      // LATER is recorded and committed while EARLIER is still in flight.
      await seed((database) =>
        database.query(INSERT, [randomUUID(), tenant, 'LATER']),
      );

      const first = await runFor(tenant);

      // Neither yet. EARLIER is invisible, and LATER sits above the horizon
      // precisely because EARLIER is still running — which is the whole point:
      // the export refuses to pass a transaction it cannot see the end of.
      expect(first.report.outcomes).toEqual([
        expect.objectContaining({ status: 'up-to-date' }),
      ]);
      await expect(exportedMovements(tenant)).resolves.toEqual([]);

      await holder.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) {
        await holder.query('ROLLBACK');
      }
      holder.release();
    }

    const second = await runFor(tenant);

    expect(second.report.outcomes).toEqual([
      expect.objectContaining({ status: 'carried', movements: 2 }),
    ]);
    // Both, each exactly once. A cursor built on the greatest identifier seen
    // would have carried LATER in the first run and left EARLIER below its own
    // point reached for ever.
    await expect(exportedMovements(tenant)).resolves.toEqual([
      'EARLIER',
      'LATER',
    ]);

    await removeMovementsOf(tenant);
  });
});
