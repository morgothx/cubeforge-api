import type {
  ExportedColumn,
  ExportedRow,
} from '../../domain/export/exported-row';
import type { ObjectKey } from '../../domain/export/partition';

export const EXPORT_SINK = Symbol('EXPORT_SINK');

/** One object: where it goes, what shape it has, and what is in it. */
export interface ColumnarFile {
  readonly key: ObjectKey;
  readonly columns: readonly ExportedColumn[];
  readonly rows: readonly ExportedRow[];
}

/**
 * Where exported rows go.
 *
 * **Rows in, not bytes.** The application layer never learns what a file is;
 * the adapter behind this decides that a file is Parquet and that the
 * destination is object storage. Anything else would put a format decision in
 * the layer that is supposed to survive changing it.
 *
 * **One write, not an add and a replace.** Object storage has no such
 * distinction, and inventing one here would be a promise the adapter cannot
 * keep. Whether a write adds or replaces is decided by the *key*: a movement
 * file is named for its window and so is new every time, a catalogue file has a
 * fixed name and so replaces. Writing the same key twice with the same rows
 * leaves one object holding those rows, which is what makes a replayed window
 * safe rather than duplicated.
 */
export interface ExportSink {
  put(file: ColumnarFile): Promise<void>;

  /**
   * Answers whether the destination can be written to at all.
   *
   * Asked once, before the first tenant is touched. An unreachable destination
   * or a rejected credential discovered half-way through is discovered where it
   * hurts: with objects written and cursors part-moved.
   */
  reachable(): Promise<void>;
}
