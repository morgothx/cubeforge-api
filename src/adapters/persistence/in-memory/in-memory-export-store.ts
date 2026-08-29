import type { DatasetName } from '../../../application/ports/export-cursor.repository';
import type { ExportCursorRepository } from '../../../application/ports/export-cursor.repository';
import type { MovementExportRepository } from '../../../application/ports/movement-export.repository';
import {
  carried,
  started,
  type ExportCursor,
} from '../../../domain/export/cursor';
import type { ExportedMovementRow } from '../../../domain/export/exported-row';
import {
  transactionId,
  type ExportWindow,
  type TransactionId,
} from '../../../domain/export/window';
import type { TenantId } from '../../../domain/identifiers';
import type { InMemoryInventoryStore } from './in-memory-inventory-store';

/**
 * Reading the movement stream for export, without a database.
 *
 * The two properties a use-case test depends on are modelled rather than
 * approximated: movements recorded together share one transaction identifier,
 * and the horizon sits above every recorded identifier. A double looser than
 * the real thing would let a windowing bug through — which is precisely the bug
 * this feature is built to prevent.
 */
export class InMemoryMovementExportRepository implements MovementExportRepository {
  constructor(
    private readonly store: InMemoryInventoryStore,
    private readonly tenantId: TenantId,
  ) {}

  horizon(): Promise<TransactionId> {
    return Promise.resolve(transactionId(this.store.transactionHorizon));
  }

  inWindow(window: ExportWindow): Promise<readonly ExportedMovementRow[]> {
    const rows = [...this.store.movements.values()]
      .filter(
        (movement) =>
          movement.tenant === this.tenantId &&
          window.covers(transactionId(movement.recordedXid)),
      )
      .sort((left, right) =>
        left.recordedXid === right.recordedXid
          ? left.externalId.localeCompare(right.externalId)
          : Number(left.recordedXid - right.recordedXid),
      )
      .map((movement): ExportedMovementRow => ({
        external_id: movement.externalId,
        sku: movement.sku,
        location_code: movement.location,
        kind: movement.kind,
        quantity: movement.quantity,
        occurred_at: movement.occurredAt,
        recorded_at: movement.recordedAt,
      }));

    return Promise.resolve(rows);
  }
}

/** What the cursor table holds for one tenant and one dataset. */
interface HeldCursor {
  carriedThrough?: bigint;
  startedWindow?: { from: bigint; to: bigint };
}

/**
 * The cursor table's double.
 *
 * The two phases are kept apart here exactly as the table keeps them, because
 * the whole recovery story is "a window recorded but not confirmed". A double
 * that collapsed them into one value would make every replay test pass against
 * an implementation that cannot replay.
 */
export class InMemoryExportCursorRepository implements ExportCursorRepository {
  constructor(
    private readonly store: InMemoryInventoryStore,
    private readonly tenantId: TenantId,
  ) {}

  private key(dataset: DatasetName): string {
    return `${this.tenantId}:${dataset}`;
  }

  private held(dataset: DatasetName): HeldCursor {
    const existing = this.store.exportCursors.get(this.key(dataset));
    if (existing) {
      return existing;
    }
    const fresh: HeldCursor = {};
    this.store.exportCursors.set(this.key(dataset), fresh);
    return fresh;
  }

  read(dataset: DatasetName): Promise<ExportCursor> {
    const held = this.store.exportCursors.get(this.key(dataset));

    if (held?.startedWindow) {
      const { from, to } = held.startedWindow;
      return Promise.resolve(
        started({
          from: transactionId(from),
          to: transactionId(to),
          covers: (identifier) => identifier >= from && identifier < to,
        }),
      );
    }
    if (held?.carriedThrough !== undefined) {
      return Promise.resolve(carried(transactionId(held.carriedThrough)));
    }
    return Promise.resolve({ state: 'never-carried' });
  }

  start(dataset: DatasetName, window: ExportWindow): Promise<void> {
    this.held(dataset).startedWindow = { from: window.from, to: window.to };
    return Promise.resolve();
  }

  finish(dataset: DatasetName, through: TransactionId): Promise<void> {
    const held = this.held(dataset);
    held.carriedThrough = through;
    // Cleared together with the confirmation, as the table's update does.
    // Leaving it would make the next run replay a window already carried.
    delete held.startedWindow;
    return Promise.resolve();
  }
}
