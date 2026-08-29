// First, and deliberately: the HTTP DTOs read `Reflect.getMetadata` while their
// module is evaluated, and this file reaches the application through Nest's
// testing harness rather than through `main.ts`.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { NestFactory } from '@nestjs/core';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ParquetExportSink } from '../../src/adapters/storage/parquet-export-sink';
import { readParquet } from '../../src/adapters/storage/parquet-runtime';
import { ExportTenantUseCase } from '../../src/application/export/export-tenant.use-case';
import { RunExportUseCase } from '../../src/application/export/run-export.use-case';
import type {
  ColumnarFile,
  ExportSink,
} from '../../src/application/ports/export-sink';
import {
  PLATFORM_UNIT_OF_WORK,
  type PlatformUnitOfWork,
} from '../../src/application/ports/platform-unit-of-work';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../../src/application/ports/tenant-scoped-unit-of-work';
import {
  catalogueKey,
  prefixFor,
  type ObjectKey,
} from '../../src/domain/export/partition';
import { ExportModule } from '../../src/export.module';
import { tenantId, type TenantId } from '../../src/domain/identifiers';
import { asPersonInTenant, seed } from './support/database';
import {
  createApplication,
  seedTenantWithAdministrator,
} from './support/application';
import { seedTenant, useIntegrationDatabase } from './support/fixtures';
import {
  RefusingOn,
  exportDestination,
  useExportDestination,
} from './support/object-storage';

const config = exportDestination();

// Two days, so a failing run has a second object to fail on.
const FIRST_DAY = new Date('2026-08-27T02:00:00.000Z');
const SECOND_DAY = new Date('2026-08-28T02:00:00.000Z');
const OCCURRED = new Date('2026-08-20T09:00:00.000Z');

const INSERT = `INSERT INTO stock_movements
    (id, tenant_id, external_id, sku, location_code, kind, quantity, occurred_at, recorded_at)
  VALUES ($1, $2, $3, 'ACME-001', 'WH-1', 'receipt', 5, $4, $5)`;

// Booting the HTTP application and pausing a sink on purpose both cost real
// time. Five seconds is Jest's default and this suite is honestly slower.
jest.setTimeout(30_000);

/**
 * What a run does when it goes wrong, and what it does to everything else.
 *
 * The use-case tests answer all of this against doubles. What only the real
 * stack can show is the half the doubles cannot model: that the objects a
 * failed run left are the objects the next run writes over, that a cursor
 * survives in PostgreSQL exactly as the recovery story needs it to, and that
 * an export in flight is not something the transactional API waits behind.
 */
