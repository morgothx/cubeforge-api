import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { loadAnalyticsConfig } from '../../src/adapters/analytics/analytics-config';
import { AthenaEngine } from '../../src/adapters/analytics/athena-engine';
import { QueryRunner } from '../../src/adapters/analytics/athena-query-runner';
import {
  GlueCatalogue,
  type CatalogueReport,
} from '../../src/adapters/analytics/glue-catalogue';
import { RunExportUseCase } from '../../src/application/export/run-export.use-case';
import { ExportModule } from '../../src/export.module';
import { tenantId, type TenantId } from '../../src/domain/identifiers';
import { asPersonInTenant, seed } from './support/database';
import { seedTenant, useIntegrationDatabase } from './support/fixtures';
import {
  exportDestination,
  useExportDestination,
} from './support/object-storage';

const analytics = loadAnalyticsConfig(process.env);
const storage = exportDestination();

const INSERT = `INSERT INTO stock_movements
    (id, tenant_id, external_id, sku, location_code, kind, quantity, occurred_at, recorded_at)
  VALUES ($1, $2, $3, 'ACME-001', 'WH-1', 'receipt', $4, $5, $6)`;

/**
 * The catalogue, applied and then asked.
 *
 * What this can show is that the command runs, is safe to run again, and leaves
 * an engine able to answer from objects the export actually wrote. What it
 * **cannot** show is whether the partition arrangement is right: the local
 * engine infers partitions from the key path and would answer either way. That
 * assertion lives in the unit spec, on the values the command sends.
 */
describe('the catalogue, against the local stack', () => {
  useIntegrationDatabase();
  useExportDestination();

  let context: INestApplicationContext;
  let engine: AthenaEngine;

  beforeAll(async () => {
    context = await NestFactory.createApplicationContext(ExportModule, {
      logger: false,
    });
    engine = new AthenaEngine(analytics);
  });

  afterAll(async () => {
    await context.close();
    engine.close();
  });

  const applied = async (): Promise<CatalogueReport> => {
    const catalogue = new GlueCatalogue(analytics, storage.bucket);
    try {
      return await catalogue.apply();
    } finally {
      catalogue.close();
    }
  };

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
      database.query(INSERT, [
        randomUUID(),
        tenant,
        'ERP-1',
        9,
        new Date('2026-08-20T09:00:00.000Z'),
        new Date('2026-08-27T02:00:00.000Z'),
      ]),
    );
    await context
      .get(RunExportUseCase)
      .execute({ correlationId: randomUUID(), onlyTenant: tenant });
    return tenant;
  }

  const ask = (statement: string) =>
    new QueryRunner(engine).run(statement, new Date(Date.now() + 30_000));

  it('describes every dataset the export writes, and says which it touched', async () => {
    const first = await applied();

    // The command's own report, not a read-back. `glue:GetTable` cannot be
    // deserialized against this emulator at all — see the note in tasks.md —
    // and the report is the better assertion anyway: it is what an operator
    // reads, and what the engine answers below is what actually matters.
    expect([...first.created, ...first.updated].sort()).toEqual([
      'locations',
      'movements',
      'products',
      'watermarks',
    ]);
    expect(first.database).toBe(analytics.database);
  });

  it('is safe to run twice, because an operator will', async () => {
    await applied();
    const again = await applied();

    // Every table updated rather than refused: this is how the catalogue is
    // corrected after the export's layout changes, not only how it is created.
    expect([...again.updated].sort()).toEqual([
      'locations',
      'movements',
      'products',
      'watermarks',
    ]);
    expect(again.created).toEqual([]);
  });

  it('leaves an engine that answers from what the export wrote', async () => {
    const tenant = await tenantWithOneMovement();
    await applied();

    const result = await ask(
      `SELECT sku, quantity FROM movements WHERE tenant_id = '${tenant}'`,
    );

    expect(result.header).toEqual(['sku', 'quantity']);
    expect(result.rows).toEqual([['ACME-001', '9']]);
  });

  it('answers about the mark the export leaves, through the same catalogue', async () => {
    const tenant = await tenantWithOneMovement();
    await applied();

    const result = await ask(
      `SELECT complete_through FROM watermarks WHERE tenant_id = '${tenant}'`,
    );

    // The fourth dataset is reachable too — without it an answer could not say
    // how current it is, which is the whole reason the export publishes it.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.[0]).toBeTruthy();
  });
});
