import { and, eq, sql } from 'drizzle-orm';
import type {
  DatasetName,
  ExportCursorRepository,
} from '../../../application/ports/export-cursor.repository';
import {
  carried,
  started,
  type ExportCursor,
} from '../../../domain/export/cursor';
import {
  transactionId,
  windowFrom,
  type ExportWindow,
  type TransactionId,
} from '../../../domain/export/window';
import type { TenantId } from '../../../domain/identifiers';
import { exportCursors } from './schema';
import type { Transaction } from './postgres-tenant-scoped-unit-of-work';

/**
 * How far this tenant has been carried.
 *
 * Both moves are upserts on `(tenant_id, dataset)`, because a tenant's first
 * run has no row and every run after it has one — and reading first to decide
 * which statement to issue is a race the constraint would win anyway.
 */
export class PostgresExportCursorRepository implements ExportCursorRepository {
  constructor(
    private readonly tx: Transaction,
    private readonly tenantId: TenantId,
  ) {}

  private where(dataset: DatasetName) {
    return and(
      eq(exportCursors.tenantId, this.tenantId),
      eq(exportCursors.dataset, dataset),
    );
  }

  async read(dataset: DatasetName): Promise<ExportCursor> {
    const [row] = await this.tx
      .select({
        exportedThrough: exportCursors.exportedThrough,
        pendingFrom: exportCursors.pendingFrom,
        pendingTo: exportCursors.pendingTo,
      })
      .from(exportCursors)
      .where(this.where(dataset));

    if (row?.pendingFrom != null && row.pendingTo != null) {
      // A run that started and did not finish. Reported as such so the next run
      // replays this window rather than computing a new one.
      return started(
        windowFrom(
          transactionId(row.pendingFrom),
          transactionId(row.pendingTo),
        ),
      );
    }
    if (row?.exportedThrough != null) {
      return carried(transactionId(row.exportedThrough));
    }
    return { state: 'never-carried' };
  }

  async start(dataset: DatasetName, window: ExportWindow): Promise<void> {
    await this.tx
      .insert(exportCursors)
      .values({
        tenantId: this.tenantId,
        dataset,
        pendingFrom: window.from,
        pendingTo: window.to,
      })
      .onConflictDoUpdate({
        target: [exportCursors.tenantId, exportCursors.dataset],
        set: {
          pendingFrom: window.from,
          pendingTo: window.to,
          updatedAt: sql`now()`,
        },
      });
  }

  async finish(dataset: DatasetName, through: TransactionId): Promise<void> {
    await this.tx
      .insert(exportCursors)
      .values({ tenantId: this.tenantId, dataset, exportedThrough: through })
      .onConflictDoUpdate({
        target: [exportCursors.tenantId, exportCursors.dataset],
        set: {
          exportedThrough: through,
          // Cleared with the confirmation, in one statement. Leaving it would
          // make the next run replay a window already carried.
          pendingFrom: null,
          pendingTo: null,
          updatedAt: sql`now()`,
        },
      });
  }
}
