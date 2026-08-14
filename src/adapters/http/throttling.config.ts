/**
 * How much guessing the credential endpoints tolerate.
 *
 * Configuration rather than constants, for the same reason the hashing cost is:
 * the right numbers depend on how the platform is used, and a number baked into
 * source is a number nobody revisits. The defaults are deliberately generous
 * enough that a person who mistypes a password several times is unaffected, and
 * tight enough that an automated guesser gets a few hundred attempts a day
 * rather than a few million.
 */
export interface ThrottlingConfig {
  /** How long attempts are counted for. */
  readonly windowSeconds: number;
  /** How long a caller waits once the count is exceeded. */
  readonly cooldownSeconds: number;
  readonly signInAttemptsPerAddress: number;
  readonly signInAttemptsPerOrigin: number;
  readonly redemptionsPerOrigin: number;
}

const BASELINE: ThrottlingConfig = {
  windowSeconds: 300,
  cooldownSeconds: 900,
  // Per address, because that is the bucket an attacker cannot avoid: guessing
  // one person's password means presenting their address every time.
  signInAttemptsPerAddress: 10,
  // Per origin, generous enough for a whole office behind one address.
  signInAttemptsPerOrigin: 60,
  redemptionsPerOrigin: 20,
};

type Env = Record<string, string | undefined>;

export function loadThrottlingConfig(env: Env): ThrottlingConfig {
  return {
    windowSeconds: positiveInteger(
      env.AUTH_THROTTLE_WINDOW_SECONDS,
      'AUTH_THROTTLE_WINDOW_SECONDS',
      BASELINE.windowSeconds,
    ),
    cooldownSeconds: positiveInteger(
      env.AUTH_THROTTLE_COOLDOWN_SECONDS,
      'AUTH_THROTTLE_COOLDOWN_SECONDS',
      BASELINE.cooldownSeconds,
    ),
    signInAttemptsPerAddress: positiveInteger(
      env.AUTH_SIGN_IN_ATTEMPTS_PER_ADDRESS,
      'AUTH_SIGN_IN_ATTEMPTS_PER_ADDRESS',
      BASELINE.signInAttemptsPerAddress,
    ),
    signInAttemptsPerOrigin: positiveInteger(
      env.AUTH_SIGN_IN_ATTEMPTS_PER_ORIGIN,
      'AUTH_SIGN_IN_ATTEMPTS_PER_ORIGIN',
      BASELINE.signInAttemptsPerOrigin,
    ),
    redemptionsPerOrigin: positiveInteger(
      env.AUTH_REDEMPTIONS_PER_ORIGIN,
      'AUTH_REDEMPTIONS_PER_ORIGIN',
      BASELINE.redemptionsPerOrigin,
    ),
  };
}

function positiveInteger(
  raw: string | undefined,
  key: string,
  fallback: number,
): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}
