import { loadObjectStorageConfig } from './object-storage-config';

const COMPLETE = {
  EXPORT_BUCKET: 'cubeforge-exports',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  AWS_DEFAULT_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
};

/**
 * Where the export writes, read from the environment.
 *
 * A missing setting has to be a refusal at the start rather than a failure
 * half-way through a run, because half-way through is where a run leaves a
 * tenant's cursor part-moved and an operator with a question. Every missing key
 * is named at once: discovering them one run at a time wastes an afternoon.
 */
describe('the export destination', () => {
  it('reads the whole destination from the environment', () => {
    expect(loadObjectStorageConfig(COMPLETE)).toEqual({
      bucket: 'cubeforge-exports',
      endpoint: 'http://localhost:4566',
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });

  it('names the missing bucket rather than failing later', () => {
    const withoutBucket = { ...COMPLETE, EXPORT_BUCKET: undefined };

    expect(() => loadObjectStorageConfig(withoutBucket)).toThrow(
      /EXPORT_BUCKET/,
    );
  });

  it('names every missing setting at once', () => {
    let message = '';
    try {
      loadObjectStorageConfig({});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // All five, in one refusal. A configuration reported one key per run is a
    // configuration fixed one run per afternoon.
    for (const key of Object.keys(COMPLETE)) {
      expect(message).toContain(key);
    }
  });

  it('treats blank as missing, because a blank bucket is not a bucket', () => {
    expect(() =>
      loadObjectStorageConfig({ ...COMPLETE, EXPORT_BUCKET: '   ' }),
    ).toThrow(/EXPORT_BUCKET/);
  });

  it('refuses an endpoint that is not the local emulator', () => {
    // The platform targets Floci and never a real account. A configuration
    // pointing at AWS is a mistake this project wants loudly, not quietly:
    // exporting a tenant's history to somebody's real bucket is not something
    // to discover from a bill.
    expect(() =>
      loadObjectStorageConfig({
        ...COMPLETE,
        AWS_ENDPOINT_URL: 'https://s3.us-east-1.amazonaws.com',
      }),
    ).toThrow(/emulator|localhost/i);
  });
});
