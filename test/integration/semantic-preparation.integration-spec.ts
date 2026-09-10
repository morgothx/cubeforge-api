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
import type { GroupingName } from '../../src/domain/semantic/vocabulary';
import { ExportModule } from '../../src/export.module';
import {
  asPersonInTenant,
  closeDatabaseConnections,
  resetDatabase,
  seed,
} from './support/database';
import { seedTenant } from './support/fixtures';
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
  VALUES ($1, $2, $3, 'W-1', 'WH-1', 'receipt', $4, $5, $6)`;

/**
 * What was prepared, and what it says about itself.
 *
 * The claim this suite exists to make falsifiable is that a prepared answer is
 * *used* — 6.2 — and the only honest way to know is to ask the layer where the
 * answer came from rather than to time it. A stopwatch cannot tell a rollup from
 * a warm cache from a quiet afternoon, so a fast answer is evidence of nothing.
 */
describe('answers prepared before they are asked for', () => {
  useExportDestination();

  let context: INestApplicationContext;
  let model: CubeModel;
  let acme: TenantId;

  /**
   * One tenant for the whole suite, and the database reset once rather than
   * between tests.
   *
   * These tests are about a rollup that carries state across questions on
   * purpose, so wiping the rows it was built from between them would be
   * arranging for the thing under test to be absent. The last test adds a
   * movement to this same tenant, which is the point: the export it triggers is
   * what the rebuild has to notice.
   */
  beforeAll(async () => {
    await resetDatabase();

    context = await NestFactory.createApplicationContext(ExportModule, {
      logger: false,
    });
    model = new CubeModel(
      new CubeClient(semantic),
      new SignedSecurityContext(semantic),
      () => new Date(),
    );

    acme = await tenantCarrying(11);

    // The precondition, waited for once and named for what it is: the first
    // build after an empty export bucket is slower than any later one, and
    // that is a fact about a cold store rather than anything these tests are
    // asserting.
    await untilPrepared(acme, 11);
  });

  afterAll(async () => {
    await context.close();
    await closeDatabaseConnections();
  });

  async function exportOf(tenant: TenantId): Promise<void> {
    await context
      .get(RunExportUseCase)
      .execute({ correlationId: randomUUID(), onlyTenant: tenant });

    const catalogue = new GlueCatalogue(analytics, storage.bucket);
    try {
      await catalogue.apply();
    } finally {
      catalogue.close();
    }
  }

  async function moving(
    tenant: TenantId,
    externalId: string,
    quantity: number,
  ): Promise<void> {
    await asPersonInTenant(tenant, (database) =>
      database.query(INSERT, [
        randomUUID(),
        tenant,
        externalId,
        quantity,
        new Date('2026-08-10T09:00:00.000Z'),
        new Date('2026-08-10T02:00:00.000Z'),
      ]),
    );
  }

  async function tenantCarrying(quantity: number): Promise<TenantId> {
    const { id } = await seedTenant();
    const tenant = tenantId(id);

    await seed(async (database) => {
      await database.query(
        `INSERT INTO inventory_products (id, tenant_id, sku, name, category)
         VALUES (gen_random_uuid(), $1, 'W-1', 'a widget', 'hardware')`,
        [tenant],
      );
      await database.query(
        `INSERT INTO inventory_locations (id, tenant_id, code, name)
         VALUES (gen_random_uuid(), $1, 'WH-1', 'a warehouse')`,
        [tenant],
      );
    });

    await moving(tenant, 'ERP-1', quantity);
    await exportOf(tenant);
    return tenant;
  }

  /** The composition the rollup was built for. */
  const PREPARED: readonly GroupingName[] = ['kind', 'recorded_day'];
  /** One it was not: the rollup carries no join, so this falls to the engine. */
  const NOT_PREPARED: readonly GroupingName[] = ['product'];

  const ask = (
    tenant: TenantId,
    groupings: readonly GroupingName[],
  ): Promise<ModelledAnswer> =>
    model.askAs(tenant, (questions) =>
      questions.ask(
        questionFrom({
          measures: ['net_quantity'],
          groupings,
          period: AUGUST,
          by: 'recorded',
        }),
      ),
    );

  const totalIn = (answer: ModelledAnswer): number => {
    if (answer.state !== 'answered') {
      throw new Error(`expected an answer, got ${answer.state}`);
    }
    return answer.rows.reduce(
      (running, row) => running + Number(row.values.net_quantity),
      0,
    );
  };

  const untilPrepared = (tenant: TenantId, total: number) =>
    untilItReflects(
      `a prepared answer totalling ${total}`,
      () => ask(tenant, PREPARED),
      (latest) =>
        latest.state === 'answered' &&
        latest.servedFrom === 'prepared' &&
        totalIn(latest) === total,
    );

  it('answers the prepared question from what was prepared, and says so', async () => {
    const answer = await ask(acme, PREPARED);

    expect(answer.state === 'answered' && answer.servedFrom).toBe('prepared');
    expect(totalIn(answer)).toBe(11);
  });

  /**
   * The other provenance, for the same tenant and the same measure.
   *
   * Two answers differing only in what was asked, one from the store and one
   * from the objects, is what makes the reported provenance a fact about the
   * system rather than a constant somebody set. Both say the same number, so
   * the difference is where it came from and nothing else.
   */
  it('answers a composition nobody prepared from the objects, and says that', async () => {
    const prepared = await ask(acme, PREPARED);
    const read = await ask(acme, NOT_PREPARED);

    expect(prepared.state === 'answered' && prepared.servedFrom).toBe(
      'prepared',
    );
    expect(read.state === 'answered' && read.servedFrom).toBe(
      'exported-objects',
    );
    expect(totalIn(read)).toBe(totalIn(prepared));
  });

  /**
   * The rebuild, observed after an export and not after a restart.
   *
   * Nothing here asks for it: the rollup's refresh key is the export's own
   * watermark, so finishing an export is the whole of the request. The
   * observable is the prepared answer's own number changing — a rollup that
   * never rebuilt would keep reporting the old total, from the store, forever,
   * and this test would sit here until its deadline saying so.
   */
  it('rebuilds what was prepared after an export moves the watermark', async () => {
    const before = await ask(acme, PREPARED);
    expect(totalIn(before)).toBe(11);

    await moving(acme, 'ERP-2', 6);
    await exportOf(acme);

    const after = await untilPrepared(acme, 17);

    expect(after.state === 'answered' && after.servedFrom).toBe('prepared');
    expect(totalIn(after)).toBe(17);
  });
});
