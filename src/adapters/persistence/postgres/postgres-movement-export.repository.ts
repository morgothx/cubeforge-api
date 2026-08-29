import { and, asc, eq, sql } from 'drizzle-orm';
import type { MovementExportRepository } from '../../../application/ports/movement-export.repository';
import type { ExportedMovementRow } from '../../../domain/export/exported-row';
import {
  transactionId,
  type ExportWindow,
  type TransactionId,
} from '../../../domain/export/window';
import type { TenantId } from '../../../domain/identifiers';
import { stockMovements } from './schema';
import type { Transaction } from './postgres-tenant-scoped-unit-of-work';

/**
 * Reading the movement stream for export.
 *
 * Separate from `PostgresMovementRepository`, which serves the transactional
 * API: that one answers what is on hand, this one answers what has been
 * recorded since a point.
 */
export class PostgresMovementExportRepository implements MovementExportRepository {
  constructor(
    private readonly tx: Transaction,
    private readonly tenantId: TenantId,
  ) {}

  /**
   * The identifier below which no transaction is still in flight.
   *
   * `pg_snapshot_xmin(pg_current_snapshot())` is the whole mechanism. A
   * movement is safe to carry only once its own transaction is **below** this
   * line, because no transaction that could still produce a lower identifier
   * remains open. A row committed above the line is deliberately left for the
   * next run: carrying it would move the cursor past a transaction that has not
   * finished, and that transaction's movement would never be carried at all.
   *
   * The cost is that a long-running transaction delays movements committed
   * after it. Late is recoverable; skipped is not.
   */
  async horizon(): Promise<TransactionId> {
    const answered = await this.tx.execute<{ horizon: string }>(
      sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon`,
    );
    const [row] = answered.rows;

    return transactionId(BigInt(row?.horizon ?? '1'));
  }

  /**
   * The movements inside the half-open window, oldest first.
   *
   * The tenant predicate is here as well as in the policy, which is the
   * platform's two-layer rule: neither layer is allowed to be the only one.
   */
  async inWindow(
    window: ExportWindow,
  ): Promise<readonly ExportedMovementRow[]> {
    const rows = await this.tx
      .select({
        external_id: stockMovements.externalId,
        sku: stockMovements.sku,
        location_code: stockMovements.locationCode,
        kind: stockMovements.kind,
        quantity: stockMovements.quantity,
        occurred_at: stockMovements.occurredAt,
        recorded_at: stockMovements.recordedAt,
      })
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.tenantId, this.tenantId),
          // Cast explicitly: a bigint parameter arrives as text, and `xid8`
          // has no implicit comparison with it.
          sql`${stockMovements.recordedXid} >= ${window.from.toString()}::xid8`,
          sql`${stockMovements.recordedXid} < ${window.to.toString()}::xid8`,
        ),
      )
      .orderBy(asc(stockMovements.recordedXid), asc(stockMovements.externalId));

    return rows;
  }
}
