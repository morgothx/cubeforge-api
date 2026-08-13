import { DomainViolation } from '../errors';

export const MINIMUM_PASSWORD_LENGTH = 12;

/**
 * Length, and nothing else.
 *
 * Composition rules — a digit, a symbol, mixed case — push people toward
 * predictable substitutions and away from length, which is the property that
 * actually resists guessing. Requiring only length is the current guidance and
 * the deliberate choice here.
 *
 * Counted in characters rather than in UTF-16 code units, so a passphrase of
 * emoji is not silently worth twice its apparent length.
 */
export function assertPasswordAcceptable(password: string): void {
  if ([...password].length < MINIMUM_PASSWORD_LENGTH) {
    throw new DomainViolation({
      kind: 'validation',
      field: 'password',
      detail: `must be at least ${MINIMUM_PASSWORD_LENGTH} characters`,
    });
  }
}
