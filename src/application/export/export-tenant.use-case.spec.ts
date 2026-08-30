import { InMemoryExportSink } from '../../adapters/storage/in-memory-export-sink';
import {
  createIdentityTestContext,
  TEST_MOMENT,
  type IdentityTestContext,
} from '../../adapters/testing/identity-test-context';
import {
  catalogueKey,
  movementsKey,
  partitionDay,
  watermarkKey,
} from '../../domain/export/partition';
import type { ObjectKey } from '../../domain/export/partition';
import type { ExportedMovementRow } from '../../domain/export/exported-row';
import { transactionId, windowFrom } from '../../domain/export/window';
import type { TenantId } from '../../domain/identifiers';
import { locationCode, sku } from '../../domain/inventory/identifiers';
import type { ActorContext } from '../actor-context';
import { DeclareLocationUseCase } from '../inventory/declare-location.use-case';
import { DeclareProductUseCase } from '../inventory/declare-product.use-case';
import {
  RecordMovementsUseCase,
  type SubmittedRow,
} from '../inventory/record-movements.use-case';
import { ExportTenantUseCase } from './export-tenant.use-case';

/**
 * Three days a movement could have been recorded on. They are the *recording*
 * moments, which is what the export partitions by — deliberately later than the
 * moments the movements occurred at, so a test that partitioned by the wrong
 * one would put every row in the same file.
 */
const RECORDED = {
  first: new Date('2025-12-20T09:00:00.000Z'),
  second: new Date('2025-12-21T09:00:00.000Z'),
  third: new Date('2025-12-22T09:00:00.000Z'),
};

const OCCURRED = '2025-12-10T08:00:00.000Z';

