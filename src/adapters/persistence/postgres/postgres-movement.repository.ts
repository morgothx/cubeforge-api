import { randomUUID } from 'node:crypto';
import { eq, sum } from 'drizzle-orm';
import type {
  MovementRepository,
  StockLevel,
} from '../../../application/ports/movement.repository';
import type { TenantId } from '../../../domain/identifiers';
import type {
  ExternalMovementId,
  LocationCode,
  Sku,
} from '../../../domain/inventory/identifiers';
import type { SubmittedMovement } from '../../../domain/inventory/movement';
import { stockMovements } from './schema';
import type { Transaction } from './postgres-tenant-scoped-unit-of-work';

export class PostgresMovementRepository implements MovementRepository {
  constructor(
    private readonly tx: Transaction,
    private readonly tenantId: TenantId,
  ) {}

  private get scope() {
    return eq(stockMovements.tenantId, this.tenantId);
  }

  /**
   * One statement, and the skipping belongs to the database.
   *
   * `on conflict do nothing … returning` inserts what is new and hands back
   * exactly those rows; the submitted identifiers absent from the result were
   * already recorded. That is a successful replay, not a failure.
   *
   * **Checking first would be wrong, not merely slower.** Two concurrent
   * retries of one batch would both read "absent" and both insert, which is the
   * duplicate this whole contract exists to prevent. The unique constraint
   * decides; this method only observes what it decided.
   */
  async record(
    movements: readonly SubmittedMovement[],
  ): Promise<ReadonlySet<ExternalMovementId>> {
    if (movements.length === 0) {
      return new Set();
    }

    const recorded = await this.tx
      .insert(stockMovements)
      .values(
        movements.map((movement) => ({
          id: randomUUID(),
          tenantId: this.tenantId,
          externalId: movement.externalId,
          sku: movement.sku,
          locationCode: movement.location,
          kind: movement.kind,
          quantity: movement.quantity,
          occurredAt: movement.occurredAt,
        })),
      )
      .onConflictDoNothing({
        target: [stockMovements.tenantId, stockMovements.externalId],
      })
      .returning({ externalId: stockMovements.externalId });

    return new Set(recorded.map((row) => row.externalId as ExternalMovementId));
  }

  async stockOnHand(): Promise<readonly StockLevel[]> {
    const rows = await this.tx
      .select({
        sku: stockMovements.sku,
        location: stockMovements.locationCode,
        onHand: sum(stockMovements.quantity),
      })
      .from(stockMovements)
      .where(this.scope)
      .groupBy(stockMovements.sku, stockMovements.locationCode)
      .orderBy(stockMovements.sku, stockMovements.locationCode);

    return rows.map((row) => ({
      sku: row.sku as Sku,
      location: row.location as LocationCode,
      // `sum` comes back as a string, because a bigint does not fit a JavaScript
      // number in general. These are sums of 32-bit quantities, so the total
      // fits comfortably; parsing here rather than leaving a string to travel
      // upward keeps the port's contract a number.
      onHand: Number(row.onHand ?? 0),
    }));
  }
}
