/**
 * Loading the columnar writer, and nothing else.
 *
 * The writer and its reader are published **only** as ES modules, and this
 * codebase is CommonJS. Node 22.12 and later can load an ES module from
 * CommonJS, and the repository compiles with `module: nodenext`, so a dynamic
 * import survives compilation as a dynamic import rather than being turned back
 * into a `require`. That is a narrow thing to depend on, so it is confined to
 * this file: everything else in the feature imports these two functions and
 * never the libraries.
 *
 * The modules are loaded once and remembered. A dynamic import per object
 * written would pay module resolution for every partition of every tenant.
 */

/** A column of the file: what it is called and what kind of value it holds. */
export interface ColumnDefinition {
  readonly name: string;
  /** The subset this feature writes. Widening it is a decision, not a typo. */
  readonly type: 'STRING' | 'INT32' | 'INT64' | 'TIMESTAMP' | 'BOOLEAN';
}

/** A row as the exporter builds it: column name to value. */
export type ColumnarRow = Record<
  string,
  string | number | boolean | Date | null
>;

interface Writer {
  readonly parquetWriteBuffer: (options: {
    columnData: { name: string; data: unknown[]; type: string }[];
  }) => ArrayBuffer;
}

interface Reader {
  readonly parquetReadObjects: (options: {
    file: {
      byteLength: number;
      slice: (start: number, end?: number) => ArrayBuffer;
    };
  }) => Promise<Record<string, unknown>[]>;
}

let writer: Promise<Writer> | null = null;
let reader: Promise<Reader> | null = null;

function loadWriter(): Promise<Writer> {
  writer ??= import('hyparquet-writer') as unknown as Promise<Writer>;
  return writer;
}

function loadReader(): Promise<Reader> {
  reader ??= import('hyparquet') as unknown as Promise<Reader>;
  return reader;
}

/**
 * Encodes rows as a Parquet file.
 *
 * Rows in, columns out: the file format is columnar and the exporter thinks in
 * rows, and this is the one place that transposition happens.
 */
export async function writeParquet(
  rows: readonly ColumnarRow[],
  columns: readonly ColumnDefinition[],
): Promise<Uint8Array> {
  const { parquetWriteBuffer } = await loadWriter();

  const buffer = parquetWriteBuffer({
    columnData: columns.map((column) => ({
      name: column.name,
      data: rows.map((row) => row[column.name] ?? null),
      type: column.type,
    })),
  });

  return new Uint8Array(buffer);
}

/**
 * Reads a Parquet file back into rows.
 *
 * Used by the tests rather than by the export, which never reads what it wrote.
 * It lives here because a round trip written and read by the same library would
 * prove nothing about the file an analytical engine will meet — the reader is a
 * separate library, and that is the point.
 */
export async function readParquet(
  file: Uint8Array,
): Promise<Record<string, unknown>[]> {
  const { parquetReadObjects } = await loadReader();

  return parquetReadObjects({
    file: {
      byteLength: file.byteLength,
      slice: (start: number, end?: number) => file.slice(start, end).buffer,
    },
  });
}
