import type { PasswordDigest } from '../../domain/credential/secrets';

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

export interface PasswordHasher {
  hash(password: string): Promise<PasswordDigest>;

  /**
   * Answers only true or false. A digest that cannot be read — a truncated
   * column, a value written by something else — is a failed verification, never
   * an error, because an error would let a caller tell a broken record from a
   * wrong password.
   */
  verify(password: string, digest: PasswordDigest): Promise<boolean>;

  /**
   * Verifies against a value that matches nothing, at the same cost as a real
   * verification. Sign-in calls this when the address is unknown, so that path
   * is not measurably faster than a wrong password (requirement 2.2). Without
   * it, response time answers a question the response body refuses to.
   */
  verifyAgainstDecoy(password: string): Promise<false>;
}
