/**
 * How long a credential setup token may be redeemed for.
 *
 * Twenty-four hours: long enough to hand over, short enough to matter if lost.
 * It lives here rather than in the use case because the bootstrap script issues
 * the very first one without going through the API, and two places deciding
 * how long a token lives is one place too many.
 */
export const SETUP_TOKEN_VALIDITY_HOURS = 24;

export function setupTokenDeadline(issuedAt: Date): Date {
  return new Date(
    issuedAt.getTime() + SETUP_TOKEN_VALIDITY_HOURS * 60 * 60 * 1000,
  );
}
