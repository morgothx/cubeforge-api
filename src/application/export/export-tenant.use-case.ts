import { Inject, Injectable } from '@nestjs/common';
import { nextWindow } from '../../domain/export/cursor';
import {
  CATALOGUE_COLUMNS,
  MOVEMENT_COLUMNS,
  WATERMARK_COLUMNS,
  type ExportedCatalogueRow,
  type ExportedMovementRow,
} from '../../domain/export/exported-row';
import {
  catalogueKey,
  movementsKey,
  partitionDay,
  watermarkKey,
  type CatalogueDataset,
  type PartitionDay,
} from '../../domain/export/partition';
import type { CarriedCounts } from '../../domain/export/report';
import type { ExportWindow } from '../../domain/export/window';
import type { TenantId } from '../../domain/identifiers';
import { CLOCK, type Clock } from '../ports/clock';
import type { DatasetName } from '../ports/export-cursor.repository';
import {
  EXPORT_SINK,
  type ColumnarFile,
  type ExportSink,
} from '../ports/export-sink';
import type { ReferenceEntity } from '../ports/reference.repository';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../ports/tenant-scoped-unit-of-work';
import { failingAs } from './export-failure';

const MOVEMENTS: DatasetName = 'movements';

export interface ExportTenantCommand {
  readonly tenantId: TenantId;
}

/**
 * What one tenant's export did.
 *
 * It reports what it carried and how far it reached, and stops there. Turning
 * that into a run's report is the run's job, which is why nothing here names
 * the tenant back to the caller that supplied it.
 */
export type TenantExport =
  | ({ readonly status: 'carried' } & CarriedCounts)
  | { readonly status: 'up-to-date' };

/** Everything read out of the database in one go, before anything is written. */
interface Readings {
  readonly movements: readonly ExportedMovementRow[];
  readonly products: readonly ExportedCatalogueRow[];
  readonly locations: readonly ExportedCatalogueRow[];
}

