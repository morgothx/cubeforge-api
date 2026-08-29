import type { ExportedMovementRow } from '../../domain/export/exported-row';
import type { ExportWindow, TransactionId } from '../../domain/export/window';

/**
 * Reading the movement stream for export.
 *
 * Separate from `MovementRepository`, which serves the transactional API. That
 * one answers "what is on hand"; this one answers "what has been recorded since
 * a point", and the two questions want different indexes, different shapes and
 * different guarantees. Putting both on one interface would mean every use case
 * that records a movement can also read the whole stream.
 */
export interface MovementExportRepository {
  /**
   * The transaction identifier below which nothing is still in flight.
   *
   * The reason this feature does not use a timestamp. `recorded_at` is the
   * moment a transaction *began*, and two concurrent inserts commit in whatever
   * order they finish — so a movement whose transaction started earlier and
   * committed later would be skipped for ever by a cursor holding the greatest
   * moment exported. Below this line, nothing new can appear.
   */
  horizon(): Promise<TransactionId>;

  /**
   * The movements whose transaction falls in the half-open window, oldest
   * first, already shaped as they will be exported.
   */
  inWindow(window: ExportWindow): Promise<readonly ExportedMovementRow[]>;
}
