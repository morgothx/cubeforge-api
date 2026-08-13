import { signInId } from '../identifiers';
import {
  decideRefresh,
  sessionDeadline,
  SESSION_LIFETIME_DAYS,
  type RefreshTokenState,
} from './session';

const SIGNED_IN_AT = new Date('2026-01-01T00:00:00.000Z');
const DEADLINE = sessionDeadline(SIGNED_IN_AT);

function tokenState(
  overrides: Partial<RefreshTokenState> = {},
): RefreshTokenState {
  return {
    signInId: signInId('sign-in-1'),
    exchangedAt: null,
    invalidatedAt: null,
    sessionExpiresAt: DEADLINE,
    ...overrides,
  };
}

describe('the session deadline', () => {
  it('is measured from the sign-in, not from the last issuance', () => {
    const expected =
      SIGNED_IN_AT.getTime() + SESSION_LIFETIME_DAYS * 24 * 60 * 60 * 1000;

    expect(sessionDeadline(SIGNED_IN_AT).getTime()).toBe(expected);
  });
});

describe('deciding whether a refresh token may be exchanged', () => {
  it('permits an untouched token before the deadline', () => {
    expect(decideRefresh(tokenState(), SIGNED_IN_AT)).toEqual({
      outcome: 'exchange',
    });
  });

  it('refuses an invalidated token', () => {
    const state = tokenState({ invalidatedAt: SIGNED_IN_AT });

    expect(decideRefresh(state, SIGNED_IN_AT)).toEqual({ outcome: 'reject' });
  });

  /**
   * The heart of requirement 4.2. A token presented twice means someone else
   * may hold a copy, and the legitimate holder and a thief cannot both be
   * allowed to continue — so nobody does.
   */
  it('ends the whole family when an already exchanged token comes back', () => {
    const state = tokenState({ exchangedAt: SIGNED_IN_AT });

    expect(decideRefresh(state, SIGNED_IN_AT)).toEqual({
      outcome: 'reject-and-invalidate-family',
    });
  });

  it('refuses a token past the session deadline', () => {
    const afterDeadline = new Date(DEADLINE.getTime() + 1000);

    expect(decideRefresh(tokenState(), afterDeadline)).toEqual({
      outcome: 'reject',
    });
  });

  it('permits a token in the last moment before the deadline', () => {
    const justBefore = new Date(DEADLINE.getTime() - 1000);

    expect(decideRefresh(tokenState(), justBefore)).toEqual({
      outcome: 'exchange',
    });
  });

  /**
   * Re-use is detected before expiry is considered, so replaying an old token
   * still reports the theft rather than being dismissed as merely stale.
   */
  it('reports re-use even after the session has expired', () => {
    const state = tokenState({ exchangedAt: SIGNED_IN_AT });
    const afterDeadline = new Date(DEADLINE.getTime() + 1000);

    expect(decideRefresh(state, afterDeadline)).toEqual({
      outcome: 'reject-and-invalidate-family',
    });
  });

  it('distinguishes the four states from one another', () => {
    const outcomes = new Set([
      decideRefresh(tokenState(), SIGNED_IN_AT).outcome,
      decideRefresh(tokenState({ invalidatedAt: SIGNED_IN_AT }), SIGNED_IN_AT)
        .outcome,
      decideRefresh(tokenState({ exchangedAt: SIGNED_IN_AT }), SIGNED_IN_AT)
        .outcome,
      decideRefresh(tokenState(), new Date(DEADLINE.getTime() + 1000)).outcome,
    ]);

    // Invalidated and expired share an outcome on purpose: the caller must not
    // be able to tell them apart, and neither must the person presenting one.
    expect(outcomes).toEqual(
      new Set(['exchange', 'reject', 'reject-and-invalidate-family']),
    );
  });
});
