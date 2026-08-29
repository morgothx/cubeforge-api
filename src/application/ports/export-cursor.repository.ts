import type { ExportCursor } from '../../domain/export/cursor';
import type { ExportWindow, TransactionId } from '../../domain/export/window';

/**
 * Which stream a cursor belongs to.
 *
 * One member today. It exists so that a second dataset is a row rather than a
 * migration on a table that by then holds every tenant's position.
 */
export type DatasetName = 'movements';

/**
 * How far this tenant has been carried, and the two moves that change it.
 *
 * **Two phases, and the order is the contract.** `start` records the window a
 * run is about to carry, before anything is written. `finish` confirms it,
 * after everything is. A run that dies between them leaves the window recorded,
 * and the next run replays it — same window, same rows, same object keys.
 *
 * There is no `clear` and no `delete`. Forgetting how far a tenant reached is
 * not an operation this feature wants to have, and the database agrees: the
 * application identity holds no delete grant on the table.
 */
export interface ExportCursorRepository {
  read(dataset: DatasetName): Promise<ExportCursor>;
  start(dataset: DatasetName, window: ExportWindow): Promise<void>;
  finish(dataset: DatasetName, through: TransactionId): Promise<void>;
}
