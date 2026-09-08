import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadAnalyticsConfig } from '../../src/adapters/analytics/analytics-config';
import { GlueCatalogue } from '../../src/adapters/analytics/glue-catalogue';
import { CubeClient } from '../../src/adapters/semantic/cube-client';
import { CubeModel } from '../../src/adapters/semantic/cube-model';
import { SignedSecurityContext } from '../../src/adapters/semantic/security-context';
import { loadSemanticConfig } from '../../src/adapters/semantic/semantic-config';
import { RunExportUseCase } from '../../src/application/export/run-export.use-case';
import {
  day,
  periodFrom,
  type Period,
} from '../../src/domain/analytics/period';
import { tenantId, type TenantId } from '../../src/domain/identifiers';
import type { ModelledAnswer } from '../../src/domain/semantic/modelled-answer';
import { questionFrom } from '../../src/domain/semantic/question';
import type {
  GroupingName,
  MeasureName,
} from '../../src/domain/semantic/vocabulary';
import { ExportModule } from '../../src/export.module';
import { asPersonInTenant, seed } from './support/database';
import { seedTenant, useIntegrationDatabase } from './support/fixtures';
import {
  exportDestination,
  useExportDestination,
} from './support/object-storage';

const analytics = loadAnalyticsConfig(process.env);
const semantic = loadSemanticConfig(process.env);
const storage = exportDestination();

const AUGUST = periodFrom(day('2026-08-01'), day('2026-08-31'));

// Seeding, exporting, cataloguing and then asking an engine that polls does not
// fit in Jest's five-second default, and a composed question asks twice.
jest.setTimeout(120_000);

