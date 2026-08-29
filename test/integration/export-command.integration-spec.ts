import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { ParquetExportSink } from '../../src/adapters/storage/parquet-export-sink';
import { loadObjectStorageConfig } from '../../src/adapters/storage/object-storage-config';
import {
  describeRun,
  exitStatusOf,
} from '../../src/adapters/cli/export-command';
import { RunExportUseCase } from '../../src/application/export/run-export.use-case';
import { EXPORT_SINK } from '../../src/application/ports/export-sink';
import type { ExportSink } from '../../src/application/ports/export-sink';
import { ExportModule } from '../../src/export.module';
import { prefixFor } from '../../src/domain/export/partition';
import { tenantId, type TenantId } from '../../src/domain/identifiers';
import { asPersonInTenant, seed } from './support/database';
import { seedTenant, useIntegrationDatabase } from './support/fixtures';

const config = loadObjectStorageConfig(process.env);

/**
 * The operator's command, assembled the way it is assembled in production.
 *
 * Every other export suite constructs the adapter it means to exercise. This
 * one constructs nothing: it boots the module and asks the container for the
 * use case, because "the ports are bound to the adapters" is a claim about the
 * wiring and a test that hand-built the graph would prove it about a graph
 * nobody runs.
 */
describe('the export command, wired', () => {
  useIntegrationDatabase();

  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true,
  });

  let context: INestApplicationContext;

  beforeAll(async () => {
    context = await NestFactory.createApplicationContext(ExportModule, {
      logger: false,
    });
  });

  afterAll(async () => {
    await context.close();
    client.destroy();
  });

  /** Everything of one tenant, which is three prefixes and never one. */
  async function objectsOf(tenant: TenantId): Promise<string[]> {
    const found: string[] = [];
    for (const dataset of ['movements', 'products', 'locations'] as const) {
      const listed = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefixFor(dataset, tenant),
        }),
      );
      found.push(...(listed.Contents ?? []).map((object) => object.Key!));
    }
    return found.sort();
  }

  async function removeObjectsOf(tenant: TenantId): Promise<void> {
    for (const key of await objectsOf(tenant)) {
      await client.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
      );
    }
  }

  async function tenantWithOneMovement(): Promise<TenantId> {
    const { id } = await seedTenant();
    const tenant = tenantId(id);
    await seed(async (database) => {
      await database.query(
        `INSERT INTO inventory_products (id, tenant_id, sku, name, category)
         VALUES (gen_random_uuid(), $1, 'ACME-001', 'A widget', 'hardware')`,
        [tenant],
      );
      await database.query(
        `INSERT INTO inventory_locations (id, tenant_id, code, name)
         VALUES (gen_random_uuid(), $1, 'WH-1', 'Main warehouse')`,
        [tenant],
      );
    });
    await asPersonInTenant(tenant, (database) =>
      database.query(
        `INSERT INTO stock_movements
           (id, tenant_id, external_id, sku, location_code, kind, quantity, occurred_at)
         VALUES ($1, $2, 'ERP-1', 'ACME-001', 'WH-1', 'receipt', 5, $3)`,
        [randomUUID(), tenant, new Date('2026-08-27T10:00:00.000Z')],
      ),
    );
    return tenant;
  }

  it('binds the ports to the adapters that reach the real destination', async () => {
    const sink = context.get<ExportSink>(EXPORT_SINK);

    expect(sink).toBeInstanceOf(ParquetExportSink);
    // Not merely constructed: the credentials are accepted and the bucket is
    // there. This is the question a run asks before it touches a tenant.
    await expect(sink.reachable()).resolves.toBeUndefined();
  });

  it('runs end to end, reports the tenant, and exits reporting success', async () => {
    const tenant = await tenantWithOneMovement();
    await removeObjectsOf(tenant);

    const correlationId = randomUUID();
    const run = await context
      .get(RunExportUseCase)
      .execute({ correlationId, onlyTenant: tenant });

    expect(exitStatusOf(run.report)).toBe(0);
    expect(run.report.outcomes).toEqual([
      expect.objectContaining({
        status: 'carried',
        tenantId: tenant,
        movements: 1,
        partitions: 1,
      }),
    ]);

    // The lines an operator reads, from the run that actually happened.
    const lines = describeRun(run);
    expect(lines.every((line) => line.startsWith(correlationId))).toBe(true);
    expect(lines.at(-1)).toBe(
      `${correlationId} finished: 1 carried, 0 up to date, 0 failed`,
    );

    expect(await objectsOf(tenant)).toEqual([
      expect.stringContaining(
        `locations/tenant_id=${tenant}/locations.parquet`,
      ),
      expect.stringContaining(`movements/tenant_id=${tenant}/recorded_date=`),
      expect.stringContaining(`products/tenant_id=${tenant}/products.parquet`),
    ]);

    await removeObjectsOf(tenant);
  });
});
