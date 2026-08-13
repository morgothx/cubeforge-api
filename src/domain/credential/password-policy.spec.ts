import { DomainViolation } from '../errors';
import {
  assertPasswordAcceptable,
  MINIMUM_PASSWORD_LENGTH,
} from './password-policy';

describe('the password rule', () => {
  it('accepts a long passphrase with no digits or symbols', () => {
    expect(() =>
      assertPasswordAcceptable('correct horse battery staple'),
    ).not.toThrow();
  });

  it('accepts a password of exactly the minimum length', () => {
    expect(() =>
      assertPasswordAcceptable('a'.repeat(MINIMUM_PASSWORD_LENGTH)),
    ).not.toThrow();
  });

  it('rejects one character short, naming the field at fault', () => {
    const attempt = () =>
      assertPasswordAcceptable('a'.repeat(MINIMUM_PASSWORD_LENGTH - 1));

    expect(attempt).toThrow(DomainViolation);
    try {
      attempt();
    } catch (error) {
      expect((error as DomainViolation).error).toEqual({
        kind: 'validation',
        field: 'password',
        detail: `must be at least ${MINIMUM_PASSWORD_LENGTH} characters`,
      });
    }
  });

  it('rejects an empty password', () => {
    expect(() => assertPasswordAcceptable('')).toThrow(DomainViolation);
  });

  /**
   * Length is measured in characters as a person types them, not in UTF-16
   * code units, so a passphrase of emoji is not silently worth double.
   */
  it('counts characters rather than code units', () => {
    const twelveEmoji = '👍'.repeat(12);

    expect(twelveEmoji.length).toBeGreaterThan(MINIMUM_PASSWORD_LENGTH);
    expect(() => assertPasswordAcceptable(twelveEmoji)).not.toThrow();
    expect(() => assertPasswordAcceptable('👍'.repeat(11))).toThrow(
      DomainViolation,
    );
  });

  /** Requirement 1.4 says no composition rules, which is a rule in itself. */
  it('imposes no composition requirement', () => {
    for (const password of [
      'aaaaaaaaaaaaaaaa',
      '1234567890123456',
      '                x',
      'ALLUPPERCASELETTERS',
    ]) {
      expect(() => assertPasswordAcceptable(password)).not.toThrow();
    }
  });
});