const INSERT = `INSERT INTO stock_movements
    (id, tenant_id, external_id, sku, location_code, kind, quantity, occurred_at, recorded_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

interface Movement {
  readonly externalId: string;
  readonly sku: string;
  readonly location: string;
  readonly kind: string;
  readonly quantity: number;
  readonly recorded: string;
  readonly occurred?: string;
}

/**
 * Composed questions, against the model, over objects the export actually
 * wrote.
 *
 * Every expectation here is computed from the movements this suite seeded
 * rather than read back from the model, because a suite that asks the model
 * what it thinks and then agrees with it has measured nothing. The numbers
 * below are arithmetic on the rows above them.
 */
describe('asking the model a composed question', () => {
  useIntegrationDatabase();
  useExportDestination();

  let context: INestApplicationContext;
  let model: CubeModel;

  beforeAll(async () => {
    context = await NestFactory.createApplicationContext(ExportModule, {
      logger: false,
    });
    model = new CubeModel(
      new CubeClient(semantic),
      new SignedSecurityContext(semantic),
      () => new Date(),
    );
  });

  afterAll(async () => {
    await context.close();
  });

  async function tenantWith(movements: readonly Movement[]): Promise<TenantId> {
    const { id } = await seedTenant();
    const tenant = tenantId(id);

    await seed(async (database) => {
      for (const sku of new Set(movements.map((each) => each.sku))) {
        await database.query(
          `INSERT INTO inventory_products (id, tenant_id, sku, name, category)
           VALUES (gen_random_uuid(), $1, $2, $3, 'hardware')`,
          [tenant, sku, `the ${sku} widget`],
        );
      }
      for (const code of new Set(movements.map((each) => each.location))) {
        await database.query(
          `INSERT INTO inventory_locations (id, tenant_id, code, name)
           VALUES (gen_random_uuid(), $1, $2, $3)`,
          [tenant, code, `the ${code} warehouse`],
        );
      }
    });

    for (const movement of movements) {
      await asPersonInTenant(tenant, (database) =>
        database.query(INSERT, [
          randomUUID(),
          tenant,
          movement.externalId,
          movement.sku,
          movement.location,
          movement.kind,
          movement.quantity,
          new Date(`${movement.occurred ?? movement.recorded}T09:00:00.000Z`),
          new Date(`${movement.recorded}T02:00:00.000Z`),
        ]),
      );
    }

    await context
      .get(RunExportUseCase)
      .execute({ correlationId: randomUUID(), onlyTenant: tenant });

    const catalogue = new GlueCatalogue(analytics, storage.bucket);
    try {
      await catalogue.apply();
    } finally {
      catalogue.close();
    }

    return tenant;
  }

  const ask = (
    tenant: TenantId,
    measures: readonly MeasureName[],
    groupings: readonly GroupingName[] = [],
    period: Period = AUGUST,
    by: 'recorded' | 'occurred' = 'recorded',
  ): Promise<ModelledAnswer> =>
    model.askAs(tenant, (questions) =>
      questions.ask(questionFrom({ measures, groupings, period, by })),
    );

  const answeredRows = (answer: ModelledAnswer) => {
    expect(answer.state).toBe('answered');
    if (answer.state !== 'answered') {
      throw new Error('unreachable');
    }
    return answer;
  };

  const asNumbers = (
    answer: ModelledAnswer,
    column: string,
  ): readonly number[] =>
    answeredRows(answer).rows.map((row) => Number(row.values[column]));

  const ACME: readonly Movement[] = [
    {
      externalId: 'ERP-1',
      sku: 'W-1',
      location: 'WH-1',
      kind: 'receipt',
      quantity: 10,
      recorded: '2026-08-27',
    },
    {
      externalId: 'ERP-2',
      sku: 'W-1',
      location: 'WH-1',
      kind: 'sale',
      quantity: -4,
      recorded: '2026-08-27',
    },
    {
      externalId: 'ERP-3',
      sku: 'W-2',
      location: 'WH-2',
      kind: 'receipt',
      quantity: 6,
      recorded: '2026-08-28',
    },
  ];

  /**
   * Read from the objects, and asserted to be.
   *
   * Every question in this suite names a product, which the prepared answer
   * cannot serve because the rollup carries no join. That is deliberate: what
   * is prepared, when it rebuilds and what it says about itself belong to the
   * preparation suite, and a suite that quietly started reading a rollup would
   * be testing something else under the same name. Asserting `servedFrom` is
   * what makes that a failure rather than a silent change of subject.
   */
  it('answers a combination nobody wrote a definition for', async () => {
    const acme = await tenantWith(ACME);

    const answer = await ask(
      acme,
      ['net_quantity', 'movement_count'],
      ['kind', 'product'],
    );

    expect(answeredRows(answer).servedFrom).toBe('exported-objects');

    const rows = answeredRows(answer).rows.map((row) => row.values);
    // W-1 received 10 and sold 4; W-2 received 6. Three rows, and the numbers
    // are arithmetic on the movements above rather than anything read back.
    expect(rows).toHaveLength(3);
    expect(
      rows.map((row) => Number(row.net_quantity)).sort((a, b) => a - b),
    ).toEqual([-4, 6, 10]);
    expect(rows.map((row) => Number(row.movement_count))).toEqual([1, 1, 1]);
  });

  it('keeps on hand the all-time sum under a period that excludes movements', async () => {
    const acme = await tenantWith(ACME);

    const onlyTheLastDay = periodFrom(day('2026-08-28'), day('2026-08-28'));
    const answer = await ask(
      acme,
      ['net_quantity', 'on_hand_quantity'],
      ['product'],
      onlyTheLastDay,
    );

    // The period holds one movement: W-2 receiving 6. W-1 moved only on the
    // 27th and so has no net quantity here at all — and still appears, with the
    // whole of its on-hand, because that measure ignores the period while the
    // rest of the question keeps it. Two products in one answer, each measure
    // answering a different span, which is the requirement stated as data.
    const rows = answeredRows(answer).rows.map((row) => row.values);
    const byProduct = new Map(
      rows.map((row) => [String(row.product_code), row]),
    );

    expect([...byProduct.keys()].sort()).toEqual(['W-1', 'W-2']);
    expect(Number(byProduct.get('W-2')?.net_quantity)).toBe(6);
    expect(byProduct.get('W-1')?.net_quantity).toBeNull();

    // 10 - 4 for W-1, 6 for W-2: every movement ever, under a period holding one.
    expect(Number(byProduct.get('W-1')?.on_hand_quantity)).toBe(6);
    expect(Number(byProduct.get('W-2')?.on_hand_quantity)).toBe(6);
  });

  it('labels a product and a location by code and by current name', async () => {
    const acme = await tenantWith(ACME);

    const byProduct = answeredRows(
      await ask(acme, ['net_quantity'], ['product']),
    );
    expect(
      byProduct.rows.map((row) => [
        row.values.product_code,
        row.values.product_name,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['W-1', 'the W-1 widget'],
        ['W-2', 'the W-2 widget'],
      ]),
    );

    const byLocation = answeredRows(
      await ask(acme, ['movement_count'], ['location']),
    );
    expect(
      byLocation.rows.map((row) => [
        row.values.location_code,
        row.values.location_name,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['WH-1', 'the WH-1 warehouse'],
        ['WH-2', 'the WH-2 warehouse'],
      ]),
    );
  });

  it('reads by the moment the question names, which backdating tells apart', async () => {
    const backdated = await tenantWith([
      {
        externalId: 'ERP-9',
        sku: 'W-1',
        location: 'WH-1',
        kind: 'receipt',
        quantity: 7,
        recorded: '2026-08-20',
        occurred: '2026-07-15',
      },
    ]);

    const august = periodFrom(day('2026-08-01'), day('2026-08-31'));

    const byRecorded = await ask(
      backdated,
      ['net_quantity'],
      ['product'],
      august,
    );
    const byOccurred = await ask(
      backdated,
      ['net_quantity'],
      ['product'],
      august,
      'occurred',
    );

    // Recorded in August, occurred in July. The same movement, in one period
    // and not the other, and only the moment read by decides which.
    expect(answeredRows(byRecorded).servedFrom).toBe('exported-objects');
    expect(asNumbers(byRecorded, 'net_quantity')).toEqual([7]);
    expect(answeredRows(byOccurred).rows).toEqual([]);
  });

  it('answers a period with nothing in it, rather than refusing it', async () => {
    const acme = await tenantWith(ACME);

    const quiet = periodFrom(day('2026-08-01'), day('2026-08-02'));
    const answer = await ask(acme, ['net_quantity'], ['product'], quiet);

    expect(answeredRows(answer).rows).toEqual([]);
  });

  it('says a tenant was never carried, which is not an empty answer', async () => {
    await tenantWith(ACME);
    const { id } = await seedTenant();

    expect(await ask(tenantId(id), ['net_quantity'])).toEqual({
      state: 'never-exported',
    });
  });

  /**
   * The moment reported is that tenant's own watermark, and never later.
   *
   * Read from the export's record of what it carried rather than from the
   * clock: an answer labelled "now" would look current and be wrong every time
   * the export is behind. For an answer read from the objects the two bounds
   * agree, so this is the watermark — which the export wrote moments ago.
   */
  it('reports the moment this tenant is complete through, and no later', async () => {
    const before = new Date();
    const acme = await tenantWith(ACME);
    const after = new Date();

    const answer = answeredRows(await ask(acme, ['net_quantity'], ['product']));

    expect(answer.servedFrom).toBe('exported-objects');
    expect(answer.completeThrough.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
    // Never later than the moment the export finished, which is the whole
    // promise: an answer may understate its currency and may never overstate it.
    expect(answer.completeThrough.getTime()).toBeLessThanOrEqual(
      after.getTime(),
    );
  });
});
