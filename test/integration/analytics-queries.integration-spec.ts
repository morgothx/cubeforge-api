import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { loadAnalyticsConfig } from '../../src/adapters/analytics/analytics-config';
import { AthenaAnalytics } from '../../src/adapters/analytics/athena-analytics';
import { GlueCatalogue } from '../../src/adapters/analytics/glue-catalogue';
import { RunExportUseCase } from '../../src/application/export/run-export.use-case';
import { day, periodFrom } from '../../src/domain/analytics/period';
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

const AUGUST = periodFrom(day('2026-08-01'), day('2026-08-31'));

// Seeding two tenants, exporting both, applying the catalogue and then asking
// four questions of an engine that polls is honest work, and it does not fit in
// Jest's five-second default. It fitted while these tests used one tenant, which
// is how it arrived as an intermittent failure rather than an obvious one.
jest.setTimeout(60_000);

const INSERT = `INSERT INTO stock_movements
    (id, tenant_id, external_id, sku, location_code, kind, quantity, occurred_at, recorded_at)
  VALUES ($1, $2, $3, 'ACME-001', 'WH-1', $4, $5, $6, $7)`;

/**
 * The statements, against the engine, over objects the export actually wrote.
 *
 * Two tenants made to look alike on purpose — the same product, the same
 * location, movements on the same days — so that nothing but the tenant tells
 * their rows apart and a leak shows up as the other tenant's number.
 */
