import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadAnalyticsConfig } from '../../src/adapters/analytics/analytics-config';
import { AthenaAnalytics } from '../../src/adapters/analytics/athena-analytics';
import { RunExportUseCase } from '../../src/application/export/run-export.use-case';
import type {
  AnalyticalAnswer,
  MovementsOnDayEntry,
} from '../../src/domain/analytics/answer';
import { day, periodFrom } from '../../src/domain/analytics/period';
import { tenantId, type TenantId } from '../../src/domain/identifiers';
import { ExportModule } from '../../src/export.module';
import { useAnalyticalStore } from './support/analytics';
import { asPersonInTenant, seed } from './support/database';
import { seedTenant, useIntegrationDatabase } from './support/fixtures';

const analytics = loadAnalyticsConfig(process.env);

const AUGUST = periodFrom(day('2026-08-01'), day('2026-08-31'));
const A_QUIET_JULY = periodFrom(day('2026-07-01'), day('2026-07-31'));

// Seeding, exporting twice and asking a polled engine several times does not
// fit Jest's five-second default, as the analytics suites before this one found
// out the hard way.
jest.setTimeout(60_000);

/**
 * What a chart receives, and whether it has to repair any of it.
 *
 * Everything here is asserted against the **real engine over real objects**,
 * because that is the only place the claims can be false. The decoder is unit
 * tested and will turn text into numbers all day; what only this can show is
 * that the text arriving from the engine is the text the decoder was written
 * for — the local engine reports every column as `varchar`, so a result typed
 * from what it says would have passed a unit test and failed here.
 */
