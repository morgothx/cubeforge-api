import { ExportFailed } from '../../application/export/export-failure';
import type {
  ColumnarFile,
  ExportSink,
} from '../../application/ports/export-sink';
import type { ExportedRow } from '../../domain/export/exported-row';
import type { ObjectKey } from '../../domain/export/partition';

/**
 * The sink a use-case test writes into.
 *
 * It keeps rows rather than bytes, which is the point of the port: what a use
 * case decides is *which rows go under which key*, and asserting that against
 * an encoded file would be asserting it through a second thing that can be
 * wrong. The real encoding is checked where it belongs — against the emulator,
 * with an independent reader.
 *
 * It replaces on a repeated key, because object storage does. A double that
 * appended would let a duplicating implementation pass every replay test.
 */
export class InMemoryExportSink implements ExportSink {
  private readonly written = new Map<ObjectKey, ColumnarFile>();
  private readonly failing = new Set<ObjectKey>();
  private refusal: ExportFailed | null = null;

  /** Makes one key fail, so a run can be killed exactly half-way. */
  failOn(key: ObjectKey): void {
    this.failing.add(key);
  }

  unreachable(): void {
    this.refusal = new ExportFailed(
      'storage-unreachable',
      new Error('the destination is unreachable'),
    );
  }

  /**
   * A destination that answers, and refuses the credential.
   *
   * Distinct from unreachable on purpose: the real sink tells the two apart by
   * the status it got back, and a double that collapsed them would let a run
   * report the wrong diagnosis with every test still green.
   */
  rejectsCredentials(): void {
    this.refusal = new ExportFailed(
      'storage-rejected',
      new Error('the credential was refused'),
    );
  }

  keys(): ObjectKey[] {
    return [...this.written.keys()];
  }

  rowsAt(key: ObjectKey): readonly ExportedRow[] {
    return this.written.get(key)?.rows ?? [];
  }

  put(file: ColumnarFile): Promise<void> {
    if (this.failing.has(file.key)) {
      return Promise.reject(new Error(`refusing to write ${file.key}`));
    }
    this.written.set(file.key, file);
    return Promise.resolve();
  }

  reachable(): Promise<void> {
    return this.refusal === null
      ? Promise.resolve()
      : Promise.reject(this.refusal);
  }
}
