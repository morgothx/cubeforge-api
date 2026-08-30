import {
  AthenaClient,
  GetQueryExecutionCommand,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import { GetDatabasesCommand, GlueClient } from '@aws-sdk/client-glue';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { loadAnalyticsConfig } from '../../src/adapters/analytics/analytics-config';

const config = loadAnalyticsConfig(process.env);

/** `s3://bucket/prefix` → `bucket`. */
const bucketOf = (location: string): string =>
  location.replace('s3://', '').split('/')[0];

/**
 * That the two clients reach the emulator at all.
 *
 * The smallest thing worth asserting before anything is built on them, and it
 * is worth asserting because the previous feature's equivalent task found that
 * a dependency can compile, install and still be unusable from the test runner.
 * Nothing here is about what the engine answers — only that it answers.
 */
describe('the analytics clients, against the emulator', () => {
  const clientOptions = {
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
  };

  const athena = new AthenaClient(clientOptions);
  const glue = new GlueClient(clientOptions);
  const objects = new S3Client({ ...clientOptions, forcePathStyle: true });

  beforeAll(async () => {
    // The engine writes its answers here itself, so it has to exist before the
    // first question. Creating it is the catalogue command's job; this suite
    // arranges it because it asks a question before that command exists.
    try {
      await objects.send(
        new CreateBucketCommand({ Bucket: bucketOf(config.resultsLocation) }),
      );
    } catch (error) {
      if (!alreadyThere(error)) {
        throw error;
      }
    }
  });

  afterAll(() => {
    athena.destroy();
    glue.destroy();
    objects.destroy();
  });

  it('reaches the catalogue', async () => {
    const answered = await glue.send(new GetDatabasesCommand({}));

    // Not what is in it — an empty catalogue is the ordinary state of a fresh
    // emulator. That the call is answered at all is the claim.
    expect(answered.DatabaseList).toBeDefined();
  });

  it('submits a question and gets an answer back', async () => {
    const started = await athena.send(
      new StartQueryExecutionCommand({
        QueryString: 'SELECT 1',
        WorkGroup: config.workgroup,
        ResultConfiguration: { OutputLocation: config.resultsLocation },
      }),
    );
    expect(started.QueryExecutionId).toBeDefined();

    const state = await settled(started.QueryExecutionId!);

    // Answered, not merely accepted. A submission that is taken and never
    // finishes would satisfy the assertion above and prove nothing.
    expect(state).toBe('SUCCEEDED');
  });

  async function settled(id: string): Promise<string> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const execution = await athena.send(
        new GetQueryExecutionCommand({ QueryExecutionId: id }),
      );
      const state = execution.QueryExecution?.Status?.State ?? 'UNKNOWN';
      if (state !== 'QUEUED' && state !== 'RUNNING') {
        return state;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('the question never settled');
  }
});

function alreadyThere(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists';
}
