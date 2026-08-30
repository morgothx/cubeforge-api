import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import { GlueCatalogue } from '../../src/adapters/analytics/glue-catalogue';
import { loadAnalyticsConfig } from '../../src/adapters/analytics/analytics-config';
import { RunExportUseCase } from '../../src/application/export/run-export.use-case';
import { tenantId } from '../../src/domain/identifiers';
import { ExportModule } from '../../src/export.module';
import {
  createApplication,
  seedTenantWithAdministrator,
  type SeededTenant,
} from './support/application';
import { asPersonInTenant, seed } from './support/database';
import { useIntegrationDatabase } from './support/fixtures';
import { useAnalyticalStore } from './support/analytics';
import { exportDestination } from './support/object-storage';

const analytics = loadAnalyticsConfig(process.env);
const storage = exportDestination();

// A real export, a real catalogue and a polled engine behind one request.
jest.setTimeout(60_000);

/**
 * The route, end to end, against the local stack.
 *
 * The adapter's suites prove the statements and the edge spec proves the
 * refusals with the engine replaced. What only this can show is the whole path
 * standing up at once: a credential resolved, a tenant taken from the path, a
 * period parsed, and an answer drawn from objects the export actually wrote a
 * moment earlier.
 *
 * Isolation, disclosure and the failure modes are proven in their own suites —
 * this one is the wiring, and it is deliberately one happy path.
 */
describe('asking for movement history through the API', () => {
  useIntegrationDatabase();
  useAnalyticalStore();

  let app: INestApplication<App>;
  let exports: INestApplicationContext;
  let acme: SeededTenant;

  beforeAll(async () => {
    app = await createApplication();
    exports = await NestFactory.createApplicationContext(ExportModule, {
      logger: false,
    });
  });

  afterAll(async () => {
    await exports.close();
    await app.close();
  });

  beforeEach(async () => {
    acme = await seedTenantWithAdministrator(app, 'Acme');
    const tenant = tenantId(acme.id);

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
           (id, tenant_id, external_id, sku, location_code, kind, quantity,
            occurred_at, recorded_at)
         VALUES ($1, $2, 'ERP-1', 'ACME-001', 'WH-1', 'receipt', 10, $3, $4)`,
        [
          randomUUID(),
          tenant,
          new Date('2026-08-01T09:00:00.000Z'),
          new Date('2026-08-27T02:00:00.000Z'),
        ],
      ),
    );

    await exports
      .get(RunExportUseCase)
      .execute({ correlationId: randomUUID(), onlyTenant: tenant });

    const catalogue = new GlueCatalogue(analytics, storage.bucket);
    try {
      await catalogue.apply();
    } finally {
      catalogue.close();
    }
  });

  it('answers a member of the tenant from what the export wrote', async () => {
    const response = await request(app.getHttpServer())
      .get(
        `/tenants/${acme.id}/analytics/movements?from=2026-08-01&to=2026-08-31`,
      )
      .set(acme.headers)
      .expect(200);

    const answer = response.body as {
      state: string;
      completeThrough: string;
      entries: { day: string; kind: string; quantity: number }[];
    };

    expect(answer.state).toBe('answered');
    expect(answer.entries).toEqual([
      { day: '2026-08-27', kind: 'receipt', quantity: 10 },
    ]);
    // A quantity that arrived as a number rather than as the text the engine
    // sent, and a moment that parses — the answer is drawable without repair.
    expect(typeof answer.entries[0].quantity).toBe('number');
    expect(Number.isNaN(Date.parse(answer.completeThrough))).toBe(false);
  });
});
