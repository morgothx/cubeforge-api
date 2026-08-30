import { requireLocalEmulator } from '../aws/require-local-emulator';

export interface ObjectStorageCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface ObjectStorageConfig {
  /** The one bucket every tenant's objects are written under. */
  readonly bucket: string;
  readonly endpoint: string;
  readonly region: string;
  readonly credentials: ObjectStorageCredentials;
}

type Env = Record<string, string | undefined>;

const KEYS = [
  'EXPORT_BUCKET',
  'AWS_ENDPOINT_URL',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
] as const;

/**
 * The export's destination, validated before a run begins.
 *
 * Read once, at the start, rather than at the first write: half-way through is
 * exactly where a missing setting hurts, because that is where a run has
 * already written objects and moved nothing. Every missing key is reported
 * together — a configuration reported one key per run is a configuration fixed
 * one run per afternoon.
 */
export function loadObjectStorageConfig(env: Env): ObjectStorageConfig {
  const missing: string[] = [];
  const values = KEYS.map((key) => {
    const value = env[key]?.trim() ?? '';
    if (value.length === 0) {
      missing.push(key);
    }
    return value;
  });

  if (missing.length > 0) {
    throw new Error(
      `missing object storage configuration: ${missing.join(', ')}`,
    );
  }

  const [bucket, endpoint, region, accessKeyId, secretAccessKey] = values as [
    string,
    string,
    string,
    string,
    string,
  ];

  requireLocalEmulator(endpoint, 'AWS_ENDPOINT_URL');

  return {
    bucket,
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
  };
}
