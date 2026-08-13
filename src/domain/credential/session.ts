import type { SignInId } from '../identifiers';

/**
 * How long a sign-in may be extended for, counted from the sign-in itself
 * rather than from the most recent refresh. A sliding window would let a
 * session live forever as long as it was used, which is not a session at all.
 */
export const SESSION_LIFETIME_DAYS = 14;

export function sessionDeadline(signedInAt: Date): Date {
  return new Date(
    signedInAt.getTime() + SESSION_LIFETIME_DAYS * 24 * 60 * 60 * 1000,
  );
}

export interface RefreshTokenState {
  readonly signInId: SignInId;
  /** Set when this token was already traded for a successor. */
  readonly exchangedAt: Date | null;
  /** Set when the token was retired without being used — sign-out, or a family ending. */
  readonly invalidatedAt: Date | null;
  readonly sessionExpiresAt: Date;
}

export type RefreshDecision =
  | { readonly outcome: 'exchange' }
  | { readonly outcome: 'reject' }
  | { readonly outcome: 'reject-and-invalidate-family' };

/**
 * Pure arithmetic over a token's recorded state, so the rule is testable
 * without a database and identical wherever it is applied.
 *
 * The order of the checks is the design. Re-use is looked for *before* expiry,
 * because a replayed token is evidence that someone else may hold a copy, and
 * that is worth acting on even when the token would have been refused anyway.
 * Dismissing it as merely stale would throw away the signal.
 *
 * Invalidated and expired deliberately produce the same outcome: the holder
 * must not be able to tell a session that was ended from one that ran out.
 */
export function decideRefresh(
  state: RefreshTokenState,
  now: Date,
): RefreshDecision {
  if (state.invalidatedAt !== null) {
    return { outcome: 'reject' };
  }
  if (state.exchangedAt !== null) {
    return { outcome: 'reject-and-invalidate-family' };
  }
  if (now.getTime() >= state.sessionExpiresAt.getTime()) {
    return { outcome: 'reject' };
  }
  return { outcome: 'exchange' };
}