@Injectable()
export class ExportTenantUseCase {
  constructor(
    @Inject(TENANT_SCOPED_UNIT_OF_WORK)
    private readonly tenants: TenantScopedUnitOfWork,
    @Inject(EXPORT_SINK) private readonly sink: ExportSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * **Three transactions, not one, and that is the whole recovery story.**
   *
   * The window a run is about to carry has to be *committed* before the first
   * object is written. If claiming it shared a transaction with the writing,
   * a failed run would roll the claim back — and the next run, reading a
   * horizon that has moved on, would carry a wider window under different
   * object names, leaving the half-written day's file beside a second copy of
   * every movement in it. Object storage is not in the transaction, so the one
   * thing that must survive a rollback is the record of what was attempted.
   *
   * The objects are also written with no transaction open. A run that held one
   * for the length of an upload would be an export getting in the transactional
   * API's way, which is the one thing requirement 5.6 asks it not to do.
   */
  async execute(command: ExportTenantCommand): Promise<TenantExport> {
    const { tenantId } = command;

    const window = await this.claimWindow(tenantId);
    const readings = await this.read(tenantId, window);

    const partitions = byDayRecorded(readings.movements);
    if (window !== null) {
      for (const [day, rows] of partitions) {
        await this.write({
          key: movementsKey({ tenantId, day, window }),
          columns: MOVEMENT_COLUMNS,
          rows,
        });
      }
    }

    // Every run, whole, and after the movements. The catalogue is small and
    // mutable, so a snapshot per run is what makes a renamed product read once
    // and currently — and writing it under a fixed name is what replaces the
    // previous one rather than adding to it.
    await this.writeCatalogue(tenantId, 'products', readings.products);
    await this.writeCatalogue(tenantId, 'locations', readings.locations);

    if (window !== null) {
      await this.confirm(tenantId, window);
    }

    // **Last, and after the point reached is confirmed.** A run that dies
    // between the two leaves a mark that is *behind* the data, so a reader
    // understates how current an answer is and the next run repairs it. Writing
    // it first would leave one that is ahead, and a mark claiming a
    // completeness the data does not have is worse than no mark at all.
    //
    // Written on any run that succeeded, including one that found nothing new:
    // such a run is still evidence that the data is complete as of now, and a
    // mark that only moved when something was carried would freeze for a quiet
    // tenant while its answers stayed perfectly current.
    await this.write({
      key: watermarkKey(tenantId),
      columns: WATERMARK_COLUMNS,
      rows: [{ complete_through: this.clock.now() }],
    });

    if (window === null) {
      return { status: 'up-to-date' };
    }

    // **Carrying nothing is being up to date, and the emptiness has to be
    // decided from the rows rather than from the cursor.** The horizon is the
    // *database's*, not this tenant's: every transaction on the platform moves
    // it, the export's own cursor writes included. So a tenant with nothing new
    // almost always gets a real window that happens to contain none of its
    // movements, and reporting that as "carried 0 movements" would mean no run
    // against a live platform ever reports a tenant up to date at all.
    //
    // The point reached still moves. Nothing was written because there was
    // nothing to write, and leaving the cursor behind would make every later
    // run re-derive a window over movements it has already read.
    if (readings.movements.length === 0) {
      return { status: 'up-to-date' };
    }

    return {
      status: 'carried',
      movements: readings.movements.length,
      partitions: partitions.size,
      through: window.to,
    };
  }

  /**
   * Decides the window and records it, or reports there is nothing to carry.
   *
   * The horizon is read once, here, so movements recorded while the run is
   * under way fall above it and are left for the next run rather than making
   * the window a moving target.
   */
  private claimWindow(tenantId: TenantId): Promise<ExportWindow | null> {
    return failingAs('database-unavailable', () =>
      this.tenants.runInTenant(
        tenantId,
        async ({ movementExport, exportCursors }) => {
          const cursor = await exportCursors.read(MOVEMENTS);
          const next = nextWindow(cursor, await movementExport.horizon());

          if (next.decision === 'up-to-date') {
            return null;
          }

          // Recorded even when it is a window being replayed: writing the same
          // pair again costs one statement and removes the branch in which a
          // replay forgets to renew its claim.
          await exportCursors.start(MOVEMENTS, next.window);
          return next.window;
        },
      ),
    );
  }

  private read(
    tenantId: TenantId,
    window: ExportWindow | null,
  ): Promise<Readings> {
    return failingAs('database-unavailable', () =>
      this.tenants.runInTenant(
        tenantId,
        async ({ movementExport, products, locations }) => ({
          movements:
            window === null ? [] : await movementExport.inWindow(window),
          products: (await products.list()).map(catalogueRowOf),
          locations: (await locations.list()).map(catalogueRowOf),
        }),
      ),
    );
  }

  /**
   * The point reached, moved only once every object is written.
   *
   * Its own transaction, and the last thing that happens. A cursor that
   * advanced before the sink answered would turn a failed upload into a day of
   * history no run will ever look at again.
   */
  private confirm(tenantId: TenantId, window: ExportWindow): Promise<void> {
    return failingAs('database-unavailable', () =>
      this.tenants.runInTenant(tenantId, ({ exportCursors }) =>
        exportCursors.finish(MOVEMENTS, window.to),
      ),
    );
  }

  private writeCatalogue(
    tenantId: TenantId,
    dataset: CatalogueDataset,
    rows: readonly ExportedCatalogueRow[],
  ): Promise<void> {
    // An empty object rather than none: a reader must see a tenant with no
    // products as having none, not as a partition that failed to appear.
    return this.write({
      key: catalogueKey(tenantId, dataset),
      columns: CATALOGUE_COLUMNS,
      rows,
    });
  }

  private write(file: ColumnarFile): Promise<void> {
    return failingAs('write-failed', () => this.sink.put(file));
  }
}

/**
 * One group per day a movement was **recorded** on.
 *
 * Recorded, never occurred: a movement backdated by a source system belongs to
 * the day this platform stored it, which is the day no later run will ever have
 * to rewrite. Partitioning by when it happened would reopen a closed day every
 * time an integration caught up.
 */
function byDayRecorded(
  movements: readonly ExportedMovementRow[],
): ReadonlyMap<PartitionDay, ExportedMovementRow[]> {
  const days = new Map<PartitionDay, ExportedMovementRow[]>();

  for (const movement of movements) {
    const day = partitionDay(movement.recorded_at);
    const existing = days.get(day);
    if (existing) {
      existing.push(movement);
    } else {
      days.set(day, [movement]);
    }
  }

  return days;
}

/** A product or a place, reduced to what labels a number in a chart. */
function catalogueRowOf(
  entity: ReferenceEntity<string> & { readonly category?: string | null },
): ExportedCatalogueRow {
  return {
    code: entity.code,
    name: entity.name,
    // A place has no category. Null rather than absent, so both datasets have
    // the same columns and a reader meets one shape.
    category: entity.category ?? null,
  };
}
