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
import { day, periodFrom } from '../../src/domain/analytics/period';
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
import { untilItReflects } from './support/semantic';

const analytics = loadAnalyticsConfig(process.env);
const semantic = loadSemanticConfig(process.env);
const storage = exportDestination();

const AUGUST = periodFrom(day('2026-08-01'), day('2026-08-31'));

jest.setTimeout(300_000);

const INSERT = `INSERT INTO stock_movements
    (id, tenant_id, external_id, sku, location_code, kind, quantity, occurred_at, recorded_at)
  VALUES ($1, $2, $3, 'SHARED-1', 'SHARED-WH', 'receipt', $4, $5, $6)`;

/**
 * Two tenants, the same question, both ways it can be answered.
 *
 * They are made to look alike on purpose — the same product code, the same
 * location, movements on the same day — so that nothing but the tenant tells
 * their rows apart and a leak shows up as the other tenant's number rather than
 * as an error.
 *
 * **Both ways matters.** A prepared answer is a second way to read and
 * therefore a second way to leak, and the two are confined by the same act
 * rather than by two mechanisms that could disagree. A suite that only asked
 * the engine would pass while the prepared rows were shared by everyone.
 */
describe('two tenants asking the same question', () => {
  useIntegrationDatabase();
  useExportDestination();

  let context: INestApplicationContext;
  let model: CubeModel;
  let acme: TenantId;
  let globex: TenantId;

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

  async function tenantMoving(quantity: number): Promise<TenantId> {
    const { id } = await seedTenant();
    const tenant = tenantId(id);

    await seed(async (database) => {
      await database.query(
        `INSERT INTO inventory_products (id, tenant_id, sku, name, category)
         VALUES (gen_random_uuid(), $1, 'SHARED-1', 'a shared code', 'hardware')`,
        [tenant],
      );
      await database.query(
        `INSERT INTO inventory_locations (id, tenant_id, code, name)
         VALUES (gen_random_uuid(), $1, 'SHARED-WH', 'a shared code')`,
        [tenant],
      );
    });

    await asPersonInTenant(tenant, (database) =>
      database.query(INSERT, [
        randomUUID(),
        tenant,
        `ERP-${quantity}`,
        quantity,
        new Date('2026-08-10T09:00:00.000Z'),
        new Date('2026-08-10T02:00:00.000Z'),
      ]),
    );

    await context
      .get(RunExportUseCase)
      .execute({ correlationId: randomUUID(), onlyTenant: tenant });

    return tenant;
  }

  beforeEach(async () => {
    // Deliberately different quantities, so one tenant's answer could never be
    // mistaken for the other's by coincidence.
    acme = await tenantMoving(11);
    globex = await tenantMoving(97);

    const catalogue = new GlueCatalogue(analytics, storage.bucket);
    try {
      await catalogue.apply();
    } finally {
      catalogue.close();
    }
  });

  const ask = (
    tenant: TenantId,
    groupings: readonly GroupingName[],
    measures: readonly MeasureName[] = ['net_quantity'],
  ): Promise<ModelledAnswer> =>
    model.askAs(tenant, (questions) =>
      questions.ask(
        questionFrom({ measures, groupings, period: AUGUST, by: 'recorded' }),
      ),
    );

  const quantitiesIn = (answer: ModelledAnswer): readonly number[] => {
    if (answer.state !== 'answered') {
      throw new Error(`expected an answer, got ${answer.state}`);
    }
    return answer.rows.map((row) => Number(row.values.net_quantity));
  };

  /**
   * Read from the objects: the composition names a product, which the prepared
   * answer cannot serve because the rollup carries no join.
   */
  it('answers each tenant its own rows when the engine reads them', async () => {
    const mine = await ask(acme, ['product']);
    const theirs = await ask(globex, ['product']);

    expect(mine.state === 'answered' && mine.servedFrom).toBe(
      'exported-objects',
    );
    expect(quantitiesIn(mine)).toEqual([11]);
    expect(quantitiesIn(theirs)).toEqual([97]);
  });

  /**
   * Served from what was prepared: the composition is exactly the rollup's.
   *
   * The prepared rows carry `tenant_id` and are confined by the same filter the
   * rewrite adds to a direct read — one mechanism, applied to two places,
   * rather than two mechanisms that could disagree. Two that disagree is a leak
   * nobody sees until there is a second tenant.
   */
  it('answers each tenant its own rows when what was prepared answers them', async () => {
    const mine = await untilItReflects(
      "this tenant's movements in what was prepared",
      () => ask(acme, ['kind', 'recorded_day']),
      (latest) =>
        latest.state === 'answered' &&
        latest.servedFrom === 'prepared' &&
        latest.rows.length > 0,
    );
    const theirs = await ask(globex, ['kind', 'recorded_day']);

    expect(quantitiesIn(mine)).toEqual([11]);
    expect(theirs.state === 'answered' && theirs.servedFrom).toBe('prepared');
    expect(quantitiesIn(theirs)).toEqual([97]);
  });

  /**
   * There is no third test here, and its absence is deliberate.
   *
   * One asserting "never sees the other's number" would add nothing: the two
   * above assert the exact rows, which already excludes the other tenant's
   * quantity, an answer carrying both, and an answer carrying none. A filter
   * that matched everything and a filter that matched nothing both fail them.
   * A test that can only pass when a stronger one already passed is a line
   * count, not a check.
   */
});
