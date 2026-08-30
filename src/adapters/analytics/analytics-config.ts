import { requireLocalEmulator } from '../aws/require-local-emulator';

export interface AnalyticsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface AnalyticsConfig {
  /** The catalogue the tables over the exported prefixes are defined in. */
  readonly database: string;
  /** Which pool of capacity a question is submitted to. */
  readonly workgroup: string;
  /** Where the engine writes what it answered. It writes there itself. */
  readonly resultsLocation: string;
  readonly endpoint: string;
  readonly region: string;
  readonly credentials: AnalyticsCredentials;
}

type Env = Record<string, string | undefined>;

const KEYS = [
  'ANALYTICS_DATABASE',
  'ANALYTICS_WORKGROUP',
  'ANALYTICS_RESULTS_LOCATION',
  'AWS_ENDPOINT_URL',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
] as const;

/**
 * Where questions go, validated before one is asked.
 *
 * Every missing setting is reported together, for the reason the export's own
 * loader gives: a configuration reported one key per attempt is a configuration
 * fixed one attempt per afternoon.
 *
 * **Called at the first question, not when the module is built.** The
 * requirement is that the analytics refuses to *answer*; an API refusing to
 * *boot* over a setting only one route uses would take every other route down
 * with it — which is the trap the export's validation gate found from the other
 * side, where a missing setting surfaced as a stack trace instead of a sentence.
 */
export function loadAnalyticsConfig(env: Env): AnalyticsConfig {
  const missing: string[] = [];
  const values = KEYS.map((key) => {
    const value = env[key]?.trim() ?? '';
    if (value.length === 0) {
      missing.push(key);
    }
    return value;
  });

  if (missing.length > 0) {
    throw new Error(`missing analytics configuration: ${missing.join(', ')}`);
  }

  const [
    database,
    workgroup,
    resultsLocation,
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
  ] = values as [string, string, string, string, string, string, string];

  requireLocalEmulator(endpoint, 'AWS_ENDPOINT_URL');
  requireObjectLocation(resultsLocation);

  return {
    database,
    workgroup,
    resultsLocation,
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
  };
}

/**
 * The engine writes its answers to this location itself.
 *
 * Checked here rather than left to the first question, because a value that is
 * not an object-store location fails later wearing the engine's wording — and
 * an operator reading "invalid S3 path" learns rather less than one reading the
 * name of the setting they got wrong.
 */
function requireObjectLocation(location: string): void {
  if (!location.startsWith('s3://')) {
    throw new Error(
      `ANALYTICS_RESULTS_LOCATION must be an object-store location, got "${location}"`,
    );
  }
}