describe('a run that fails, and the application while one is in flight', () => {
  useIntegrationDatabase();
  useExportDestination();

  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true,
  });
  /** One client for everything this suite writes, reads and wraps. */
  const storage = new ParquetExportSink(config);

  let context: INestApplicationContext;
  let app: INestApplication<App>;

  beforeAll(async () => {
    context = await NestFactory.createApplicationContext(ExportModule, {
      logger: false,
    });
    app = await createApplication();
  });

  afterAll(async () => {
    await app.close();
    await context.close();
    await storage.close();
    client.destroy();
  });

  /** A run built over a sink of this test's choosing, wired like the real one. */
  function runWith(sink: ExportSink): RunExportUseCase {
    return new RunExportUseCase(
      context.get<PlatformUnitOfWork>(PLATFORM_UNIT_OF_WORK),
      sink,
      new ExportTenantUseCase(
        context.get<TenantScopedUnitOfWork>(TENANT_SCOPED_UNIT_OF_WORK),
        sink,
      ),
    );
  }

  const runFor = (tenant: TenantId, use = context.get(RunExportUseCase)) =>
    use.execute({ correlationId: randomUUID(), onlyTenant: tenant });

  async function tenantWithCatalogue(): Promise<TenantId> {
    const { id } = await seedTenant();
    await seed(async (database) => {
      await database.query(
        `INSERT INTO inventory_products (id, tenant_id, sku, name, category)
         VALUES (gen_random_uuid(), $1, 'ACME-001', 'A widget', 'hardware')`,
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

  const record = (tenant: TenantId, externalId: string, recordedAt: Date) =>
    asPersonInTenant(tenant, (database) =>
      database.query(INSERT, [
        randomUUID(),
        tenant,
        externalId,
        OCCURRED,
        recordedAt,
      ]),
    );

  async function movementKeysOf(tenant: TenantId): Promise<ObjectKey[]> {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefixFor('movements', tenant),
      }),
    );
    return (listed.Contents ?? [])
      .map((object) => object.Key as ObjectKey)
      .sort();
  }

  async function exportedIdentifiers(tenant: TenantId): Promise<string[]> {
    const found: string[] = [];
    for (const key of await movementKeysOf(tenant)) {
      const rows = await readParquet(await storage.read(key));
      found.push(...rows.map((row) => String(row.external_id)));
    }
    return found.sort();
  }

  const cursorOf = (tenant: TenantId) =>
    context
      .get<TenantScopedUnitOfWork>(TENANT_SCOPED_UNIT_OF_WORK)
      .runInTenant(tenant, ({ exportCursors }) =>
        exportCursors.read('movements'),
      );

  it('finishes what a failed run started, under the keys it was already writing', async () => {
    const tenant = await tenantWithCatalogue();
    await record(tenant, 'ERP-1', FIRST_DAY);
    await record(tenant, 'ERP-2', SECOND_DAY);

    // One object written, the next refused: the run dies with a day on disk and
    // its point reached unmoved.
    const failing = new FailingAfter(storage, 1);
    const first = await runFor(tenant, runWith(failing));

    expect(first.report.outcomes).toEqual([
      expect.objectContaining({ status: 'failed', reason: 'write-failed' }),
    ]);
    await expect(cursorOf(tenant)).resolves.toMatchObject({
      state: 'started',
    });

    const attempted = failing.asked
      .filter((key) => key.startsWith('movements/'))
      .sort();
    expect(attempted).toHaveLength(2);
    expect(await movementKeysOf(tenant)).toEqual([attempted[0]]);

    // Something new arrives before the retry. The replay carries the recorded
    // window, so this movement waits — and the keys stay the ones the failed
    // run was already writing.
    await record(tenant, 'ERP-3', SECOND_DAY);

    const second = await runFor(tenant);

    expect(second.report.outcomes).toEqual([
      expect.objectContaining({ status: 'carried', movements: 2 }),
    ]);
    expect(await movementKeysOf(tenant)).toEqual(attempted);
    // Exactly once each, which is the whole of 2.3: the object the failed run
    // wrote was rewritten with identical contents rather than joined by a
    // second copy under a different name.
    await expect(exportedIdentifiers(tenant)).resolves.toEqual([
      'ERP-1',
      'ERP-2',
    ]);
  });

  it('costs one tenant only, and advances every other point reached', async () => {
    const tenants: TenantId[] = [];
    for (let i = 0; i < 3; i += 1) {
      const tenant = await tenantWithCatalogue();
      await record(tenant, `ERP-${i}`, FIRST_DAY);
      tenants.push(tenant);
    }
    const [, failing] = tenants;

    const run = await runWith(
      new RefusingOn(storage, catalogueKey(failing, 'products')),
    ).execute({ correlationId: randomUUID() });

    expect(run.report.failed).toBe(1);
    expect(run.report.succeeded).toBe(false);
    expect(run.report.outcomes).toContainEqual({
      status: 'failed',
      tenantId: failing,
      reason: 'write-failed',
    });

    for (const tenant of tenants.filter((id) => id !== failing)) {
      // Carried, in the real cursor table: the failure next door cost them
      // nothing, not even a retry.
      await expect(cursorOf(tenant)).resolves.toMatchObject({
        state: 'carried',
      });
      await expect(exportedIdentifiers(tenant)).resolves.toHaveLength(1);
    }
    await expect(cursorOf(failing)).resolves.toMatchObject({
      state: 'started',
    });
  });

  it('stops before touching a tenant when the destination cannot be reached', async () => {
    const tenants: TenantId[] = [];
    for (let i = 0; i < 2; i += 1) {
      const tenant = await tenantWithCatalogue();
      await record(tenant, `ERP-${i}`, FIRST_DAY);
      tenants.push(tenant);
    }

    const nowhere = new ParquetExportSink({
      ...config,
      bucket: 'cubeforge-not-a-bucket',
    });

    await expect(
      runWith(nowhere).execute({ correlationId: randomUUID() }),
    ).rejects.toThrow();
    await nowhere.close();

    for (const tenant of tenants) {
      // Nothing advanced and nothing attempted: a bad destination costs a run
      // exactly one question.
      await expect(cursorOf(tenant)).resolves.toEqual({
        state: 'never-carried',
      });
      await expect(movementKeysOf(tenant)).resolves.toEqual([]);
    }
  });

  it('answers the transactional API while an export is in flight', async () => {
    const acme = await seedTenantWithAdministrator(app, 'Acme');
    const server = () => app.getHttpServer();
    for (const [path, name] of [
      ['products/ACME-001', 'A widget'],
      ['locations/WH-1', 'Main warehouse'],
    ]) {
      await request(server())
        .put(`/tenants/${acme.id}/inventory/${path}`)
        .set(acme.headers)
        .send({ name })
        .expect(200);
    }
    const tenant = tenantId(acme.id);
    await record(tenant, 'ERP-1', FIRST_DAY);
    await record(tenant, 'ERP-2', SECOND_DAY);

    // A run held open at the sink, which is where a real export spends its
    // time. Long enough that a request landing during it is a fact rather than
    // a race the scheduler happened to win.
    const order: string[] = [];
    const running = runFor(tenant, runWith(new PausingSink(storage, 400))).then(
      (run) => {
        order.push('the export');
        return run;
      },
    );

    const answered = await request(server())
      .post(`/tenants/${acme.id}/inventory/movements`)
      .set(acme.headers)
      .send({
        externalId: 'WHILE-EXPORTING',
        sku: 'ACME-001',
        location: 'WH-1',
        kind: 'receipt',
        quantity: 7,
        occurredAt: '2026-08-21T10:00:00.000Z',
      });
    order.push('the request');

    // 200, and the movement recorded: the request was understood and answered
    // while the export was still writing.
    expect(answered.status).toBe(200);
    expect(answered.body).toEqual({
      status: 'recorded',
      externalId: 'WHILE-EXPORTING',
    });
    const run = await running;
    expect(run.report.succeeded).toBe(true);

    // The request finished first, so it was answered *during* the export and
    // not after it. An export holding a lock on the movement table would put
    // these the other way round, or never let the request finish at all.
    expect(order).toEqual(['the request', 'the export']);
  });
});

/**
 * The real sink, allowed a fixed number of objects and refusing the rest.
 *
 * A double would not do: this test is about the objects a failed run leaves in
 * storage and the keys the next run writes over, so the objects have to be
 * real. It remembers every key it was asked for, which is how the second run's
 * keys are compared against what the first was attempting rather than against a
 * pattern this test wrote for itself.
 */
class FailingAfter implements ExportSink {
  readonly asked: ObjectKey[] = [];
  private written = 0;

  constructor(
    private readonly inner: ExportSink,
    private readonly allowed: number,
  ) {}

  put(file: ColumnarFile): Promise<void> {
    this.asked.push(file.key);
    if (this.written >= this.allowed) {
      return Promise.reject(new Error('the destination refused this object'));
    }
    this.written += 1;
    return this.inner.put(file);
  }

  reachable(): Promise<void> {
    return this.inner.reachable();
  }
}

/** The real sink, slowed to the pace of a destination that is far away. */
class PausingSink implements ExportSink {
  constructor(
    private readonly inner: ExportSink,
    private readonly pause: number,
  ) {}

  async put(file: ColumnarFile): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.pause));
    return this.inner.put(file);
  }

  reachable(): Promise<void> {
    return this.inner.reachable();
  }
}
