import { resolve } from 'node:path';
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadDatabaseConfig } from '../../../src/adapters/persistence/postgres/database-config';
import { loadObjectStorageConfig } from '../../../src/adapters/storage/object-storage-config';

/**
 * Brings the local database up to date once, before the suite runs.
 *
 * Migrations are applied as the schema owner, exactly as they are in
 * development, so the tests exercise the same grants and policies a real
 * deployment gets rather than a hand-built approximation of them.
 *
 * Creating the roles is deliberately not done here. Role creation needs the
 * container superuser and is a one-time act of local setup; doing it silently
 * from a test run would hide a missing prerequisite behind a green suite.
 */
export default async function globalSetup(): Promise<void> {
  await migrateDatabase();
  await emptyExportBucket();
}

/**
 * Gives the run an empty export bucket, once, before any suite starts.
 *
 * Nothing ever cleaned it, so every tenant every run has ever exported was
 * still there — and the analytical engine builds its view over the *whole*
 * prefix on every question, whichever table is being asked about. The cost of
 * one question therefore grew with the entire history of the machine, until
 * the emulator started failing to reach its own object store mid-query:
 *
 *     IO Error: Could not connect to server ... GET .../?prefix=movements/
 *
 * which surfaces as `the engine answered FAILED` on an arbitrary test. It read
 * as an intermittent defect in the analytics and was neither — it was a fixture
 * that never reset.
 *
 * Emptying it **here** rather than in a suite is the distinction task 4.3 drew:
 * a suite that clears the bucket between its own tests is reaching into
 * whatever runs next, while the run's prerequisite is arranged once, before
 * anything is using it — exactly as the database is migrated.
 */
async function emptyExportBucket(): Promise<void> {
  const config = loadObjectStorageConfig(process.env);
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true,
  });

  try {
    await client
      .send(new CreateBucketCommand({ Bucket: config.bucket }))
      .catch(() => undefined);

    for (;;) {
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: config.bucket }),
      );
      const keys = (listed.Contents ?? []).flatMap((object) =>
        object.Key === undefined ? [] : [{ Key: object.Key }],
      );
      if (keys.length === 0) {
        return;
      }
      await client.send(
        new DeleteObjectsCommand({
          Bucket: config.bucket,
          Delete: { Objects: keys },
        }),
      );
    }
  } finally {
    client.destroy();
  }
}

async function migrateDatabase(): Promise<void> {
  const config = loadDatabaseConfig(process.env);

  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.migrator.user,
    password: config.migrator.password,
    max: 1,
  });

  try {
    await migrate(drizzle(pool), {
      migrationsFolder: resolve(__dirname, '../../../drizzle'),
    });
  } catch (error) {
    throw new Error(
      `could not migrate the integration database as "${config.migrator.user}" ` +
        `at ${config.host}:${config.port}/${config.database}. ` +
        'Start the local stack with `docker compose up -d postgres` and create the roles ' +
        'once with `pnpm db:bootstrap`.\n' +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await pool.end();
  }
}
