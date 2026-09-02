export interface SemanticConfig {
  /** Where the semantic layer answers. Reached by name inside the stack. */
  readonly url: string;
  /**
   * Signs the context that tells the semantic layer which tenant is asking.
   *
   * Deliberately not the secret the platform signs access tokens with. See
   * `refuseSharedSecret` below.
   */
  readonly secret: string;
  /** The whole exchange, including every wait, must finish inside this. */
  readonly questionTimeoutMs: number;
}

type Env = Record<string, string | undefined>;

const REQUIRED = ['CUBE_URL', 'CUBEJS_API_SECRET'] as const;

const DEFAULT_QUESTION_TIMEOUT_MS = 30_000;

/**
 * The same minimum the platform's own signing secret must meet.
 *
 * A second secret exists so that a token minted for one verifier is refused by
 * the other. A second secret that is easier to guess than the first does not
 * give that property; it gives the appearance of it.
 */
const MINIMUM_SECRET_LENGTH = 32;

/**
 * Where questions go, validated before one is asked.
 *
 * Every missing setting is reported together, for the reason the analytics
 * loader gives: a configuration reported one key per attempt is a configuration
 * fixed one attempt per afternoon.
 *
 * **Called at the first question, not when the module is built.** Requirement
 * 8.1 says the platform starts when the semantic layer is not configured; an
 * API refusing to boot over a setting only one route uses would take sign-in
 * and inventory down with it.
 */
export function loadSemanticConfig(env: Env): SemanticConfig {
  const missing: string[] = [];
  const values = REQUIRED.map((key) => {
    const value = env[key]?.trim() ?? '';
    if (value.length === 0) {
      missing.push(key);
    }
    return value;
  });

  if (missing.length > 0) {
    throw new Error(`missing semantic configuration: ${missing.join(', ')}`);
  }

  const [url, secret] = values as [string, string];

  requireAddress(url);
  refuseSharedSecret(secret, env.AUTH_TOKEN_SECRET?.trim() ?? '');

  return {
    url,
    secret,
    questionTimeoutMs: questionTimeout(env.CUBE_QUESTION_TIMEOUT_MS?.trim()),
  };
}

/**
 * An address a client can actually dial.
 *
 * `cube:4000` — a host and a port typed without a scheme — parses perfectly
 * well as a URL whose protocol is `cube:`, so nothing objects until a request
 * fails somewhere far from the setting that caused it. An operator reading
 * "unsupported protocol" learns rather less than one reading the name of the
 * setting they got wrong.
 */
function requireAddress(url: string): void {
  const parsed = parseUrl(url);
  if (
    parsed === null ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
  ) {
    throw new Error(`CUBE_URL must be an http or https address, got "${url}"`);
  }
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Two secrets, never one.
 *
 * The semantic layer verifies what it is given with its own secret. If that
 * secret were the platform's, a platform access token — held by anyone who has
 * signed in — would verify there too, and a caller could ask the model
 * directly without passing through the API at all (4.2). Both would verify, so
 * nothing would fail and nothing would be logged.
 */
function refuseSharedSecret(secret: string, platformSecret: string): void {
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new Error(
      `CUBEJS_API_SECRET must be at least ${MINIMUM_SECRET_LENGTH} characters`,
    );
  }
  if (platformSecret.length > 0 && secret === platformSecret) {
    throw new Error(
      'CUBEJS_API_SECRET must not be the same value as AUTH_TOKEN_SECRET',
    );
  }
}

function questionTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_QUESTION_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `CUBE_QUESTION_TIMEOUT_MS must be a positive integer, got "${raw}"`,
    );
  }
  return value;
}
