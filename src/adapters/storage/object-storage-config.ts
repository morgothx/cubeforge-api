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
 * Hosts this project is allowed to write to. The platform targets a local
 * emulator and never a real account, and exporting a tenant's history to
 * somebody's real bucket is not a thing to learn about from a bill.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'floci']);

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

  requireLocalEmulator(endpoint);

  return {
    bucket,
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
  };
}

/**
 * Refuses an endpoint that is not the local emulator.
 *
 * Steering states it as a rule rather than a preference: everything here talks
 * to Floci, and a real deployment would be a deliberate, human-approved step.
 * Enforcing it in code rather than trusting a `.env` means a copied production
 * value fails at startup instead of writing one tenant's history somewhere it
 * cannot be taken back from.
 */
function requireLocalEmulator(endpoint: string): void {
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    throw new Error(`AWS_ENDPOINT_URL is not a URL: "${endpoint}"`);
  }

  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `AWS_ENDPOINT_URL must point at the local emulator, got "${host}". ` +
        'This project never writes to a real account; a real deployment is a ' +
        'deliberate, human-approved step outside this path.',
    );
  }
}