describe('drawing an answer without repairing it', () => {
  useIntegrationDatabase();
  useAnalyticalStore();

  let exports: INestApplicationContext;
  let subject: AthenaAnalytics;

  beforeAll(async () => {
    exports = await NestFactory.createApplicationContext(ExportModule, {
      logger: false,
    });
    subject = new AthenaAnalytics(analytics);
  });

  afterAll(async () => {
    subject.close();
    await exports.close();
  });

  /**
   * A tenant with a catalogue and nothing carried out of the database yet.
   *
   * The name is generated rather than chosen: tenant names are unique
   * platform-wide, and a fixed one collides with whatever the previous suite
   * left behind.
   */
  async function aTenant(): Promise<TenantId> {
    const { id } = await seedTenant({ name: `answers-${randomUUID()}` });
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

    return tenant;
  }

  async function record(
    tenant: TenantId,
    movement: {
      externalId: string;
      kind: string;
      quantity: number;
      recorded: string;
    },
  ): Promise<void> {
    await asPersonInTenant(tenant, (database) =>
      database.query(
        `INSERT INTO stock_movements
           (id, tenant_id, external_id, sku, location_code, kind, quantity,
            occurred_at, recorded_at)
         VALUES ($1, $2, $3, 'ACME-001', 'WH-1', $4, $5, $6, $7)`,
        [
          randomUUID(),
          tenant,
          movement.externalId,
          movement.kind,
          movement.quantity,
          new Date('2026-08-01T09:00:00.000Z'),
          new Date(`${movement.recorded}T02:00:00.000Z`),
        ],
      ),
    );
  }

  const carry = (tenant: TenantId): Promise<unknown> =>
    exports
      .get(RunExportUseCase)
      .execute({ correlationId: randomUUID(), onlyTenant: tenant });

  /** Narrows the union, and fails the test rather than the next line if it cannot. */
  function answeredEntries<Entry>(
    answer: AnalyticalAnswer<Entry>,
  ): readonly Entry[] {
    if (answer.state !== 'answered') {
      throw new Error(`expected an answer, got ${answer.state}`);
    }
    return answer.entries;
  }

  function completeThrough<Entry>(answer: AnalyticalAnswer<Entry>): Date {
    if (answer.state !== 'answered') {
      throw new Error(`expected an answer, got ${answer.state}`);
    }
    return answer.completeThrough;
  }

  it('says a tenant has never been carried, rather than reporting a moment', async () => {
    const tenant = await aTenant();
    await record(tenant, {
      externalId: 'ERP-1',
      kind: 'receipt',
      quantity: 5,
      recorded: '2026-08-27',
    });

    // Recorded but not exported. The data exists and has simply not arrived,
    // which is a different fact from "nothing happened" and must not be dressed
    // up as one — an answer with a default moment would draw a confident empty
    // chart for a tenant whose numbers are merely still in the database.
    const answer = await subject.askAs(tenant, (q) => q.movementsByDay(AUGUST));
    const stock = await subject.askAs(tenant, (q) => q.stockOnHand());

    expect(answer.state).toBe('never-exported');
    expect(stock.state).toBe('never-exported');
  });

  it('hands over quantities as numbers and moments as moments', async () => {
    const tenant = await aTenant();
    await record(tenant, {
      externalId: 'ERP-1',
      kind: 'receipt',
      quantity: 12,
      recorded: '2026-08-27',
    });
    await carry(tenant);

    const answer = await subject.askAs(tenant, (q) => q.movementsByDay(AUGUST));
    const [entry] = answeredEntries(answer);
    const [held] = answeredEntries(
      await subject.askAs(tenant, (q) => q.stockOnHand()),
    );

    // The engine sends every value as text and reports every column as
    // `varchar`. Nothing downstream should have to know that.
    expect(typeof entry.quantity).toBe('number');
    expect(entry.quantity).toBe(12);
    expect(typeof held.onHand).toBe('number');
    expect(held.onHand).toBe(12);
    expect(typeof entry.day).toBe('string');
    expect(entry.day).toBe('2026-08-27');

    const moment = completeThrough(answer);
    expect(moment).toBeInstanceOf(Date);
    expect(Number.isNaN(moment.getTime())).toBe(false);
  });

  it('answers a period with no activity with no entries at all', async () => {
    const tenant = await aTenant();
    await record(tenant, {
      externalId: 'ERP-1',
      kind: 'receipt',
      quantity: 7,
      recorded: '2026-08-27',
    });
    await carry(tenant);

    const july = await subject.askAs(tenant, (q) =>
      q.movementsByDay(A_QUIET_JULY),
    );

    // Answered, not refused, and not "never carried". A chart asking about a
    // quiet month wants an empty chart; an error there would make "nothing
    // happened" indistinguishable from "something broke".
    expect(july.state).toBe('answered');
    expect(answeredEntries(july)).toEqual([]);
    expect(completeThrough(july)).toBeInstanceOf(Date);
  });

  it('orders the entries of the same question the same way every time', async () => {
    const tenant = await aTenant();
    // Recorded out of order, and of two kinds on one day, so a statement
    // without an explicit order has something to get wrong.
    await record(tenant, {
      externalId: 'ERP-3',
      kind: 'sale',
      quantity: -2,
      recorded: '2026-08-28',
    });
    await record(tenant, {
      externalId: 'ERP-1',
      kind: 'receipt',
      quantity: 9,
      recorded: '2026-08-27',
    });
    await record(tenant, {
      externalId: 'ERP-2',
      kind: 'sale',
      quantity: -3,
      recorded: '2026-08-27',
    });
    await carry(tenant);

    const asked = async (): Promise<readonly MovementsOnDayEntry[]> =>
      answeredEntries(
        await subject.askAs(tenant, (q) => q.movementsByDay(AUGUST)),
      );

    const once = await asked();
    const again = await asked();

    expect(once).toEqual(again);
    // And it is the order the statement declares, rather than whatever order
    // two runs happened to agree on.
    expect(once).toEqual([
      { day: '2026-08-27', kind: 'receipt', quantity: 9 },
      { day: '2026-08-27', kind: 'sale', quantity: -3 },
      { day: '2026-08-28', kind: 'sale', quantity: -2 },
    ]);
  });

  it('leaves out activity recorded after the moment it reports, and says so again after the next run', async () => {
    const tenant = await aTenant();
    await record(tenant, {
      externalId: 'ERP-1',
      kind: 'receipt',
      quantity: 4,
      recorded: '2026-08-27',
    });
    await carry(tenant);

    const first = await subject.askAs(tenant, (q) => q.movementsByDay(AUGUST));
    const firstMoment = completeThrough(first);
    expect(answeredEntries(first)).toEqual([
      { day: '2026-08-27', kind: 'receipt', quantity: 4 },
    ]);

    // Recorded, and deliberately not carried.
    await record(tenant, {
      externalId: 'ERP-2',
      kind: 'receipt',
      quantity: 100,
      recorded: '2026-08-28',
    });

    const between = await subject.askAs(tenant, (q) =>
      q.movementsByDay(AUGUST),
    );

    // The answer is complete through a moment, and nothing after that moment
    // may appear in it — including something the transactional database
    // already holds. This is the whole reason the answer carries a date.
    expect(answeredEntries(between)).toEqual(answeredEntries(first));
    expect(completeThrough(between)).toEqual(firstMoment);

    await carry(tenant);
    const after = await subject.askAs(tenant, (q) => q.movementsByDay(AUGUST));

    expect(answeredEntries(after)).toEqual([
      { day: '2026-08-27', kind: 'receipt', quantity: 4 },
      { day: '2026-08-28', kind: 'receipt', quantity: 100 },
    ]);
    // The mark moved, which is what makes the previous assertion mean "not
    // yet" rather than "never". A watermark that never advanced would satisfy
    // every check above and freeze the platform's answers for ever.
    expect(completeThrough(after).getTime()).toBeGreaterThan(
      firstMoment.getTime(),
    );
  });
});
