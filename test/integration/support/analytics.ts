import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { loadAnalyticsConfig } from '../../../src/adapters/analytics/analytics-config';
import { GlueCatalogue } from '../../../src/adapters/analytics/glue-catalogue';
import { RunExportUseCase } from '../../../src/application/export/run-export.use-case';
import { tenantId } from '../../../src/domain/identifiers';
import { ExportModule } from '../../../src/export.module';
import { asPersonInTenant, seed } from './database';
import { seedTenant } from './fixtures';
import { exportDestination, useExportDestination } from './object-storage';

/**
 * An analytical store a question can actually be asked of.
 *
 * Two things have to be true, and only one of them is obvious. The catalogue
 * has to exist — that is the obvious one. The prefixes also have to hold at
 * least one object, and that is the **fifth fidelity gap** this feature has
 * found in the emulator:
 *
 *     IO Error: No files found that match the pattern "s3://…/movements/**"
 *
 * The local engine builds a view over each prefix on every question, whichever
 * table is being asked about, and an empty prefix is an error rather than no
 * rows. Real Athena reads an empty partition as zero rows and answers "this
 * tenant has never been carried", which is what requirement 3.3 asks for.
 *
 * So the emulator cannot be asked about a store nothing has ever been exported
 * to, and no local test can distinguish the correct behaviour there from this
 * one. The fixture arranges around the gap rather than the adapter matching on
 * a driver's wording to paper over it — which is the mistake this repository
 * has refused four times already, for the same reason each time.
 */
export function useAnalyticalStore(): void {
  useExportDestination();

  beforeAll(async () => {
    const exports = await NestFactory.createApplicationContext(ExportModule, {
      logger: false,
    });
    try {
      const { id } = await seedTenant({ name: 'Analytical store fixture' });
      const tenant = tenantId(id);

      await seed(async (database) => {
        await database.query(
          `INSERT INTO inventory_products (id, tenant_id, sku, name, category)
           VALUES (gen_random_uuid(), $1, 'FIXTURE-001', 'A fixture', null)`,
          [tenant],
        );
        await database.query(
          `INSERT INTO inventory_locations (id, tenant_id, code, name)
           VALUES (gen_random_uuid(), $1, 'FIX-1', 'Fixture warehouse')`,
          [tenant],
        );
      });

      await asPersonInTenant(tenant, (database) =>
        database.query(
          `INSERT INTO stock_movements
             (id, tenant_id, external_id, sku, location_code, kind, quantity,
              occurred_at, recorded_at)
           VALUES ($1, $2, 'FIXTURE-1', 'FIXTURE-001', 'FIX-1', 'receipt', 1,
                   $3, $4)`,
          [
            randomUUID(),
            tenant,
            new Date('2026-01-01T00:00:00.000Z'),
            new Date('2026-01-01T00:00:00.000Z'),
          ],
        ),
      );

      await exports
        .get(RunExportUseCase)
        .execute({ correlationId: randomUUID(), onlyTenant: tenant });
    } finally {
      await exports.close();
    }

    const catalogue = new GlueCatalogue(
      loadAnalyticsConfig(process.env),
      exportDestination().bucket,
    );
    try {
      await catalogue.apply();
    } finally {
      catalogue.close();
    }
  }, 60_000);
}
