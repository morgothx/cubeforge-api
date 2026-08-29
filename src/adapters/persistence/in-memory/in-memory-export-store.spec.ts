import { transactionId, windowFrom } from '../../../domain/export/window';
import { tenantId } from '../../../domain/identifiers';
import {
  externalMovementId,
  locationCode,
  sku,
} from '../../../domain/inventory/identifiers';
import type { SubmittedMovement } from '../../../domain/inventory/movement';
import {
  InMemoryExportCursorRepository,
  InMemoryMovementExportRepository,
} from './in-memory-export-store';
import {
  InMemoryInventoryStore,
  InMemoryMovementRepository,
} from './in-memory-inventory-store';

const ACME = tenantId('018f2c00-0000-7000-8000-00000000ac01');
const RIVAL = tenantId('018f2c00-0000-7000-8000-00000000ac02');

function movement(externalId: string, quantity = 5): SubmittedMovement {
  return {
    externalId: externalMovementId(externalId),
    sku: sku('ACME-001'),
    location: locationCode('WH-1'),
    kind: 'receipt',
    quantity,
    occurredAt: new Date('2026-08-27T10:00:00.000Z'),
  };
}

/**
 * The doubles the use-case tests run against.
 *
 * A double that is more permissive than the thing it stands for lets through
 * exactly the bug it exists to catch. Two properties matter here and are
 * modelled rather than approximated: movements recorded together share one
 * transaction identifier, because they are one transaction; and the horizon is
 * above every recorded identifier and below every future one.
 */
describe('the export doubles', () => {
  let store: InMemoryInventoryStore;

  beforeEach(() => {
    store = new InMemoryInventoryStore();
  });

  const record = (tenant: typeof ACME, movements: SubmittedMovement[]) =>
    new InMemoryMovementRepository(store, tenant).record(movements);

  const exportOf = (tenant: typeof ACME) =>
    new InMemoryMovementExportRepository(store, tenant);

  it('gives movements recorded together one identifier, as one transaction does', async () => {
    // Asserted by how far the horizon moves, which is the only thing that
    // actually separates the two models. A first attempt asserted that a window
    // covering both returns both — true under per-row numbering as well, so it
    // proved nothing and the probe walked straight through it.
    //
    // One call is one transaction, so the horizon advances by exactly one.
    // Numbering rows individually would advance it by two and put a boundary
    // between two movements the real database records inseparably.
    const before = await exportOf(ACME).horizon();

    await record(ACME, [movement('ERP-1'), movement('ERP-2')]);

    expect(await exportOf(ACME).horizon()).toBe(before + 1n);

    const together = await exportOf(ACME).inWindow(
      windowFrom(before, await exportOf(ACME).horizon()),
    );
    expect(together.map((row) => row.external_id).sort()).toEqual([
      'ERP-1',
      'ERP-2',
    ]);
  });

  it('puts the horizon above what is recorded and below what is not', async () => {
    await record(ACME, [movement('ERP-1')]);
    const afterFirst = await exportOf(ACME).horizon();

    await record(ACME, [movement('ERP-2')]);
    const afterSecond = await exportOf(ACME).horizon();

    expect(afterSecond).toBeGreaterThan(afterFirst);

    // The first horizon covers the first movement and not the second, which is
    // the behaviour the real cursor depends on.
    const early = await exportOf(ACME).inWindow(
      windowFrom(transactionId(1n), afterFirst),
    );
    expect(early.map((row) => row.external_id)).toEqual(['ERP-1']);
  });

  it('has nothing to carry before anything is recorded', async () => {
    expect(await exportOf(ACME).horizon()).toBe(1n);
  });

  it('shows one tenant nothing of another', async () => {
    await record(ACME, [movement('ERP-1')]);
    await record(RIVAL, [movement('ERP-2')]);

    const mine = await exportOf(ACME).inWindow(
      windowFrom(transactionId(1n), await exportOf(ACME).horizon()),
    );

    expect(mine.map((row) => row.external_id)).toEqual(['ERP-1']);
  });

  it('shapes a movement as it will be exported', async () => {
    await record(ACME, [movement('ERP-1', -3)]);

    const [row] = await exportOf(ACME).inWindow(
      windowFrom(transactionId(1n), await exportOf(ACME).horizon()),
    );

    expect(row).toEqual({
      external_id: 'ERP-1',
      sku: 'ACME-001',
      location_code: 'WH-1',
      kind: 'receipt',
      quantity: -3,
      occurred_at: new Date('2026-08-27T10:00:00.000Z'),
      recorded_at: expect.any(Date) as Date,
    });
  });

  describe('the cursor double', () => {
    it('starts having carried nothing', async () => {
      const cursors = new InMemoryExportCursorRepository(store, ACME);

      await expect(cursors.read('movements')).resolves.toEqual({
        state: 'never-carried',
      });
    });

    it('remembers a window that was started but not finished', async () => {
      const cursors = new InMemoryExportCursorRepository(store, ACME);
      const window = windowFrom(transactionId(1n), transactionId(9n));

      await cursors.start('movements', window);

      const cursor = await cursors.read('movements');
      expect(cursor.state).toBe('started');
      expect(cursor.state === 'started' && cursor.window.to).toBe(9n);
    });

    it('forgets the window once the run finishes', async () => {
      const cursors = new InMemoryExportCursorRepository(store, ACME);
      await cursors.start(
        'movements',
        windowFrom(transactionId(1n), transactionId(9n)),
      );

      await cursors.finish('movements', transactionId(9n));

      await expect(cursors.read('movements')).resolves.toEqual({
        state: 'carried',
        through: 9n,
      });
    });

    it('keeps each tenant position to itself', async () => {
      await new InMemoryExportCursorRepository(store, ACME).finish(
        'movements',
        transactionId(9n),
      );

      await expect(
        new InMemoryExportCursorRepository(store, RIVAL).read('movements'),
      ).resolves.toEqual({ state: 'never-carried' });
    });
  });
});
