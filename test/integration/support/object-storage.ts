import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { loadObjectStorageConfig } from '../../../src/adapters/storage/object-storage-config';
import type { ObjectStorageConfig } from '../../../src/adapters/storage/object-storage-config';

/**
 * The destination every export suite writes to, read once.
 *
 * It refuses a non-local endpoint on the way through, so a `.env` carrying real
 * values fails here rather than sending a tenant's history somewhere it cannot
 * be taken back from.
 */
export function exportDestination(): ObjectStorageConfig {
  return loadObjectStorageConfig(process.env);
}

/**
 * Guarantees the bucket exists before the suite runs.
 *
 * This used to happen inside one suite's `beforeAll`, and two other suites
 * quietly depended on it — a dependency that held on a developer's machine,
 * where the bucket survives from run to run, and would have failed on a fresh
 * emulator every time. Alphabetically the suite that created it ran *last*.
 *
 * The bucket is a prerequisite of the run, like the migrated database is, so it
 * is arranged by whoever needs it rather than left as a side effect of whoever
 * happens to go first. Creating it is idempotent: the ordinary case is that it
 * is already there.
 */
export function useExportDestination(): void {
  beforeAll(async () => {
    const config = exportDestination();
    const client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: config.credentials,
      forcePathStyle: true,
    });

    try {
      await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
    } catch (error) {
      if (!alreadyThere(error)) {
        throw error;
      }
    } finally {
      client.destroy();
    }
  });
}

/**
 * Distinguishes "it exists" from every other refusal. Swallowing all of them
 * would turn a rejected credential into a suite that fails later, somewhere
 * less legible.
 */
function alreadyThere(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists';
}