describe('exporting one tenant', () => {
  let context: IdentityTestContext;
  let acme: TenantId;
  let sink: InMemoryExportSink;
  let exportTenant: ExportTenantUseCase;
  let record: RecordMovementsUseCase;
  let sequence = 0;

  const machineIn = (tenant: TenantId): ActorContext => ({
    kind: 'machine',
    apiKeyId: context.identifiers.apiKeyId(),
    tenantId: tenant,
    role: 'editor',
  });

  async function catalogueFor(tenant: TenantId): Promise<void> {
    await new DeclareProductUseCase(context.tenantScoped).execute({
      actor: machineIn(tenant),
      sku: sku('ACME-001'),
      name: 'A widget',
      category: 'hardware',
    });
    await new DeclareLocationUseCase(context.tenantScoped).execute({
      actor: machineIn(tenant),
      code: locationCode('WH-1'),
      name: 'The warehouse',
    });
  }

  /** One movement, recorded on the day given — one transaction, as in the table. */
  async function recordOn(
    day: Date,
    tenant: TenantId = acme,
    overrides: Partial<SubmittedRow> = {},
  ): Promise<string> {
    context.inventory.recordingMoment = () => day;
    const externalId = `ERP-${++sequence}`;
    const report = await record.execute({
      actor: machineIn(tenant),
      movements: [
        {
          externalId,
          sku: 'ACME-001',
          location: 'WH-1',
          kind: 'receipt',
          quantity: 5,
          occurredAt: OCCURRED,
          ...overrides,
        },
      ],
    });
    // A rejected fixture would leave the export with nothing to carry and the
    // assertions below would pass for the wrong reason.
    expect(report.recorded).toBe(1);
    return externalId;
  }

  const movementKeys = (written: InMemoryExportSink = sink): ObjectKey[] =>
    written.keys().filter((key) => key.startsWith('movements/'));

  const cursorOf = (tenant: TenantId = acme) =>
    context.tenantScoped.runInTenant(tenant, ({ exportCursors }) =>
      exportCursors.read('movements'),
    );

  beforeEach(async () => {
    context = createIdentityTestContext();
    acme = await context.seedTenant('Acme');
    sink = new InMemoryExportSink();
    exportTenant = new ExportTenantUseCase(
      context.tenantScoped,
      sink,
      context.clock,
    );
    record = new RecordMovementsUseCase(context.tenantScoped, context.clock);
    await catalogueFor(acme);
  });

  it('writes one object per day recorded, and confirms how far it reached', async () => {
    await recordOn(RECORDED.first);
    await recordOn(RECORDED.second);
    await recordOn(RECORDED.third);

    const carried = await exportTenant.execute({ tenantId: acme });

    expect(carried.status).toBe('carried');
    expect(carried).toMatchObject({ movements: 3, partitions: 3 });
    expect(movementKeys().sort()).toEqual([
      expect.stringContaining(
        `movements/tenant_id=${acme}/recorded_date=2025-12-20/`,
      ),
      expect.stringContaining(
        `movements/tenant_id=${acme}/recorded_date=2025-12-21/`,
      ),
      expect.stringContaining(
        `movements/tenant_id=${acme}/recorded_date=2025-12-22/`,
      ),
    ]);
    await expect(cursorOf()).resolves.toEqual({
      state: 'carried',
      through: carried.status === 'carried' ? carried.through : undefined,
    });
  });

  it('leaves a second run with nothing new writing no movement object', async () => {
    await recordOn(RECORDED.first);
    const first = await exportTenant.execute({ tenantId: acme });
    const written = movementKeys();

    const second = await exportTenant.execute({ tenantId: acme });

    expect(second).toEqual({ status: 'up-to-date' });
    expect(movementKeys()).toEqual(written);
    // The point reached is exactly where the first run left it: an up-to-date
    // run must not quietly move it past movements it never read.
    await expect(cursorOf()).resolves.toEqual(
      expect.objectContaining({
        state: 'carried',
        through: first.status === 'carried' ? first.through : undefined,
      }),
    );
  });

  it('reports a tenant up to date when its window turns out to hold nothing', async () => {
    await recordOn(RECORDED.first);
    const first = await exportTenant.execute({ tenantId: acme });
    const written = movementKeys();

    // Another tenant records something. Nothing of Acme's changed, but the
    // transaction horizon is the *database's*, so Acme's next window is a real
    // window that happens to contain none of its movements. This is what a run
    // against a live platform meets every single time.
    const globex = await context.seedTenant('Globex');
    await catalogueFor(globex);
    await recordOn(RECORDED.second, globex);

    const second = await exportTenant.execute({ tenantId: acme });

    expect(second).toEqual({ status: 'up-to-date' });
    expect(movementKeys()).toEqual(written);
    // And the point reached moves anyway: leaving it behind would make every
    // later run re-derive a window over movements it has already read.
    await expect(cursorOf()).resolves.not.toEqual(
      expect.objectContaining({
        through: first.status === 'carried' ? first.through : undefined,
      }),
    );
    await expect(cursorOf()).resolves.toMatchObject({ state: 'carried' });
  });

  it('says how far it carried the tenant, on any run that succeeded', async () => {
    await recordOn(RECORDED.first);

    await exportTenant.execute({ tenantId: acme });

    // The moment comes from the platform clock, so the one value this whole
    // pipeline reports downstream is a value a test can name.
    expect(sink.rowsAt(watermarkKey(acme))).toEqual([
      { complete_through: TEST_MOMENT },
    ]);

    // A run that finds nothing new still succeeded, and the data is still
    // complete as of now. A mark that only moved when something was carried
    // would freeze for a quiet tenant while its answers stayed current — the
    // same trap the transaction horizon set in the previous feature.
    //
    // The clock has to move for this to mean anything. Asserting the mark is
    // still *present* after a quiet run passes against an implementation that
    // never wrote it again, because the first run's mark is still sitting
    // there — which is what a probe caught this test doing.
    const later = new Date('2026-02-02T00:00:00.000Z');
    context.clock.advanceTo(later);

    const second = await exportTenant.execute({ tenantId: acme });
    expect(second).toEqual({ status: 'up-to-date' });
    expect(sink.rowsAt(watermarkKey(acme))).toEqual([
      { complete_through: later },
    ]);
  });

  it('leaves no mark for a tenant whose run failed', async () => {
    await recordOn(RECORDED.first);
    sink.failOn(catalogueKey(acme, 'products'));

    await expect(exportTenant.execute({ tenantId: acme })).rejects.toThrow();

    // Absence is the answer for a tenant nothing has been carried for, and it
    // has to stay absent when a run dies — a mark written before the work
    // finished would claim a completeness the data does not have.
    expect(sink.keys()).not.toContain(watermarkKey(acme));
  });

  it('partitions by the day a movement was recorded, not the day it occurred', async () => {
    await recordOn(RECORDED.second, acme, { occurredAt: OCCURRED });

    await exportTenant.execute({ tenantId: acme });

    const [key] = movementKeys();
    expect(key).toContain('recorded_date=2025-12-21');
    expect(key).not.toContain('2025-12-10');

    const [row] = sink.rowsAt(key) as ExportedMovementRow[];
    // Both moments, and neither of them a string: a reader that has to parse a
    // date is reading a slow CSV.
    expect(row?.occurred_at).toEqual(new Date(OCCURRED));
    expect(row?.recorded_at).toEqual(RECORDED.second);
    expect(typeof row?.quantity).toBe('number');
  });

  it('writes the whole catalogue every run, naming a renamed product once', async () => {
    await recordOn(RECORDED.first);
    await exportTenant.execute({ tenantId: acme });

    await new DeclareProductUseCase(context.tenantScoped).execute({
      actor: machineIn(acme),
      sku: sku('ACME-001'),
      name: 'A better widget',
      category: 'hardware',
    });
    await exportTenant.execute({ tenantId: acme });

    expect(sink.rowsAt(catalogueKey(acme, 'products'))).toEqual([
      { code: 'ACME-001', name: 'A better widget', category: 'hardware' },
    ]);
    expect(sink.rowsAt(catalogueKey(acme, 'locations'))).toEqual([
      { code: 'WH-1', name: 'The warehouse', category: null },
    ]);
  });

  it('gives a tenant that has declared nothing a catalogue with no entries', async () => {
    const globex = await context.seedTenant('Globex');

    await exportTenant.execute({ tenantId: globex });

    expect(sink.keys()).toEqual([
      catalogueKey(globex, 'products'),
      catalogueKey(globex, 'locations'),
      // Its mark too: a tenant with nothing declared has still been looked at,
      // and an answer about it is still current as of now.
      watermarkKey(globex),
    ]);
    expect(sink.rowsAt(catalogueKey(globex, 'products'))).toEqual([]);
  });

  it('finishes a run that failed part-way rather than repeating it', async () => {
    const attemptedFirst = await recordOn(RECORDED.first);
    const attemptedSecond = await recordOn(RECORDED.second);

    // The window the first run will take: nothing has been carried, so it runs
    // from the first identifier to the horizon as it stands now.
    const attempted = windowFrom(
      transactionId(1n),
      transactionId(context.inventory.transactionHorizon),
    );
    const secondDay = movementsKey({
      tenantId: acme,
      day: partitionDay(RECORDED.second),
      window: attempted,
    });
    sink.failOn(secondDay);

    await expect(exportTenant.execute({ tenantId: acme })).rejects.toThrow();
    await expect(cursorOf()).resolves.toEqual({
      state: 'started',
      window: expect.objectContaining({
        from: attempted.from,
        to: attempted.to,
      }) as unknown,
    });

    // Something new arrives before the retry. The replay must carry the window
    // that was recorded, not a fresh one, or the object keys change and the
    // half-written day is left beside a second copy of itself.
    await recordOn(RECORDED.third);

    const retry = new InMemoryExportSink();
    const finished = await new ExportTenantUseCase(
      context.tenantScoped,
      retry,
      context.clock,
    ).execute({ tenantId: acme });

    expect(finished).toEqual({
      status: 'carried',
      movements: 2,
      partitions: 2,
      through: attempted.to,
    });
    expect(movementKeys(retry).sort()).toEqual(
      [
        movementsKey({
          tenantId: acme,
          day: partitionDay(RECORDED.first),
          window: attempted,
        }),
        secondDay,
      ].sort(),
    );

    // Every movement the two runs wrote, once each — the third is still ahead.
    const externals = movementKeys(retry).flatMap((key) =>
      (retry.rowsAt(key) as ExportedMovementRow[]).map(
        (row) => row.external_id,
      ),
    );
    expect(externals.sort()).toEqual([attemptedFirst, attemptedSecond].sort());
  });
});
