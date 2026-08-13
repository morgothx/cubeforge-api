import type { SecretDigest } from '../../domain/credential/secrets';
import type { RefreshTokenState } from '../../domain/credential/session';
import type { PersonId, SignInId } from '../../domain/identifiers';

export interface StoredRefreshToken extends RefreshTokenState {
  readonly id: string;
  readonly personId: PersonId;
}

export interface SessionRepository {
  insert(token: {
    readonly id: string;
    readonly signInId: SignInId;
    readonly personId: PersonId;
    readonly secretDigest: SecretDigest;
    readonly sessionExpiresAt: Date;
  }): Promise<void>;

  /** Found by digest: the token handed to the caller is never stored. */
  findByDigest(digest: SecretDigest): Promise<StoredRefreshToken | null>;

  markExchanged(id: string, at: Date): Promise<void>;

  /**
   * Ends every token descended from one sign-in. This is the response to a
   * replayed token: the legitimate holder and whoever copied it cannot both be
   * allowed to continue, so neither is.
   */
  invalidateFamily(signInId: SignInId, at: Date): Promise<void>;

  /**
   * Ends every session a person holds. Signing out everywhere asks for this,
   * and so does establishing a credential and being deactivated — in those two
   * cases nobody asked, which is the point.
   */
  invalidateAllForPerson(personId: PersonId, at: Date): Promise<void>;
}
