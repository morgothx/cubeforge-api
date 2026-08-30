import {
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ExportFailed } from '../../application/export/export-failure';
import type {
  ColumnarFile,
  ExportSink,
} from '../../application/ports/export-sink';
import type { ObjectKey } from '../../domain/export/partition';
import type { ObjectStorageConfig } from './object-storage-config';
import { writeParquet } from './parquet-runtime';

/**
 * Rows in, objects out.
 *
 * The only file in the feature that knows what a file is or where it goes.
 * Everything above it hands over rows and a key; that the rows become Parquet
 * and the key becomes an object is decided here and nowhere else.
 */
export class ParquetExportSink implements ExportSink {
  private readonly client: S3Client;

  constructor(private readonly config: ObjectStorageConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: config.credentials,
      // The emulator addresses buckets by path rather than by subdomain, and a
      // virtual-host style request against it resolves to nothing at all.
      forcePathStyle: true,
    });
  }

  /**
   * A single put, which is also a replace.
   *
   * Writing the same key twice with the same rows leaves one object holding
   * those rows — the property a replayed window depends on. Nothing here needs
   * to know whether this key is new; the key itself decides that.
   */
  async put(file: ColumnarFile): Promise<void> {
    const encoded = await writeParquet(file.rows, file.columns);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: file.key,
        Body: encoded,
        ContentType: 'application/vnd.apache.parquet',
      }),
    );
  }

  /**
   * Asked once, before the first tenant is touched.
   *
   * An unreachable destination or a rejected credential discovered half-way
   * through is discovered where it hurts: with objects written and cursors
   * part-moved. `HeadBucket` costs nothing and answers both questions.
   */
  async reachable(): Promise<void> {
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.config.bucket }),
      );
    } catch (error) {
      // Classified here, where the HTTP status still exists. One layer up there
      // is only an exception with a driver's wording in it, and an operator
      // does one thing about a key the destination refused and quite another
      // about a destination that is not there.
      throw new ExportFailed(reasonRefusing(error), error);
    }
  }

  /**
   * Reads an object back. Used by the tests, which check the file with a reader
   * that is not the library that wrote it; the export never reads what it
   * wrote.
   */
  async read(key: ObjectKey): Promise<Uint8Array> {
    const answered = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );

    return answered.Body!.transformToByteArray();
  }

  /** Releases the connections. A long-lived process would keep one client. */
  close(): Promise<void> {
    this.client.destroy();
    return Promise.resolve();
  }

  /**
   * The same thing, under the name Nest calls when its context closes. Without
   * it the command's process would sit with open sockets after the run it was
   * started for has finished.
   */
  onModuleDestroy(): Promise<void> {
    return this.close();
  }
}

/**
 * Which class of problem a refused `HeadBucket` is.
 *
 * Only the two the caller can act on. Anything else — no route to the host, a
 * bucket that does not exist, a connection refused — is the destination not
 * being there, which is what "unreachable" says.
 */
function reasonRefusing(
  error: unknown,
): 'storage-rejected' | 'storage-unreachable' {
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;

  return status === 401 || status === 403
    ? 'storage-rejected'
    : 'storage-unreachable';
}
