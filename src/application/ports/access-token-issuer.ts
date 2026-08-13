import type { AccessToken } from '../../domain/credential/secrets';
import type { PersonId } from '../../domain/identifiers';

export const ACCESS_TOKEN_ISSUER = Symbol('ACCESS_TOKEN_ISSUER');

export interface AccessTokenIssuer {
  issue(subject: PersonId, issuedAt: Date): Promise<AccessToken>;

  /**
   * Returns the person, or nothing at all.
   *
   * Absent, malformed, expired and foreign-signed tokens are one outcome by
   * construction: there is no variant for a caller to branch on, which is how
   * requirement 3.4 stays true no matter who writes the caller.
   */
  verify(token: string, now: Date): Promise<PersonId | null>;
}