describe('asking the exported data a question', () => {
  useIntegrationDatabase();
  useExportDestination();

  let context: INestApplicationContext;
  let subject: AthenaAnalytics;

  beforeAll(async () => {
    context = await NestFactory.createApplicationContext(ExportModule, {
      logger: false,
    });
    subject = new AthenaAnalytics(analytics);
  });

  afterAll(async () => {
    await context.close();
    subject.close();
  });

  async function tenantWith(
    movements: readonly {
      externalId: string;
      kind: string;
      quantity: number;
      recorded: string;
    }[],
  ): Promise<TenantId> {
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
    for (const movement of movements) {
      await asPersonInTenant(tenant, (database) =>
        database.query(INSERT, [
          randomUUID(),
          tenant,
          movement.externalId,
          movement.kind,
          movement.quantity,
          new Date('2026-08-01T09:00:00.000Z'),
          new Date(`${movement.recorded}T02:00:00.000Z`),
        ]),
      );
    }
    await context
      .get(RunExportUseCase)
      .execute({ correlationId: randomUUID(), onlyTenant: tenant });
    return tenant;
  }

  async function catalogued(): Promise<void> {
    const catalogue = new GlueCatalogue(analytics, storage.bucket);
    try {
      await catalogue.apply();
    } finally {
      catalogue.close();
    }
  }

  it('answers what moved, day by day, for the tenant the seam bound', async () => {
    const acme = await tenantWith([
      {
        externalId: 'ERP-1',
        kind: 'receipt',
        quantity: 10,
        recorded: '2026-08-27',
      },
      {
        externalId: 'ERP-2',
        kind: 'sale',
        quantity: -4,
        recorded: '2026-08-27',
      },
      {
        externalId: 'ERP-3',
        kind: 'receipt',
        quantity: 6,
        recorded: '2026-08-28',
      },
    ]);
    await catalogued();

    const answer = await subject.askAs(acme, (q) => q.movementsByDay(AUGUST));

    expect(answer.state).toBe('answered');
    expect(answer.state === 'answered' && answer.entries).toEqual([
      { day: '2026-08-27', kind: 'receipt', quantity: 10 },
      { day: '2026-08-27', kind: 'sale', quantity: -4 },
      { day: '2026-08-28', kind: 'receipt', quantity: 6 },
    ]);
  });

  it('gives two look-alike tenants their own numbers', async () => {
    const acme = await tenantWith([
      {
        externalId: 'ERP-1',
        kind: 'receipt',
        quantity: 10,
        recorded: '2026-08-27',
      },
    ]);
    const globex = await tenantWith([
      {
        externalId: 'ERP-1',
        kind: 'receipt',
        quantity: 77,
        recorded: '2026-08-27',
      },
    ]);
    await catalogued();

    const forAcme = await subject.askAs(acme, (q) => q.movementsByDay(AUGUST));
    const forGlobex = await subject.askAs(globex, (q) =>
      q.movementsByDay(AUGUST),
    );

    // The quantities are what tells them apart: a statement missing its tenant
    // would sum both and hand each of them the same wrong number.
    expect(forAcme.state === 'answered' && forAcme.entries).toEqual([
      { day: '2026-08-27', kind: 'receipt', quantity: 10 },
    ]);
    expect(forGlobex.state === 'answered' && forGlobex.entries).toEqual([
      { day: '2026-08-27', kind: 'receipt', quantity: 77 },
    ]);
  });

  it('answers only within the period it was asked about', async () => {
    const acme = await tenantWith([
      {
        externalId: 'ERP-1',
        kind: 'receipt',
        quantity: 10,
        recorded: '2026-08-27',
      },
      {
        externalId: 'ERP-2',
        kind: 'receipt',
        quantity: 5,
        recorded: '2026-09-03',
      },
    ]);
    await catalogued();

    const answer = await subject.askAs(acme, (q) => q.movementsByDay(AUGUST));

    expect(answer.state === 'answered' && answer.entries).toEqual([
      { day: '2026-08-27', kind: 'receipt', quantity: 10 },
    ]);
  });

  it('says how far the answer reaches, from the mark the export left', async () => {
    const acme = await tenantWith([
      {
        externalId: 'ERP-1',
        kind: 'receipt',
        quantity: 1,
        recorded: '2026-08-27',
      },
    ]);
    await catalogued();

    const answer = await subject.askAs(acme, (q) => q.movementsByDay(AUGUST));

    expect(
      answer.state === 'answered' && answer.completeThrough,
    ).toBeInstanceOf(Date);
  });

  it('answers a tenant nothing has been carried for as never exported', async () => {
    const { id } = await seedTenant();
    await catalogued();

    const answer = await subject.askAs(tenantId(id), (q) =>
      q.movementsByDay(AUGUST),
    );

    // No mark, so no claim about how current anything is — and emphatically not
    // an empty answer, which would read as "nothing moved".
    expect(answer).toEqual({ state: 'never-exported' });
  });

  it('answers what is on hand, named as the catalogue names it', async () => {
    const acme = await tenantWith([
      {
        externalId: 'ERP-1',
        kind: 'receipt',
        quantity: 12,
        recorded: '2026-08-27',
      },
      {
        externalId: 'ERP-2',
        kind: 'sale',
        quantity: -4,
        recorded: '2026-08-28',
      },
    ]);
    await catalogued();

    const answer = await subject.askAs(acme, (q) => q.stockOnHand());

    // The total is what the movements sum to, and the name comes from the
    // exported catalogue — which is the reason the catalogue is exported at
    // all. A chart resolving its own labels would put that load back on the
    // database this whole pipeline exists to keep out of the way.
    expect(answer.state === 'answered' && answer.entries).toEqual([
      { sku: 'ACME-001', name: 'A widget', onHand: 8 },
    ]);
  });

  it('names a product renamed since the last export by its new name', async () => {
    const acme = await tenantWith([
      {
        externalId: 'ERP-1',
        kind: 'receipt',
        quantity: 3,
        recorded: '2026-08-27',
      },
    ]);

    await seed((database) =>
      database.query(
        `UPDATE inventory_products SET name = $2 WHERE tenant_id = $1`,
        [acme, 'A better widget'],
      ),
    );
    await context
      .get(RunExportUseCase)
      .execute({ correlationId: randomUUID(), onlyTenant: acme });
    await catalogued();

    const answer = await subject.askAs(acme, (q) => q.stockOnHand());

    // Once, and currently. The catalogue is replaced whole every run precisely
    // so a reader never has to choose between two names for one product.
    expect(answer.state === 'answered' && answer.entries).toEqual([
      { sku: 'ACME-001', name: 'A better widget', onHand: 3 },
    ]);
  });

  it('gives two look-alike tenants their own totals', async () => {
    const acme = await tenantWith([
      {
        externalId: 'ERP-1',
        kind: 'receipt',
        quantity: 5,
        recorded: '2026-08-27',
      },
    ]);
    const globex = await tenantWith([
      {
        externalId: 'ERP-1',
        kind: 'receipt',
        quantity: 91,
        recorded: '2026-08-27',
      },
    ]);
    await catalogued();

    const forAcme = await subject.askAs(acme, (q) => q.stockOnHand());
    const forGlobex = await subject.askAs(globex, (q) => q.stockOnHand());

    // Two tables are joined here, so there are two places the tenant could be
    // lost rather than one.
    expect(forAcme.state === 'answered' && forAcme.entries).toEqual([
      { sku: 'ACME-001', name: 'A widget', onHand: 5 },
    ]);
    expect(forGlobex.state === 'answered' && forGlobex.entries).toEqual([
      { sku: 'ACME-001', name: 'A widget', onHand: 91 },
    ]);
  });

  it('answers a tenant never carried as never exported, whichever question', async () => {
    const { id } = await seedTenant();
    await catalogued();

    await expect(
      subject.askAs(tenantId(id), (q) => q.stockOnHand()),
    ).resolves.toEqual({ state: 'never-exported' });
  });

  it('refuses a tenant identifier that is not one', async () => {
    await expect(
      subject.askAs(tenantId('../elsewhere'), (q) => q.movementsByDay(AUGUST)),
    ).rejects.toThrow('tenant identifier');
  });
});
